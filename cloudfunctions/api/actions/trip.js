'use strict';

const resp = require('../lib/resp');
const { CODES, require_fields, assert, fail } = require('../lib/errors');
const { requireCrewMember, getMembership, canBeTripNode, canBeMeetingPoint } = require('../lib/authz');
const { resolveParams } = require('../lib/params');
const timelineMod = require('../domain/timeline');
const { checkFeasibility } = require('../domain/feasibility');
const { generateCandidates } = require('../domain/planner');
const constraintMod = require('../domain/constraint');
const { logEvent, logDecision } = require('../lib/trace');
const { createMapProvider } = require('../lib/map');
const geo = require('../lib/geo');
const time = require('../lib/time');
const C = require('../lib/repo/collections');

/**
 * 把缺失的步行时间从**地图路线接口**取回来。
 *
 * ⚠️ 2026-10-13 修正：首版规划器只用 `place.walkableTo` 缓存或直线估算，
 * **从不调用地图接口** —— 于是全天调通的步行路线接口在规划里一次都没被用到，
 * "根据路况计算"名不副实（实测：同一条路直线估算与真实路线差 1.35 倍，
 * 短距离下差 7.6 倍）。
 *
 * `buildTimeline` 是同步纯函数，所以这里先一次性取回、写进 `placesById`，
 * 再交给它同步计算。
 *
 * 取回的时间会**写回 places 集合**作为缓存：下次同路段零成本、零延迟。
 * 但一律标记 `source: 'upstream'` —— **它不是踏勘实测**，可信度不同，不能混为一谈。
 */
async function fillMissingWalkTimes(ctx) {
  const { repo, placesById, placeIds, now } = ctx;
  const out = { fetched: 0, fromCache: 0, failed: 0, skipped: 0, mapApiCalls: 0, failures: [] };

  const legs = [];
  for (let i = 1; i < placeIds.length; i++) {
    const from = placesById[placeIds[i - 1]];
    const to = placesById[placeIds[i]];
    if (!from || !to) continue;
    if (!geo.needsWalkFetch(from, to)) {
      out.fromCache++;
      continue;
    }
    if (!from.location || !to.location) {
      out.skipped++;
      continue;
    }
    legs.push({ from, to });
  }
  if (!legs.length) return out;

  const provider = createMapProvider(process.env.MAP_PROVIDER);

  for (const leg of legs) {
    let r;
    try {
      r = await provider.walkingRoute(leg.from.location, leg.to.location);
    } catch (e) {
      r = { ok: false, reason: 'THREW', message: (e && e.message) || String(e) };
    }
    out.mapApiCalls++;

    if (!r.ok) {
      // 取不到就让它回落直线估算，但**必须记下失败** —— 不掩盖、不冒充
      out.failed++;
      out.failures.push({
        from: leg.from.name,
        to: leg.to.name,
        reason: r.reason || 'UPSTREAM_FAILED',
        message: r.message || null,
      });
      continue;
    }

    const rec = {
      walkMin: r.durationMinutes,
      walkMeters: r.distanceMeters,
      source: geo.WALK_SOURCE.UPSTREAM,
      measuredAt: now,
    };

    leg.from.walkableTo = geo.withWalkRecord(leg.from, leg.to._id, rec);

    try {
      await repo.update(C.PLACES, leg.from._id, { walkableTo: leg.from.walkableTo });
    } catch (e) {
      // 缓存写失败不该让整次规划失败 —— 本次仍用内存里的值
      out.cacheWriteFailed = (out.cacheWriteFailed || 0) + 1;
    }
    out.fetched++;
  }

  return out;
}

/** 载入一组地点，返回 placeId -> place 映射；缺失的地点会让调用方明确报错。 */
async function loadPlaces(repo, placeIds) {
  const map = {};
  const missing = [];
  for (const id of [...new Set(placeIds.filter(Boolean))]) {
    const p = await repo.get(C.PLACES, id);
    if (p) map[id] = p;
    else missing.push(id);
  }
  return { map, missing };
}

/** 行程访问控制：个人看 owner，团队看成员身份。 */
async function loadTripForRead(repo, tripId, openid) {
  const trip = await repo.get(C.TRIPS, tripId);
  if (!trip) throw fail(CODES.NOT_FOUND, '行程不存在');
  if (trip.mode === 'team') {
    await requireCrewMember(repo, trip.crewId, openid);
  } else if (trip.ownerUserId !== openid) {
    throw fail(CODES.FORBIDDEN_NOT_MEMBER, '无权查看该行程');
  }
  return trip;
}

/**
 * 生成行程。
 *
 * 关键行为：**不可行时不落库**。返回 feasible:false 与冲突原因，由用户调整要求后重试。
 * 只有显式传 allowInfeasible:true 时才存为 draft，并强制记录冲突 ——
 * 这是"遇到异常不会悄悄执行错误安排"在规划入口的落地。
 */
async function plan(ctx) {
  const { repo, openid } = ctx;
  const p = ctx.payload || {};
  const started = Date.now();
  const now = new Date(ctx.now ? ctx.now : Date.now());

  let spec;
  if (p.requirementId) {
    const req = await repo.get(C.REQUIREMENTS, p.requirementId);
    if (!req) throw fail(CODES.NOT_FOUND, '需求不存在');
    assert(
      req.ownerUserId === openid || (req.crewId && (await getMembership(repo, req.crewId, openid))),
      CODES.FORBIDDEN_NOT_MEMBER,
      '无权使用该需求'
    );
    spec = {
      placeIds: (req.structured && req.structured.placeIds) || [],
      startAt: (req.structured && req.structured.startAt) || now,
      constraints: req.constraints || [],
      crewId: req.crewId || null,
      scope: req.scope,
      requirementId: p.requirementId,
      rawText: req.rawText,
      paramsInput: req.structured && req.structured.params,
    };
  } else {
    require_fields(p, ['placeIds', 'startAt']);
    spec = {
      placeIds: p.placeIds,
      startAt: p.startAt,
      constraints: p.constraints || [],
      crewId: p.crewId || null,
      scope: p.crewId ? 'team' : 'personal',
      requirementId: null,
      rawText: p.rawText || null,
      paramsInput: p.params,
    };
  }

  const params = resolveParams(spec.paramsInput);
  assert(Array.isArray(spec.placeIds) && spec.placeIds.length > 0, CODES.INVALID_PARAM, '至少需要一个地点');

  if (spec.crewId) await requireCrewMember(repo, spec.crewId, openid);

  const { map: placesById, missing } = await loadPlaces(repo, spec.placeIds);
  assert(missing.length === 0, CODES.NOT_FOUND, `地点不存在：${missing.join(', ')}`);

  /**
   * 行程节点准入：需要名称与坐标。
   *
   * **未核验不再是拒绝理由**（2026-10-13 修正）。首版把核验做成了"全有或全无"，
   * 结果是地点检索回来的 POI 一个都用不了 —— 与「外部检索保证覆盖度、
   * 实地踏勘保证可信度」的设计目标直接矛盾。
   *
   * 正确的分级见 `lib/authz.js`：
   *   · 行程节点：有名称与坐标即可（外部 POI 够用）
   *   · 集合点：还必须实地核验（§7.1 可达性、辨识度、停留条件）
   *
   * 这里只拒绝**真正无法使用**的地点 —— 缺坐标会让时间线失真。
   */
  const notUsable = Object.values(placesById).filter((pl) => !canBeTripNode(pl));

  if (notUsable.length) {
    // 拒绝也必须留痕：11/5 要能分清"正常拒绝、误拒绝和错误放行"
    await logDecision(repo, {
      ts: now,
      kind: 'plan',
      crewId: spec.crewId,
      inputDigest: { placeIds: spec.placeIds, startAt: time.toISO(spec.startAt) },
      candidates: [],
      algoVersion: params.algoVersion,
      params,
      durationMs: Date.now() - started,
      mapApiCalls: 0,
      result: 'insufficient_data',
      excludedReasons: notUsable.map((pl) => ({
        placeId: pl._id,
        reason: 'PLACE_NOT_LOCATABLE',
        message: `${pl.name} 缺少可用坐标，无法计算步行时间`,
      })),
    });
    return resp.ok({
      feasible: false,
      conflicts: notUsable.map((pl) => ({
        code: 'INSUFFICIENT_DATA',
        message: `「${pl.name}」缺少坐标，无法计算前往它的步行时间`,
        placeId: pl._id,
        hardConstraintKey: null,
      })),
      nodes: [],
      saved: false,
      reason: 'PLACE_NOT_LOCATABLE',
      hint: '请补全该地点的经纬度；地点检索入库时会一并取回坐标。',
    });
  }

  /**
   * 未核验地点：**允许安排进路线，但必须随结果标注**，不得静默。
   * 标注同时说明它的使用边界（不能作为集合点），让界面能如实提示用户。
   */
  const unverifiedPlaces = Object.values(placesById)
    .filter((pl) => !canBeMeetingPoint(pl))
    .map((pl) => ({
      placeId: pl._id,
      name: pl.name,
      dataSource: pl.dataSource || null,
      confidence: pl.confidence || null,
      verifiedAt: pl.verifiedAt || null,
    }));

  const unverifiedNotice = unverifiedPlaces.length
    ? {
        count: unverifiedPlaces.length,
        placeIds: unverifiedPlaces.map((pl) => pl.placeId),
        places: unverifiedPlaces,
        scope: 'tripNodeOnly',
        warning:
          '本次路线含未核验地点：可以安排进游览顺序，但**不能作为集合点**（集合点要求实地核验）。',
      }
    : null;

  // ★ 先把缺失的步行时间从地图接口取回来，再交给同步的时间线计算
  const walkFill = await fillMissingWalkTimes({
    repo,
    placesById,
    placeIds: spec.placeIds,
    now,
  });

  const items = spec.placeIds.map((placeId, i) => ({ nodeId: `n_${i}_${placeId}`, placeId }));
  const tl = timelineMod.buildTimeline({ startAt: spec.startAt, items, placesById, params });
  const feasibility = checkFeasibility({
    timeline: tl,
    constraints: spec.constraints,
    placesById,
  });

  const decisionBase = {
    ts: now,
    kind: 'plan',
    crewId: spec.crewId,
    inputDigest: {
      placeIds: spec.placeIds,
      startAt: time.toISO(spec.startAt),
      constraintKeys: constraintMod.normalize(spec.constraints).map((c) => `${c.key}:${c.hardness}`),
      requirementId: spec.requirementId,
    },
    candidates: [],
    algoVersion: params.algoVersion,
    params,
    durationMs: Date.now() - started,
    /** 本次规划真实消耗的地图接口调用次数（11/8、11/12 成本核算要用） */
    mapApiCalls: walkFill.mapApiCalls,
  };

  /**
   * 步行时间的来源构成 —— **必须随结果回传**。
   *
   * 界面上"步行 12 分钟"这句话，可能是真实路线、也可能是直线估算，
   * 两者在短距离下能差 7 倍。不标出来，用户会以为一样可信。
   */
  const legSources = (tl.legs || []).reduce((acc, l) => {
    const k = l.travelSource || 'none';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const walkTimes = {
    bySource: legSources,
    fetchedFromMap: walkFill.fetched,
    fromCache: walkFill.fromCache,
    upstreamFailed: walkFill.failed,
    failures: walkFill.failures,
    mapApiCalls: walkFill.mapApiCalls,
    note:
      walkFill.failed > 0
        ? `有 ${walkFill.failed} 段没能从地图服务取到路线，已回落为**直线估算**（时间可能明显偏小）`
        : walkFill.fetched > 0
          ? `本次从地图服务取回 ${walkFill.fetched} 段真实步行路线，已缓存，下次规划零成本`
          : '全部路段均使用已有记录，未消耗地图配额',
    sourceMeaning: {
      survey: '踏勘实测，最可信',
      upstream: '地图步行路线接口返回的真实路线',
      estimated: '直线估算 —— 地图服务不可用时的兜底，短距离下很不可靠',
    },
  };

  if (!feasibility.feasible && p.allowInfeasible !== true) {
    await logDecision(repo, Object.assign(decisionBase, {
      result: 'no_feasible',
      candidates: [{ candidateId: 'c_plan', feasible: false, conflictCodes: feasibility.conflicts.map((c) => c.code) }],
    }));
    return resp.ok({
      feasible: false,
      conflicts: feasibility.conflicts,
      warnings: feasibility.warnings,
      quality: feasibility.quality,
      nodes: [],
      saved: false,
      reason: 'INFEASIBLE',
      walkTimes,
    });
  }

  const nodes = timelineMod.toNodes(tl.legs, 'plan');
  const trip = await repo.insert(C.TRIPS, {
    mode: spec.scope === 'team' ? 'team' : 'personal',
    ownerUserId: openid,
    crewId: spec.crewId,
    requirementId: spec.requirementId,
    // 行程自带约束快照：adjust 时不依赖原始需求，且 11/5 固定测试集可完整复现
    constraints: constraintMod.normalize(spec.constraints),
    title: p.title || `${Object.values(placesById)[0].name} 一带游览`,
    status: p.allowInfeasible === true ? 'draft' : 'active',
    version: 1,
    nodes,
    params,
    plannedStartAt: new Date(spec.startAt),
    plannedEndAt: tl.endAt,
    generatedBy: {
      algoVersion: params.algoVersion,
      candidateId: 'c_plan',
      planRunId: `plan_${now.getTime()}`,
    },
    conflicts: feasibility.conflicts, // 不可行但被显式保存时，冲突必须留在记录里
    createdAt: now,
    updatedAt: now,
  });

  await repo.insert(C.TRIP_VERSIONS, {
    tripId: trip._id,
    version: 1,
    snapshot: { nodes, params },
    reason: 'plan',
    changeProposalId: null,
    createdByUserId: openid,
    createdAt: now,
  });

  await logDecision(repo, Object.assign(decisionBase, {
    tripId: trip._id,
    result: feasibility.feasible ? 'ok' : 'no_feasible',
    selectedCandidateId: 'c_plan',
    candidates: [
      {
        candidateId: 'c_plan',
        strategy: 'initial',
        feasible: feasibility.feasible,
        conflictCodes: feasibility.conflicts.map((c) => c.code),
        impactSummary: { nodeCount: nodes.length, endAt: time.toISO(tl.endAt), walkMin: tl.totalWalkMin },
      },
    ],
  }));

  return resp.ok({
    tripId: trip._id,
    version: trip.version,
    status: trip.status,
    feasible: feasibility.feasible,
    conflicts: feasibility.conflicts,
    warnings: feasibility.warnings,
    quality: feasibility.quality,
    nodes,
    summary: {
      endAt: time.toISO(tl.endAt),
      totalWalkMin: tl.totalWalkMin,
      totalWalkMeters: tl.totalWalkMeters,
      totalStayMin: tl.totalStayMin,
    },
    /** 非 null 表示本次路线含未核验地点（可游览、不可作集合点）—— 界面必须显著标注 */
    unverifiedNotice,
    /** 各段步行时间的来源构成 —— 界面必须能区分真实路线与直线估算 */
    walkTimes,
    saved: true,
  });
}

/** 读取行程，并附带团队位置时效（§8.2 界面必须显示实际时效）。 */
async function get(ctx) {
  const { repo, openid } = ctx;
  require_fields(ctx.payload, ['tripId']);

  const trip = await loadTripForRead(repo, ctx.payload.tripId, openid);
  const nodes = (trip.nodes || []).slice().sort((a, b) => a.seq - b.seq);
  const currentNodeIndex = Math.max(
    0,
    nodes.findIndex((n) => n.status !== 'done' && n.status !== 'skipped')
  );

  const out = {
    trip: {
      tripId: trip._id,
      mode: trip.mode,
      status: trip.status,
      version: trip.version,
      title: trip.title,
      crewId: trip.crewId || null,
      nodes,
      plannedStartAt: trip.plannedStartAt,
      plannedEndAt: trip.plannedEndAt,
      params: trip.params,
      generatedBy: trip.generatedBy,
    },
    currentNodeIndex,
    freshness: { computedAt: new Date(ctx.now ? ctx.now : Date.now()).toISOString() },
  };

  if (trip.mode === 'team' && trip.crewId) {
    const latest = await repo.findOne(
      C.LOCATIONS,
      { userId: openid, crewId: trip.crewId },
      { sort: { reportedAt: -1 }, limit: 1 }
    );
    out.freshness = latest
      ? Object.assign(time.freshness(latest.reportedAt, ctx), {
          source: latest.source,
          computedAt: new Date(ctx.now ? ctx.now : Date.now()).toISOString(),
        })
      : { hasLocation: false, computedAt: new Date(ctx.now ? ctx.now : Date.now()).toISOString() };
  }

  return resp.ok(out);
}

/**
 * 提交调整请求。
 *
 * **本接口不修改行程**，只产生变更提案与候选（docs/02 §3 第 1 条）。
 * 生效的唯一路径是 trip.confirmChange。
 */
async function adjust(ctx) {
  const { repo, openid } = ctx;
  require_fields(ctx.payload, ['tripId', 'trigger']);
  const p = ctx.payload;
  const started = Date.now();
  const now = new Date(ctx.now ? ctx.now : Date.now());

  const trip = await repo.get(C.TRIPS, p.tripId);
  if (!trip) throw fail(CODES.NOT_FOUND, '行程不存在');
  if (trip.mode === 'team') await requireCrewMember(repo, trip.crewId, openid);
  else assert(trip.ownerUserId === openid, CODES.FORBIDDEN_NOT_MEMBER, '无权修改该行程');

  // 只重算未完成的节点：已完成的节点是既成事实，不应被重算覆盖
  const baseNodes = (trip.nodes || [])
    .filter((n) => n.status === 'pending' || n.status === 'arrived')
    .sort((a, b) => a.seq - b.seq);

  assert(baseNodes.length > 0, CODES.INVALID_PARAM, '行程已全部完成，没有可调整的节点');

  const extraIds = [p.trigger.payload && p.trigger.payload.newPlaceId].filter(Boolean);
  const { map: placesById, missing } = await loadPlaces(
    repo,
    baseNodes.map((n) => n.placeId).concat(extraIds)
  );
  assert(missing.length === 0, CODES.NOT_FOUND, `地点不存在：${missing.join(', ')}`);

  const params = resolveParams(Object.assign({}, trip.params, p.params));
  const constraints = constraintMod.normalize(trip.constraints || []);

  // 行程进行中从"现在"重算；未开始则从计划出发时刻重算
  const startAt = trip.status === 'active' ? now : new Date(trip.plannedStartAt);

  const result = generateCandidates({
    baseNodes,
    trigger: p.trigger,
    constraints,
    placesById,
    params,
    startAt,
  });

  const proposal = await repo.insert(C.CHANGE_PROPOSALS, {
    tripId: trip._id,
    baseVersion: trip.version, // ← 确认时用来发现"确认的是旧版本"
    status: 'proposed',
    trigger: p.trigger,
    candidates: result.candidates,
    selectedCandidateId: null,
    confirmations: [],
    decidedAt: null,
    expiresAt: new Date(now.getTime() + 30 * time.MIN),
    createdByUserId: openid,
    createdAt: now,
  });

  await logDecision(repo, {
    ts: now,
    kind: 'adjust',
    tripId: trip._id,
    crewId: trip.crewId || null,
    inputDigest: {
      baseVersion: trip.version,
      triggerType: p.trigger.type,
      triggerPayload: p.trigger.payload || {},
      nodeCount: baseNodes.length,
    },
    candidates: result.candidates.map((c) => ({
      candidateId: c.candidateId,
      strategy: c.strategy,
      feasible: c.feasible,
      conflictCodes: c.conflicts.map((x) => x.code),
      impactSummary: c.impact,
      quality: c.quality,
    })),
    excludedReasons: result.excludedReasons,
    algoVersion: result.algoVersion,
    params,
    durationMs: Date.now() - started,
    mapApiCalls: 0,
    result: result.feasibleCount > 0 ? 'ok' : 'no_feasible',
  });

  await logEvent(repo, {
    ts: now,
    type: 'state_change',
    action: 'trip.adjust',
    userId: openid,
    tripId: trip._id,
    algoVersion: result.algoVersion,
    durationMs: Date.now() - started,
    detail: { proposalId: proposal._id, candidateCount: result.candidates.length },
  });

  return resp.ok(
    {
      proposalId: proposal._id,
      tripId: trip._id,
      baseVersion: trip.version,
      candidates: result.candidates,
      feasibleCount: result.feasibleCount,
      excludedReasons: result.excludedReasons,
      algoVersion: result.algoVersion,
      // 无可行方案时明确告知，不补默认方案（10/28 验收）
      noFeasible: result.feasibleCount === 0,
    },
    { version: trip.version }
  );
}

/**
 * 确认变更并生效。
 *
 * 三条校验缺一不可：
 *   1. 提案仍处于 proposed（重复确认、已拒绝、已过期都拒绝）
 *   2. **提案的 baseVersion 必须等于行程当前版本** → 否则 VERSION_CONFLICT
 *      （这就是"旧版本确认不能使新方案生效"）
 *   3. 被确认的候选必须是可行的 → 不允许把不可行方案落库
 */
async function confirmChange(ctx) {
  const { repo, openid } = ctx;
  require_fields(ctx.payload, ['proposalId', 'candidateId']);
  const now = new Date(ctx.now ? ctx.now : Date.now());

  const proposal = await repo.get(C.CHANGE_PROPOSALS, ctx.payload.proposalId);
  if (!proposal) throw fail(CODES.NOT_FOUND, '变更提案不存在');

  if (proposal.status !== 'proposed') {
    throw fail(CODES.INVALID_PARAM, `该提案已${proposal.status === 'confirmed' ? '确认' : '处理'}，不能重复确认`, {
      status: proposal.status,
    });
  }
  if (proposal.expiresAt && new Date(proposal.expiresAt) < now) {
    await repo.update(C.CHANGE_PROPOSALS, proposal._id, { status: 'expired' });
    throw fail(CODES.INVALID_PARAM, '提案已超时失效，请重新发起调整');
  }

  const trip = await repo.get(C.TRIPS, proposal.tripId);
  if (!trip) throw fail(CODES.NOT_FOUND, '行程不存在');
  if (trip.mode === 'team') await requireCrewMember(repo, trip.crewId, openid);
  else assert(trip.ownerUserId === openid, CODES.FORBIDDEN_NOT_MEMBER, '无权修改该行程');

  // ← 核心校验：提案基于的版本必须仍是当前版本
  if (proposal.baseVersion !== trip.version) {
    throw fail(CODES.VERSION_CONFLICT, '行程已被更新，该确认基于旧版本，已失效', {
      proposalBaseVersion: proposal.baseVersion,
      currentVersion: trip.version,
    });
  }

  const candidate = (proposal.candidates || []).find((c) => c.candidateId === ctx.payload.candidateId);
  if (!candidate) throw fail(CODES.NOT_FOUND, '候选方案不存在');
  if (!candidate.feasible) {
    throw fail(CODES.INFEASIBLE_HARD_CONSTRAINT, '该候选方案不满足硬约束，不能生效', {
      conflicts: candidate.conflicts,
    });
  }

  const nodes = (candidate.nodes || []).map((n, i) => Object.assign({}, n, { seq: i }));
  const expectedVersion = ctx.expectedVersion == null ? trip.version : ctx.expectedVersion;

  const res = await repo.updateCas(C.TRIPS, trip._id, expectedVersion, {
    nodes,
    plannedEndAt: candidate.impact.changedEndAt,
    status: 'active',
  });

  if (!res.updated) {
    throw fail(CODES.VERSION_CONFLICT, '行程已被其他成员更新，请刷新后重试', {
      expectedVersion,
      currentVersion: (await repo.get(C.TRIPS, trip._id)).version,
    });
  }

  await repo.insert(C.TRIP_VERSIONS, {
    tripId: trip._id,
    version: res.doc.version,
    snapshot: { nodes, params: res.doc.params },
    reason: 'adjust',
    changeProposalId: proposal._id,
    createdByUserId: openid,
    createdAt: now,
  });

  await repo.update(C.CHANGE_PROPOSALS, proposal._id, {
    status: 'confirmed',
    selectedCandidateId: candidate.candidateId,
    decidedAt: now,
    confirmations: (proposal.confirmations || []).concat([
      { userId: openid, decision: 'confirm', at: now, baseVersion: proposal.baseVersion },
    ]),
  });

  await logEvent(repo, {
    ts: now,
    type: 'state_change',
    action: 'trip.confirmChange',
    userId: openid,
    tripId: trip._id,
    detail: {
      proposalId: proposal._id,
      candidateId: candidate.candidateId,
      fromVersion: trip.version,
      toVersion: res.doc.version,
      appliedNotes: candidate.notes || [],
    },
  });

  return resp.ok(
    {
      tripId: trip._id,
      version: res.doc.version,
      applied: true,
      candidateId: candidate.candidateId,
      strategyLabel: candidate.strategyLabel,
      nodes: res.doc.nodes,
      plannedEndAt: res.doc.plannedEndAt,
      // 把"改了什么"原样回给界面，供 §5.2 的四条展示规则使用
      changes: candidate.notes || [],
      impact: candidate.impact,
    },
    { version: res.doc.version }
  );
}

/** 上报实际进度（已到达／已离开／跳过）。 */
async function progress(ctx) {
  const { repo, openid } = ctx;
  require_fields(ctx.payload, ['tripId', 'nodeId', 'status']);
  const now = new Date(ctx.now ? ctx.now : Date.now());

  const trip = await repo.get(C.TRIPS, ctx.payload.tripId);
  if (!trip) throw fail(CODES.NOT_FOUND, '行程不存在');
  if (trip.mode === 'team') await requireCrewMember(repo, trip.crewId, openid);
  else assert(trip.ownerUserId === openid, CODES.FORBIDDEN_NOT_MEMBER, '无权修改该行程');

  const valid = ['pending', 'arrived', 'skipped', 'done'];
  assert(valid.includes(ctx.payload.status), CODES.INVALID_PARAM, `status 必须是 ${valid.join('/')}`);

  let found = false;
  const nodes = (trip.nodes || []).map((n) => {
    if (n.nodeId !== ctx.payload.nodeId) return n;
    found = true;
    const next = Object.assign({}, n, { status: ctx.payload.status });
    if (ctx.payload.status === 'arrived') next.actualArriveAt = now;
    if (ctx.payload.status === 'done') {
      next.actualLeaveAt = now;
      if (!next.actualArriveAt) next.actualArriveAt = now;
    }
    return next;
  });
  assert(found, CODES.NOT_FOUND, '节点不存在');

  const res = await repo.updateCas(C.TRIPS, trip._id, ctx.expectedVersion == null ? trip.version : ctx.expectedVersion, {
    nodes,
  });
  if (!res.updated) {
    throw fail(CODES.VERSION_CONFLICT, '行程已被更新，请刷新后重试', { currentVersion: trip.version });
  }

  return resp.ok({ tripId: trip._id, version: res.doc.version, nodes: res.doc.nodes }, { version: res.doc.version });
}

module.exports = { plan, get, adjust, confirmChange, progress, loadPlaces, loadTripForRead };

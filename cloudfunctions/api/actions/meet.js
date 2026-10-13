'use strict';

const resp = require('../lib/resp');
const { CODES, require_fields, assert, fail } = require('../lib/errors');
const { requireCrewMember, requireCrew } = require('../lib/authz');
const { resolveParams } = require('../lib/params');
const meetDomain = require('../domain/meet');
const { generateCandidates } = require('../domain/planner');
const constraintMod = require('../domain/constraint');
const { logEvent, logDecision } = require('../lib/trace');
const time = require('../lib/time');
const C = require('../lib/repo/collections');
const tripActions = require('./trip');

/** 可作为集合点的地点类别。 */
const MEET_CATEGORIES = ['meeting', 'entrance', 'exit', 'spot', 'rest'];

/** 读取队伍成员的最新有效位置，返回给推荐算法。 */
async function collectMemberLocations(repo, crewId, ctx) {
  const members = await repo.find(C.CREW_MEMBERS, { crewId, status: 'active' }, { limit: 50 });
  const out = [];
  for (const m of members) {
    if (m.locationSharing === false) {
      out.push({ userId: m.userId, point: null, reportedAt: null, source: null, sharingOff: true });
      continue;
    }
    const latest = await repo.findOne(
      C.LOCATIONS,
      { userId: m.userId, crewId },
      { sort: { reportedAt: -1 }, limit: 1 }
    );
    out.push({
      userId: m.userId,
      point: latest ? latest.point : null,
      reportedAt: latest ? latest.reportedAt : null,
      source: latest ? latest.source : null,
      locationId: latest ? latest._id : null,
    });
  }
  return out;
}

/**
 * 集合点推荐（§7.1）。
 *
 * 返回的 `excluded` 是**一等交付物**，不是调试信息：10/23 验收要求
 * "返回各成员步行时间与候选排除原因"。
 */
async function recommend(ctx) {
  const { repo, openid } = ctx;
  require_fields(ctx.payload, ['crewId']);
  const p = ctx.payload || {};
  const started = Date.now();
  const now = new Date(ctx.now ? ctx.now : Date.now());

  await requireCrewMember(repo, p.crewId, openid);

  /**
   * 这里**只按类目筛**，准入判定交给 `domain/meet.js`。
   *
   * 原因：如果在 action 层就把不合格的地点滤掉，用户只会看到"候选里没有它"，
   * 而**看不到为什么没有**。把它交给下层，排除原因才会出现在 `excluded` 里 ——
   * 这正面服务 10/31 验收「失败原因可定位」。
   */
  const places = (await repo.find(C.PLACES, {}, { limit: 200 })).filter((pl) =>
    MEET_CATEGORIES.includes(pl.category)
  );

  if (!places.length) {
    return resp.ok({
      candidates: [],
      excluded: [],
      reason: 'NO_VERIFIED_PLACE',
      message: '尚无可用的集合点地点数据，请先完成踏勘录入',
    });
  }

  const members = await collectMemberLocations(repo, p.crewId, ctx);
  const usable = members.filter((m) => !m.sharingOff);

  if (!usable.length) {
    return resp.ok({
      candidates: [],
      excluded: members.map((m) => ({
        userId: m.userId,
        reason: 'LOCATION_SHARING_OFF',
        message: '没有成员共享位置，无法推荐集合点，可改为手动选点',
      })),
      reason: 'NO_LOCATION_AVAILABLE',
      message: '没有可用的成员位置。可让成员手动在地图上选点，或直接手动指定集合地点。',
      manualFallback: true, // ← 与 location 权限解耦的降级路径
    });
  }

  const params = resolveParams(p.params);
  const result = meetDomain.recommendMeetPoints({
    members: usable,
    candidatePlaces: places,
    params,
    deadline: p.deadline ? new Date(p.deadline) : null,
    ctx,
  });

  await logDecision(repo, {
    ts: now,
    kind: 'meet_recommend',
    crewId: p.crewId,
    tripId: p.tripId || null,
    inputDigest: {
      memberCount: usable.length,
      locationSources: usable.map((m) => m.source),
      deadline: p.deadline || null,
    },
    candidates: result.candidates.map((c) => ({
      candidateId: c.placeId,
      feasible: true,
      impactSummary: { maxWalkMin: c.maxWalkMin, avgWalkMin: c.avgWalkMin, spreadMin: c.spreadMin },
    })),
    excludedReasons: result.excluded,
    algoVersion: params.algoVersion,
    params,
    durationMs: Date.now() - started,
    mapApiCalls: 0,
    result: result.candidates.length ? 'ok' : 'no_feasible',
  });

  return resp.ok({
    candidates: result.candidates,
    excluded: result.excluded,
    // 推荐规则写进响应，界面与答辩都可以直接引用，避免"算法是个黑箱"
    rule: 'minimax：先让最远的成员步行时间最短，再比较平均值与差距',
    staleThresholdSec: time.STALE_THRESHOLD_SEC,
  });
}

/** 创建集合任务。状态从 proposed 开始（§7.2）。 */
async function create(ctx) {
  const { repo, openid } = ctx;
  require_fields(ctx.payload, ['crewId', 'plannedMeetAt']);
  const p = ctx.payload;
  const now = new Date(ctx.now ? ctx.now : Date.now());

  await requireCrewMember(repo, p.crewId, openid);
  await requireCrew(repo, p.crewId);

  assert(
    p.placeId || (p.point && p.placeName),
    CODES.INVALID_PARAM,
    '需要 placeId，或 point 与 placeName 同时提供'
  );

  const method = p.method || (p.placeId ? 'manual' : 'manual');
  assert(
    ['recommended', 'member_location', 'manual'].includes(method),
    CODES.INVALID_PARAM,
    'method 必须是 recommended / member_location / manual'
  );

  const members = await repo.find(C.CREW_MEMBERS, { crewId: p.crewId, status: 'active' }, { limit: 50 });
  const participantIds = p.participantIds && p.participantIds.length
    ? p.participantIds
    : members.map((m) => m.userId);

  // 参与人必须是队伍成员，否则会出现越权写入
  const memberIds = new Set(members.map((m) => m.userId));
  const outsiders = participantIds.filter((id) => !memberIds.has(id));
  assert(outsiders.length === 0, CODES.INVALID_PARAM, '参与人必须是小队成员', { outsiders });

  const round = (await repo.count(C.MEET_TASKS, { crewId: p.crewId })) + 1;
  const participants = participantIds.map((userId) => ({
    userId,
    status: 'invited',
    confirmedVersion: null,
    confirmedAt: null,
    arrivedAt: null,
    declinedAt: null,
  }));

  // 发起人自己的确认自动生效（他刚刚点了"发起"），其余成员待确认
  const me = participants.find((x) => x.userId === openid);
  if (me) {
    me.status = 'confirmed';
    me.confirmedVersion = 1;
    me.confirmedAt = now;
  }

  // ⚠️ 必须是 `{}` 而不是 null。
  // 云数据库对对象字段是**合并语义**：向 null 合并会去创建子路径并报
  // -502001 "Cannot create field ... in element {...null}"（见 lib/idem.js 的踩坑记录）。
  // 读取方一律判内层字段（linkToTrip.affectsNodeId）而不是判对象本身。
  let linkToTrip = {};
  if (p.tripId) {
    const trip = await repo.get(C.TRIPS, p.tripId);
    if (trip) {
      const anchor = (trip.nodes || [])
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .find((n) => n.status !== 'done' && n.status !== 'skipped');
      linkToTrip = {
        affectsNodeId: anchor ? anchor.nodeId : null,
        plannedLeaveAt: anchor ? anchor.plannedArriveAt : null,
        delayMin: 0,
      };
    }
  }

  const task = await repo.insert(C.MEET_TASKS, {
    crewId: p.crewId,
    tripId: p.tripId || null,
    initiatorUserId: openid,
    round,
    status: 'proposed',
    version: 1,
    method,
    placeId: p.placeId || null,
    point: p.point || null,
    placeName: p.placeName || null,
    candidatePlaceIds: p.candidatePlaceIds || [],
    walkEstimates: p.walkEstimates || [],
    excludedCandidates: p.excludedCandidates || [],
    participants,
    // ① 计划集合时间
    plannedMeetAt: new Date(p.plannedMeetAt),
    // ② ③ 留空，等真实事件发生才写。绝不预填、绝不用 ① 推断
    allArrivedAt: null,
    departedAt: null,
    linkToTrip,
    createdAt: now,
    updatedAt: now,
  });

  await logEvent(repo, {
    ts: now,
    type: 'state_change',
    action: 'meet.create',
    userId: openid,
    crewId: p.crewId,
    tripId: p.tripId || null,
    meetTaskId: task._id,
    detail: {
      round,
      method,
      participantCount: participants.length,
      plannedMeetAt: time.toISO(task.plannedMeetAt),
    },
  });

  return resp.ok({
    meetTaskId: task._id,
    version: task.version,
    status: task.status,
    round,
    plannedMeetAt: time.toISO(task.plannedMeetAt),
    participants: task.participants,
  });
}

/** 成员确认或拒绝。必须带确认所依据的版本号。 */
async function confirm(ctx) {
  const { repo, openid } = ctx;
  require_fields(ctx.payload, ['meetTaskId', 'decision']);
  const p = ctx.payload;
  const now = new Date(ctx.now ? ctx.now : Date.now());

  const task = await repo.get(C.MEET_TASKS, p.meetTaskId);
  if (!task) throw fail(CODES.NOT_FOUND, '集合任务不存在');
  await requireCrewMember(repo, task.crewId, openid);

  assert(['confirm', 'decline'].includes(p.decision), CODES.INVALID_PARAM, 'decision 必须是 confirm 或 decline');
  // 强制携带版本号：否则客户端可省略该字段绕过"旧版本确认失效"的校验
  assert(
    ctx.expectedVersion != null,
    CODES.INVALID_PARAM,
    '确认必须携带确认时所依据的版本号 expectedVersion'
  );

  const me = (task.participants || []).find((x) => x.userId === openid);
  assert(me, CODES.FORBIDDEN_NOT_MEMBER, '你不在本次集合的参与名单中');

  const r = meetDomain.applyConfirm(task, openid, p.decision, now, ctx.expectedVersion);
  if (r.invalidated) {
    throw fail(CODES.VERSION_CONFLICT, r.reason, {
      expectedVersion: ctx.expectedVersion,
      currentVersion: task.version,
    });
  }

  await repo.update(C.MEET_TASKS, task._id, Object.assign({}, r.patch, { updatedAt: now }));

  const updated = await repo.get(C.MEET_TASKS, task._id);
  await logEvent(repo, {
    ts: now,
    type: 'state_change',
    action: 'meet.confirm',
    userId: openid,
    crewId: task.crewId,
    meetTaskId: task._id,
    detail: { decision: p.decision, version: task.version, status: updated.status },
  });

  return resp.ok({
    meetTaskId: task._id,
    version: updated.version,
    status: updated.status,
    myStatus: (updated.participants || []).find((x) => x.userId === openid).status,
    confirmedCount: meetDomain.effectiveConfirmed(updated).length,
    participantCount: meetDomain.activeParticipants(updated).length,
    allConfirmed: meetDomain.allConfirmed(updated),
  });
}

/**
 * 标记已到达。最后一人到达时写 **② allArrivedAt**。
 * 本接口**不修改行程**（§7.3 联动规则第一条：② 时只给预计，不改路线）。
 */
async function arrive(ctx) {
  const { repo, openid } = ctx;
  require_fields(ctx.payload, ['meetTaskId']);
  const now = new Date(ctx.now ? ctx.now : Date.now());

  const task = await repo.get(C.MEET_TASKS, ctx.payload.meetTaskId);
  if (!task) throw fail(CODES.NOT_FOUND, '集合任务不存在');
  await requireCrewMember(repo, task.crewId, openid);

  assert(
    ['confirmed', 'active', 'arrived_all'].includes(task.status),
    CODES.INVALID_PARAM,
    `当前状态（${task.status}）不能标记到达`
  );

  const r = meetDomain.applyArrive(task, openid, now);
  await repo.update(C.MEET_TASKS, task._id, Object.assign({}, r.patch, { updatedAt: now }));
  const updated = await repo.get(C.MEET_TASKS, task._id);

  await logEvent(repo, {
    ts: now,
    type: 'state_change',
    action: 'meet.arrive',
    userId: openid,
    crewId: task.crewId,
    meetTaskId: task._id,
    detail: { allArrived: r.allArrived, arrived: meetDomain.arrivedCount(updated) },
  });

  return resp.ok({
    meetTaskId: task._id,
    status: updated.status,
    arrivedCount: meetDomain.arrivedCount(updated),
    participantCount: meetDomain.activeParticipants(updated).length,
    // ② 实际全员到齐时间（只在全员到齐后非空）
    allArrivedAt: updated.allArrivedAt ? time.toISO(updated.allArrivedAt) : null,
    // 明确告知：到齐不等于出发，路线暂不改动
    tripUpdated: false,
    message: r.allArrived
      ? '全员已到齐。后续安排暂不调整，请确认后点击"前往下一站"。'
      : '已记录到达，等待其他成员。',
  });
}

/**
 * 发起人点击"前往下一站"，写 **③ departedAt**，此刻才评估并一次性提出调整候选。
 */
async function depart(ctx) {
  const { repo, openid } = ctx;
  require_fields(ctx.payload, ['meetTaskId']);
  const now = new Date(ctx.now ? ctx.now : Date.now());

  const task = await repo.get(C.MEET_TASKS, ctx.payload.meetTaskId);
  if (!task) throw fail(CODES.NOT_FOUND, '集合任务不存在');
  await requireCrewMember(repo, task.crewId, openid);

  // 幂等：重复点击不覆盖首次出发时间
  if (task.status === meetDomain.MEET_STATUS.DEPARTED) {
    return resp.ok({
      meetTaskId: task._id,
      status: task.status,
      departedAt: time.toISO(task.departedAt),
      alreadyDeparted: true,
      delayMin: Math.max(0, Math.round(time.diffMin(task.departedAt, task.plannedMeetAt))),
    });
  }

  const r = meetDomain.applyDepart(task, now, ctx.expectedVersion);
  if (r.error) throw fail(r.error.code, r.error.message, r.error.details);

  await repo.update(C.MEET_TASKS, task._id, Object.assign({}, r.patch, { updatedAt: now }));
  const updated = await repo.get(C.MEET_TASKS, task._id);

  const delayMin = Math.max(0, Math.round(time.diffMin(now, task.plannedMeetAt)));
  let tripImpact = null;
  let proposal = null;

  // ③ 之后才更新后续行程的可行性判断
  if (task.tripId) {
    const trip = await repo.get(C.TRIPS, task.tripId);
    if (trip) {
      const { map: placesById } = await tripActions.loadPlaces(
        repo,
        (trip.nodes || []).map((n) => n.placeId)
      );
      const params = resolveParams(trip.params);
      const impact = meetDomain.evaluateDepartImpact({
        task: updated,
        trip,
        placesById,
        params,
        constraints: constraintMod.normalize(trip.constraints || []),
        departedAt: now,
      });

      tripImpact = {
        affectsTrip: impact.affectsTrip,
        delayMin: impact.delayMin,
        shouldReevaluate: impact.shouldReevaluate,
        conflicts: impact.conflicts || [],
        remainingEndAt: impact.remainingTimeline ? time.toISO(impact.remainingTimeline.endAt) : null,
        remainingWalkMin: impact.remainingTimeline ? impact.remainingTimeline.totalWalkMin : null,
      };

      // §7.3 第三条：确实不可行时，在 ③ 一次性提出调整候选，而不是在 ② 反复提示
      if (impact.shouldReevaluate) {
        const baseNodes = (trip.nodes || [])
          .filter((n) => n.status !== 'done' && n.status !== 'skipped')
          .sort((a, b) => a.seq - b.seq);
        if (baseNodes.length) {
          const gen = generateCandidates({
            baseNodes,
            trigger: { type: 'manual_progress', payload: { shiftedByMin: delayMin } },
            constraints: constraintMod.normalize(trip.constraints || []),
            placesById,
            params,
            startAt: now,
          });
          const saved = await repo.insert(C.CHANGE_PROPOSALS, {
            tripId: trip._id,
            baseVersion: trip.version,
            status: 'proposed',
            trigger: { type: 'meet_delay', payload: { meetTaskId: task._id, delayMin } },
            candidates: gen.candidates,
            selectedCandidateId: null,
            confirmations: [],
            decidedAt: null,
            expiresAt: new Date(now.getTime() + 30 * time.MIN),
            createdByUserId: openid,
            createdAt: now,
          });
          proposal = {
            proposalId: saved._id,
            candidates: gen.candidates,
            feasibleCount: gen.feasibleCount,
            reason: `集合比计划晚了 ${delayMin} 分钟`,
          };
        }
      }

      // 记录集合对行程的延迟，供 11/3 核查
      await repo.update(C.MEET_TASKS, task._id, {
        linkToTrip: Object.assign({}, updated.linkToTrip, { delayMin }),
      });
    }
  }

  await logEvent(repo, {
    ts: now,
    type: 'state_change',
    action: 'meet.depart',
    userId: openid,
    crewId: task.crewId,
    tripId: task.tripId || null,
    meetTaskId: task._id,
    detail: { delayMin, shouldReevaluate: tripImpact ? tripImpact.shouldReevaluate : false },
  });

  return resp.ok({
    meetTaskId: task._id,
    status: updated.status,
    // ③ 实际开始前往下一站时间
    departedAt: time.toISO(updated.departedAt),
    delayMin,
    tripImpact,
    proposal,
    message: tripImpact && tripImpact.shouldReevaluate
      ? `集合延迟 ${delayMin} 分钟，已影响后续安排，请确认调整后再出发`
      : '已记录出发，后续安排仍然可行',
  });
}

/** 读取集合任务。分享卡片打开时调用：既校验权限，又读最新状态（§8.2）。 */
async function get(ctx) {
  const { repo, openid } = ctx;
  require_fields(ctx.payload, ['meetTaskId']);

  const task = await repo.get(C.MEET_TASKS, ctx.payload.meetTaskId);
  if (!task) throw fail(CODES.NOT_FOUND, '集合任务不存在');
  // 获得分享卡片不等于获得权限：这里必须再校验一次成员身份
  await requireCrewMember(repo, task.crewId, openid);

  const me = (task.participants || []).find((x) => x.userId === openid) || null;

  return resp.ok({
    meetTask: {
      meetTaskId: task._id,
      crewId: task.crewId,
      tripId: task.tripId || null,
      status: task.status,
      version: task.version,
      round: task.round,
      method: task.method,
      placeId: task.placeId,
      placeName: task.placeName,
      point: task.point,
      plannedMeetAt: time.toISO(task.plannedMeetAt),
      allArrivedAt: task.allArrivedAt ? time.toISO(task.allArrivedAt) : null,
      departedAt: task.departedAt ? time.toISO(task.departedAt) : null,
      participants: task.participants,
      walkEstimates: task.walkEstimates,
      excludedCandidates: task.excludedCandidates,
      initiatorUserId: task.initiatorUserId,
    },
    myParticipant: me,
    // 我的确认是否因版本变化而失效，必须直接告诉界面
    myConfirmationValid: me ? me.confirmedVersion === task.version : null,
    staleConfirmations: meetDomain.staleConfirmations(task),
    serverTime: new Date(ctx.now ? ctx.now : Date.now()).toISOString(),
    staleThresholdSec: time.STALE_THRESHOLD_SEC,
  });
}

module.exports = { recommend, create, confirm, arrive, depart, get, MEET_CATEGORIES };

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
  const { repo, placesById, placeIds, now, makeProvider } = ctx;
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

  const provider = makeProvider();

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

    /**
     * ── 记一条**训练样本**（2026-10-13 新增）──────────────────
     *
     * 这里同时拿得到「直线距离」与「实际步行距离」——
     * 而 `geo.js` 用一个**常数** `DETOUR_FACTOR = 1.3` 从前者推后者。
     * 实测它并不是常数：
     *
     *     直线 605 米 → 实际 815 米   倍率 1.35
     *     直线  10 米 → 实际  76 米   倍率 7.6
     *
     * 这条记录**现在就有用**（能算分段经验系数、能说清估算偏差），
     * 攒够之后就是回归模型的训练数据。
     *
     * ⚠️ 写失败不能影响规划 —— 它只是攒数据，不是功能的一部分。
     */
    try {
      const straight = geo.haversineMeters(leg.from.location, leg.to.location);
      await repo.insert(C.WALK_SAMPLES, {
        straightMeters: Math.round(straight),
        actualMeters: r.distanceMeters,
        actualMinutes: r.durationMinutes,
        /** 实际 ÷ 直线。**模型要预测的就是它** */
        detourRatio:
          straight > 0 && typeof r.distanceMeters === 'number'
            ? Number((r.distanceMeters / straight).toFixed(3))
            : null,
        fromName: leg.from.name,
        toName: leg.to.name,
        /** 同一段反复规划会产生多条 —— 保留，用来看稳定性 */
        sampledAt: now,
      });
      out.samplesRecorded = (out.samplesRecorded || 0) + 1;
    } catch (e) {
      // 攒数据失败不该让整次规划失败
      out.sampleWriteFailed = (out.sampleWriteFailed || 0) + 1;
    }

    /**
     * ⚠️ **只给库里的地点写缓存**（2026-10-13 加）。
     *
     * 检索来的地点不入库（用户决定：全从腾讯地图实时搜），
     * 往一个不存在的文档上写会**静默失败或报错** ——
     * 而它的 `_id` 是内存里合成的，库里根本没有这条记录。
     *
     * 代价：这些地点每次规划都要重新调一次地图接口。
     * 值得 —— 换来的是"检索不污染地点库"。
     */
    if (leg.from.__persisted === false) {
      out.skippedCache = (out.skippedCache || 0) + 1;
      out.fetched++;
      continue;
    }

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

/**
 * 内嵌地点的**稳定标识**。
 *
 * ⚠️ **必须稳定**：同一批地点两次规划要得到相同的 `_id`，
 * 否则 `nodes[].placeId` 每次都变，踏勘实测的步行时间（`walkableTo` 按
 * placeId 索引）就永远对不上。
 *
 * 优先级：
 *   ① 已入库地点用它的 `placeId`（踏勘过的）；
 *   ② 上游 POI 的 `poiId`（腾讯给的，稳定）；
 *   ③ 名字 + 坐标 —— 前两者都没有时的兜底，仍然稳定。
 */
function inlinePlaceId(item) {
  if (!item) return null;
  if (item.placeId) return item.placeId;
  if (item.poiId) return `poi_${item.poiId}`;
  const loc = item.location || {};
  if (typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') return null;
  if (!item.name) return null;
  return `x_${item.name}_${loc.latitude.toFixed(6)}_${loc.longitude.toFixed(6)}`;
}

/**
 * 决定游览顺序。
 *
 * 顺序**只由调用方给的次序决定** —— 内嵌 `places` 按数组顺序，
 * `placeIds` 按数组顺序，两者都有时先 `places` 后 `placeIds`。
 * 不按对象键顺序（那在 JS 里不保证，会让顺序随机漂移）。
 */
function resolveItemOrder(spec, placesById) {
  const out = [];
  const push = (id) => {
    if (id && placesById[id] && out.indexOf(id) < 0) out.push(id);
  };
  for (const item of Array.isArray(spec.places) ? spec.places : []) push(inlinePlaceId(item));
  for (const id of spec.placeIds || []) push(id);
  return out;
}

/**
 * 载入一组地点，返回 placeId -> place 映射；缺失的地点会让调用方明确报错。 */
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

/**
 * 从行程节点的**地点快照**重建 `placeId -> place` 映射。
 *
 * ⚠️ 为什么需要它（2026-10-13）：检索到的地点**不再入库**
 * （用户决定：全从腾讯地图实时搜），所以 `adjust` 事后按 `placeId`
 * 回库是读不到的。节点自带快照，行程就**自洽**了 ——
 * 与"行程自带约束快照"是同一个原则：**自洽的记录才可复现**。
 *
 * 老行程可能没有快照（字段是后加的）→ 由调用方明确报错，
 * **不要静默用一个空地点对象继续算**。
 */
function placesFromNodes(nodes) {
  const map = {};
  const missing = [];
  for (const n of nodes || []) {
    const snap = n.placeSnapshot;
    if (!snap || !snap._id) {
      missing.push(n.placeId || n.nodeId);
      continue;
    }
    map[snap._id] = Object.assign({}, snap, { walkableTo: snap.walkableTo || [] });
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
      places: (req.structured && req.structured.places) || [],
      placeIds: (req.structured && req.structured.placeIds) || [],
      startAt: (req.structured && req.structured.startAt) || now,
      constraints: req.constraints || [],
      crewId: req.crewId || null,
      scope: req.scope,
      requirementId: p.requirementId,
      rawText: req.rawText,
      paramsInput: req.structured && req.structured.params,
      startPoint: (req.structured && req.structured.startPoint) || p.startPoint || null,
      stayMin: (req.structured && req.structured.stayMin) != null ? req.structured.stayMin : p.stayMin,
      stayByText:
        (req.structured && req.structured.stayByText) || p.stayByText || null,
    };
  } else {
    /**
     * ⚠️ **不再强制要求 `placeIds`**（2026-10-13 改）。
     *
     * 用户决定：检索到的地点不入库，全从腾讯地图实时搜 ——
     * 那种情况下前端根本拿不到 `placeId`，只能传内嵌的 `places`。
     * 两者给其一即可，由下面的 `resolveItemOrder` 统一处理。
     */
    assert(
      (Array.isArray(p.places) && p.places.length > 0) ||
        (Array.isArray(p.placeIds) && p.placeIds.length > 0),
      CODES.INVALID_PARAM,
      '至少需要一个地点：传 places（检索结果，含 name 与 location）或 placeIds（已入库的踏勘地点）'
    );
    spec = {
      places: p.places || [],
      placeIds: p.placeIds || [],
      startAt: p.startAt,
      constraints: p.constraints || [],
      crewId: p.crewId || null,
      scope: p.crewId ? 'team' : 'personal',
      requirementId: null,
      rawText: p.rawText || null,
      paramsInput: p.params,
      /**
       * 出发位置（通常是用户当前位置）。给了它，**第一段交通就从这里算起** ——
       * 否则行程会假装"人已经在第一个景点门口"，总时间和总步行量都会偏小。
       * 前端默认传当前位置（用户要求：行程默认起始位置是自己的当前位置）。
       */
      startPoint: p.startPoint || null,
      /**
       * 每站停留分钟数（可选）。用户说「逛一小时」时由解析层给出 ——
       * 不给就用地点自带的 `visitDurationMin.default`。
       */
      stayMin: p.stayMin,
      /**
       * **按地点分别给的停留时长**：`{"哈工大": 60, "冰雪大世界": 120}`。
       *
       * ⚠️ 实测（2026-10-13）：用户说「先去哈工大玩一小时再去冰雪大世界玩两小时
       * 再去哈学院玩一小时」，而 schema 只有单个 `stayMinutes` ——
       * **模型听懂了却装不下**，只好反过来问用户"三个时长请确认统一哪个"。
       * 见 lib/ai/rulebased.js 里 `stayMinutesByText` 的说明。
       */
      stayByText: p.stayByText || null,
    };
  }

  const params = resolveParams(spec.paramsInput);

  /**
   * 地图服务的取得方式：**通过 ctx 注入的工厂**。
   *
   * 生产代码里不留测试钩子（此前为了能注入"上游故障"，加过一个
   * `MAP_FAKE_FAIL` 环境变量 —— 那等于给产品代码开后门）。
   * 注入工厂可以表达任意状态：正常、故障、特定 Key、特定超时。
   */
  const makeProvider = (name, opts) =>
    (ctx.createMapProvider || createMapProvider)(name || process.env.MAP_PROVIDER, opts);

  if (spec.crewId) await requireCrewMember(repo, spec.crewId, openid);

  /**
   * ── 地点的两个来源（2026-10-13 改）────────────────────────
   *
   * ⚠️ 用户决定：**检索到的地点不再入库**，全从腾讯地图实时搜。
   * 所以 `trip.plan` 必须能接受**内嵌的地点数据**，而不只是 `placeIds`。
   *
   *   ① `places: [{name, location, category?, ...}]` —— 检索回来的候选（不入库）
   *   ② `placeIds: [...]`                        —— 库里**踏勘核验过**的地点
   *
   * 两者可同时给。①的 `_id` 由 `inlinePlaceId()` 稳定合成 ——
   * **必须稳定**，否则同一批地点两次规划会得到不同的节点标识，
   * `walkableTo`（踏勘实测的步行时间）也就对不上了。
   */
  const placesById = {};
  const missing = [];

  for (const item of Array.isArray(spec.places) ? spec.places : []) {
    const id = inlinePlaceId(item);
    if (!id) {
      missing.push(item && item.name ? item.name : '(未命名)');
      continue;
    }
    placesById[id] = {
      _id: id,
      name: item.name,
      category: item.category || '未分类',
      location: item.location || null,
      entranceLocation: item.entranceLocation || null,
      visitDurationMin: item.visitDurationMin || null,
      /** 检索来的地点一律**未核验** —— 只有踏勘过的才算 */
      verifiedAt: null,
      confidence: 'low',
      walkableTo: [],
      dataSource: 'tencent-poi',
      /** 不在库里 —— 步行时间缓存不能往它身上写（见 fillMissingWalkTimes） */
      __persisted: false,
    };
  }

  if (spec.placeIds.length) {
    const loaded = await loadPlaces(repo, spec.placeIds);
    for (const [id, p] of Object.entries(loaded.map)) {
      // 库里的（踏勘过的）覆盖内嵌的同名项 —— 它才有核验信息
      placesById[id] = Object.assign({}, p, { __persisted: true });
    }
    missing.push(...loaded.missing);
  }

  assert(missing.length === 0, CODES.NOT_FOUND, `地点不存在或数据不完整：${missing.join(', ')}`);
  /** 顺序由 itemIds 决定，而不是对象键的顺序 */
  const itemIds = resolveItemOrder(spec, placesById);
  assert(itemIds.length > 0, CODES.INVALID_PARAM, '至少需要一个地点');

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
      inputDigest: { itemIds: itemIds, startAt: time.toISO(spec.startAt) },
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
    placeIds: itemIds,
    now,
    makeProvider,
  });

  /**
   * ★ 起点段：从出发位置（默认"我的位置"）到第一站的交通。
   *
   * 不这样做的话，行程会假装人已经在第一个景点门口 ——
   * 计划出发时间、总步行量与"能不能赶上结束时间"都会偏乐观。
   *
   * 起点是**移动的**，所以不进 `walkableTo` 缓存（缓存是地点↔地点的，
   * 存一个每次都不同的位置没有意义），每次都实时取或估算。
   */
  const startPoint =
    spec.startPoint && typeof spec.startPoint.latitude === 'number' && typeof spec.startPoint.longitude === 'number'
      ? {
          latitude: spec.startPoint.latitude,
          longitude: spec.startPoint.longitude,
          label: spec.startPoint.label || '我的位置',
        }
      : null;

  let startLeg = null;
  if (startPoint) {
    const firstPlace = placesById[itemIds[0]];
    if (firstPlace && firstPlace.location) {
      const provider = makeProvider();
      let r;
      try {
        r = await provider.walkingRoute(startPoint, firstPlace.location);
      } catch (e) {
        r = { ok: false, reason: 'THREW', message: (e && e.message) || String(e) };
      }
      walkFill.mapApiCalls++;

      if (r.ok) {
        startLeg = {
          minutes: r.durationMinutes,
          meters: r.distanceMeters,
          source: geo.WALK_SOURCE.UPSTREAM,
          from: startPoint,
          toPlaceId: firstPlace._id,
          toPlaceName: firstPlace.name,
        };
      } else {
        // 取不到就估算 —— 但**必须记进失败清单**，让界面能说明这段不可靠
        startLeg = Object.assign(
          geo.walkMinutesFromPoint(startPoint, firstPlace, params) || {},
          {
            from: startPoint,
            toPlaceId: firstPlace._id,
            toPlaceName: firstPlace.name,
            fallbackReason: r.reason || 'UPSTREAM_FAILED',
          }
        );
        walkFill.failed++;
        walkFill.failures.push({
          from: startPoint.label,
          to: firstPlace.name,
          reason: r.reason || 'UPSTREAM_FAILED',
          message: r.message || null,
        });
      }
    }
  }

  /**
   * 每站停留：优先级 **按地点的时长 > 统一时长 > 地点自带默认值**。
   *
   * 「我想去冰雪大世界，逛一小时」→ 每站 60 分钟；
   * 「哈工大 1 小时、冰雪大世界 2 小时」→ 各按各的。
   *
   * ⚠️ 不给时传 `undefined`，`buildTimeline` 会回落到 `visitDurationMin.default`
   * —— 注意不能用 `null`，那会被当成"停留 0 分钟"。
   */
  const items = itemIds.map((placeId, i) => {
    const place = placesById[placeId];
    const byName = matchStayByText(spec.stayByText, place && place.name);
    const stayMin =
      byName != null
        ? byName
        : typeof spec.stayMin === 'number' && spec.stayMin > 0
          ? spec.stayMin
          : undefined;
    return { nodeId: `n_${i}_${placeId}`, placeId: placeId, stayMin: stayMin };
  });
  const tl = timelineMod.buildTimeline({
    startAt: spec.startAt,
    items,
    placesById,
    params,
    startLeg,
  });
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
    /**
     * ⚠️ **训练样本的记账**（2026-10-13 加）。
     *
     * 这个对象是**显式挑字段拼出来的** —— 新字段不写在这里就会被**静默丢掉**。
     * 加这两个字段时正是踩了这个坑：地图调用发生了、样本没记上，
     * 而响应里什么都看不出来。（工作日志里那条
     * 「数据在某一层被截断，且不报错」，今天第二次。）
     *
     * 为什么必须暴露：样本管道最大的风险不是算法，是**静默地什么都没记** ——
     * 规划照常成功，样本表却是空的，等到要训练时才发现白攒了一个月。
     */
    samplesRecorded: walkFill.samplesRecorded || 0,
    sampleWriteFailed: walkFill.sampleWriteFailed || 0,
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
    /**
     * ⚠️ 出发位置必须**随行程持久化**（2026-10-13 补）。
     *
     * 首版只把它放进响应，没落库 —— 于是事后取导航时，
     * **第一段的起点无处可查**。出发位置是这次计划的一部分，
     * 不是一次性的响应字段。
     *
     * 放在**顶层**而不是 `params` 里：`params` 是算法参数白名单
     * （`resolveParams` 会拒绝不认识的键），而这是行程数据。
     */
    startPoint: startPoint || null,
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
    /** 出发位置（默认"我的位置"）与第一段交通 */
    startPoint,
    startLeg,
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

  /**
   * ⚠️ **从行程节点的地点快照重建，不回库读**（2026-10-13 改）。
   *
   * 检索到的地点**不再入库**（用户决定：全从腾讯地图实时搜），
   * 所以按 `placeId` 回库是读不到的。快照让行程自洽 ——
   * 与"行程自带约束快照"是同一个原则。
   */
  const { map: placesById } = placesFromNodes(baseNodes);

  /**
   * 换地点/加地点时的"新地点"仍要回库读 —— 那通常是**踏勘核验过的**地点
   * （`placeId` 有值），而库里只放踏勘数据。
   */
  if (extraIds.length) {
    const extra = await loadPlaces(repo, extraIds);
    assert(extra.missing.length === 0, CODES.NOT_FOUND, `地点不存在：${extra.missing.join(', ')}`);
    Object.assign(placesById, extra.map);
  }

  assert(
    baseNodes.every((n) => placesById[n.placeId]),
    CODES.INVALID_PARAM,
    '行程节点缺少地点快照，无法调整 —— 请重新生成行程'
  );

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

  /**
   * 这次候选**牺牲了别的安排**吗？
   *
   * 判据用 `impact` 里已有的数据，不另立标准：
   *   · 删掉了某个节点，或把某个节点的停留压到下限以下 → **有取舍**，必须让用户选；
   *   · 只是把后续整体往后推（没有任何东西被牺牲） → **没有取舍**，
   *     此时"确认"只是让用户多点一次，不产生任何信息。
   */
  const tradeoffOf = (c) => {
    const im = c.impact || {};
    const removed = (im.removedNodeIds || []).length;
    const shortened = (im.shortenedNodeIds || []).length;
    return { removed, shortened, has: removed > 0 || shortened > 0 };
  };
  result.candidates.forEach((c) => {
    c.tradeoff = tradeoffOf(c);
    c.requiresConfirmation = c.tradeoff.has;
  });

  /**
   * 无取舍时自动生效（2026-10-13 用户决定）。
   *
   * 为什么可以这样做：
   *   · **没有任何安排被牺牲** —— 不存在需要用户权衡的东西，
   *     这时候弹确认只是增加一次点击，不增加任何决策信息；
   *   · **团队模式一律确认** —— §8.1 的成员确认是本项目核心卖点，
   *     不能被"省事"简化掉。个人模式没有第二个人要确认，所以可以省。
   *
   * 生效走的仍然是 `confirmChange` —— **同一套版本校验、同一份快照**，
   * 不复制一份"绕过确认"的旁路（那种旁路迟早与主路径行为不一致）。
   */
  const wantAuto = p.autoApply !== 'never';
  const feasible = result.candidates.filter((c) => c.feasible);
  const autoTarget =
    wantAuto && trip.mode !== 'team' && feasible.length === 1 && !feasible[0].tradeoff.has
      ? feasible[0]
      : null;

  await logEvent(repo, {
    ts: now,
    type: 'state_change',
    action: 'trip.adjust',
    userId: openid,
    tripId: trip._id,
    algoVersion: result.algoVersion,
    durationMs: Date.now() - started,
    detail: {
      proposalId: proposal._id,
      candidateCount: result.candidates.length,
      autoApplied: Boolean(autoTarget),
      tradeoffCount: result.candidates.filter((c) => c.tradeoff.has).length,
    },
  });

  if (autoTarget) {
    // 走正式确认路径，不另开旁路
    const confirmed = await confirmChange(
      Object.assign({}, ctx, {
        payload: { proposalId: proposal._id, candidateId: autoTarget.candidateId },
        expectedVersion: trip.version,
      })
    );
    await repo.update(C.CHANGE_PROPOSALS, proposal._id, {
      autoApplied: true,
      autoReason: 'no_tradeoff',
    });
    return resp.ok(
      Object.assign({}, confirmed.data, {
        applied: true,
        appliedReason: 'no_tradeoff',
        proposalId: proposal._id,
        candidates: result.candidates,
        feasibleCount: result.feasibleCount,
        excludedReasons: result.excludedReasons,
        noFeasible: false,
        autoApplied: { candidateId: autoTarget.candidateId, strategy: autoTarget.strategy },
        note:
          '本次调整没有牺牲任何已有安排，已直接生效。' +
          '若出现取舍（需要压缩或删除某个节点），系统仍会先给出候选让你选择。',
      }),
      { version: trip.version }
    );
  }

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
      applied: false,
      /** 哪种情况需要用户确认 —— 界面据此决定是弹卡片还是直接提示已生效 */
      confirmationRule:
        trip.mode === 'team'
          ? '团队行程一律需要成员确认（§8.1）'
          : '仅当调整牺牲了已有安排（压缩或删除节点）时才需要确认',
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

  /**
   * ⚠️ **必须显式给版本号，不提供"没给就用当前版本"的兜底。**
   *
   * 那个兜底正是让版本校验静默失效的原因：前端把 expectedVersion 传进了 payload，
   * 信封层读不到 → undefined → 回落成"当前版本" → 校验恒等于通过。
   * 而「旧版本确认不得使新方案生效」是 11/5 的验收项。
   *
   * 注意：这里校验的是**确认时的版本**，与上面 `proposal.baseVersion !== trip.version`
   * 是两道不同的闸 —— 前者防"提案过期"，后者防"并发写入"。
   */
  assert(
    ctx.expectedVersion != null,
    CODES.INVALID_PARAM,
    '缺少 expectedVersion：确认变更必须基于明确的版本号（它属于请求信封，不在 payload 里）'
  );
  const expectedVersion = ctx.expectedVersion;

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

  /**
   * ⚠️ **必须显式给版本号，不提供"没给就用当前版本"的兜底。**
   *
   * 2026-10-13 发现的真实缺陷：前端把 `expectedVersion` 传进了 payload，
   * 而信封层与 api.js 都只看第三个参数 → `ctx.expectedVersion` 永远是 undefined
   * → 回落成"当前版本" → **版本校验恒等于通过**。
   * 「旧版本确认不得使新方案生效」这条 11/5 验收项在实际使用中根本没生效。
   *
   * 所以这里改成必填（与 meet.confirm 的写法对齐）：
   * 漏传会被明确拒绝，而不是静默放行。
   */
  assert(
    ctx.expectedVersion != null,
    CODES.INVALID_PARAM,
    '缺少 expectedVersion：进度更新必须基于明确的版本号，否则无法防止"用旧状态覆盖新状态"。' +
      '注意它属于请求信封，不在 payload 里（见 docs/02 §1）。'
  );

  const res = await repo.updateCas(C.TRIPS, trip._id, ctx.expectedVersion, {
    nodes,
  });
  if (!res.updated) {
    throw fail(CODES.VERSION_CONFLICT, '行程已被更新，请刷新后重试', { currentVersion: trip.version });
  }

  return resp.ok({ tripId: trip._id, version: res.doc.version, nodes: res.doc.nodes }, { version: res.doc.version });
}

/**
 * 在"按地点给的时长"里找这个地点对应的值。
 *
 * 匹配用**双向包含**（与必去项同一套宽松度）：
 * 用户说「冰雪大世界」，POI 叫「哈尔滨冰雪大世界」—— 应当算命中。
 * 反过来 POI 名更短时（用户说全称）也要能匹配上。
 *
 * ⚠️ 匹配不上就返回 null，**绝不用别的地点的时长顶替** ——
 * 那会让"哈工大 1 小时"变成"冰雪大世界也 1 小时"。
 */
function matchStayByText(map, name) {
  if (!map || !name) return null;
  for (const k of Object.keys(map)) {
    if (!k) continue;
    if (name.indexOf(k) >= 0 || k.indexOf(name) >= 0) {
      const v = map[k];
      if (typeof v === 'number' && v > 0) return v;
    }
  }
  return null;
}

/**
 * 取某一段的**真实步行路线与转向指引** —— 内置导航的数据来源。
 *
 * ── 为什么单独一个接口，而不是让 trip.plan 一并返回 ──────────
 *
 * 一条路线的折线有几十到几百个点，一次计划里有好几段 ——
 * 全塞进 `trip.plan` 的响应里，只会让"生成路线"这个动作变慢、变重。
 * 而导航是**用户主动点**才需要的，一次只要一段。
 *
 * ── 起点怎么取（优先级从高到低）────────────────────────────
 *
 *   ① `fromPoint`：**客户端当前位置** —— 导航本来就该从"你在哪"算起；
 *   ② 上一站的位置；
 *   ③ `trip.params.startPoint`：计划时的出发位置（旧行程可能没有）。
 *
 * 三者都没有就如实失败，**不编一个起点**。
 *
 * ⚠️ 每次调用**真实消耗 1 次地图配额**（`walkTimes` 会如实计数）。
 */
async function legRoute(ctx) {
  const { repo, openid, env } = ctx;
  require_fields(ctx.payload, ['tripId']);
  const p = ctx.payload;
  const started = Date.now();

  const trip = await repo.get(C.TRIPS, p.tripId);
  if (!trip) throw fail(CODES.NOT_FOUND, '行程不存在');
  if (trip.mode === 'team') await requireCrewMember(repo, trip.crewId, openid);
  else assert(trip.ownerUserId === openid, CODES.FORBIDDEN_NOT_MEMBER, '无权读取该行程');

  const nodes = trip.nodes || [];
  const isReached = (s) => s === 'arrived' || s === 'done';

  /** 目标节点：显式给 nodeId 用它；否则用"当前站"（第一个没走完的） */
  let idx = -1;
  if (p.nodeId) {
    idx = nodes.findIndex((n) => n.nodeId === p.nodeId);
    assert(idx >= 0, CODES.NOT_FOUND, '节点不存在');
  } else {
    idx = nodes.findIndex((n) => !isReached(n.status));
    assert(idx >= 0, CODES.NOT_FOUND, '行程已全部走完，没有需要导航的下一站');
  }

  const to = nodes[idx];
  assert(to && to.location, CODES.INVALID_PARAM, '该节点没有坐标，无法导航');

  const startFromTrip = trip.startPoint;
  const from =
    (p.fromPoint && typeof p.fromPoint.latitude === 'number' && p.fromPoint) ||
    (idx > 0 && nodes[idx - 1] && nodes[idx - 1].location) ||
    (startFromTrip && typeof startFromTrip.latitude === 'number' && startFromTrip) ||
    null;

  if (!from) {
    return resp.ok({
      ok: false,
      reason: 'NO_START_POINT',
      message: '不知道从哪里出发，无法规划这一段路线',
      hint:
        '客户端传 fromPoint（当前位置）最准；或在生成路线时传 startPoint，' +
        '那样出发位置会随行程一起保存。',
      legs: [],
    });
  }

  // 起终点重合时上游会直接拒绝（status 374，已实测）—— 先自行判掉
  if (from.latitude === to.location.latitude && from.longitude === to.location.longitude) {
    return resp.ok({
      ok: false,
      reason: 'SAME_POINT',
      message: '你已经在这一站了，不需要导航',
      legs: [],
    });
  }

  const provider = (ctx.createMapProvider || createMapProvider)(
    p.provider || process.env.MAP_PROVIDER,
    { key: env === 'dev' ? p.overrideKey : undefined, timeoutMs: p.timeoutMs }
  );

  let r;
  try {
    r = await provider.walkingRoute(from, to.location);
  } catch (e) {
    r = { ok: false, reason: 'THREW', message: (e && e.message) || String(e) };
  }

  await logEvent(repo, {
    ts: new Date(ctx.now ? ctx.now : Date.now()),
    type: 'upstream_call',
    action: 'trip.legRoute',
    userId: openid,
    result: r.ok ? 'ok' : 'error',
    errCode: r.ok ? null : r.reason || 'UPSTREAM_FAILED',
    durationMs: Date.now() - started,
    mapApiCalls: 1,
    detail: { tripId: trip._id, nodeId: to.nodeId, provider: provider.name },
  });

  if (!r.ok) {
    return resp.ok({
      ok: false,
      reason: r.reason,
      status: r.status || null,
      message: r.message,
      hint: r.hint || null,
      legs: [],
      mapApiCalls: 1,
    });
  }

  return resp.ok({
    ok: true,
    tripId: trip._id,
    nodeId: to.nodeId,
    placeName: to.placeName,
    /** 上一次的段序号（第几段）与总段数，界面用来显示"第 k / n 段" */
    legIndex: idx + 1,
    totalLegs: nodes.length,
    from: { latitude: from.latitude, longitude: from.longitude, label: from.label || null },
    to: { latitude: to.location.latitude, longitude: to.location.longitude, name: to.placeName },
    distanceMeters: r.distanceMeters,
    durationMinutes: r.durationMinutes,
    /**
     * 解码后的真实路径与分步指引。
     * `decoded: false` 表示上游没给或解不开 —— 界面要能分清，
     * 而不是画一条直线冒充真实路线。
     */
    route: r.route,
    mapApiCalls: 1,
    note: '每次导航消耗 1 次地图配额；路径与指令均来自上游，未做改写',
  });
}

module.exports = { plan, get, adjust, confirmChange, progress, legRoute, loadPlaces, loadTripForRead };

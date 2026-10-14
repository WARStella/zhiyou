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
const { createMapProvider } = require('../lib/map');
const geo = require('../lib/geo');

/**
 * 候选集合点的检索词（2026-10-14）。
 *
 * ── 为什么是这几个词，而不是让用户输 ──────────────────────
 *
 * 用户要的是"**默认**按小队成员能同时步行到达的地方算" ——
 * 既然叫默认，就不该要求他先想一个关键词。
 *
 * 这几个词覆盖的是"**在城市里找人不难找的地方**"：
 *   · 地铁站   —— 有明确出入口、地标性强，城市里最常见的碰头点
 *   · 商场     —— 有室内空间，下雨天与冬天能等
 *   · 公园     —— 景区游览场景下常见的入口集合处
 *   · 广场     —— 开阔、好认
 *
 * ⚠️ **不包含任何"路"或"街"**。用户明确要求"不要标在马路上" ——
 *    检索词本身就避开道路，比事后过滤更可靠。
 *
 * ⚠️ 按顺序取，**找到一个够用的就停**：每次检索消耗 1 次地图配额，
 *    而地点检索是**日配额**（见 docs/06 成本记录）。
 */
const MEET_POI_KEYWORDS = ['地铁站', '商场', '公园', '广场'];

/** 单次检索取回的 POI 数上限（上游 `page_size` 上限是 20） */
const MEET_POI_PAGE_SIZE = 20;

/**
 * 用 POI 检索找出候选集合点（2026-10-14 新增）。
 *
 * ── "不标在马路上"是怎么保证的 ────────────────────────────
 *
 * **不是靠过滤，而是靠来源**：算出来的任何坐标都可能在马路中间、
 * 江面或楼顶，而 POI 检索返回的**必然是真实存在的地点**。
 * 所以这条路从根上就不可能把集合点标在车道上。
 *
 * ── 检索中心为什么是成员的**几何中心** ────────────────────
 *
 * 推荐目标是 minimax（先让最远的成员步行最短）。而"到各点最大距离
 * 最小"的那个位置，正是这一组点的**几何中心** —— 用它当检索中心，
 * 与算法目标一致；换成"某一个成员的位置"会让其他人系统性偏远。
 *
 * ── 半径为什么用 `MAX_WALK_METERS` ───────────────────────
 *
 * 用户要"成员**能同时步行到达**"。半径超过步行可达范围时，
 * 检索回来的点在准入阶段就会被 `TOO_FAR` 排除 ——
 * 白花一次配额，还不如直接按可达范围问。
 *
 * ⚠️ 用**几何中心 + 直线距离**近似，不是真走行距离：
 *    下游 `recommendMeetPoints` 会用 `DETOUR_FACTOR` 折算并给出
 *    每个成员的步行分钟数，那才是给用户看的数。
 */
async function searchMeetingPoiCandidates(ctx, members, payload) {
  const withPoint = members.filter((m) => m.point && typeof m.point.latitude === 'number');
  if (!withPoint.length) {
    return {
      ok: false,
      places: [],
      reason: 'NO_LOCATION_AVAILABLE',
      message: '成员位置缺少坐标，无法检索集合点',
    };
  }

  const center = {
    latitude: withPoint.reduce((s, m) => s + m.point.latitude, 0) / withPoint.length,
    longitude: withPoint.reduce((s, m) => s + m.point.longitude, 0) / withPoint.length,
  };

  const provider = (ctx.createMapProvider || createMapProvider)(
    payload.mapProvider || process.env.MAP_PROVIDER,
    { timeoutMs: process.env.MAP_TIMEOUT_MS ? Number(process.env.MAP_TIMEOUT_MS) : undefined }
  );

  const collected = [];
  const tried = [];
  let lastFailure = null;

  for (const keyword of MEET_POI_KEYWORDS) {
    let res;
    try {
      res = await provider.searchPlaces({
        keyword,
        center,
        radius: geo.MAX_WALK_METERS,
        pageSize: MEET_POI_PAGE_SIZE,
        pageIndex: 1,
      });
    } catch (e) {
      lastFailure = { reason: 'UPSTREAM_FAILED', message: (e && e.message) || String(e) };
      continue;
    }
    tried.push(keyword);

    if (!res || !res.ok) {
      /**
       * ⚠️ Key 没配是**配置问题**，不是"附近没地方" ——
       * 必须分开报，否则用户会一直换关键词找一个根本连不通的服务。
       */
      lastFailure = {
        reason: (res && res.reason) || 'UPSTREAM_FAILED',
        message: (res && res.message) || '地点检索失败',
        hint: (res && res.hint) || null,
      };
      continue;
    }

    for (const it of res.items || []) {
      if (!it || !it.title || !it.location) continue;
      /**
       * 落成 `domain/meet.js` 认的形状。
       *
       * ⚠️ `_id` 用 `poi_` 前缀：这些点**不入库**（检索结果一律不入库，
       *    2026-10-13 用户决定），前缀让人一眼看出它不是 `places` 里的记录。
       *    回给界面时再换成 `placeId`（见下面 `resp.ok`）。
       */
      collected.push({
        _id: 'poi_' + (it.poiId || collected.length),
        name: it.title,
        location: it.location,
        /**
         * 类目用 `meeting` —— 检索词已经保证它是"可以用来碰头的地方"，
         * 而上游类目名（如"购物中心"）与我们的枚举对不上，
         * 硬映射只会引入一个容易错的表。
         */
        category: 'meeting',
        /** POI 是真实地点，但**没有实地核验过** —— 等级如实标为 none */
        address: it.address || null,
        poiSource: 'tencent-search',
        confidence: 'normal',
      });
    }

    /** 第一批就够用就不再花第二次配额 */
    if (collected.length >= 5) break;
  }

  if (!collected.length) {
    return {
      ok: false,
      places: [],
      reason: (lastFailure && lastFailure.reason) || 'NO_POI_FOUND',
      message:
        (lastFailure && lastFailure.message) ||
        '附近没有检索到可用作集合点的地点（试过：' + tried.join('、') + '）',
      hint: (lastFailure && lastFailure.hint) || null,
      center,
      tried,
    };
  }

  return {
    ok: true,
    places: collected,
    note: '候选来自地图 POI 检索（关键词：' + tried.join('、') + '），中心在成员位置的几何中心',
    center,
    tried,
    count: collected.length,
  };
}

// revision serializes state writes; version remains the proposal users confirmed.
async function mutateTask(ctx, id, compute) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const task = await ctx.repo.get(C.MEET_TASKS, id);
    if (!task) throw fail(CODES.NOT_FOUND, '集合任务不存在');
    await requireCrewMember(ctx.repo, task.crewId, ctx.openid);
    const result = compute(task);
    if (!result.patch) return { task, updated: task, result };
    const revision = task.revision == null ? { __op: 'exists', value: false } : task.revision;
    const patch = Object.assign({}, result.patch, { revision: (task.revision || 0) + 1 });
    const saved = await ctx.repo.updateIf(C.MEET_TASKS, id, { revision, version: task.version, status: task.status }, patch);
    if (saved.updated) return { task, updated: Object.assign({}, task, patch), result };
  }
  throw fail(CODES.VERSION_CONFLICT, '集合状态正在更新，请刷新后重试');
}

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

  /**
   * ══════════ 候选：库里没有就**实时检索 POI**（2026-10-14）══════════
   *
   * 用户要求："这个推荐一个集合点默认按小队成员能同时步行到达的地方算吧，
   *            **注意不要标在马路上**"
   *
   * ── 为什么必须走检索，而不是自己算一个坐标 ────────────────
   *
   * "不标在马路上"这条是硬约束：**算出来的任何坐标都可能在马路中间**，
   * 甚至在江面或楼顶。只有 POI 检索返回的是**真实存在的地点**
   * （地铁口、商场、公园门口），它天然满足这条。
   *
   * ── 为什么之前推荐不出来 ──────────────────────────────────
   *
   * 旧实现只从 `places` 集合取候选，而那个集合**只有 `place.survey`
   * （限 dev 的踏勘工具）会写入** —— 线上基本是空的，
   * 于是永远报 `NO_VERIFIED_PLACE`。**功能从上线起就不可能跑通。**
   * 检索结果本身**一律不入库**（2026-10-13 用户决定），所以这里
   * 直接用一次、不落库。
   */
  let source = 'library';
  let candidatePlaces = places;
  let poiNote = null;

  if (!candidatePlaces.length) {
    const found = await searchMeetingPoiCandidates(ctx, usable, p);
    candidatePlaces = found.places;
    poiNote = found.note;
    source = found.ok ? 'poi-search' : 'none';
    if (!found.ok) {
      return resp.ok({
        candidates: [],
        excluded: found.excluded || [],
        reason: found.reason,
        message: found.message,
        manualFallback: true,
      });
    }
  }

  const params = resolveParams(p.params);
  const result = meetDomain.recommendMeetPoints({
    members: usable,
    candidatePlaces: candidatePlaces,
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
    /**
     * ⚠️ 候选的 id 字段改名为 `placeId` 再回给界面。
     *
     * 检索出来的候选**不在 `places` 里**（检索结果一律不入库），
     * 它的 `_id` 是 `poi_…`。界面全程用 `placeId`，这里对齐一下，
     * 免得前端要同时认两种字段名。
     */
    candidates: result.candidates.map((c) =>
      Object.assign({}, c, { placeId: c.placeId || c._id })
    ),
    excluded: result.excluded,
    // 推荐规则写进响应，界面与答辩都可以直接引用，避免"算法是个黑箱"
    rule: 'minimax：先让最远的成员步行时间最短，再比较平均值与差距',
    /**
     * 候选是哪来的 —— 界面要能说清"为什么推荐的是这几个地方"。
     *
     *   `library`    人工录入的地点库（有踏勘数据时优先用它）
     *   `poi-search` 地图 POI 实时检索（**不入库**，用完即弃）
     */
    candidateSource: source,
    candidateNote: poiNote,
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
    assert(trip && trip.mode === 'team' && trip.crewId === p.crewId, CODES.INVALID_PARAM, '集合只能关联本小队的共同路线');
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
    revision: 0,
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

  assert(['confirm', 'decline'].includes(p.decision), CODES.INVALID_PARAM, 'decision 必须是 confirm 或 decline');
  assert(ctx.expectedVersion != null, CODES.INVALID_PARAM, '确认必须携带 expectedVersion');
  const { task, updated } = await mutateTask(ctx, p.meetTaskId, (current) => {
    assert(['proposed', 'confirmed'].includes(current.status), CODES.INVALID_PARAM, '集合已开始或结束，不能重新确认');
    assert(current.participants.some(x => x.userId === openid), CODES.FORBIDDEN_NOT_MEMBER, '你不在本次集合的参与名单中');
    const r = meetDomain.applyConfirm(current, openid, p.decision, now, ctx.expectedVersion);
    if (r.invalidated) throw fail(CODES.VERSION_CONFLICT, r.reason);
    return r;
  });

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

  const { task, updated, result: r } = await mutateTask(ctx, ctx.payload.meetTaskId, (current) => {
    assert(['confirmed', 'active', 'arrived_all'].includes(current.status), CODES.INVALID_PARAM, '当前状态不能标记到达');
    const me = current.participants.find(x => x.userId === openid);
    assert(me && ['confirmed', 'arrived'].includes(me.status) && me.confirmedVersion === current.version,
      CODES.FORBIDDEN_NOT_MEMBER, '需要是本次集合已确认的参与成员');
    if (me.status === 'arrived') return { patch: null, allArrived: current.status === 'arrived_all' };
    return meetDomain.applyArrive(current, openid, now);
  });

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

module.exports = { recommend, create, confirm, arrive, depart: require('./departure').depart, get, MEET_CATEGORIES };

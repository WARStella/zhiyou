'use strict';

const resp = require('../lib/resp');
const { CODES, require_fields, assert, fail } = require('../lib/errors');
const { requireCrewMember, requireCrew } = require('../lib/authz');
const { resolveParams } = require('../lib/params');
const meetDomain = require('../domain/meet');
const { logEvent, logDecision } = require('../lib/trace');
const time = require('../lib/time');
const C = require('../lib/repo/collections');
const geo = require('../lib/geo');
const { hasLocationConsent } = require('../lib/location-consent');
const { searchMeetingPlaces } = require('../lib/meet-search');
const { onMeetCreated, onMeetStatusChanged } = require('../lib/subscribe/notify-triggers');
const { reconcileMeeting } = require('../lib/meeting-members');
const MEET_CATEGORIES = ['meeting', 'entrance', 'exit', 'spot', 'rest'];

// revision serializes state writes; version remains the proposal users confirmed.
async function mutateTask(ctx, id, compute) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let task = await ctx.repo.get(C.MEET_TASKS, id);
    if (!task) throw fail(CODES.NOT_FOUND, '集合任务不存在');
    await requireCrewMember(ctx.repo, task.crewId, ctx.openid);
    task = await reconcileMeeting(ctx, id);
    const result = compute(task);
    if (!result.patch) return { task, updated: task, result };
    const revision = task.revision == null ? { __op: 'exists', value: false } : task.revision;
    const patch = Object.assign({}, result.patch, { revision: (task.revision || 0) + 1 });
    const saved = await ctx.repo.updateIf(C.MEET_TASKS, id, { revision, version: task.version, status: task.status }, patch);
    if (saved.updated) return { task, updated: Object.assign({}, task, patch), result };
  }
  throw fail(CODES.VERSION_CONFLICT, '集合状态正在更新，请刷新后重试');
}

/** 读取队伍成员的最新有效位置，返回给推荐算法。 */
async function collectMemberLocations(repo, crewId, ctx) {
  const members = await repo.find(C.CREW_MEMBERS, { crewId, status: 'active' }, { limit: 50 });
  const out = [];
  for (const m of members) {
    if (!hasLocationConsent(m)) {
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
      point: latest ? geo.coord(latest.point) : null,
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
  const p = ctx.payload;
  const started = Date.now();
  const now = new Date(ctx.now ? ctx.now : Date.now());
  await requireCrewMember(repo, p.crewId, openid);

  // 库内已知地点也参与同一半径内的比较，但不能阻断实时地点搜索。
  const library = [];
  for (let skip = 0; ; skip += 100) {
    const batch = await repo.find(C.PLACES, {}, { limit: 100, skip, sort: { _id: 1 } });
    library.push(...batch.filter(place => MEET_CATEGORIES.includes(place.category)));
    if (batch.length < 100) break;
  }

  const members = await collectMemberLocations(repo, p.crewId, ctx);
  const params = resolveParams(p.params);
  const input = { members, params, deadline: p.deadline ? new Date(p.deadline) : null, ctx };
  const preflight = meetDomain.recommendMeetPoints({ ...input, candidatePlaces: [] });
  // 任一成员缺位置或已过期时，不用其他人的中心发请求。
  const found = preflight.center ? await searchMeetingPlaces(ctx, preflight.center)
    : { places: [], search: { radiusMeters: meetDomain.MEET_SEARCH_RADIUS_METERS,
      keywords: [], mapApiCalls: 0, failures: [], status: 'not_searched' } };
  const result = meetDomain.recommendMeetPoints({ ...input,
    candidatePlaces: library.concat(found.places), fallbackToCenter: true });
  const top = result.candidates[0];
  const source = top ? top.candidateSource : 'none';
  const rule = '计算所有成员坐标的平均中心，搜索中心周围 1 公里内的地点并选最近的一个；搜不到则直接采用中心，不限制成员到集合点的距离';
  const note = source === 'geometric-center'
    ? (found.search.failures.length ? '地图检索未完整成功，暂用成员平均中心。' : '中心周围 1 公里内未找到可用地点，直接采用成员平均中心。')
    : source === 'library' ? '已选择中心周围 1 公里内的最近库内地点。'
      : source === 'poi-search' ? '已选择中心周围 1 公里内搜索到的最近地点。' : null;


  await logDecision(repo, {
    ts: now, kind: 'meet_recommend', crewId: p.crewId, tripId: p.tripId || null,
    inputDigest: { memberCount: members.length, locationSources: members.map(m => m.source),
      deadline: p.deadline || null, center: result.center, rule },
    candidates: result.candidates.map(c => ({
      candidateId: c.placeId || 'geometric-center', feasible: true,
      impactSummary: { centerDistanceMeters: c.centerDistanceMeters,
        maxWalkMin: c.maxWalkMin, avgWalkMin: c.avgWalkMin, spreadMin: c.spreadMin },
    })),
    excludedReasons: result.excluded, algoVersion: params.algoVersion, params,
    durationMs: Date.now() - started, mapApiCalls: found.search.mapApiCalls,
    result: top ? 'ok' : 'no_feasible',
  });
  return resp.ok({
    candidates: result.candidates, excluded: result.excluded, center: result.center, rule,
    candidateSource: source, candidateNote: note,
    reason: result.reason, message: result.message, manualFallback: !top,
    staleThresholdSec: time.STALE_THRESHOLD_SEC, searchRadiusMeters: result.searchRadiusMeters, search: found.search,
  });
}

/** 创建集合任务。状态从 proposed 开始（§7.2）。 */
async function create(ctx) {
  const { repo, openid } = ctx;
  require_fields(ctx.payload, ['crewId', 'plannedMeetAt']);
  const p = ctx.payload;
  const now = new Date(ctx.now ? ctx.now : Date.now());

  if (p.point != null) {
    assert(geo.coord(p.point), CODES.INVALID_PARAM, '集合点坐标无效：纬度须在 [-90, 90]、经度须在 [-180, 180] 范围内');
  }

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
    point: geo.coord(p.point),
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

  /**
   * 集合已落库 → 通知队员去哪里、几点。
   *
   * 通知失败不影响集合创建（`onMeetCreated` 内部吞掉所有异常）：
   * 集合已经定下来了，"这次没提醒到"不等于"集合没建成"。
   * 去重键带 meetTaskId，同一次集合只通知一次。
   */
  await onMeetCreated(ctx, {
    crewId: p.crewId,
    actorUserId: openid,
    meetId: task._id,
    activityName: p.placeName || '队伍集合',
    meetingPlace: p.placeName || '集合地点待定',
    meetingTime: task.plannedMeetAt,
    remark: '打开「队伍」页查看集合点与集合时间',
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

  /**
   * 通知条件：**集合状态真的变了**，或者**有人拒绝**（需要重新协商）。
   *
   * 不是"每次点确认都通知"：
   *   · 单人确认时任务状态仍是 `proposed`（要么全确认才变 `confirmed`），
   *     此时通知别人"集合已确认"是**假消息**；
   *   · 每确认一次就推一条，会迅速耗光成员的一次性订阅次数。
   * 所以只在 `status` 变化或有人 `declined` 时发，其余只记事件日志。
   */
  const statusChanged = updated.status !== task.status;
  const someoneDeclined = p.decision === 'decline';
  if (statusChanged || someoneDeclined) {
    await onMeetStatusChanged(ctx, {
      crewId: task.crewId,
      actorUserId: openid,
      meetId: task._id,
      status: updated.status,
      activityName: task.placeName || '队伍集合',
      tip: updated.status === 'confirmed' ? '集合已确认，请按时到达' : '集合需要重新确认',
      reason: someoneDeclined ? '有成员无法参加，需要重新确认'
        : (updated.status === 'confirmed' ? '成员已全部确认集合' : '集合状态已更新'),
      changedAt: now,
    });
  }

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

  let task = await repo.get(C.MEET_TASKS, ctx.payload.meetTaskId);
  if (!task) throw fail(CODES.NOT_FOUND, '集合任务不存在');
  // 获得分享卡片不等于获得权限：这里必须再校验一次成员身份
  await requireCrewMember(repo, task.crewId, openid);
  task = await reconcileMeeting(ctx, task._id);

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

'use strict';

const resp = require('../lib/resp');
const { CODES, require_fields, assert } = require('../lib/errors');
const { requireCrewMember, canReadLocation } = require('../lib/authz');
const time = require('../lib/time');
const C = require('../lib/repo/collections');

/** 允许的位置来源。降级路径的关键：算法不关心坐标怎么来的（docs/01 §0 决定 3）。 */
const SOURCES = ['gps', 'manual', 'poi', 'fuzzy'];

/** 位置精确数据的保留期。7 天后由 timer-cleanup 定时清理（docs/01 §5）。 */
const RETENTION_DAYS = 7;

/**
 * 上报位置。
 *
 * reportedAt 一律用**服务端时间**，忽略客户端可改的时钟；
 * clientAt 只存下来用于诊断时钟偏差。
 */
async function report(ctx) {
  const { repo, openid } = ctx;
  const p = ctx.payload || {};
  require_fields(p, ['point', 'source']);

  assert(SOURCES.includes(p.source), CODES.INVALID_PARAM, `位置来源必须是 ${SOURCES.join('/')}`);

  const now = new Date(ctx.now ? ctx.now : Date.now());

  let member = null;
  if (p.crewId) {
    member = await requireCrewMember(repo, p.crewId, openid);
    // 关闭共享时不接受上报，避免"关了还在传"
    assert(
      member.locationSharing !== false,
      CODES.LOCATION_SHARING_OFF,
      '你已关闭位置共享，如需上报请先开启'
    );
  }

  const loc = await repo.insert(C.LOCATIONS, {
    userId: openid,
    crewId: p.crewId || null,
    tripId: p.tripId || null,
    meetTaskId: p.meetTaskId || null,
    point: p.point,
    accuracyM: typeof p.accuracyM === 'number' ? p.accuracyM : null,
    source: p.source,
    reportedAt: now,
    clientAt: p.clientAt ? new Date(p.clientAt) : null,
    expiresAt: new Date(now.getTime() + RETENTION_DAYS * time.DAY),
  });

  if (member) {
    await repo.update(C.CREW_MEMBERS, member._id, { lastLocationAt: now });
  }

  return resp.ok({
    locationId: loc._id,
    reportedAt: now.toISOString(),
    source: p.source,
    retentionDays: RETENTION_DAYS,
  });
}

/**
 * 读取队伍位置。
 *
 * 两条规则：
 *   1. 非成员 → FORBIDDEN_NOT_MEMBER（不区分"队不存在"与"你不是成员"，避免泄露队伍存在性）
 *   2. 关闭共享的成员**不返回坐标**，只返回 sharingOff: true
 *
 * 时效由服务端计算后回传（ageSeconds / stale），客户端不得用本地时间判断（§8.2）。
 */
async function list(ctx) {
  const { repo, openid } = ctx;
  require_fields(ctx.payload, ['crewId']);

  const viewer = await requireCrewMember(repo, ctx.payload.crewId, openid);
  const members = await repo.find(
    C.CREW_MEMBERS,
    { crewId: ctx.payload.crewId, status: 'active' },
    { limit: 50 }
  );

  const out = [];
  for (const m of members) {
    if (!canReadLocation(viewer, m)) {
      // 对方关闭了共享：只暴露状态，不暴露任何坐标与时间
      out.push({ userId: m.userId, role: m.role, sharingOff: true });
      continue;
    }

    const latest = await repo.findOne(
      C.LOCATIONS,
      { userId: m.userId, crewId: ctx.payload.crewId },
      { sort: { reportedAt: -1 }, limit: 1 }
    );

    if (!latest) {
      out.push({
        userId: m.userId,
        role: m.role,
        point: null,
        hasLocation: false,
        source: null,
        reporting: 'none',
      });
      continue;
    }

    const fresh = time.freshness(latest.reportedAt, ctx);
    out.push({
      userId: m.userId,
      role: m.role,
      point: latest.point,
      accuracyM: latest.accuracyM,
      source: latest.source, // 界面必须显示来源：GPS 还是手动选点
      reportedAt: time.toISO( latest.reportedAt),
      ageSeconds: fresh.ageSeconds,
      stale: fresh.stale,
      hasLocation: true,
      reporting: fresh.stale ? 'stale' : 'ok',
    });
  }

  return resp.ok({
    members: out,
    staleThresholdSec: time.STALE_THRESHOLD_SEC,
    serverTime: new Date(ctx.now ? ctx.now : Date.now()).toISOString(),
  });
}

/** 开启／关闭自己的位置共享。个人级开关，权威值在 crew_members.locationSharing。 */
async function stopSharing(ctx) {
  const { repo, openid } = ctx;
  require_fields(ctx.payload, ['crewId']);
  assert(typeof ctx.payload.sharing === 'boolean', CODES.INVALID_PARAM, 'sharing 必须是布尔值');

  const member = await requireCrewMember(repo, ctx.payload.crewId, openid);
  await repo.update(C.CREW_MEMBERS, member._id, { locationSharing: ctx.payload.sharing });

  return resp.ok({
    crewId: ctx.payload.crewId,
    sharing: ctx.payload.sharing,
    // 关闭后不再接受上报，已有历史位置按保留期自然过期
    note: ctx.payload.sharing ? null : '已停止共享，队伍将看不到你的位置',
  });
}

module.exports = { report, list, stopSharing, SOURCES, RETENTION_DAYS };

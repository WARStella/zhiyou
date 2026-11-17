'use strict';
const { crewMemberKey } = require('../lib/crew-member-key');

const resp = require('../lib/resp');
const { CODES, require_fields, assert } = require('../lib/errors');
const { requireCrewMember, canReadLocation } = require('../lib/authz');
const time = require('../lib/time');
const C = require('../lib/repo/collections');
const { coord } = require('../lib/geo');
const { memberNicknames, memberAvatars } = require('../lib/member-nicknames');
const { mutateCrew, requireMember } = require('../lib/crew-mutation');
const { POLICY_VERSION, hasLocationConsent, recordLocationConsent } = require('../lib/location-consent');

/** 允许的位置来源。降级路径的关键：算法不关心坐标怎么来的（docs/项目计划书.md#data-model §0 决定 3）。 */
const SOURCES = ['gps', 'manual', 'poi', 'fuzzy'];

/** 位置精确数据的保留期。7 天后由 timer-cleanup 定时清理（docs/项目计划书.md#data-model §5）。 */
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
  const point = coord(p.point);
  assert(point, CODES.INVALID_PARAM, '位置坐标无效：纬度须在 [-90, 90]、经度须在 [-180, 180] 范围内');

  const now = new Date(ctx.now ? ctx.now : Date.now());

  assert(p.crewId, CODES.LOCATION_SHARING_OFF, '请先加入队伍，并在「我的 → 设置」明确开启位置共享');
  const member = await requireCrewMember(repo, p.crewId, openid);
  const loc = await repo.runTransaction(async tx => {
    const crew = await tx.get(C.CREWS, p.crewId);
    const current = await tx.get(C.CREW_MEMBERS, member._id);
    assert(crew && crew.status === 'active' && current && current.status === 'active',
      CODES.FORBIDDEN_NOT_MEMBER, '你已退出或队伍已解散');
    assert(hasLocationConsent(current), CODES.LOCATION_SHARING_OFF,
      '尚未同意本版位置共享说明或已关闭共享，请到「我的 → 设置」主动开启');
    const saved = await tx.insert(C.LOCATIONS, {
      userId: openid,
      crewId: p.crewId,
      tripId: p.tripId || null,
      meetTaskId: p.meetTaskId || null,
      point,
      accuracyM: typeof p.accuracyM === 'number' ? p.accuracyM : null,
      source: p.source,
      reportedAt: now,
      clientAt: p.clientAt ? new Date(p.clientAt) : null,
      expiresAt: new Date(now.getTime() + RETENTION_DAYS * time.DAY),
    });
    await tx.update(C.CREW_MEMBERS, member._id, { lastLocationAt: now });
    // 云事务是快照隔离；写同一队伍文档，才能与解散/退出形成写冲突。
    await tx.update(C.CREWS, p.crewId, { revision: (crew.revision || 0) + 1 });
    return saved;
  }, [C.LOCATIONS, C.CREW_MEMBERS]);

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
  const nicknames = await memberNicknames(repo, members);
  const avatars = await memberAvatars(repo, members);
  for (const m of members) {
    if (!canReadLocation(viewer, m) || !hasLocationConsent(m)) {
      // 对方关闭了共享：只暴露状态，不暴露任何坐标与时间
      out.push({ userId: m.userId, memberKey: crewMemberKey(ctx.payload.crewId, m.userId),
        nickname: nicknames.get(m.userId) || null, role: m.role, sharingOff: true });
      continue;
    }

    const latest = await repo.findOne(
      C.LOCATIONS,
      { userId: m.userId, crewId: ctx.payload.crewId },
      { sort: { reportedAt: -1 }, limit: 1 }
    );

    if (!latest || !coord(latest.point)) {
      out.push({
        userId: m.userId,
        memberKey: crewMemberKey(ctx.payload.crewId, m.userId),
        nickname: nicknames.get(m.userId) || null,
        role: m.role,
        point: null,
        hasLocation: false,
        source: null,
        reporting: 'none',
        invalidLocation: Boolean(latest),
      });
      continue;
    }

    const fresh = time.freshness(latest.reportedAt, ctx);
    out.push({
      userId: m.userId,
      memberKey: crewMemberKey(ctx.payload.crewId, m.userId),
      nickname: nicknames.get(m.userId) || null,
      role: m.role,
      point: coord(latest.point),
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
    members: out.map(member => ({ ...member, avatarFileId: avatars.get(member.userId) || null })),
    staleThresholdSec: time.STALE_THRESHOLD_SEC,
    serverTime: new Date(ctx.now ? ctx.now : Date.now()).toISOString(),
  });
}

/** 开启／关闭自己的位置共享。个人级开关，权威值在 crew_members.locationSharing。 */
async function stopSharing(ctx) {
  const { repo, openid } = ctx;
  require_fields(ctx.payload, ['crewId']);
  assert(typeof ctx.payload.sharing === 'boolean', CODES.INVALID_PARAM, 'sharing 必须是布尔值');

  if (ctx.payload.sharing) assert(ctx.payload.policyVersion === POLICY_VERSION, CODES.INVALID_PARAM,
    '位置共享说明已更新，请更新小程序并阅读说明后重新开启', { policyVersion: POLICY_VERSION });
  await mutateCrew(ctx, ctx.payload.crewId, [openid], async ({ tx, members }) => {
    const member = requireMember(members, openid);
    const patch = await recordLocationConsent(tx, ctx, ctx.payload.crewId, member,
      ctx.payload.sharing, 'sharing_switch');
    await tx.update(C.CREW_MEMBERS, member._id, patch);
    return { result: null };
  });

  return resp.ok({
    crewId: ctx.payload.crewId,
    sharing: ctx.payload.sharing,
    policyVersion: POLICY_VERSION,
    // 关闭后不再接受上报，已有历史位置按保留期自然过期
    note: ctx.payload.sharing ? null : '已停止共享，队伍将看不到你的位置',
  });
}

module.exports = { report, list, stopSharing, SOURCES, RETENTION_DAYS };

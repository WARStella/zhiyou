'use strict';

const { memberNicknames } = require('../lib/member-nicknames');

const resp = require('../lib/resp');
const { CODES, require_fields, assert, fail } = require('../lib/errors');
const { requireCrewMember, requireCrew } = require('../lib/authz');
const C = require('../lib/repo/collections');
const { mutateCrew, requireMember } = require('../lib/crew-mutation');
const { hasLocationConsent, recordLocationConsent } = require('../lib/location-consent');
const { reconcileCrewMeetings } = require('../lib/meeting-members');

/** 生成 6 位大写邀请码，排除易混字符。 */
function makeInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

async function create(ctx) {
  const { repo, openid } = ctx;
  const p = ctx.payload || {};
  require_fields(p, ['name']);
  assert(String(p.name).length <= 20, CODES.INVALID_PARAM, '小队名称不能超过 20 个字');

  const now = new Date(ctx.now ? ctx.now : Date.now());

  // 邀请码唯一性：最多重试 5 次
  let inviteCode = null;
  for (let i = 0; i < 5 && !inviteCode; i++) {
    const candidate = makeInviteCode();
    const dup = await repo.findOne(C.CREWS, { inviteCode: candidate });
    if (!dup) inviteCode = candidate;
  }
  assert(inviteCode, CODES.INTERNAL, '邀请码生成失败，请重试');

  const crew = await repo.runTransaction(async tx => {
    const created = await tx.insert(C.CREWS, {
      name: String(p.name),
      ownerUserId: openid,
      inviteCode,
      status: 'active',
      memberCount: 1,
      revision: 0,
      shareLocationDefault: false, // 建队/入队不是本人对位置共享的同意。
      createdAt: now,
      closedAt: null,
    });

    await tx.insert(C.CREW_MEMBERS, {
      crewId: created._id,
      userId: openid,
      role: 'owner',
      status: 'active',
      joinedAt: now,
      leftAt: null,
      locationSharing: false,
      lastLocationAt: null,
    });
    return created;
  }, [C.CREWS, C.CREW_MEMBERS]);

  return resp.ok({ crewId: crew._id, inviteCode, role: 'owner', memberCount: 1 });
}

/**
 * 加入小队。重复加入是幂等的：已在队中直接返回，不重复插入成员记录。
 * 曾退出的成员重新加入时复用原记录（保持 crewId+userId 唯一索引成立）。
 */
async function join(ctx) {
  const { repo, openid } = ctx;
  require_fields(ctx.payload, ['inviteCode']);

  const code = String(ctx.payload.inviteCode).trim().toUpperCase();
  const crew = await repo.findOne(C.CREWS, { inviteCode: code });
  if (!crew || crew.status !== 'active') throw fail(CODES.NOT_FOUND, '邀请码无效或小队已解散');
  return resp.ok(await joinCrew(ctx, crew._id));
}

async function joinCrew(ctx, crewId, guard, otherUsers = []) {
  const { openid } = ctx;
  const now = new Date(ctx.now ? ctx.now : Date.now());
  return mutateCrew(ctx, crewId, [openid, ...otherUsers], async ({ tx, crew, members, count }) => {
    if (guard) await guard({ tx, crew, members });
    const existing = members.get(openid);
    if (existing && existing.status === 'active') return {
      result: { crewId: crew._id, role: existing.role, memberCount: count, joined: false },
    };
    const patch = { status: 'active', joinedAt: now, leftAt: null, locationSharing: false,
      locationConsentId: null, locationConsentPolicyVersion: null, locationConsentGrantedAt: null,
      lastLocationAt: null };
    if (existing) await tx.update(C.CREW_MEMBERS, existing._id, patch);
    else await tx.insert(C.CREW_MEMBERS, Object.assign({ crewId: crew._id, userId: openid, role: 'member' }, patch));
    return { crewPatch: { memberCount: count + 1 },
      result: { crewId: crew._id, role: existing ? existing.role : 'member', memberCount: count + 1, joined: true } };
  });
}

/**
 * 退出小队。
 * 立即生效：位置共享同时关闭，且后续任何队伍请求都会因查不到 active 记录而被拒绝
 * （lib/authz.js 不缓存成员身份）。对应 10/20、10/21 的权限验收。
 */
async function leave(ctx) {
  const { openid } = ctx;
  require_fields(ctx.payload, ['crewId']);

  const now = new Date(ctx.now ? ctx.now : Date.now());
  const result = await mutateCrew(ctx, ctx.payload.crewId, [openid], async ({ tx, members, count }) => {
    const member = requireMember(members, openid);
    const consent = await recordLocationConsent(tx, ctx, ctx.payload.crewId, member, false, 'crew_leave');
    await tx.update(C.CREW_MEMBERS, member._id, Object.assign({ status: 'left', leftAt: now }, consent));
    return { crewPatch: { memberCount: count - 1 }, result: {
      crewId: ctx.payload.crewId, leftAt: now.toISOString(), memberCount: count - 1, revoked: true } };
  });
  await reconcileCrewMeetings(ctx, ctx.payload.crewId);
  return resp.ok(result);
}

/** 读取小队与成员。非成员一律 FORBIDDEN_NOT_MEMBER。 */
async function get(ctx) {
  const { repo, openid } = ctx;
  require_fields(ctx.payload, ['crewId']);

  const member = await requireCrewMember(repo, ctx.payload.crewId, openid);
  const crew = await requireCrew(repo, ctx.payload.crewId);
  const members = await repo.find(
    C.CREW_MEMBERS,
    { crewId: ctx.payload.crewId, status: 'active' },
    { limit: 50 }
  );
  const nicknames = await memberNicknames(repo, members);

  return resp.ok({
    crew: {
      crewId: crew._id,
      name: crew.name,
      inviteCode: crew.inviteCode,
      ownerUserId: crew.ownerUserId,
      status: crew.status,
      memberCount: members.length,
    },
    me: openid,
    myRole: member.role,
    members: members.map((m) => ({
      userId: m.userId,
      nickname: nicknames.get(m.userId) || null,
      role: m.role,
      joinedAt: m.joinedAt,
      // 只暴露"是否共享"，不在这里返回坐标 —— 坐标必须走 loc.list
      locationSharing: hasLocationConsent(m),
      lastLocationAt: m.lastLocationAt || null,
    })),
  });
}

/** 移除成员：仅发起人可用（P0 接口清单 §2.4）。 */
async function remove(ctx) {
  const { openid } = ctx;
  require_fields(ctx.payload, ['crewId', 'userId']);

  const now = new Date(ctx.now ? ctx.now : Date.now());
  const result = await mutateCrew(ctx, ctx.payload.crewId, [openid, ctx.payload.userId], async ({ tx, members, count }) => {
    requireMember(members, openid, true);
    const target = members.get(ctx.payload.userId);
    assert(target, CODES.NOT_FOUND, '该成员不在小队中');
    assert(target.userId !== openid, CODES.INVALID_PARAM, '发起人不能移除自己，请使用解散');
    const consent = await recordLocationConsent(tx, ctx, ctx.payload.crewId, target, false, 'crew_remove');
    await tx.update(C.CREW_MEMBERS, target._id, Object.assign({ status: 'removed', leftAt: now }, consent));
    const memberCount = count - (target.status === 'active' ? 1 : 0);
    return { crewPatch: { memberCount }, result: { removed: true, userId: ctx.payload.userId, memberCount } };
  });
  await reconcileCrewMeetings(ctx, ctx.payload.crewId);
  return resp.ok(result);
}

module.exports = { create, join, leave, get, remove, joinCrew };

'use strict';

const resp = require('../lib/resp');
const { CODES, require_fields, assert, fail } = require('../lib/errors');
const { requireCrewMember, requireCrewOwner, requireCrew } = require('../lib/authz');
const C = require('../lib/repo/collections');

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

  const crew = await repo.insert(C.CREWS, {
    name: String(p.name),
    ownerUserId: openid,
    inviteCode,
    status: 'active',
    memberCount: 1,
    shareLocationDefault: p.shareLocationDefault !== false,
    createdAt: now,
    closedAt: null,
  });

  await repo.insert(C.CREW_MEMBERS, {
    crewId: crew._id,
    userId: openid,
    role: 'owner',
    status: 'active',
    joinedAt: now,
    leftAt: null,
    // 个人级共享开关，权威值在此（docs/01 §2.8）
    locationSharing: p.shareLocationDefault !== false,
    lastLocationAt: null,
  });

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

  const now = new Date(ctx.now ? ctx.now : Date.now());
  const existing = await repo.findOne(C.CREW_MEMBERS, { crewId: crew._id, userId: openid });

  if (existing && existing.status === 'active') {
    return resp.ok({ crewId: crew._id, role: existing.role, memberCount: crew.memberCount, joined: false });
  }

  if (existing) {
    // 重新加入：**重置共享开关为队伍默认值**，不继承退出前的设置
    await repo.update(C.CREW_MEMBERS, existing._id, {
      status: 'active',
      joinedAt: now,
      leftAt: null,
      locationSharing: crew.shareLocationDefault !== false,
    });
  } else {
    await repo.insert(C.CREW_MEMBERS, {
      crewId: crew._id,
      userId: openid,
      role: 'member',
      status: 'active',
      joinedAt: now,
      leftAt: null,
      locationSharing: crew.shareLocationDefault !== false,
      lastLocationAt: null,
    });
  }

  const memberCount = await repo.count(C.CREW_MEMBERS, { crewId: crew._id, status: 'active' });
  await repo.update(C.CREWS, crew._id, { memberCount });

  return resp.ok({ crewId: crew._id, role: 'member', memberCount, joined: true });
}

/**
 * 退出小队。
 * 立即生效：位置共享同时关闭，且后续任何队伍请求都会因查不到 active 记录而被拒绝
 * （lib/authz.js 不缓存成员身份）。对应 10/20、10/21 的权限验收。
 */
async function leave(ctx) {
  const { repo, openid } = ctx;
  require_fields(ctx.payload, ['crewId']);

  const member = await requireCrewMember(repo, ctx.payload.crewId, openid);
  const now = new Date(ctx.now ? ctx.now : Date.now());

  await repo.update(C.CREW_MEMBERS, member._id, {
    status: 'left',
    leftAt: now,
    locationSharing: false, // 退出即停止共享，不等用户手动关
  });

  const memberCount = await repo.count(C.CREW_MEMBERS, {
    crewId: ctx.payload.crewId,
    status: 'active',
  });
  await repo.update(C.CREWS, ctx.payload.crewId, { memberCount });

  return resp.ok({ crewId: ctx.payload.crewId, leftAt: now.toISOString(), memberCount, revoked: true });
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

  return resp.ok({
    crew: {
      crewId: crew._id,
      name: crew.name,
      inviteCode: crew.inviteCode,
      ownerUserId: crew.ownerUserId,
      status: crew.status,
      memberCount: members.length,
    },
    myRole: member.role,
    members: members.map((m) => ({
      userId: m.userId,
      role: m.role,
      joinedAt: m.joinedAt,
      // 只暴露"是否共享"，不在这里返回坐标 —— 坐标必须走 loc.list
      locationSharing: m.locationSharing !== false,
      lastLocationAt: m.lastLocationAt || null,
    })),
  });
}

/** 移除成员：仅发起人可用（P0 接口清单 §2.4）。 */
async function remove(ctx) {
  const { repo, openid } = ctx;
  require_fields(ctx.payload, ['crewId', 'userId']);

  await requireCrewOwner(repo, ctx.payload.crewId, openid);
  const target = await repo.findOne(C.CREW_MEMBERS, {
    crewId: ctx.payload.crewId,
    userId: ctx.payload.userId,
  });
  if (!target) throw fail(CODES.NOT_FOUND, '该成员不在小队中');
  assert(target.userId !== openid, CODES.INVALID_PARAM, '发起人不能移除自己，请使用解散');

  const now = new Date(ctx.now ? ctx.now : Date.now());
  await repo.update(C.CREW_MEMBERS, target._id, {
    status: 'removed',
    leftAt: now,
    locationSharing: false,
  });
  const memberCount = await repo.count(C.CREW_MEMBERS, {
    crewId: ctx.payload.crewId,
    status: 'active',
  });
  await repo.update(C.CREWS, ctx.payload.crewId, { memberCount });

  return resp.ok({ removed: true, userId: ctx.payload.userId, memberCount });
}

module.exports = { create, join, leave, get, remove };

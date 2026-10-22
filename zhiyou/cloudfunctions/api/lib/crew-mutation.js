'use strict';

const C = require('./repo/collections');
const { assert, fail, CODES } = require('./errors');

/** 所有成员变更/解散都推进队伍 revision，让事务外的查询可在事务内验证。 */
async function mutateCrew(ctx, crewId, userIds, change) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = await ctx.repo.get(C.CREWS, crewId);
    assert(before && before.status === 'active', CODES.FORBIDDEN_NOT_MEMBER, '小队已解散或不存在');
    const rows = await Promise.all([...new Set(userIds)].map(userId =>
      ctx.repo.findOne(C.CREW_MEMBERS, { crewId, userId })));
    const count = await ctx.repo.count(C.CREW_MEMBERS, { crewId, status: 'active' });
    try {
      return await ctx.repo.runTransaction(async tx => {
        const crew = await tx.get(C.CREWS, crewId);
        assert(crew && crew.status === 'active', CODES.FORBIDDEN_NOT_MEMBER, '小队已解散');
        assert((crew.revision || 0) === (before.revision || 0), CODES.VERSION_CONFLICT, '队伍成员正在更新');
        const members = new Map();
        for (const row of rows) if (row) members.set(row.userId, await tx.get(C.CREW_MEMBERS, row._id));
        const changed = await change({ tx, crew, members, count });
        await tx.update(C.CREWS, crewId, Object.assign({ memberCount: count }, changed.crewPatch,
          { revision: (crew.revision || 0) + 1 }));
        return changed.result;
      }, [C.CREWS, C.CREW_MEMBERS, C.PRIVACY_CONSENTS]);
    } catch (e) {
      if (e.code !== CODES.VERSION_CONFLICT && !e.transactionConflict) throw e;
    }
  }
  throw fail(CODES.VERSION_CONFLICT, '队伍更新频繁，请刷新后重试');
}

function requireMember(members, userId, owner) {
  const member = members.get(userId);
  assert(member && member.status === 'active', CODES.FORBIDDEN_NOT_MEMBER, '你不是该小队成员，或已退出');
  if (owner) assert(member.role === 'owner', CODES.FORBIDDEN_NOT_MEMBER, '仅发起人可执行此操作');
  return member;
}

module.exports = { mutateCrew, requireMember };

'use strict';

const C = require('./repo/collections');
const { assert, fail, CODES } = require('./errors');
const domain = require('../domain/meet');
const LIVE = ['proposed', 'confirmed', 'active', 'arrived_all'];

/** 成员退出不等同于拒绝本轮邀请；移出参与名单，另留退出记录。 */
function membershipPatch(task, members, ownerUserId, now) {
  if (!task || !LIVE.includes(task.status)) return null;
  const active = new Map(members.map(m => [m.userId, m]));
  const removed = (task.participants || []).filter(p => {
    const member = active.get(p.userId);
    // 退队后重新加入，也不能自动恢复旧一轮集合的参与/确认。
    return !member || (member.joinedAt && task.createdAt && new Date(member.joinedAt) > new Date(task.createdAt));
  });
  if (!removed.length) return null;
  const ids = new Set(removed.map(p => p.userId));
  const participants = task.participants.filter(p => !ids.has(p.userId));
  const next = { ...task, participants };
  const need = domain.activeParticipants(next);
  const allArrived = need.length > 0 && need.every(p => p.status === 'arrived' && p.confirmedVersion === task.version);
  const status = !need.length ? 'cancelled' : allArrived ? 'arrived_all'
    : domain.allConfirmed(next) ? (need.some(p => p.status === 'arrived') ? 'active' : 'confirmed') : 'proposed';
  return { participants, status, allArrivedAt: allArrived ? (task.allArrivedAt || now) : null,
    initiatorUserId: active.has(task.initiatorUserId) ? task.initiatorUserId
      : active.has(ownerUserId) ? ownerUserId : (members[0] && members[0].userId) || task.initiatorUserId,
    withdrawnParticipants: (task.withdrawnParticipants || []).concat(removed.map(p => ({ ...p, withdrawnAt: now, reason: 'crew_membership_ended' }))),
    departureCheck: null, updatedAt: now, revision: (task.revision || 0) + 1 };
}

/** 事务内复核队伍 revision，避免退队与确认/到达并发时把旧名单写回。 */
async function reconcileMeeting(ctx, id) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const task = await ctx.repo.get(C.MEET_TASKS, id);
    if (!task || !LIVE.includes(task.status)) return task;
    const crew = await ctx.repo.get(C.CREWS, task.crewId);
    if (!crew || crew.status !== 'active') return task;
    const members = await ctx.repo.find(C.CREW_MEMBERS, { crewId: task.crewId, status: 'active' }, { limit: 50 });
    const now = new Date(ctx.now || Date.now());
    if (!membershipPatch(task, members, crew.ownerUserId, now)) return task;
    try {
      return await ctx.repo.runTransaction(async tx => {
        const currentCrew = await tx.get(C.CREWS, task.crewId);
        assert(currentCrew && currentCrew.status === 'active' && (currentCrew.revision || 0) === (crew.revision || 0),
          CODES.VERSION_CONFLICT, '队伍成员正在更新');
        const current = await tx.get(C.MEET_TASKS, id);
        const patch = membershipPatch(current, members, crew.ownerUserId, now);
        if (!patch) return current;
        await tx.update(C.MEET_TASKS, id, patch);
        return { ...current, ...patch };
      }, [C.CREWS, C.MEET_TASKS]);
    } catch (error) {
      if (error.code !== CODES.VERSION_CONFLICT && !error.transactionConflict) throw error;
    }
  }
  throw fail(CODES.VERSION_CONFLICT, '集合成员正在更新，请刷新后重试');
}

async function reconcileCrewMeetings(ctx, crewId) {
  for (let skip = 0; ; skip += 100) {
    const tasks = await ctx.repo.find(C.MEET_TASKS, { crewId }, { limit: 100, skip, sort: { _id: 1 } });
    for (const task of tasks) if (LIVE.includes(task.status)) await reconcileMeeting(ctx, task._id);
    if (tasks.length < 100) break;
  }
}

module.exports = { membershipPatch, reconcileMeeting, reconcileCrewMeetings };

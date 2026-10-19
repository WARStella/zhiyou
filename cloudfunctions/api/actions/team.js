'use strict';
const resp = require('../lib/resp');
const { assert, require_fields, CODES } = require('../lib/errors');
const { requireCrewMember, requireCrewOwner, requireCrew } = require('../lib/authz');
const C = require('../lib/repo/collections');
const tripActions = require('./trip');
const { mutateCrew, requireMember } = require('../lib/crew-mutation');

async function current(ctx) {
  const { repo, openid, payload: p } = ctx;
  require_fields(p, ['crewId']);
  await requireCrewMember(repo, p.crewId, openid);
  const crew = await requireCrew(repo, p.crewId);
  const meetings = await repo.find(C.MEET_TASKS, { crewId: p.crewId }, { sort: { createdAt: -1 }, limit: 1 });
  const proposals = crew.activeTripId ? await repo.find(C.CHANGE_PROPOSALS, { tripId: crew.activeTripId, status: 'proposed' }, { sort: { createdAt: -1 }, limit: 1 }) : [];
  const latest = proposals[0];
  const trip = crew.activeTripId ? await repo.get(C.TRIPS, crew.activeTripId) : null;
  const valid = latest && trip && latest.baseVersion === trip.version && (!latest.expiresAt || new Date(latest.expiresAt) > new Date(ctx.now || Date.now()));
  return resp.ok({ tripId: crew.activeTripId || null, meetTaskId: meetings[0] ? meetings[0]._id : null,
    proposal: valid ? { proposalId: latest._id, candidates: latest.candidates } : null });
}

async function publishTrip(ctx) {
  const { repo, openid, payload: p } = ctx;
  require_fields(p, ['crewId', 'tripId']);
  await requireCrewOwner(repo, p.crewId, openid);
  const crew = await requireCrew(repo, p.crewId);
  assert(!crew.activeTripId, CODES.INVALID_PARAM, '小队已有共同路线，请先使用当前路线');
  const source = await tripActions.loadTripForRead(repo, p.tripId, openid);
  assert(source.mode === 'personal' && source.ownerUserId === openid, CODES.INVALID_PARAM, '请使用自己的个人路线创建团队路线');
  assert(source.status === 'active', CODES.INVALID_PARAM, '请使用可执行的有效路线');
  const now = new Date(ctx.now || Date.now());
  const copy = Object.assign({}, source, {
    mode: 'team', crewId: p.crewId, ownerUserId: openid, version: 1,
    sourceTripId: source._id, createdAt: now, updatedAt: now,
    // The copy has not produced its own measured travel samples.
    generatedBy: Object.assign({}, source.generatedBy, { planRunId: null }),
  });
  delete copy._id;
  const trip = await repo.insert(C.TRIPS, copy);
  const saved = await repo.updateIf(C.CREWS, p.crewId, {
    activeTripId: crew.activeTripId === undefined ? { __op: 'exists', value: false } : null,
    status: 'active',
  }, { activeTripId: trip._id });
  if (!saved.updated) {
    await repo.remove(C.TRIPS, trip._id);
    assert(false, CODES.VERSION_CONFLICT, '共同路线已更新，请刷新');
  }
  return resp.ok({ tripId: trip._id, version: 1 });
}

async function progress(ctx) {
  require_fields(ctx.payload, ['tripId']);
  const trip = await tripActions.loadTripForRead(ctx.repo, ctx.payload.tripId, ctx.openid);
  assert(trip.mode === 'team', CODES.INVALID_PARAM, '需要团队路线');
  await requireCrewOwner(ctx.repo, trip.crewId, ctx.openid);
  return tripActions.progress(ctx);
}
async function close(ctx) {
  require_fields(ctx.payload, ['crewId']);
  const result = await mutateCrew(ctx, ctx.payload.crewId, [ctx.openid], async ({ members }) => {
    requireMember(members, ctx.openid, true);
    return { crewPatch: { status: 'closed', closedAt: new Date(ctx.now || Date.now()) }, result: { closed: true } };
  });
  return resp.ok(result);
}
async function cancelMeeting(ctx) {
  require_fields(ctx.payload, ['meetTaskId']);
  const task = await ctx.repo.get(C.MEET_TASKS, ctx.payload.meetTaskId);
  assert(task, CODES.NOT_FOUND, '集合不存在');
  await requireCrewOwner(ctx.repo, task.crewId, ctx.openid);
  assert(ctx.expectedVersion === task.version, CODES.VERSION_CONFLICT, '集合已更新，请刷新');
  assert(!['departed', 'cancelled'].includes(task.status), CODES.INVALID_PARAM, '本次集合已结束');
  const result = await ctx.repo.updateIf(C.MEET_TASKS, task._id, {
    version: task.version, revision: task.revision == null ? { __op: 'exists', value: false } : task.revision,
  }, { status: 'cancelled', version: task.version + 1, revision: (task.revision || 0) + 1 });
  assert(result.updated, CODES.VERSION_CONFLICT, '集合状态已变化，请刷新后重试');
  return resp.ok({ cancelled: true });
}
module.exports = { current, publishTrip, progress, close, cancelMeeting };

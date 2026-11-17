'use strict';
const { reconcileMeeting } = require('../lib/meeting-members');
const { randomUUID } = require('node:crypto');
const { assert, CODES, require_fields } = require('../lib/errors');
const { requireCrewMember } = require('../lib/authz');
const C = require('../lib/repo/collections');
const resp = require('../lib/resp');
const time = require('../lib/time');
const geo = require('../lib/geo');
const { resolveParams } = require('../lib/params');
const timeline = require('../domain/timeline');
const { checkFeasibility } = require('../domain/feasibility');
const { generateCandidates } = require('../domain/planner');
const { loadPlaces } = require('./trip');

async function load(ctx) {
  require_fields(ctx.payload, ['meetTaskId']);
  let task = await ctx.repo.get(C.MEET_TASKS, ctx.payload.meetTaskId);
  assert(task, CODES.NOT_FOUND, '集合任务不存在');
  await requireCrewMember(ctx.repo, task.crewId, ctx.openid);
  task = await reconcileMeeting(ctx, task._id);
  assert(task.initiatorUserId === ctx.openid, CODES.FORBIDDEN_NOT_MEMBER, '只有发起人可以检查和确认出发');
  assert(ctx.expectedVersion != null, CODES.INVALID_PARAM, '必须携带集合版本 expectedVersion');
  assert(ctx.expectedVersion === task.version, CODES.VERSION_CONFLICT, '集合已更新，请刷新');
  return task;
}
function condition(task) {
  return { version: task.version, status: task.status, revision: task.revision == null ? { __op: 'exists', value: false } : task.revision };
}
async function evaluate(ctx, task, now) {
  if (!task.tripId) return { canDepart: true, tripVersion: null, tripImpact: null, message: '未关联行程，仅确认本次集合出发。' };
  const trip = await ctx.repo.get(C.TRIPS, task.tripId);
  assert(trip && trip.mode === 'team' && trip.crewId === task.crewId, CODES.INVALID_PARAM, '关联行程不存在或不属于本小队');
  const remaining = (trip.nodes || []).filter(n => !['done','skipped'].includes(n.status));
  const history = (trip.nodes || []).filter(n => ['done','skipped'].includes(n.status));
  const completed = new Set(history.filter(n => n.status === 'done').map(n => n.placeId));
  const constraints = (trip.constraints || []).map(c => c.key === 'mustVisit'
    ? Object.assign({}, c, { value: Array.isArray(c.value) ? c.value.filter(id => !completed.has(id)) : c.value }) : c);
  const { map: places } = await loadPlaces(ctx.repo, remaining.map(n => n.placeId));
  for (const n of remaining) if (!places[n.placeId] && n.placeSnapshot) places[n.placeId] = n.placeSnapshot;
  assert(remaining.every(n => places[n.placeId]), CODES.INSUFFICIENT_DATA, '后续地点资料缺失，暂不能确认出发');
  let point = task.point;
  if (!point && task.placeId) { const place = await ctx.repo.get(C.PLACES, task.placeId); point = place && geo.coordOf(place, true); }
  const params = resolveParams(trip.params);
  function calculate(nodes) {
    const first = nodes[0];
    const startLeg = first ? geo.walkMinutesFromPoint(point, places[first.placeId], params) : null;
    assert(!first || startLeg, CODES.INSUFFICIENT_DATA, '集合点或下一站坐标缺失，暂不能检查');
    const tl = timeline.buildTimeline({ startAt: now, items: nodes.map(n => ({ nodeId:n.nodeId, placeId:n.placeId, stayMin:n.plannedStayMin })), placesById:places, params, startLeg });
    const feasibility = checkFeasibility({ timeline:tl, constraints, placesById:places });
    return { tl, feasibility };
  }
  const computed = calculate(remaining);
  const delayMin = Math.max(0, Math.round(time.diffMin(now, task.plannedMeetAt)));
  const tripImpact = { delayMin, shouldReevaluate: !computed.feasibility.feasible,
    conflicts: computed.feasibility.conflicts, remainingEndAt: time.toISO(computed.tl.endAt),
    remainingWalkMin: computed.tl.totalWalkMin, travelNote: '集合点到下一站使用距离估算，非实时路况保证' };
  return { canDepart:computed.feasibility.feasible, tripVersion:trip.version, tripImpact, trip, remaining, history, places, params, constraints, calculate };
}
async function prepare(ctx) {
  const task = await load(ctx), now = new Date(ctx.now || Date.now());
  assert(task.status === 'arrived_all', CODES.INVALID_PARAM, '请先等待全员到齐');
  const result = await evaluate(ctx, task, now);
  let proposal = null;
  if (!result.canDepart && result.remaining.length) {
    const gen = generateCandidates({ baseNodes:result.remaining, trigger:{type:'manual_progress',payload:{}}, constraints:result.constraints, placesById:result.places, params:result.params, startAt:now });
    const candidates = gen.candidates.map(c => {
      const checked = result.calculate(c.nodes || []);
      return Object.assign({}, c, { feasible:checked.feasibility.feasible,
        conflicts:checked.feasibility.conflicts,
        nodes:result.history.concat(timeline.toNodes(checked.tl.legs, 'meet_preflight')).map((n,i)=>Object.assign({},n,{seq:i})),
        impact:Object.assign({},c.impact,{changedEndAt:time.toISO(checked.tl.endAt)}) });
    });
    const saved = await ctx.repo.insert(C.CHANGE_PROPOSALS, { tripId:task.tripId, baseVersion:result.tripVersion, status:'proposed',
      trigger:{type:'meet_delay',payload:{meetTaskId:task._id}}, candidates, confirmations:[], selectedCandidateId:null,
      createdByUserId:ctx.openid, createdAt:now, expiresAt:new Date(now.getTime()+30*time.MIN) });
    proposal = { proposalId:saved._id, candidates, feasibleCount:candidates.filter(c=>c.feasible).length };
  }
  const check = { id:randomUUID(), canDepart:result.canDepart, tripVersion:result.tripVersion, checkedAt:now.toISOString(), expiresAt:new Date(now.getTime()+2*time.MIN).toISOString() };
  const saved = await ctx.repo.updateIf(C.MEET_TASKS, task._id, condition(task), { departureCheck:check, revision:(task.revision||0)+1 });
  assert(saved.updated, CODES.VERSION_CONFLICT, '集合状态已更新，请重新检查');
  return resp.ok({ meetTaskId:task._id, checkId:check.id, canDepart:result.canDepart, expiresAt:check.expiresAt,
    tripImpact:result.tripImpact, delayMin:result.tripImpact ? result.tripImpact.delayMin : 0, proposal,
    message:result.canDepart ? '检查通过，请确认实际出发。' : '后续安排存在冲突，请先调整，再重新检查。' });
}
async function depart(ctx) {
  const task = await load(ctx), now = new Date(ctx.now || Date.now());
  if (task.status === 'departed') return resp.ok({meetTaskId:task._id,status:task.status,departedAt:time.toISO(task.departedAt),alreadyDeparted:true});
  assert(task.status === 'arrived_all', CODES.INVALID_PARAM, '请先等待全员到齐');
  // Standalone meetings have no itinerary to check; retain their existing API behavior.
  if (task.tripId || ctx.payload.checkId) {
    const check = task.departureCheck;
    assert(check && ctx.payload.checkId === check.id, CODES.INVALID_PARAM, '请先检查后续行程');
    assert(check.canDepart, CODES.INFEASIBLE_HARD_CONSTRAINT, '请先处理行程冲突，再重新检查');
    assert(new Date(check.expiresAt) > now, CODES.VERSION_CONFLICT, '检查已过期，请重新检查');
  }
  const result = await evaluate(ctx, task, now);
  if (task.tripId) assert(task.departureCheck.tripVersion === result.tripVersion, CODES.VERSION_CONFLICT, '路线已更新，请重新检查');
  assert(result.canDepart, CODES.INFEASIBLE_HARD_CONSTRAINT, '时间已变化，后续安排不再可行，请重新检查');
  const saved = await ctx.repo.updateIf(C.MEET_TASKS, task._id, condition(task), { status:'departed', departedAt:now, revision:(task.revision||0)+1 });
  if (!saved.updated) {
    const latest = await ctx.repo.get(C.MEET_TASKS, task._id);
    if (latest && latest.status === 'departed' && latest.version === task.version) return resp.ok({meetTaskId:task._id,status:'departed',departedAt:time.toISO(latest.departedAt),alreadyDeparted:true});
    assert(false, CODES.VERSION_CONFLICT, '集合状态已更新，请刷新');
  }
  return resp.ok({ meetTaskId:task._id,status:'departed',departedAt:now.toISOString(),tripImpact:result.tripImpact,
    delayMin:Math.max(0,Math.round(time.diffMin(now,task.plannedMeetAt))),message:'已记录实际出发时间' });
}
module.exports = { prepare, depart };

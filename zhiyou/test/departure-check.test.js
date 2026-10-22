const test=require('node:test');
const assert=require('node:assert/strict');
const {makeWorld,makeCrew,expectOk,expectFail,C}=require('./helpers');
async function setup(){
  const w=await makeWorld(),{crewId}=await makeCrew(w);
  const trip=expectOk(await w.A('trip.plan',{crewId,placeIds:['p_zhongyang'],startAt:w.NOW,constraints:[]}));
  const task=expectOk(await w.A('meet.create',{crewId,tripId:trip.tripId,placeName:'集合点',point:{latitude:45.7756,longitude:126.6175},plannedMeetAt:w.NOW}));
  const payload={meetTaskId:task.meetTaskId};
  for(const who of ['B','C'])expectOk(await w[who]('meet.confirm',{...payload,decision:'confirm'},{expectedVersion:1}));
  for(const who of ['A','B','C'])expectOk(await w[who]('meet.arrive',payload));
  return {w,trip,payload};
}
test('出发前检查不写出发时间或路线；检查通过后才可确认，重复确认不改首次时间',async()=>{
  const {w,trip,payload}=await setup();
  const before=await w.repo.get(C.TRIPS,trip.tripId);
  expectFail(await w.A('meet.depart',payload,{expectedVersion:1}),'INVALID_PARAM');
  const check=expectOk(await w.A('meet.prepareDepart',payload,{expectedVersion:1}));
  assert.equal(check.canDepart,true);
  assert.deepEqual(await w.repo.get(C.TRIPS,trip.tripId),before);
  assert.equal((await w.repo.get(C.MEET_TASKS,payload.meetTaskId)).departedAt,null);
  const d=expectOk(await w.A('meet.depart',{...payload,checkId:check.checkId},{expectedVersion:1}));
  assert.equal(d.status,'departed');
  const twice=expectOk(await w.A('meet.depart',{...payload,checkId:check.checkId},{expectedVersion:1,now:w.plusMin(1)}));
  assert.equal(twice.departedAt,d.departedAt);
});
test('过期、伪造、路线变更后的检查都不能出发',async()=>{
  for(const scenario of ['expired','forged','changed']){
    const {w,trip,payload}=await setup();
    const check=expectOk(await w.A('meet.prepareDepart',payload,{expectedVersion:1}));
    if(scenario==='changed')await w.repo.update(C.TRIPS,trip.tripId,{version:2});
    const r=await w.A('meet.depart',{...payload,checkId:scenario==='forged'?'wrong':check.checkId},{expectedVersion:1,now:scenario==='expired'?w.plusMin(3):w.NOW});
    assert.equal(r.ok,false);
    assert.equal((await w.repo.get(C.MEET_TASKS,payload.meetTaskId)).departedAt,null);
  }
});
test('即使检查没过期，实际时间导致结束时间超限也必须拦截',async()=>{
  const {w,trip,payload}=await setup();
  const first=expectOk(await w.A('meet.prepareDepart',payload,{expectedVersion:1}));
  const endAt=new Date(new Date(first.tripImpact.remainingEndAt).getTime()+30000);
  await w.repo.update(C.TRIPS,trip.tripId,{version:2,constraints:[{key:'endAt',value:endAt,hardness:'hard',confirmedAt:w.NOW}]});
  const second=expectOk(await w.A('meet.prepareDepart',payload,{expectedVersion:1}));
  assert.equal(second.canDepart,true);
  expectFail(await w.A('meet.depart',{...payload,checkId:second.checkId},{expectedVersion:1,now:w.plusMin(1.5)}),'INFEASIBLE_HARD_CONSTRAINT');
  assert.equal((await w.repo.get(C.MEET_TASKS,payload.meetTaskId)).status,'arrived_all');
});
test('普通成员不能检查，地点信息缺失不能被当作可行',async()=>{
  const {w,trip,payload}=await setup();
  expectFail(await w.B('meet.prepareDepart',payload,{expectedVersion:1}),'FORBIDDEN_NOT_MEMBER');
  await w.repo.update(C.TRIPS,trip.tripId,{nodes:[{nodeId:'missing',placeId:'missing',status:'pending'}]});
  expectFail(await w.A('meet.prepareDepart',payload,{expectedVersion:1}),'INSUFFICIENT_DATA');
});
test('外部地点可用节点快照检查，不要求搜索结果入库',async()=>{
  const {w,trip,payload}=await setup();
  const saved=await w.repo.get(C.TRIPS,trip.tripId);
  assert.ok(saved.nodes[0].placeSnapshot);
  await w.repo.remove(C.PLACES,saved.nodes[0].placeId);
  assert.equal(expectOk(await w.A('meet.prepareDepart',payload,{expectedVersion:1})).canDepart,true);
});
test('有冲突时先接受候选，再重新检查，最后才写实际出发',async()=>{
  const {w,trip,payload}=await setup();
  await w.repo.update(C.TRIPS,trip.tripId,{constraints:[{key:'endAt',value:w.plusMin(25),hardness:'hard',confirmedAt:w.NOW}]});
  const blocked=expectOk(await w.A('meet.prepareDepart',payload,{expectedVersion:1}));
  assert.equal(blocked.canDepart,false);
  expectFail(await w.A('meet.depart',{...payload,checkId:blocked.checkId},{expectedVersion:1}),'INFEASIBLE_HARD_CONSTRAINT');
  const candidate=blocked.proposal.candidates.find(c=>c.feasible);
  assert.ok(candidate);
  expectOk(await w.A('trip.confirmChange',{proposalId:blocked.proposal.proposalId,candidateId:candidate.candidateId},{expectedVersion:1}));
  assert.equal((await w.repo.get(C.MEET_TASKS,payload.meetTaskId)).departedAt,null);
  const ready=expectOk(await w.A('meet.prepareDepart',payload,{expectedVersion:1}));
  assert.equal(ready.canDepart,true);
  expectOk(await w.A('meet.depart',{...payload,checkId:ready.checkId},{expectedVersion:1}));
});

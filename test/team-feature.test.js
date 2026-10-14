const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { makeWorld, makeCrew, expectOk, expectFail, C } = require('./helpers');

async function personal(w) {
  return expectOk(await w.A('trip.plan', { placeIds: ['p_zhongyang','p_fanghong','p_sofia'], startAt: w.NOW, constraints: [] }));
}
test('共同路线是独立副本；发布受队长权限保护；成员读取同一路线', async () => {
  const w = await makeWorld(), p = await personal(w), { crewId } = await makeCrew(w);
  expectFail(await w.B('team.publishTrip', { crewId, tripId: p.tripId }), 'FORBIDDEN_NOT_MEMBER');
  const before = await w.repo.get(C.TRIPS, p.tripId);
  const published = expectOk(await w.A('team.publishTrip', { crewId, tripId: p.tripId }));
  assert.notEqual(published.tripId, p.tripId);
  assert.deepEqual(await w.repo.get(C.TRIPS, p.tripId), before);
  for (const who of ['A','B','C']) assert.equal(expectOk(await w[who]('team.current', { crewId })).tripId, published.tripId);
  const teamTrip = await w.repo.get(C.TRIPS, published.tripId);
  assert.equal(teamTrip.generatedBy.planRunId, null);
  expectFail(await w.B('trip.progress', { tripId: published.tripId, nodeId: teamTrip.nodes[0].nodeId, status: 'arrived' }, { expectedVersion: 1 }), 'FORBIDDEN_NOT_MEMBER');
  expectOk(await w.A('team.progress', { tripId: published.tripId, nodeId: teamTrip.nodes[0].nodeId, status: 'arrived' }, { expectedVersion: 1 }));
  assert.deepEqual(await w.repo.get(C.TRIPS, p.tripId), before);
});
test('同时发布只绑定一条共同路线，不保留失败副本', async () => {
  const w = await makeWorld(), p = await personal(w), { crewId } = await makeCrew(w);
  const results = await Promise.all([w.A('team.publishTrip',{crewId,tripId:p.tripId}),w.A('team.publishTrip',{crewId,tripId:p.tripId})]);
  assert.equal(results.filter(r=>r.ok).length,1);
  assert.equal(await w.repo.count(C.TRIPS,{crewId}),1);
});
test('退出与解散后访问立即被拒绝；不能把集合关联到个人路线', async () => {
  const w = await makeWorld(), p = await personal(w), { crewId } = await makeCrew(w);
  expectFail(await w.A('meet.create',{crewId,tripId:p.tripId,placeId:'p_zhongyang',plannedMeetAt:w.plusMin(30)}),'INVALID_PARAM');
  expectOk(await w.B('crew.leave',{crewId}));
  expectFail(await w.B('team.current',{crewId}),'FORBIDDEN_NOT_MEMBER');
  expectFail(await w.C('team.close',{crewId}),'FORBIDDEN_NOT_MEMBER');
  expectOk(await w.A('team.close',{crewId}));
  expectFail(await w.C('loc.list',{crewId}),'FORBIDDEN_NOT_MEMBER');
  expectFail(await w.A('team.current',{crewId}),'FORBIDDEN_NOT_MEMBER');
});

function component(w, who) {
  let definition; const storage = {}; const events = []; const calls = [];
  const wx = { getStorageSync:k=>storage[k], setStorageSync:(k,v)=>storage[k]=v, removeStorageSync:k=>delete storage[k], showModal:o=>o.success({confirm:true}), switchTab:()=>{}, setClipboardData:()=>{} };
  const file=path.join(__dirname,'../miniprogram/components/team-panel/index.js');
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{
    Component:d=>definition=d, wx, require:name=>name.endsWith('stay-duration') ? {requestMinutes:()=>Promise.resolve(25)} : ({callApi:(...args)=>{calls.push(args);return w[who](...args)}}),
    Date: class extends Date { constructor(...args){super(...(args.length?args:[w.NOW]));} static now(){return w.NOW.getTime();} },
  });
  const p={data:JSON.parse(JSON.stringify(definition.data)),properties:{personalTripId:'',point:null,source:''},setData(d){Object.assign(this.data,d)},triggerEvent(name,data){events.push({name,data})},events,calls};
  for(const [k,v] of Object.entries(definition.methods))p[k]=v.bind(p);
  return p;
}
const event=kind=>({currentTarget:{dataset:{kind}}});
test('正式团队面板三人完成建队、复制路线、自动发现集合、同时确认到达',async()=>{
  const w=await makeWorld(), plan=await personal(w);
  const a=component(w,'A'),b=component(w,'B'),c=component(w,'C');
  await a.create();
  for(const p of [b,c]){p.setData({invite:a.data.crew.inviteCode});await p.join();}
  a.properties.personalTripId=plan.tripId;await a.publish();
  await b.refresh(); assert.equal(b.data.trip.tripId,a.data.trip.tripId);
  assert.equal(a.data.sharing,false);
  a.properties.point={latitude:45.77,longitude:126.62};a.properties.source='manual';
  a.setData({pointName:'集合入口',meetTime:'23:59'});await a.createMeeting();
  assert.equal(a.data.error,'');
  await b.refresh();await c.refresh();
  assert.equal(b.data.task.meetTaskId,a.data.task.meetTaskId);
  await Promise.all([b.meetAction(event('confirm')),c.meetAction(event('confirm'))]);
  await a.refresh();assert.equal(a.data.task.status,'confirmed');
  await Promise.all([a.meetAction(event('arrive')),b.meetAction(event('arrive')),c.meetAction(event('arrive'))]);
  await a.refresh();assert.equal(a.data.task.status,'arrived_all');
  await a.toggleSharing();await a.report();await b.refresh();
  assert.equal(b.events.at(-1).data.locations.length,1);
  await a.toggleSharing();await b.refresh();assert.equal(b.events.at(-1).data.locations.length,0);
  await a.prepareDepart();
  assert.equal(a.data.departureCheck.canDepart,true);
  assert.equal(a.data.task.departedAt,null);
  await a.refresh();
  assert.equal(a.data.departureCheck,null,'刷新后必须重新检查');
  await a.prepareDepart();
  await a.meetAction(event('depart'));
  assert.equal(a.data.task.status,'departed');
});
test('取消集合使旧确认失效，成员不能取消',async()=>{
  const w=await makeWorld(),{crewId}=await makeCrew(w);
  const task=expectOk(await w.A('meet.create',{crewId,placeId:'p_zhongyang',plannedMeetAt:w.plusMin(30)}));
  expectFail(await w.B('team.cancelMeeting',{meetTaskId:task.meetTaskId},{expectedVersion:1}),'FORBIDDEN_NOT_MEMBER');
  expectOk(await w.A('team.cancelMeeting',{meetTaskId:task.meetTaskId},{expectedVersion:1}));
  assert.equal((await w.repo.get(C.MEET_TASKS,task.meetTaskId)).status,'cancelled');
  assert.equal((await w.B('meet.confirm',{meetTaskId:task.meetTaskId,decision:'confirm'},{expectedVersion:1})).ok,false);
});
test('正式页面组件注册与事件绑定完整',()=>{
  for(const p of ['trip','map'])assert.equal(require('../miniprogram/pages/'+p+'/index.json').usingComponents['team-panel'],'/components/team-panel/index');
  const xml=fs.readFileSync(path.join(__dirname,'../miniprogram/components/team-panel/index.wxml'),'utf8');
  const c=component({},'A');
  for(const m of xml.matchAll(/bind(?:tap|input|change)="([^"]+)"/g))assert.equal(typeof c[m[1]],'function',m[1]);
});

test('成员不能绕过面板调整共同路线，待确认方案可在重新打开页面后读取',async()=>{
  const w=await makeWorld(),p=await personal(w),{crewId}=await makeCrew(w);
  const published=expectOk(await w.A('team.publishTrip',{crewId,tripId:p.tripId}));
  expectFail(await w.B('trip.adjust',{tripId:published.tripId,trigger:{type:'extend_stay',payload:{nodeId:p.nodes[0].nodeId,deltaMin:10}}},{expectedVersion:1}),'FORBIDDEN_NOT_MEMBER');
  const proposal=await w.repo.insert(C.CHANGE_PROPOSALS,{tripId:published.tripId,status:'proposed',baseVersion:1,candidates:[],expiresAt:w.plusMin(30)});
  assert.equal(expectOk(await w.B('team.current',{crewId})).proposal.proposalId,proposal._id);
  await w.repo.update(C.TRIPS,published.tripId,{version:2});
  assert.equal(expectOk(await w.A('team.current',{crewId})).proposal,null);
});

test('团队调整使用输入时长，不再写死十分钟',async()=>{
  const w=await makeWorld(),plan=await personal(w),a=component(w,'A');
  await a.create();a.properties.personalTripId=plan.tripId;await a.publish();
  await a.adjust({currentTarget:{dataset:{kind:'extend',id:a.data.trip.nodes[0].nodeId}}});
  const request=a.calls.find(x=>x[0]==='trip.adjust');
  assert.equal(request[1].trigger.payload.deltaMin,25);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMinutes } = require('../miniprogram/utils/stay-duration');
const { loadPage, node } = require('./page-harness');
const { makeWorld, makeCrew, expectOk, C } = require('./helpers');
test('时长接受整数分钟，拒绝空值、负数、小数、非数值与超范围输入', () => {
  assert.equal(parseMinutes(' 25 '), 25);
  for (const v of ['', ' ', '-1', '0', '1.5', '十五', 'Infinity', '1441']) assert.throws(() => parseMinutes(v));
});
function page(response) {
  const p=loadPage('miniprogram/pages/trip/index.js',{
    wx:{showModal:opts=>opts.success(response)},
    api:{'trip.adjust':{ok:true,data:{candidates:[],excludedReasons:[]}}},
  });
  p.applyTrip({tripId:'t1',version:1,nodes:[node('n1','景点','pending',0)],saved:true},'');
  return p;
}
test('个人增加和缩短停留均传递用户填写的分钟数',async()=>{
  for(const key of ['extend','shorten']){
    const p=page({confirm:true,content:'35'});
    await p.nodeAction({currentTarget:{dataset:{nodeid:'n1',key}}});
    const call=p.__calls.find(x=>x.action==='trip.adjust');
    assert.equal(call.payload.trigger.payload.deltaMin,35);
    assert.equal(call.payload.trigger.type,key==='extend'?'extend_stay':'shorten_stay');
  }
});
test('取消和无效时长不会发送调整请求，且恢复按钮状态',async()=>{
  for(const response of [{confirm:false},{confirm:true,content:'-5'}]){
    const p=page(response);
    await p.nodeAction({currentTarget:{dataset:{nodeid:'n1',key:'extend'}}});
    assert.ok(!p.__calls.some(x=>x.action==='trip.adjust'));
    assert.equal(p.data.busy,'');
  }
});

const places = [0, 1].map(i => ({ name: '停留回归地点' + i,
  location: { latitude: 45.77, longitude: 126.62 + i * 0.01 },
  visitDurationMin: { default: 60, min: 5, max: 120 } }));

test('输入确认少停分钟后个人行程立即生效，界面、云端和重新读取均显示新时长，连续调整按当前值扣减', async () => {
  const w = await makeWorld();
  const plan = expectOk(await w.A('trip.plan', { places: places.slice(0, 1), startAt: w.NOW }));
  let minutes = '15';
  const p = loadPage('miniprogram/pages/trip/index.js', {
    wx: { showModal: opts => opts.success({ confirm: true, content: minutes }) },
    api: { 'trip.adjust': (payload, options) => w.A('trip.adjust', payload, options) },
  });
  try {
    p.applyTrip(plan, '');
    const target = plan.nodes[0].nodeId;
    const event = { currentTarget: { dataset: { nodeid: target, key: 'shorten' } } };
    await p.nodeAction(event);
    assert.equal(p.data.error, '');
    assert.equal(p.data.proposal, null, '用户已明确确认的减时不再隐藏在第二次确认中');
    assert.equal(p.data.rawNodes[0].plannedStayMin, 45);
    assert.equal(p.data.busy, '', '生效后解锁按钮，允许继续调整');
    assert.equal(p.data.timeline[0].stayMin, 45);
    assert.match(p.data.note, /60.*45.*已生效/);
    let fresh = expectOk(await w.A('trip.get', { tripId: plan.tripId }));
    assert.equal(fresh.trip.nodes[0].plannedStayMin, 45);
    assert.equal(fresh.trip.version, plan.version + 1);
    minutes = '10';
    await p.nodeAction(event);
    assert.equal(p.data.rawNodes[0].plannedStayMin, 35);
    fresh = expectOk(await w.A('trip.get', { tripId: plan.tripId }));
    assert.equal(fresh.trip.nodes[0].plannedStayMin, 35);
    const proposals = await w.repo.find(C.CHANGE_PROPOSALS, { tripId: plan.tripId });
    assert.ok(proposals.every(prop => prop.status === 'confirmed' && prop.autoApplied));
    assert.ok(proposals.every(prop => prop.candidates.every(c => !c.tradeoff.has && !c.requiresConfirmation)));
  } finally { p.restore(); }
});

test('少停后仍需额外压缩其他安排时保留方案选择，不自动改写行程', async () => {
  const w = await makeWorld();
  const plan = expectOk(await w.A('trip.plan', { places, startAt: w.NOW }));
  await w.repo.update(C.TRIPS, plan.tripId, { constraints: [{ key: 'endAt', hardness: 'hard', confirmedAt: w.NOW, value: w.plusMin(40).toISOString() }] });
  const adjusted = expectOk(await w.A('trip.adjust', { tripId: plan.tripId,
    trigger: { type: 'shorten_stay', payload: { nodeId: plan.nodes[0].nodeId, deltaMin: 15 } } }));
  assert.equal(adjusted.applied, false);
  assert.ok(adjusted.feasibleCount > 0);
  assert.ok(adjusted.candidates.filter(c => c.feasible).every(c => c.tradeoff.has && c.requiresConfirmation));
  assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).nodes[0].plannedStayMin, 60);
});

test('低于停留下限或显式禁止自动生效时保留候选，并把用户带到方案选择处', async () => {
  for (const [deltaMin, extra] of [[58, {}], [15, { autoApply: 'never' }]]) {
    const w = await makeWorld();
    const plan = expectOk(await w.A('trip.plan', { places: places.slice(0, 1), startAt: w.NOW }));
    const response = await w.A('trip.adjust', { tripId: plan.tripId, ...extra,
      trigger: { type: 'shorten_stay', payload: { nodeId: plan.nodes[0].nodeId, deltaMin } } });
    const adjusted = expectOk(response);
    assert.equal(adjusted.applied, false);
    assert.ok(adjusted.candidates.every(c => c.requiresConfirmation));
    const p = loadPage('miniprogram/pages/trip/index.js', {
      wx: { showModal: opts => opts.success({ confirm: true, content: String(deltaMin) }) },
      api: { 'trip.adjust': response },
    });
    try {
      p.applyTrip(plan, '');
      await p.nodeAction({ currentTarget: { dataset: { nodeid: plan.nodes[0].nodeId, key: 'shorten' } } });
      assert.ok(p.data.proposal);
      assert.match(p.data.note, /尚未生效/);
      assert.ok(p.__wx.some(call => call.fn === 'pageScrollTo' && call.args.selector === '#adjustment-proposals'));
      assert.equal(p.data.rawNodes[0].plannedStayMin, 60);
    } finally { p.restore(); }
  }
});

test('团队少停仍经候选确认，确认后才更新共同路线时长', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);
  const plan = expectOk(await w.A('trip.plan', { places: places.slice(0, 1), startAt: w.NOW, crewId }));
  const adjusted = expectOk(await w.A('trip.adjust', { tripId: plan.tripId,
    trigger: { type: 'shorten_stay', payload: { nodeId: plan.nodes[0].nodeId, deltaMin: 15 } } }));
  assert.equal(adjusted.applied, false);
  assert.ok(adjusted.candidates.every(c => c.requiresConfirmation));
  assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).nodes[0].plannedStayMin, 60);
  const confirmed = expectOk(await w.A('trip.confirmChange', { proposalId: adjusted.proposalId,
    candidateId: adjusted.candidates.find(c => c.feasible).candidateId }, { expectedVersion: plan.version }));
  assert.equal(confirmed.nodes[0].plannedStayMin, 45);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, expectOk, C } = require('./helpers');
const { createGuideAssistant } = require('../miniprogram/utils/guide-assistant');
const { loadPage } = require('./page-harness');
const { createMapProvider } = require('../cloudfunctions/api/lib/map');
const start = { latitude: 45.77, longitude: 126.62 };
const destination = { latitude: 45.70, longitude: 126.60 };
async function fixture(overrides = {}) {
  const queries = [];
  const w = await makeWorld({ createGuideProvider: () => ({ modelAvailable: false, visionAvailable: false }),
    createMapProvider: () => ({ ...createMapProvider('fake'), searchPlaces: async args => { queries.push(args.keyword); return { ok: true,
      items: [{ title: '哈尔滨学院', address: '哈尔滨市南岗区中兴大道109号', location: destination }] }; } }), ...overrides });
  return { w, queries };
}
async function prepared(w, text = '想去哈尔滨学院') {
  const first = expectOk(await w.A('guide.ask', { text }));
  assert.equal(first.tripPlan, null); assert.equal(await w.repo.count(C.TRIPS), 0);
  return expectOk(await w.A('guide.ask', { sessionId: first.sessionId, candidateId: first.candidates[0].id }, { expectedVersion: first.version }));
}
test('无当前行程说想去哈尔滨学院：精确检索、确认地点后准备首次规划，尚不写行程', async () => {
  const { w, queries } = await fixture();
  const result = await prepared(w);
  assert.equal(queries[0], '哈尔滨学院');
  assert.equal(result.tripPlan.destination.name, '哈尔滨学院');
  assert.deepEqual(result.tripPlan.destination.point, destination);
  assert.match(result.answer, /生成.*行程|规划/);
  assert.equal(await w.repo.count(C.TRIPS), 0);
});
test('“帮我规划去某地的行程”在没有行程时进入首次规划，讲解和否定请求不进入', async () => {
  for (const text of ['我想去哈尔滨学院', '帮我规划去哈尔滨学院的行程', '想去哈尔滨学院，帮我规划行程']) {
    const { w, queries } = await fixture(); const result = await prepared(w, text);
    assert.ok(result.tripPlan); assert.equal(queries[0], '哈尔滨学院');
  }
  for (const text of ['介绍一下哈尔滨学院的历史', '我不想去哈尔滨学院', '想去哈尔滨学院吗？']) {
    const { w } = await fixture(); const result = expectOk(await w.A('guide.ask', { text }));
    assert.ok(!result.tripPlan); assert.equal(await w.repo.count(C.TRIPS), 0);
  }
});
test('模型不能把明确的首次目的地改成别的地点或执行已有行程修改', async () => {
  const { w, queries } = await fixture({ createGuideProvider: () => ({ modelAvailable: true, visionAvailable: false,
    decide: async () => ({ ok: true, data: { tool: 'propose_trip_change', tripId: 'forged' } }) }) });
  const result = await prepared(w); assert.ok(result.tripPlan); assert.equal(queries[0], '哈尔滨学院');
  assert.equal(await w.repo.count(C.CHANGE_PROPOSALS), 0);
});
test('确认首次规划经真实接口保存个人行程，重试只创建一次且读取保留出发位置', async () => {
  const { w } = await fixture();
  const result = await prepared(w);
  const state = {}, storage = {};
  const controller = createGuideAssistant({ wx: { getLocation: o => o.success(start), showModal: o => o.success({ confirm: true }),
    setStorageSync: (k, v) => { storage[k] = v; }, switchTab: o => o.success({}) }, getCrewId: () => null,
    onState: p => Object.assign(state, p), newRequestId: () => 'initial-plan-real',
    callApi: (action, payload, config) => action === 'guide.ask' ? Promise.resolve({ ok: true, data: result }) : w.A(action, payload, config) });
  controller.setText('想去哈尔滨学院'); await controller.ask(); await controller.locate();
  controller.setPlanMode(3); await controller.confirmPlan();
  assert.equal(state.error, ''); assert.equal(await w.repo.count(C.TRIPS), 1);
  const tripId = storage['zhiyou-guide-created-trip'].tripId;
  await controller.confirmPlan(); assert.equal(await w.repo.count(C.TRIPS), 1);
  const trip = expectOk(await w.A('trip.get', { tripId })).trip;
  assert.equal(trip.mode, 'personal'); assert.equal(trip.nodes[0].placeName, '哈尔滨学院');
  assert.equal(trip.nodes[0].plannedStayMin, 60); assert.deepEqual(trip.startPoint, { ...start, label: '我的位置' });
  assert.equal((await w.B('trip.get', { tripId })).ok, false);
});
function controllerFixture(overrides = {}) {
  const state = {}, calls = [], storage = {}, wxCalls = [];
  let confirm = true;
  const result = { sessionId: 'session', version: 2, candidates: [], place: { name: '哈尔滨学院', address: '哈尔滨市', point: destination },
    tripPlan: { destination: { name: '哈尔滨学院', address: '哈尔滨市', point: destination }, stayMin: 60 } };
  const controller = createGuideAssistant({ getCrewId: () => null, onState: p => Object.assign(state, p),
    newRequestId: () => 'stable-plan', wx: {
      getLocation: o => o.success(start),
      showModal: o => { assert.ok([...o.confirmText].length <= 4); o.success({ confirm }); },
      setStorageSync: (k, v) => { storage[k] = v; },
      switchTab: o => { wxCalls.push(o); o.success({}); },
      ...overrides.wx,
    }, callApi: async (action, payload, options) => { calls.push({ action, payload, options });
      if (overrides.callApi) return overrides.callApi(action, payload, options);
      return { ok: true, data: action === 'guide.ask' ? result : { tripId: 'created', version: 1, feasible: true, saved: true, nodes: [] } };
    } });
  return { controller, state, calls, storage, wxCalls, result, setConfirm: v => { confirm = v; } };
}
test('助手首次规划要求出发点并在确认后调用现有规划接口，成功跳至行程页', async () => {
  const e = controllerFixture(); e.controller.setText('想去哈尔滨学院'); await e.controller.ask();
  await e.controller.confirmPlan(); assert.match(e.state.error, /出发/); assert.equal(e.calls.length, 1);
  await e.controller.locate(); e.controller.setPlanStay('90');
  e.setConfirm(false); await e.controller.confirmPlan(); assert.equal(e.calls.length, 1);
  e.setConfirm(true); await e.controller.confirmPlan();
  const call = e.calls.find(c => c.action === 'trip.plan');
  assert.deepEqual(call.payload.startPoint, { ...start, label: '我的位置' });
  assert.deepEqual(call.payload.places[0].location, destination); assert.equal(call.payload.stayMin, 90);
  assert.equal(call.payload.crewId, undefined); assert.ok(call.options.requestId);
  assert.equal(e.storage['zhiyou-guide-created-trip'].tripId, 'created');
  assert.equal(e.wxCalls[0].url, '/pages/trip/index');
});
test('首次规划网络失败保持相同请求和出发时间重试，跳转失败重开已有行程不再次生成', async () => {
  let attempts = 0, opens = 0;
  const e = controllerFixture({ callApi: async action => {
    if (action === 'guide.ask') return { ok: true, data: e.result };
    if (++attempts === 1) throw new Error('网络断开');
    return { ok: true, data: { tripId: 'created', version: 1, saved: true, feasible: true } };
  }, wx: { switchTab: o => { if (++opens === 1) o.fail({}); else o.success({}); } } });
  e.controller.setText('想去哈尔滨学院'); await e.controller.ask(); await e.controller.locate();
  await e.controller.confirmPlan(); await e.controller.confirmPlan();
  const calls = e.calls.filter(c => c.action === 'trip.plan');
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
  assert.match(e.state.error, /打开行程/);
  await e.controller.confirmPlan(); assert.equal(attempts, 2); assert.equal(opens, 2);
});
test('隐藏期间的首次规划确认不发送请求，拒绝定位后可在地图中选择出发点', async () => {
  let modal;
  const e = controllerFixture({ wx: { showModal: o => { modal = o; }, getLocation: o => o.fail({}),
    chooseLocation: o => o.success({ ...start, name: '出发位置' }) } });
  e.controller.setText('想去哈尔滨学院'); await e.controller.ask(); await e.controller.locate();
  assert.ok(!e.state.center); await e.controller.chooseStart(); assert.equal(e.state.center.label, '出发位置');
  const pending = e.controller.confirmPlan(); e.controller.hide(); modal.success({ confirm: true }); await pending;
  assert.equal(e.calls.some(c => c.action === 'trip.plan'), false);
});
test('清除会话后丢弃迟到的创建结果；创建已完成而跳转失败时仍可重新打开', async () => {
  let release;
  const e = controllerFixture({ callApi: action => action === 'guide.ask' ? Promise.resolve({ ok: true, data: e.result })
    : action === 'guide.close' ? Promise.resolve({ ok: true, data: {} }) : new Promise(r => { release = r; }) });
  e.controller.setText('想去哈尔滨学院'); await e.controller.ask(); await e.controller.locate();
  const pending = e.controller.confirmPlan(); await new Promise(r => setImmediate(r));
  await e.controller.clear(); release({ ok: true, data: { tripId: 'old', version: 1, saved: true } }); await pending;
  assert.equal(e.state.result, null); assert.equal(e.storage['zhiyou-guide-created-trip'], undefined); assert.equal(e.wxCalls.length, 0);
});
test('行程页消费首次规划交接ID，重新鉴权读取行程，保留出发点并显示目的地', async () => {
  const page = loadPage('miniprogram/pages/trip/index.js', { storage: { 'zhiyou-guide-created-trip': { tripId: 'created', version: 1 } },
    api: { 'trip.get': { ok: true, data: { trip: { tripId: 'created', version: 1, startPoint: start,
      nodes: [{ nodeId: 'n', seq: 0, status: 'pending', placeName: '哈尔滨学院', location: destination, plannedStayMin: 60 }],
      plannedEndAt: '2026-10-17T09:00:00.000Z' } } } } });
  try { await page.onShow(); assert.equal(page.data.trip.tripId, 'created'); assert.deepEqual(page.data.startPoint, start);
    assert.equal(page.data.currentLeg.to, '哈尔滨学院'); assert.equal(page.__storage['zhiyou-guide-created-trip'], undefined);
    assert.equal(page.__storage['zhiyou-active-trip'].tripId, 'created');
  } finally { page.restore(); }
});
test('首次规划交接读取失败可重试，隐藏期间的旧交接结果不覆盖现有页面', async () => {
  let release, attempt = 0;
  const page = loadPage('miniprogram/pages/trip/index.js', { storage: { 'zhiyou-guide-created-trip': { tripId: 'created' } },
    api: { 'trip.get': () => ++attempt === 1 ? { ok: false, error: { message: '暂时断网' } } : new Promise(r => { release = r; }) } });
  try {
    await page.onShow(); assert.match(page.data.error, /断网/); assert.ok(page.__storage['zhiyou-guide-created-trip']);
    const pending = page.onShow(); page.onHide();
    release({ ok: true, data: { trip: { tripId: 'created', version: 1, nodes: [] } } }); await pending;
    assert.equal(page.data.trip, null); assert.ok(page.__storage['zhiyou-guide-created-trip']);
  } finally { page.restore(); }
});

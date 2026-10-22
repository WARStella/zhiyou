'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, expectOk, C } = require('./helpers');
const { loadPage } = require('./page-harness');
const { createGuideAssistant } = require('../miniprogram/utils/guide-assistant');

async function fixture() {
  const w = await makeWorld({ createGuideProvider: () => ({ modelAvailable: false, visionAvailable: false }) });
  const plan = expectOk(await w.A('trip.plan', { placeIds: ['p_zhongyang', 'p_sofia'], startAt: w.NOW }));
  const calls = [], wxCalls = [], state = {}, storage = {};
  let tripId = plan.tripId, crewId = null, confirm = true;
  const controller = createGuideAssistant({ wx: {
    showModal: options => { assert.ok([...options.confirmText].length <= 4); options.success({ confirm }); },
    openLocation: options => { wxCalls.push(options); options.success({}); },
    setStorageSync: (key, value) => { storage[key] = value; },
  }, getCrewId: () => crewId, getTripId: () => tripId, onState: patch => Object.assign(state, patch),
  callApi: (action, payload, options) => { calls.push({ action, payload, options }); return w.A(action, payload, options); } });
  return { w, plan, calls, wxCalls, controller, state, storage, setConfirm: value => { confirm = value; }, setTrip: id => { tripId = id; } };
}
test('助手内提交修改、显示候选、取消确认保持原行程、确认后更新并可问新下一站', async () => {
  const e = await fixture();
  e.controller.setText('下一站少待十分钟'); await e.controller.ask();
  assert.equal(e.state.tripChange.tripId, e.plan.tripId); assert.ok(e.state.changeCandidates[0].nodeSummary.includes('分钟'));
  const candidate = e.state.changeCandidates.find(c => c.feasible);
  e.setConfirm(false); await e.controller.confirmChange(candidate.candidateId);
  assert.equal(e.calls.some(call => call.action === 'trip.confirmChange'), false);
  e.setConfirm(true); await e.controller.confirmChange(candidate.candidateId);
  assert.equal(e.state.tripChange, null); assert.match(e.state.result.answer, /已确认并生效/);
  const call = e.calls.find(call => call.action === 'trip.confirmChange');
  assert.equal(call.options.expectedVersion, 1); assert.ok(call.options.requestId);
  assert.equal(e.storage['zhiyou-guide-trip-refresh'].tripId, e.plan.tripId);
  e.controller.setText('下一站去哪？'); await e.controller.ask();
  assert.equal(e.state.result.tripContext.version, 2);
  assert.equal(e.state.result.tripContext.next.plannedStayMin, e.plan.nodes[0].plannedStayMin - 10);
});
test('助手内逐步补充模糊地点和分钟数，未补全前不写行程，过期版本确认会失效', async () => {
  const e = await fixture();
  e.controller.setText('这里少待一会儿'); await e.controller.ask();
  assert.equal(e.state.tripChange.needsClarification, true);
  let q = e.state.changeQuestions[0]; assert.equal(q.kind, 'node');
  e.controller.answerChange(q.key, q.options[0].value); await e.controller.continueChange();
  q = e.state.changeQuestions[0]; assert.equal(q.kind, 'minutes');
  e.controller.answerChange(q.key, '10'); await e.controller.continueChange();
  assert.ok(e.state.tripChange.proposalId); assert.equal((await e.w.repo.get(C.TRIPS, e.plan.tripId)).version, 1);
  await e.w.repo.update(C.TRIPS, e.plan.tripId, { version: 2 });
  await e.controller.confirmChange(e.state.changeCandidates.find(c => c.feasible).candidateId);
  assert.match(e.state.error, /更新|失效/); assert.equal(e.state.tripChange, null);
});
test('切换当前行程后清除旧提案；隐藏期间的确认回调不会修改行程', async () => {
  const e = await fixture();
  e.controller.setText('下一站少待十分钟'); await e.controller.ask();
  e.setTrip('another-trip'); e.controller.show();
  assert.equal(e.state.result, null); assert.equal(e.state.tripChange, null);
  let modal;
  const state = {}, calls = [];
  const change = { tripId: 'trip', baseVersion: 1, proposalId: 'proposal', candidates: [{ candidateId: 'candidate', feasible: true, nodes: [] }] };
  const c = createGuideAssistant({ wx: { showModal: options => { modal = options; } }, getCrewId: () => null,
    onState: patch => Object.assign(state, patch), callApi: async (action) => { calls.push(action); return { ok: true, data: { sessionId: 's', version: 1, candidates: [], tripChange: change } }; } });
  c.setText('少待十分钟'); await c.ask(); const pending = c.confirmChange('candidate');
  c.hide(); modal.success({ confirm: true }); await pending;
  assert.deepEqual(calls, ['guide.ask']); assert.equal(state.busy, false);
});
test('导航按钮重新查询授权目的地，只使用服务端坐标；界面跨行程避免迟到导航', async () => {
  const e = await fixture(); await e.controller.navigate('next');
  assert.equal(e.calls[0].action, 'guide.navigation'); assert.equal(e.calls[0].payload.target, 'next');
  assert.equal(e.wxCalls[0].latitude, e.plan.nodes[0].location.latitude);
  assert.equal(e.wxCalls[0].longitude, e.plan.nodes[0].location.longitude);
  const state = {}; let resolve, opens = 0, current = 'one';
  const c = createGuideAssistant({ wx: { openLocation: () => { opens++; } }, getCrewId: () => null, getTripId: () => current,
    onState: patch => Object.assign(state, patch), callApi: () => new Promise(r => { resolve = r; }) });
  const pending = c.navigate('next'); current = 'two'; c.show(); resolve({ ok: true, data: { point: { latitude: 1, longitude: 2 } } }); await pending;
  assert.equal(opens, 0);
});
test('照片计数只主动提交，零人仍显示结果，取消/隐藏时不回填图片和检测框', async () => {
  const state = {}, calls = [];
  let release;
  const photo = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=';
  const c = createGuideAssistant({ getCrewId: () => null, onState: patch => Object.assign(state, patch), wx: {
    chooseMedia: o => o.success({ tempFiles: [{ tempFilePath: '/photo.jpg' }] }), compressImage: o => o.success({ tempFilePath: '/photo.jpg' }),
    getFileSystemManager: () => ({ stat: o => o.success({ stats: { size: 68 } }), readFile: o => o.success({ data: photo }) }),
  }, callApi: (action, payload) => { calls.push({ action, payload }); return new Promise(r => { release = r; }); } });
  await c.choose(); assert.equal(calls.length, 0);
  const first = c.countPeople(); await new Promise(r => setImmediate(r));
  assert.equal(calls[0].action, 'guide.countPeople');
  release({ ok: true, data: { count: 0, boxes: [], estimated: true } }); await first;
  assert.equal(state.crowdResult.count, 0); assert.equal(state.crowdImagePath, '/photo.jpg');
  const pending = c.countPeople(); await new Promise(r => setImmediate(r)); c.hide();
  release({ ok: true, data: { count: 1, boxes: [] } }); await pending;
  assert.equal(state.crowdResult, null); assert.equal(state.crowdImagePath, '');
  c.show(); c.setText('照片里有多少人？'); const asked = c.ask(); await new Promise(r => setImmediate(r));
  assert.equal(calls.at(-1).action, 'guide.countPeople'); assert.equal(calls.some(call => call.action === 'guide.ask'), false);
  release({ ok: true, data: { count: 0, boxes: [], estimated: true } }); await asked;
  assert.equal(state.crowdResult.count, 0);
});
test('助手页面按入口选择行程上下文，行程页返回时刷新助手已确认的新版本', async () => {
  const requests = [];
  const guide = loadPage('miniprogram/pages/guide/index.js', { storage: { 'zhiyou-active-trip': { tripId: 'personal' } }, api: {
    'guide.ask': payload => { requests.push(payload); return { ok: true, data: { sessionId: 's', version: 1, candidates: [] } }; },
  } });
  try { guide.onLoad({ scope: 'team' }); guide.onShow(); guide.onText({ detail: { value: '下一站去哪？' } }); await guide.ask();
    assert.equal(requests[0].scope, 'team'); assert.equal(requests[0].tripId, null);
  } finally { guide.onUnload(); guide.restore(); }
  const page = loadPage('miniprogram/pages/trip/index.js', { storage: { 'zhiyou-guide-trip-refresh': { tripId: 'trip', version: 2 } } });
  try {
    let refreshed; page.setData({ trip: { tripId: 'trip', version: 1 } }); page.refreshTextTrip = id => { refreshed = id; };
    await page.onShow(); assert.equal(refreshed, 'trip'); assert.equal(page.__storage['zhiyou-guide-trip-refresh'], undefined);
  } finally { page.restore(); }
});
test('助手修改后刷新行程仍保留原出发点和新节点的首段交通信息', async () => {
  const startPoint = { latitude: 45.77, longitude: 126.62, label: '原出发点' };
  const nodes = [{ nodeId: 'one', placeId: 'p', placeName: '新第一站', status: 'pending', plannedStayMin: 40,
    location: { latitude: 45.78, longitude: 126.63 }, travelFromStart: true, travelFromPrevMin: 5,
    travelFromPrevMeters: 400, travelMode: 'walking', travelSource: 'upstream', seq: 0 }];
  const page = loadPage('miniprogram/pages/trip/index.js', { api: {
    'trip.get': { ok: true, data: { trip: { version: 2, nodes, plannedEndAt: '2026-10-17T09:00:00.000Z' } } },
  } });
  try {
    page.setData({ trip: { tripId: 'trip', version: 1 }, startPoint });
    await page.refreshTextTrip('trip', '已同步助手确认的新行程');
    assert.deepEqual(page.data.startPoint, startPoint); assert.equal(page.data.startLeg.minutes, 5);
    assert.equal(page.data.trip.version, 2); assert.equal(page.data.rawNodes[0].placeName, '新第一站');
  } finally { page.restore(); }
});

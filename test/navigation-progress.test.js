'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, node } = require('./page-harness');
const { makeWorld, expectOk, expectFail, C, defaultMapFactory } = require('./helpers');
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
const NODES = [node('a', '第一站', 'pending', 0), node('b', '第二站', 'pending', 1), node('c', '第三站', 'pending', 2)];
function response(page, payload, options) {
  const target = page.data.rawNodes.find(n => n.nodeId === payload.nodeId) || page.data.rawNodes.find(n => n.status === 'pending');
  return { ok: true, data: { ok: true, tripId: page.data.trip.tripId, version: options && options.expectedVersion,
    nodeId: target.nodeId, placeName: target.placeName, to: target.location, from: payload.fromPoint || page.data.startPoint,
    route: { decoded: true, points: [page.data.startPoint, target.location], steps: [{ seq: 1, instruction: '前往' + target.placeName }] } } };
}
function fixture(override = {}) {
  let page;
  page = loadPage('miniprogram/pages/trip/index.js', { api: {
    'trip.legRoute': (payload, options) => response(page, payload, options),
    'trip.progress': payload => ({ ok: true, data: { tripId: 'trip', version: page.data.trip.version + 1,
      nodes: page.data.rawNodes.map(n => n.nodeId === payload.nodeId ? { ...n, status: payload.status } : n) } }), ...override,
  } });
  page.applyTrip({ tripId: 'trip', version: 1, nodes: NODES, startPoint: { latitude: 45.75, longitude: 126.6 },
    startLeg: { minutes: 10 }, summary: { endAt: '2026-10-17T09:00:00Z' } });
  return page;
}
test('导航中标记到了后清除旧路线与指引，返回行程页自动获取下一站路线', async () => {
  const p = fixture();
  try {
    await p.startNavigation(); await settle(); assert.equal(p.data.navLeg.placeName, '第一站');
    await p.nodeProgress({ currentTarget: { dataset: { nodeid: 'a', status: 'arrived' } } }); await settle();
    assert.equal(p.data.currentLeg.to, '第二站'); assert.equal(p.data.navLeg, null);
    assert.notEqual(p.data.routeMap.nextName, '第一站');
    p.onHide(); await p.onShow(); await settle();
    assert.equal(p.data.navLeg.placeName, '第二站'); assert.equal(p.data.navLeg.steps[0].instruction, '前往第二站');
    const call = p.__calls.filter(c => c.action === 'trip.legRoute').at(-1);
    assert.equal(call.payload.nodeId, 'b'); assert.equal(call.options.expectedVersion, 2);
  } finally { p.onUnload && p.onUnload(); p.restore(); }
});
test('最后一站到达或全部跳过后退出导航，不保留旧折线、旧指引或错误的第一站', async () => {
  const p = fixture();
  try {
    await p.startNavigation(); await settle();
    p.setData({ rawNodes: NODES.map((n, i) => ({ ...n, status: i === 2 ? 'arrived' : 'done' })), trip: { tripId: 'trip', version: 2 } });
    p.rebuildFromNodes(); await settle();
    assert.equal(p.data.currentLeg, null); assert.equal(p.data.navLeg, null); assert.equal(p.data.navLoading, false);
    assert.notEqual(p.data.routeMap.navMode, true);
    p.setData({ rawNodes: NODES.map(n => ({ ...n, status: 'skipped' })) }); p.rebuildFromNodes();
    assert.equal(p.data.currentLeg, null);
  } finally { p.onUnload && p.onUnload(); p.restore(); }
});
test('已到达站后跳过中间一站，下一目标直接选后面的待前往站', () => {
  const p = fixture();
  try {
    p.setData({ rawNodes: [{ ...NODES[0], status: 'arrived' }, { ...NODES[1], status: 'skipped' }, NODES[2]] });
    p.rebuildFromNodes(); assert.equal(p.data.currentLeg.toNodeId, 'c');
    assert.equal(p.data.currentLeg.to, '第三站'); assert.equal(p.data.currentLeg.minutes, null);
  } finally { p.restore(); }
});
test('退出导航、隐藏页面或切换路线后，迟到的路线响应不能重新出现', async () => {
  for (const action of ['stop', 'hide', 'replace', 'reset']) {
    let release, old;
    const p = fixture({ 'trip.legRoute': (payload, options) => { old = response(p, payload, options); return new Promise(r => { release = r; }); } });
    try {
      p.startNavigation(); await settle(); assert.equal(p.data.navLoading, true);
      if (action === 'stop') p.stopNavigation();
      else if (action === 'hide') p.onHide();
      else if (action === 'reset') p.resetTrip();
      else p.applyTrip({ tripId: 'new', version: 1, nodes: [NODES[1]], startPoint: p.data.startPoint });
      release(old); await settle();
      assert.equal(p.data.navLeg, null); assert.equal(p.data.navLoading, false);
      assert.notEqual(p.data.routeMap && p.data.routeMap.navMode, true);
    } finally { p.onUnload && p.onUnload(); p.restore(); }
  }
});
test('还在获取定位时退出导航，不继续发送旧路线请求；重新规划清除旧当前行程ID', async () => {
  const p = fixture(); let locate;
  try {
    p.tryLocate = () => new Promise(r => { locate = r; });
    const pending = p.startNavigation(); p.stopNavigation(); locate(null); await pending;
    assert.equal(p.__calls.some(c => c.action === 'trip.legRoute'), false);
    p.resetTrip(); assert.equal(p.__storage['zhiyou-active-trip'], undefined);
    assert.equal(p.data.currentLeg, null);
  } finally { p.restore(); }
});
test('导航请求尚未完成时记录进度，旧目标结果不会覆盖新的下一站', async () => {
  let release, old;
  const p = fixture({ 'trip.legRoute': (payload, options) => { old = response(p, payload, options); return new Promise(r => { release = r; }); } });
  try {
    p.startNavigation(); await settle();
    await p.nodeProgress({ currentTarget: { dataset: { nodeid: 'a', status: 'arrived' } } }); await settle();
    release(old); await settle(); assert.equal(p.data.navLeg, null); assert.equal(p.data.currentLeg.to, '第二站');
  } finally { p.onUnload && p.onUnload(); p.restore(); }
});
test('后端默认导航跳过已到达/跳过站点，从真实已到达站出发而非跳过站', async () => {
  let captured;
  const w = await makeWorld({ createMapProvider: (...args) => ({ ...defaultMapFactory(...args),
    walkingRoute: async (from, to) => { captured = { from, to }; return { ok: true, route: { decoded: false, points: [], steps: [] } }; } }) });
  const plan = expectOk(await w.A('trip.plan', { placeIds: ['p_zhongyang', 'p_sofia', 'p_fanghong'], startAt: w.NOW }));
  await w.repo.update(C.TRIPS, plan.tripId, { nodes: plan.nodes.map((n, i) => ({ ...n, status: i === 0 ? 'arrived' : i === 1 ? 'skipped' : 'pending' })) });
  const nav = expectOk(await w.A('trip.legRoute', { tripId: plan.tripId }, { expectedVersion: 1 }));
  assert.equal(nav.nodeId, plan.nodes[2].nodeId); assert.deepEqual(captured.from, plan.nodes[0].location);
  await w.repo.update(C.TRIPS, plan.tripId, { nodes: plan.nodes.map(n => ({ ...n, status: 'skipped' })) });
  expectFail(await w.A('trip.legRoute', { tripId: plan.tripId }), 'NOT_FOUND');
});
test('后端路线查询期间进度版本变化时拒绝返回旧导航', async () => {
  let release;
  const w = await makeWorld({ createMapProvider: (...args) => ({ ...defaultMapFactory(...args),
    walkingRoute: () => new Promise(r => { release = r; }) }) });
  const plan = expectOk(await w.A('trip.plan', { placeIds: ['p_zhongyang', 'p_sofia'], startAt: w.NOW,
    startPoint: { latitude: 45.76, longitude: 126.6 } }));
  const pending = w.A('trip.legRoute', { tripId: plan.tripId }, { expectedVersion: 1 }); await settle();
  await w.repo.update(C.TRIPS, plan.tripId, { version: 2 });
  release({ ok: true, route: { decoded: false, points: [], steps: [] } });
  expectFail(await pending, 'VERSION_CONFLICT');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchLegRoute } = require('../cloudfunctions/api/lib/navigation');
const { createTencentProvider } = require('../cloudfunctions/api/lib/map/tencent');
const { createAmapTransitProvider, parseTransit } = require('../cloudfunctions/api/lib/transit/amap');
const { loadPage, node } = require('./page-harness');
const { makeWorld, C, expectOk, defaultMapFactory } = require('./helpers');
const from = { latitude: 45.7, longitude: 126.6 }, to = { latitude: 45.8, longitude: 126.7 };

// 合成接口样本，专门覆盖多方案、备选线路与缺失接驳，非真实接口录音。
function transitBody() {
  const make = (duration, subway, name) => ({ duration: String(duration), distance: '2000', cost: '0', walking_distance: '100', segments: [{
    walking: { distance: '100', duration: '120', steps: [{ instruction: '沿路步行到站', distance: '100', polyline: '126.6,45.7;126.61,45.71' }] },
    bus: { buslines: [{ name, type: subway ? '地铁线路' : '普通公交线路', distance: '1900', duration: '300', via_num: '2',
      via_stops: [{ name: '中间站' }], departure_stop: { name: '甲站' }, arrival_stop: { name: '乙站' }, polyline: '126.62,45.72;126.7,45.8' }] },
    entrance: { name: '1号口' }, exit: { name: '2号口' },
  }] });
  return { status: '1', infocode: '10000', info: 'OK', route: { transits: [make(1200, true, '慢地铁'), make(600, false, '快公交'), make(900, true, '快地铁')] } };
}
const amap = body => createAmapTransitProvider({ key: 'unit-test', http: async () => ({ json: body }) });

test('步行、骑行、驾车分别调用对应端点，选同一方式的最快路线并保持分钟单位', async () => {
  for (const mode of ['walking', 'bicycling', 'driving']) {
    const urls = [];
    const provider = createTencentProvider({ key: 'unit-test', http: async url => {
      urls.push(url); return { json: { status: 0, result: { routes: [
        { distance: 1000, duration: 30, polyline: [45.7, 126.6, 1000, 1000] },
        { distance: 800, duration: 10, polyline: [45.7, 126.6, 2000, 2000], steps: [{ instruction: '到达目的地' }] },
      ] } } };
    } });
    const result = await fetchLegRoute({ mode, from, to, makeRoadProvider: () => provider });
    assert.equal(result.ok, true); assert.equal(result.mode, mode); assert.equal(result.durationMinutes, 10);
    assert.equal(result.route.durationMinutes, 10); assert.equal(result.distanceMeters, 800);
    assert.match(urls[0], new RegExp('/' + mode + '/')); assert.equal(result.route.steps[0].instruction, '到达目的地');
  }
});

test('公交选最快总耗时，地铁只在含地铁方案中选最快，保留零票价和进出站顺序', async () => {
  for (const [mode, minutes, line] of [['transit', 10, '快公交'], ['subway', 15, '快地铁']]) {
    const result = await fetchLegRoute({ mode, from, to, makeTransitProvider: () => amap(transitBody()) });
    assert.equal(result.ok, true); assert.equal(result.durationMinutes, minutes); assert.deepEqual(result.transit.lineNames, [line]);
    assert.equal(result.transit.costYuan, 0); assert.equal(result.transit.transferCount, 0);
    assert.deepEqual(result.route.steps.map(s => s.kind), ['walking', 'entrance', 'transit', 'exit']);
    assert.match(result.route.steps[2].instruction, /甲站 上车.*乙站 下车.*途经 2 站/);
    assert.equal(result.route.steps[2].viaStopText, '中间站');
  }
});

test('公交无地铁方案、方式不支持、接口失败时明确失败，绝不查询步行顶替', async () => {
  const body = transitBody(); body.route.transits = [body.route.transits[1]];
  const subway = await fetchLegRoute({ mode: 'subway', from, to, makeTransitProvider: () => amap(body) });
  assert.equal(subway.ok, false); assert.equal(subway.reason, 'NO_TRANSIT_ROUTE');
  let walkingCalls = 0;
  const unsupported = await fetchLegRoute({ mode: 'driving', from, to, makeRoadProvider: () => ({ walkingRoute: () => { walkingCalls++; } }) });
  assert.equal(unsupported.ok, false); assert.equal(unsupported.requestCount, 0); assert.equal(walkingCalls, 0);
  const failed = await fetchLegRoute({ mode: 'transit', from, to, makeTransitProvider: () => ({ route: async () => ({ ok: false, reason: 'TIMEOUT', requestCount: 1 }) }) });
  assert.equal(failed.reason, 'TIMEOUT'); assert.equal(failed.requestCount, 1);
  body.route.transits[0].segments[0].railway = { id: 'train', name: '铁路接驳' };
  const train = await fetchLegRoute({ mode: 'transit', from, to, makeTransitProvider: () => amap(body) });
  assert.equal(train.ok, false); assert.equal(train.reason, 'UNSUPPORTED_TRANSIT_SEGMENT');
});

test('同一公交段的备选线路不算换乘，缺失或非法折线不跨段拼接', () => {
  const body = transitBody(); const seg = body.route.transits[0].segments[0];
  seg.bus.buslines.push({ ...seg.bus.buslines[0], name: '备选车', polyline: '0,0;1,1' });
  seg.walking.steps.push({ instruction: '继续走', distance: '20' });
  const parsed = parseTransit(body, { includeGeometry: true });
  assert.equal(parsed.best.transferCount, 0); assert.deepEqual(parsed.best.lineNames, ['慢地铁']);
  assert.equal(parsed.best.route.polylines.length, 2); assert.equal(parsed.best.route.partial, true);
  seg.walking.steps[0].polyline = '126.6,45.7;999,999;126.61,45.71';
  const invalid = parseTransit(body, { includeGeometry: true }).best.route;
  assert.equal(invalid.polylines.length, 1); assert.equal(invalid.polylines[0].mode, 'subway');
});

test('最快公交不能被更快的纯步行方案占用，缺少Key请求计数为零', async () => {
  const body = transitBody(); body.route.transits.unshift({ duration: '1', distance: '1', segments: [] });
  const result = await fetchLegRoute({ mode: 'transit', from, to, makeTransitProvider: () => amap(body) });
  assert.equal(result.durationMinutes, 10);
  const noKey = createTencentProvider({ key: '', http: () => { throw Error('不应请求'); } });
  const failed = await fetchLegRoute({ mode: 'driving', from, to, makeRoadProvider: () => noKey });
  assert.equal(failed.ok, false); assert.equal(failed.requestCount, 0);
});

test('路线预览分别画步行接驳与乘车段，并保留真实行程进度；无几何时只画端点', async () => {
  const result = await fetchLegRoute({ mode: 'transit', from, to, makeTransitProvider: () => amap(transitBody()) });
  const page = loadPage('miniprogram/pages/trip/index.js');
  try {
    const nodes = [node('a', '甲', 'done', 0), node('b', '乙', 'pending', 1)];
    const nav = { mode: 'transit', modeLabel: '公交', fromLocation: from, toLocation: to, route: result.route };
    const map = page.buildRouteMap(nodes, from, nav);
    assert.equal(map.reachedCount, 1); assert.equal(map.totalCount, 2); assert.equal(map.polyline.length, 2);
    assert.equal(map.polyline[0].dottedLine, true); assert.equal(map.polyline[1].dottedLine, false);
    const missing = page.buildRouteMap(nodes, from, { ...nav, route: { decoded: false, points: [] } });
    assert.equal(missing.navMode, true); assert.equal(missing.polyline.length, 0); assert.equal(missing.markers.length, 2);
  } finally { page.restore(); }
});

test('客户端请求传所选方式，显示本次路线耗时，不覆盖计划时间；模式变化使旧响应失效', async () => {
  let release;
  const page = loadPage('miniprogram/pages/trip/index.js', { api: { 'trip.legRoute': payload => new Promise(r => { release = () => r({ ok: true, data: { ok: true, mode: payload.mode, from, to, durationMinutes: 15, route: { decoded: true, points: [from, to], steps: [] } } }); }) } });
  try {
    page.applyTrip({ tripId: 't', version: 1, nodes: [node('a', '甲', 'pending', 0)], startPoint: from, startLeg: { mode: 'driving', minutes: 20 } });
    const request = page.startNavigation(); for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    assert.equal(page.__calls.at(-1).payload.mode, 'driving'); release(); await request;
    assert.equal(page.data.navLeg.modeLabel, '驾车'); assert.equal(page.data.navLeg.durationMinutes, 15); assert.equal(page.data.currentLeg.minutes, 20);
    const old = page.startNavigation(); for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    page.setData({ startLeg: { ...page.data.startLeg, rawMode: 'bicycling' } }); page.rebuildFromNodes({ refreshNavigation: false }); release(); await old;
    assert.equal(page.data.navLeg, null);
  } finally { page.onUnload(); page.restore(); }
});

test('后端路线读取默认使用行程的骑行或公交方式，按实际请求数记账', async () => {
  let biking = 0;
  const w = await makeWorld({ createMapProvider: (...args) => ({ ...defaultMapFactory(...args), bicyclingRoute: async () => { biking++; return { ok: true, requestCount: 1, durationMinutes: 5, distanceMeters: 1000, route: {} }; } }), createTransitProvider: () => amap(transitBody()) });
  const plan = expectOk(await w.A('trip.plan', { placeIds: ['p_zhongyang', 'p_sofia'], startAt: w.NOW }));
  await w.repo.update(C.TRIPS, plan.tripId, { nodes: plan.nodes.map(n => ({ ...n, travelMode: 'bicycling' })) });
  const first = expectOk(await w.A('trip.legRoute', { tripId: plan.tripId, fromPoint: from }, { expectedVersion: 1 }));
  assert.equal(first.mode, 'bicycling');
  for (const mode of ['bicycling', 'transit']) {
    await w.repo.update(C.TRIPS, plan.tripId, { nodes: plan.nodes.map((n, i) => ({ ...n, status: i ? 'pending' : 'done', travelMode: mode })) });
    const route = expectOk(await w.A('trip.legRoute', { tripId: plan.tripId }, { expectedVersion: 1 }));
    assert.equal(route.ok, true); assert.equal(route.mode, mode); assert.equal(route.mapApiCalls, 1);
  }
  assert.equal(biking, 2);
});

test('确认方式修改后保留未改边的选择器，更新已生效方式和时长，清除临时选择', () => {
  const page = loadPage('miniprogram/pages/trip/index.js');
  try {
    const nodes = [node('a', '甲', 'done', 0), { ...node('b', '乙', 'pending', 1), travelMode: 'walking', travelFromPrevMin: 30 }];
    page.applyTrip({ tripId: 't', version: 1, nodes, legOptions: [{ toNodeId: 'b', toPlaceId: 'p_b', chosenMode: 'walking', options: [{ mode: 'walking', minutes: 30 }, { mode: 'driving', minutes: 10 }] }] });
    page.setData({ legModes: { p_b: 'driving' } });
    page.applyTrip({ tripId: 't', version: 2, nodes: [nodes[0], { ...nodes[1], travelMode: 'driving', travelFromPrevMin: 8 }] });
    assert.equal(page.data.legPicker.length, 1); assert.equal(page.data.legPicker[0].selected, 'driving');
    assert.equal(page.data.legPicker[0].options.find(o => o.mode === 'driving').minutes, 8);
    assert.deepEqual(page.data.legModes, {}); assert.equal(page.data.rawNodes[0].status, 'done');
  } finally { page.restore(); }
});

test('原行程修改出行方式重算后续到达时间，确认前不生效，完成记录与实际时间保持一致', async () => {
  const w = await makeWorld({ createMapProvider: (...args) => ({ ...defaultMapFactory(...args), distanceMatrix: async (origin, destinations, mode) => ({
    ok: true, requestCount: 1, elements: destinations.map(() => ({ usable: true, distanceMeters: 1500, durationMinutes: mode === 'bicycling' ? 10 : 25 })) }),
  }) });
  const plan = expectOk(await w.A('trip.plan', { placeIds: ['p_zhongyang', 'p_sofia', 'p_fanghong'], startAt: w.NOW }));
  expectOk(await w.A('trip.progress', { tripId: plan.tripId, nodeId: plan.nodes[0].nodeId, status: 'done' }, { expectedVersion: 1 }));
  const before = await w.repo.get(C.TRIPS, plan.tripId);
  const proposal = expectOk(await w.A('trip.adjust', { tripId: plan.tripId, autoApply: 'never', trigger: { type: 'batch', payload: { operations: [
    { type: 'change_travel_mode', payload: { nodeId: plan.nodes[1].nodeId, mode: 'bicycling' } },
  ] } } }, { expectedVersion: 2 }));
  assert.equal(proposal.applied, false); assert.deepEqual((await w.repo.get(C.TRIPS, plan.tripId)).nodes, before.nodes);
  const candidate = proposal.candidates.find(c => c.feasible); assert.ok(candidate);
  const done = expectOk(await w.A('trip.confirmChange', { proposalId: proposal.proposalId, candidateId: candidate.candidateId }, { expectedVersion: 2 }));
  assert.deepEqual(done.nodes[0], before.nodes[0]); assert.equal(done.nodes[1].travelMode, 'bicycling'); assert.equal(done.nodes[1].travelFromPrevMin, 10);
  assert.notEqual(new Date(done.nodes[1].plannedArriveAt).getTime(), new Date(before.nodes[1].plannedArriveAt).getTime());
  assert.notEqual(new Date(done.nodes[2].plannedArriveAt).getTime(), new Date(before.nodes[2].plannedArriveAt).getTime());
});

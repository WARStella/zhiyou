'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, node } = require('./page-harness');
const { makeWorld, makeCrew, expectOk } = require('./helpers');
const { suggestOrder } = require('../miniprogram/utils/route-order');
const { parseTransit } = require('../cloudfunctions/api/lib/transit/amap');
const { legTravelTimes } = require('../cloudfunctions/api/lib/leg-times');
const fixture = require('./fixtures/upstream/direction-transit-integrated-harbin.json');
const flush = () => new Promise(resolve => setImmediate(resolve));
const point = { latitude: 45.77, longitude: 126.62 };
const place = (id, lng) => ({ itemId: id, name: id, location: { latitude: 45.77, longitude: lng } });

test('集合点无实地核验数据也能推荐并发起，路线不显示核验前置警告', async () => {
  const w = await makeWorld({ seedPlaces: [{ _id: 'p_map', name: '地图集合点', location: point,
    category: 'meeting', confidence: 'normal', verifiedAt: null, dataSource: 'tencent-poi' }] });
  const crew = expectOk(await w.A('crew.create', { name: '地图选点队', shareLocationDefault: true }));
  await require('./helpers').enableLocation(w, 'A', crew.crewId);
  expectOk(await w.A('loc.report', { crewId: crew.crewId, point, source: 'gps' }));
  const recommended = expectOk(await w.A('meet.recommend', { crewId: crew.crewId }));
  assert.equal(recommended.candidates[0].placeId, 'p_map');
  const task = expectOk(await w.A('meet.create', { crewId: crew.crewId, point,
    placeName: '手动集合点', method: 'manual', plannedMeetAt: w.plusMin(30) }));
  assert.ok(task.meetTaskId);
  const planned = expectOk(await w.A('trip.plan', { placeIds: ['p_map'], startAt: w.NOW }));
  assert.equal(planned.saved, true);
  assert.equal(planned.unverifiedNotice.scope, 'sourceInfo');
  assert.match(planned.unverifiedNotice.warning, /无需实地核验/);
  assert.equal(planned.warnings.some(w => w.code === 'PLACE_UNVERIFIED'), false);
  const fs = require('node:fs');
  const path = require('node:path');
  const template = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/trip/index.wxml'), 'utf8');
  assert.doesNotMatch(template, /集合点要求实地核验|不可集合|不能作为集合点/);
});

test('预选顺序遵循需求中的地点顺序，不受候选距离排序影响', () => {
  const p = loadPage('miniprogram/pages/trip/index.js');
  p.applyAutoSelect([place('B', 126.63), place('A', 126.65)], { itemIds: ['A', 'B'], items: [], note: '' });
  assert.deepEqual(p.data.selected.map(x => x.itemId), ['A', 'B']);
});

for (const useRequested of [true, false]) {
  test(`优化顺序不同时先弹窗，选择${useRequested ? '需求' : '优化'}顺序后才规划`, async () => {
    let modal;
    const p = loadPage('miniprogram/pages/trip/index.js', {
      wx: { showModal: o => { modal = o; } },
      api: { 'trip.plan': { ok: true, data: { saved: false, conflicts: [] } } },
    });
    p.setData({ selected: [place('A', 126.68), place('B', 126.63)] });
    p.tryLocate = () => Promise.resolve(point);
    const planning = p.createTrip();
    await flush();
    assert.ok(modal);
    assert.ok(modal.confirmText.length <= 4 && modal.cancelText.length <= 4, '原生弹窗按钮文字限制为四个字');
    assert.equal(p.__calls.length, 0, '用户选顺序前不能保存路线');
    assert.match(modal.content, /A → B/);
    assert.match(modal.content, /B → A/);
    modal.success({ confirm: useRequested, cancel: !useRequested });
    await planning;
    const request = p.__calls.find(c => c.action === 'trip.plan');
    assert.deepEqual(request.payload.places.map(x => x.name), useRequested ? ['A', 'B'] : ['B', 'A']);
    assert.deepEqual(p.data.selected.map(x => x.itemId), ['A', 'B'], '用户需求仍保留');
  });
}

test('顺序相同不弹窗；定位缺失时保留第一站', async () => {
  const p = loadPage('miniprogram/pages/trip/index.js', { wx: { showModal: () => assert.fail('不应弹窗') } });
  const selected = [place('A', 126.63), place('B', 126.68)];
  p.setData({ selected });
  assert.deepEqual(await p.chooseRouteOrder(point), selected);
  const reordered = suggestOrder([place('A', 126.68), place('B', 126.62), place('C', 126.67)], null);
  assert.deepEqual(reordered.map(x => x.itemId), ['A', 'C', 'B']);
});

test('弹窗失败时停止规划，不静默采用优化顺序', async () => {
  const p = loadPage('miniprogram/pages/trip/index.js', { wx: { showModal: o => o.fail({}) } });
  p.setData({ selected: [place('A', 126.68), place('B', 126.63)] });
  p.tryLocate = () => Promise.resolve(point);
  await p.createTrip();
  assert.equal(p.__calls.length, 0);
  assert.equal(p.data.loading, false);
});

function teamPage(w, who, crewId) {
  const actions = ['crew.get', 'team.current', 'meet.get', 'meet.create', 'meet.confirm', 'meet.arrive',
    'meet.prepareDepart', 'meet.depart', 'team.cancelMeeting', 'loc.list', 'loc.report', 'loc.stopSharing'];
  const api = Object.fromEntries(actions.map(action => [action, (payload, options) => w[who](action, payload, options)]));
  return loadPage('miniprogram/pages/map/index.js', { storage: { 'zhiyou-active-crew': crewId }, api });
}

test('队伍页经真实接口发现集合，确认、到达和出发均携带正确版本', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);
  const created = expectOk(await w.A('meet.create', { crewId, point, placeName: '南门', plannedMeetAt: w.plusMin(30) }));
  for (const who of ['B', 'C']) {
    const p = teamPage(w, who, crewId);
    await p.loadCrew();
    assert.equal(p.data.teamError, '');
    assert.equal(p.data.meetTask.meetTaskId, created.meetTaskId);
    p.meetAction({ currentTarget: { dataset: { kind: 'confirm' } } });
    await flush();
    assert.equal(p.data.teamError, '');
    assert.equal(p.__calls.find(c => c.action === 'meet.confirm').options.expectedVersion, 1);
  }
  for (const who of ['A', 'B', 'C']) {
    const p = teamPage(w, who, crewId);
    await p.loadCrew();
    p.meetAction({ currentTarget: { dataset: { kind: 'arrive' } } });
    await flush();
    assert.equal(p.data.teamError, '');
  }
  const p = teamPage(w, 'A', crewId);
  await p.loadCrew();
  assert.equal(p.data.meetTask.status, 'arrived_all');
  assert.equal(p.data.isInitiator, true);
  p.prepareDepart();
  await flush();
  assert.equal(p.data.teamError, '');
  assert.equal(p.data.departureCheck.canDepart, true);
  p.confirmDepart();
  await flush();
  assert.equal(p.data.teamError, '');
  assert.equal(expectOk(await w.A('meet.get', { meetTaskId: created.meetTaskId })).meetTask.status, 'departed');
});

test('拒绝集合调用 meet.confirm，取消集合后允许重新发起', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);
  const created = expectOk(await w.A('meet.create', { crewId, point, placeName: '南门', plannedMeetAt: w.plusMin(30) }));
  const b = teamPage(w, 'B', crewId);
  await b.loadCrew();
  b.meetAction({ currentTarget: { dataset: { kind: 'decline' } } });
  await flush();
  assert.equal(b.data.teamError, '');
  const task = expectOk(await w.B('meet.get', { meetTaskId: created.meetTaskId })).meetTask;
  assert.equal(task.participants.find(m => m.userId === 'openid_B').status, 'declined');
  const a = teamPage(w, 'A', crewId);
  await a.loadCrew();
  a.meetAction({ currentTarget: { dataset: { kind: 'cancel' } } });
  await flush();
  await a.loadCrew();
  assert.equal(a.data.teamError, '');
  assert.equal(a.data.meetTask, null);
});

test('共享开关与个人状态一致，主动共享会开启并上报，对方地图能画出位置', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);
  expectOk(await w.A('loc.stopSharing', { crewId, sharing: false }));
  const a = teamPage(w, 'A', crewId);
  await a.loadCrew();
  assert.equal(a.data.sharing, false);
  a.setData({ myPoint: point, mySource: 'gps' });
  await a.reportMyLocation();
  await flush();
  assert.equal(a.data.teamError, '');
  assert.ok(a.__calls.find(c => c.action === 'loc.report').payload.point);
  const b = teamPage(w, 'B', crewId);
  await b.loadCrew();
  b.refreshTeamLocations();
  await flush();
  const marker = b.data.markers.find(m => m.id >= 2000 && m.id < 3000);
  assert.ok(marker);
  assert.equal(marker.latitude, point.latitude);
  b.setData({ myPoint: { latitude: 45.80, longitude: 126.70 } });
  b.showTeamOnMap();
  assert.equal(b.__wx.find(c => c.fn === 'includePoints').args.points.length, 2);
  expectOk(await w.A('loc.stopSharing', { crewId, sharing: false }));
  b.refreshTeamLocations();
  await flush();
  assert.equal(b.data.markers.some(m => m.id >= 2000 && m.id < 3000), false);
});

test('过期位置明确标注，不静默消失；退出队伍清空图钉', async () => {
  const p = loadPage('miniprogram/pages/map/index.js', { api: {
    'loc.list': { ok: true, data: { members: [{ userId: 'B', point, hasLocation: true, stale: true, source: 'gps' }] } },
  } });
  p.setData({ crewId: 'c1' });
  p.refreshTeamLocations();
  await flush();
  assert.equal(p.data.markers.find(m => m.id === 2000).alpha, 0.25, '过期头像明显变淡');
  assert.match(p.data.markers.find(m => m.id === 2000).callout.content, /上次位置（已过期）/);
  p.loadCrew();
  assert.equal(p.data.markers.some(m => m.id === 2000), false);
});

test('公交摘要为线路号和总价，地铁标签覆盖时间轴、出发段和当前路段', () => {
  const p = loadPage('miniprogram/pages/trip/index.js');
  const bus = { lineNames: ['365路(起点--终点)', '643路（起点--终点）', '815路'], costYuan: 6 };
  const metro = { lineNames: ['地铁2号线(起点--终点)'], costYuan: 3, hasSubway: true };
  const nodes = [node('a', 'A', 'pending', 0), node('b', 'B', 'pending', 1, { travelMode: 'transit', travelTransit: bus })];
  p.applyTrip({ tripId: 't1', version: 1, nodes, startPoint: point, startLeg: { mode: 'transit', transit: metro, minutes: 30 } });
  assert.equal(p.data.timeline[0].legToNext.transitText, '365/643/815 总价6元');
  assert.equal(p.data.startLeg.mode, '地铁');
  assert.equal(p.data.currentLeg.mode, '地铁');
  assert.equal(p.data.currentLeg.transitText, '地铁2号线 总价3元');
});

test('同一公共交通请求同时提供最快方案与可选地铁方案，缓存保留线路票价', async () => {
  const parsed = parseTransit(fixture.body);
  assert.ok(parsed.bestSubway && parsed.bestSubway.hasSubway);
  const destination = { _id: 'dest', location: { latitude: 45.80, longitude: 126.53 } };
  const r = await legTravelTimes({ fromPoint: point, toPlace: destination,
    providers: { transit: { route: async () => ({ ok: true, ...parsed }) } },
    opts: { transitCity: '0451', preferredMode: 'subway' },
  });
  assert.equal(r.calls.transit, 1);
  assert.equal(r.choice.chosen.mode, 'subway');
  assert.ok(r.choice.chosen.transit.lineNames.length);
  const { withLegRecord, findLegRecord } = require('../cloudfunctions/api/lib/geo');
  const cached = withLegRecord({}, 'dest', { ...r.choice.chosen, source: 'upstream' });
  const record = findLegRecord({ walkableTo: cached }, 'dest', 'subway');
  assert.deepEqual(record.transit, r.choice.chosen.transit);
});

test('上游仅有公交时不虚构地铁路线，保留无法选择的原因', async () => {
  const body = structuredClone(fixture.body);
  body.route.transits = body.route.transits.filter(t =>
    !t.segments.some(seg => (seg.bus && seg.bus.buslines || []).some(line => /地铁/.test(line.type))));
  const parsed = parseTransit(body);
  assert.equal(parsed.bestSubway, null);
  const result = await legTravelTimes({ fromPoint: point,
    toPlace: { _id: 'dest', location: { latitude: 45.80, longitude: 126.53 } },
    providers: { transit: { route: async () => ({ ok: true, ...parsed }) } },
    opts: { transitCity: '0451', preferredMode: 'subway' },
  });
  assert.equal(result.options.some(o => o.mode === 'subway'), false);
  assert.match(result.unavailable.find(o => o.mode === 'subway').reason, /没有.*地铁/);
  assert.equal(result.choice.matchedPreference, false);
});

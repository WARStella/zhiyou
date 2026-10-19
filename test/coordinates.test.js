'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, node } = require('./page-harness');
const { makeWorld, makeCrew, expectOk, expectFail, C } = require('./helpers');
const { isValidPoint } = require('../miniprogram/utils/coordinates');
const { coord } = require('../cloudfunctions/api/lib/geo');
const { decodePolyline } = require('../cloudfunctions/api/lib/map/polyline');
const recording = require('./fixtures/upstream/direction-walking-central-avenue.json');

const good = { latitude: 45.77, longitude: 126.62 };
const bad = { latitude: 45.77, longitude: 126620000 };
const invalidPoints = [null, {}, bad, { latitude: 126.62, longitude: 45.77 },
  { latitude: 90.001, longitude: 0 }, { latitude: -90.001, longitude: 0 },
  { latitude: 0, longitude: 180.001 }, { latitude: 0, longitude: -180.001 },
  { latitude: NaN, longitude: 0 }, { latitude: 0, longitude: Infinity },
  { latitude: 0, longitude: -Infinity }, { latitude: '45.77', longitude: 126.62 }];

function assertMapSafe(map) {
  if (map.center) assert.ok(isValidPoint(map.center), '地图中心必须有效');
  for (const p of [...(map.markers || []), ...(map.includePoints || [])]) {
    assert.ok(isValidPoint(p), '图钉和视野坐标必须有效');
  }
  for (const line of map.polyline || []) {
    assert.ok(line.points.every(isValidPoint), '折线的每个点必须有效');
  }
}

test('前后端拒绝越界、非有限值和字符串，保留合法边界且不交换坐标', () => {
  for (const p of invalidPoints) {
    assert.equal(isValidPoint(p), false);
    assert.equal(coord(p), null);
  }
  for (const p of [good, { latitude: 0, longitude: 0 },
    { latitude: 90, longitude: 180 }, { latitude: -90, longitude: -180 }]) {
    assert.equal(isValidPoint(p), true);
    assert.deepEqual(coord(p), p);
  }
  assert.deepEqual(coord({ lat: good.latitude, lng: good.longitude }), good);
});

test('队伍地图跳过异常图钉与集合连线，仍展示正常队员', () => {
  const p = loadPage('miniprogram/pages/map/index.js');
  p.setData({ myPoint: bad, meetingPoint: { ...bad, name: '坏点' }, me: 'me' });
  p.teamLocations = [{ userId: 'bad', point: bad }, { userId: 'ok', point: good }];
  p.refreshMarkers();
  assertMapSafe(p.data);
  assert.equal(p.data.markers.length, 1);
  assert.deepEqual(p.data.polyline, []);
  assert.match(p.data.coordinateError, /坐标异常/);
  p.showTeamOnMap();
  assert.ok(p.__wx.find(c => c.fn === 'includePoints').args.points.every(isValidPoint));
  p.setData({ myPoint: good, meetingPoint: null });
  p.teamLocations = [];
  p.refreshMarkers();
  assert.equal(p.data.coordinateError, '', '重新定位后消除警告');
});

test('队伍地图关闭未经业务校验的内置定位图钉，定位只显示一个自绘图钉', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const template = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/map/index.wxml'), 'utf8');
  const mapTag = template.match(/<map\s[\s\S]*?>/)[0];
  assert.match(mapTag, /show-location="\{\{false\}\}"/, '组件不得另行绘制未经过校验的定位图钉');
  const p = loadPage('miniprogram/pages/map/index.js', { wx: {
    getSetting: o => o.success({ authSetting: { 'scope.userLocation': true } }),
    getLocation: o => o.success(good),
  } });
  p.autoLocate();
  assert.deepEqual(p.data.center, good, '自动定位也要同步地图中心');
  assert.equal(p.data.markers.filter(m => m.id === 999).length, 1);
  const move = p.__wx.find(c => c.fn === 'moveToLocation');
  assert.ok(move);
  assert.equal(move.args.latitude, good.latitude);
  assert.equal(move.args.longitude, good.longitude, '镜头显式使用与图钉相同的已校验坐标');
});

test('回到我的位置不重新取定位，坐标无效时不调用地图接口', () => {
  const p = loadPage('miniprogram/pages/map/index.js', { wx: {
    getLocation: () => assert.fail('回中不能另行读取未经校验的定位'),
  } });
  for (const point of invalidPoints) {
    p.setData({ myPoint: point });
    assert.equal(p.recenterOnMe(), false);
  }
  assert.equal(p.__wx.filter(c => c.fn === 'moveToLocation').length, 0);
  p.setData({ myPoint: good, mySource: 'manual' });
  assert.equal(p.recenterOnMe(), true);
  assert.deepEqual(p.data.center, good);
  assert.equal(p.__wx.filter(c => c.fn === 'moveToLocation').length, 1);
});

test('异常坐标诊断包含来源，同一异常不随刷新反复输出', t => {
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  const p = loadPage('miniprogram/pages/map/index.js');
  p.setData({ myPoint: bad });
  p.refreshMarkers();
  p.refreshMarkers();
  assert.equal(logs.length, 1);
  assert.match(logs[0][0], /coordinate-guard-v2/);
  assert.equal(logs[0][1].source, 'myPoint');
  assert.deepEqual(logs[0][1].points, [bad]);
  p.setData({ myPoint: good });
  p.refreshMarkers();
  p.setData({ myPoint: bad });
  p.refreshMarkers();
  assert.equal(logs.length, 2, '恢复后再出异常需重新报告');
});

test('旧服务端返回异常队员位置或新服务端异常标记时均不向地图传坏坐标', async () => {
  const p = loadPage('miniprogram/pages/map/index.js', { api: {
    'loc.list': { ok: true, data: { members: [
      { userId: 'bad', point: bad, hasLocation: true },
      { userId: 'history', invalidLocation: true, hasLocation: false, point: null },
      { userId: 'ok', point: good, hasLocation: true, stale: true },
    ] } },
  } });
  p.setData({ crewId: 'c' });
  await p.refreshTeamLocations();
  assert.equal(p.data.markers.length, 1);
  assert.equal(p.data.markers[0].alpha, 0.25, '过期位置保留明显变淡的头像');
  assert.match(p.data.coordinateError, /坐标异常/);
  assertMapSafe(p.data);
  p.loadCrew(); // 没有存储中的队伍：清掉旧队伍的异常提示
  assert.equal(p.data.coordinateError, '');
});

test('异常 GPS、地图中心、跨页聚焦与集合点不会污染地图状态', async () => {
  const p = loadPage('miniprogram/pages/map/index.js', {
    wx: { getLocation: o => o.success(bad) }, mapCenter: bad,
    storage: { 'zhiyou-focus-place': { ...bad, at: Date.now() } },
  });
  p.useGps();
  assert.equal(p.data.myPoint, null);
  assert.match(p.data.note, /坐标异常/);
  p.readCenter(point => assert.equal(point, null));
  assert.equal(p.applyPendingFocus(), false);
  assert.equal(p.setAutoMeetingPoint({ ...bad, name: '集合点' }), false);
  p.setData({ places: [{ ...bad, placeId: 'bad', name: '坏点' }] });
  assert.equal(p.selectPlace('bad'), false);
  assert.equal(p.data.meetingPoint, null);
  assertMapSafe(p.data);
  const trip = loadPage('miniprogram/pages/trip/index.js', { wx: { getLocation: o => o.success(bad) } });
  assert.equal(await trip.tryLocate(), null);
});

test('行程地图忽略历史异常节点和起点，全部异常时不创建地图', () => {
  const p = loadPage('miniprogram/pages/trip/index.js');
  const nodes = [node('bad', '坏点', 'pending', 1, { location: bad }), node('ok', '正常点', 'pending', 2)];
  const map = p.buildRouteMap(nodes, bad, null);
  assertMapSafe(map);
  assert.equal(map.markers.length, 1);
  assert.equal(p.buildRouteMap([nodes[0]], bad, null), null);
});

test('历史导航路径含越界点时整段停画，合法终点仍显示为终点', () => {
  const p = loadPage('miniprogram/pages/trip/index.js');
  const map = p.buildRouteMap([node('ok', '正常点', 'pending', 1)], bad, {
    route: { decoded: true, points: [good, bad, good] },
    toLocation: good, placeName: '正常终点',
  });
  assertMapSafe(map);
  assert.deepEqual(map.polyline, []);
  assert.match(map.legend, /坐标异常/);
  assert.equal(map.markers[0].callout.content, '正常终点');
});

test('真实路线录音被污染或截断时不输出异常坐标，也不跨过坏点拼接路径', () => {
  const raw = recording.body.result.routes[0].polyline;
  const decoded = decodePolyline(raw);
  assert.ok(decoded.length > 10 && decoded.every(isValidPoint));
  for (const corrupted of [
    [good, bad, good], [good, null, good],
    [...raw.slice(0, 3)], [raw[0], raw[1], 0, 1e12],
    [NaN, raw[1], ...raw.slice(2)],
  ]) assert.deepEqual(decodePolyline(corrupted), []);
});

test('地图检索中的越界 POI 坐标不可作为有效位置返回', async () => {
  const { createTencentProvider } = require('../cloudfunctions/api/lib/map/tencent');
  const provider = createTencentProvider({ key: 'test-key', http: async () => ({
    httpStatus: 200, json: { status: 0, data: [
      { id: 'bad', title: '异常地点', location: { lat: bad.latitude, lng: bad.longitude } },
      { id: 'ok', title: '正常地点', location: { lat: good.latitude, lng: good.longitude } },
    ] },
  }) });
  const result = await provider.searchPlaces({ keyword: '地点', region: '哈尔滨' });
  assert.equal(result.ok, true);
  assert.equal(result.items[0].location, null);
  assert.deepEqual(result.items[1].location, good);
});

test('位置上报和集合创建拒绝越界坐标且不写入，合法别名坐标规范化保存', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);
  for (const point of invalidPoints.filter(Boolean)) {
    expectFail(await w.A('loc.report', { crewId, point, source: 'gps' }), 'INVALID_PARAM');
    expectFail(await w.A('meet.create', { crewId, point, placeName: '坏点', plannedMeetAt: w.plusMin(30) }), 'INVALID_PARAM');
  }
  assert.equal(await w.repo.count(C.LOCATIONS, {}), 0);
  assert.equal(await w.repo.count(C.MEET_TASKS, {}), 0);
  const point = { lat: good.latitude, lng: good.longitude };
  const location = expectOk(await w.A('loc.report', { crewId, point, source: 'manual' }));
  assert.deepEqual((await w.repo.get(C.LOCATIONS, location.locationId)).point, good);
  const meeting = expectOk(await w.A('meet.create', { crewId, point, placeName: '好点', plannedMeetAt: w.plusMin(30) }));
  assert.deepEqual((await w.repo.get(C.MEET_TASKS, meeting.meetTaskId)).point, good);
});

test('服务端屏蔽历史越界位置，仍保留关闭共享的隐私规则', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);
  await w.repo.insert(C.LOCATIONS, { userId: 'openid_B', crewId, point: bad, reportedAt: w.NOW, source: 'gps' });
  expectOk(await w.C('loc.report', { crewId, point: good, source: 'gps' }));
  const list = expectOk(await w.A('loc.list', { crewId })).members;
  const b = list.find(m => m.userId === 'openid_B');
  assert.equal(b.point, null);
  assert.equal(b.hasLocation, false);
  assert.equal(b.invalidLocation, true);
  assert.deepEqual(list.find(m => m.userId === 'openid_C').point, good);
  expectOk(await w.B('loc.stopSharing', { crewId, sharing: false }));
  const hidden = expectOk(await w.A('loc.list', { crewId })).members.find(m => m.userId === 'openid_B');
  assert.equal(hidden.sharingOff, true);
  assert.equal(Object.hasOwn(hidden, 'point'), false);
  assert.equal(Object.hasOwn(hidden, 'invalidLocation'), false);
});

test('规划拒绝异常出发点，合法别名坐标在返回的起点中规范化', async () => {
  const w = await makeWorld();
  const [place] = await w.repo.find(C.PLACES, {});
  const placeIds = [place._id];
  expectFail(await w.A('trip.plan', { placeIds, startPoint: bad, startAt: w.NOW }), 'INVALID_PARAM');
  const result = expectOk(await w.A('trip.plan', { placeIds, startPoint: { lat: good.latitude, lng: good.longitude }, startAt: w.NOW }));
  assert.deepEqual(result.startPoint, { ...good, label: '我的位置' });
});

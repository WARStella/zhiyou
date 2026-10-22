'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, makeCrew, enableLocation, expectOk, C, createMapProvider } = require('./helpers');
const { loadPage } = require('./page-harness');
const meet = require('../cloudfunctions/api/domain/meet');

const A = { latitude: 45.77, longitude: 126.61 };
const B = { latitude: 45.774, longitude: 126.616 };
const MID = { latitude: (A.latitude + B.latitude) / 2, longitude: (A.longitude + B.longitude) / 2 };
const place = (id, point, extra) => Object.assign({ _id: id, name: id, location: point, category: 'meeting', confidence: 'normal' }, extra);
const noMap = () => { throw new Error('几何中心推荐不应初始化地图服务'); };
const emptyMap = () => ({ searchPlaces: async () => ({ ok: true, items: [], requestCount: 0 }) });

async function pair(opts, points) {
  const w = await makeWorld(Object.assign({ seedPlaces: [], createMapProvider: emptyMap }, opts));
  const crew = expectOk(await w.A('crew.create', { name: '中心推荐测试' }));
  expectOk(await w.B('crew.join', { inviteCode: crew.inviteCode }));
  const positions = points || [A, B];
  for (const [i, who] of ['A', 'B'].entries()) {
    await enableLocation(w, who, crew.crewId);
    expectOk(await w[who]('loc.report', { crewId: crew.crewId, point: positions[i], source: 'gps' }));
  }
  return { w, crewId: crew.crewId };
}

test('两人搜索无结果时直接推荐坐标中点，不写入地点库', async () => {
  const { w, crewId } = await pair();
  const rec = expectOk(await w.A('meet.recommend', { crewId }));
  assert.deepEqual(rec.center, MID);
  assert.equal(rec.candidateSource, 'geometric-center');
  assert.equal(rec.candidates.length, 1);
  assert.equal(rec.candidates[0].placeId, null, '不能给临时中心编造库内地点 ID');
  assert.deepEqual(rec.candidates[0].point, MID);
  assert.equal(rec.candidates[0].centerDistanceMeters, 0);
  assert.equal(rec.candidates[0].estimates.length, 2);
  assert.equal(await w.repo.count(C.PLACES, {}), 0);
  const decision = await w.repo.findOne(C.DECISIONS, { kind: 'meet_recommend' });
  assert.equal(decision.mapApiCalls, 0);
  assert.deepEqual(decision.inputDigest.center, MID);
});

test('三人中心使用全部成员坐标的算术平均值', async () => {
  const w = await makeWorld({ seedPlaces: [], createMapProvider: emptyMap });
  const { crewId } = await makeCrew(w);
  const points = [A, B, { latitude: 45.772, longitude: 126.615 }];
  for (const [i, who] of ['A', 'B', 'C'].entries()) {
    expectOk(await w[who]('loc.report', { crewId, point: points[i], source: 'manual' }));
  }
  const rec = expectOk(await w.A('meet.recommend', { crewId }));
  assert.deepEqual(rec.center, {
    latitude: points.reduce((s, p) => s + p.latitude, 0) / 3,
    longitude: points.reduce((s, p) => s + p.longitude, 0) / 3,
  });
  assert.deepEqual(rec.candidates[0].point, rec.center);
  assert.equal(rec.candidates[0].estimates.length, 3);
});

test('库内地点按离平均中心的距离排序，即使另一个点的最远步行时间更短', () => {
  const now = new Date('2026-10-15T02:00:00Z');
  const point = offset => ({ latitude: 45.77, longitude: 126.61 + offset });
  const members = [0, 0, 0.009].map((offset, i) => ({ userId: String(i), point: point(offset), reportedAt: now }));
  const rec = meet.recommendMeetPoints({ members, ctx: { now }, candidatePlaces: [
    place('minimax', point(0.009 / 2)), place('centroid', point(0.009 / 3)),
  ] });
  assert.equal(rec.candidates[0].placeId, 'centroid');
  assert.ok(rec.candidates[0].maxWalkMin > rec.candidates[1].maxWalkMin, '夹具必须真正区分新旧规则');
  assert.equal(rec.candidates[0].candidateSource, 'library');
});

test('搜索结果超过中心 1 公里时，排除并回落中心', async () => {
  const { w, crewId } = await pair({ createMapProvider: () => ({ searchPlaces: async () => ({
    ok: true, requestCount: 0, items: [{ poiId: 'far', title: '远处地点', location: { latitude: 46, longitude: 127 } }],
  }) }) });
  const rec = expectOk(await w.A('meet.recommend', { crewId }));
  assert.equal(rec.candidateSource, 'geometric-center');
  assert.deepEqual(rec.candidates[0].point, MID);
  assert.ok(rec.excluded.some(e => e.reason === 'OUTSIDE_CENTER_RADIUS'));
});

test('各类地点统一按中心距离比较，不因先找到多个地铁站就漏掉更近商场', async () => {
  const calls = [];
  const { w, crewId } = await pair({ createMapProvider: () => ({ searchPlaces: async input => {
    calls.push(input);
    const items = input.keyword === '地铁站'
      ? Array.from({ length: 20 }, (_, i) => ({ poiId: 'station_' + i, title: '地铁站' + i, location: A }))
      : input.keyword === '商场' ? [{ poiId: 'mall', title: '中心商场', location: MID }] : [];
    return { ok: true, items, requestCount: 0 };
  } }) });
  const rec = expectOk(await w.A('meet.recommend', { crewId }));
  assert.equal(rec.candidateSource, 'poi-search');
  assert.equal(rec.candidates[0].placeId, 'poi_mall');
  assert.equal(rec.candidates.length, 21);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.deepEqual(call.center, MID);
    assert.equal(call.radius, 1000);
    assert.equal(call.autoExtend, false);
    assert.equal(call.orderBy, 'distance');
  }
});

test('任一成员缺位置时不以其余成员的中心冒充全队中心', async () => {
  let initialized = false;
  const { w, crewId } = await pair({ createMapProvider: () => { initialized = true; return noMap(); } });
  const crew = await w.repo.get(C.CREWS, crewId);
  expectOk(await w.C('crew.join', { inviteCode: crew.inviteCode }));
  await enableLocation(w, 'C', crewId);
  const rec = expectOk(await w.A('meet.recommend', { crewId }));
  assert.equal(rec.candidates.length, 0);
  assert.equal(rec.center, null);
  assert.equal(rec.reason, 'MEMBER_NO_LOCATION');
  assert.equal(initialized, false, '缺位置时连地图服务都不应初始化');
});

test('任一成员关闭共享时明确提示，不能偷偷缩小中心计算的人数', async () => {
  let initialized = false;
  const { w, crewId } = await pair({ createMapProvider: () => { initialized = true; return noMap(); } });
  expectOk(await w.B('loc.stopSharing', { crewId, sharing: false }));
  const rec = expectOk(await w.A('meet.recommend', { crewId }));
  assert.equal(rec.candidates.length, 0);
  assert.equal(rec.center, null);
  assert.equal(rec.reason, 'LOCATION_SHARING_OFF');
  assert.equal(initialized, false);
});

test('真实腾讯请求禁用自动扩大、按距离排序，去重并把四次请求写入决策', async () => {
  const urls = [];
  const { w, crewId } = await pair({ createMapProvider: () => createMapProvider('tencent', {
    key: 'TEST_KEY_FOR_CENTER_ONLY',
    http: async url => {
      urls.push(new URL(url));
      const body = { status: 0, data: [{ id: 'same', title: '中心商场',
        location: { lat: MID.latitude, lng: MID.longitude }, _distance: 0 }] };
      return { httpStatus: 200, json: body, rawBody: JSON.stringify(body) };
    },
  }) });
  const rec = expectOk(await w.A('meet.recommend', { crewId }));
  assert.equal(urls.length, 4);
  for (const url of urls) {
    assert.equal(url.searchParams.get('boundary'), `nearby(${MID.latitude},${MID.longitude},1000,0)`);
    assert.equal(url.searchParams.get('orderby'), '_distance');
  }
  assert.equal(rec.candidates.length, 1, '同一 POI 出现在多个类别时不能重复推荐');
  assert.equal(rec.candidateSource, 'poi-search');
  assert.equal(rec.search.mapApiCalls, 4);
  const decision = await w.repo.findOne(C.DECISIONS, { kind: 'meet_recommend' });
  assert.equal(decision.mapApiCalls, 4);
  assert.equal(await w.repo.count(C.PLACES, {}), 0, '搜索结果不落库');
});

test('库内有地点也继续搜索，选择更靠近中心的搜索结果', async () => {
  const { w, crewId } = await pair({ seedPlaces: [place('library', A)],
    createMapProvider: () => ({ searchPlaces: async () => ({ ok: true, requestCount: 0,
      items: [{ poiId: 'near', title: '中心地点', location: MID }] }) }),
  });
  const rec = expectOk(await w.A('meet.recommend', { crewId }));
  assert.equal(rec.candidates[0].placeId, 'poi_near');
  assert.ok(rec.candidates.some(c => c.placeId === 'library'));
});

for (const failure of ['missing-key', 'network', 'provider']) {
  test(`搜索失败（${failure}）仍回落平均中心，并准确记录失败与请求数`, async () => {
    const { w, crewId } = await pair({ createMapProvider: failure === 'provider' ? noMap : () => createMapProvider('tencent', {
      key: failure === 'missing-key' ? '' : 'TEST_KEY_FOR_CENTER_ONLY',
      http: async () => { throw new Error('test network failed'); },
    }) });
    const rec = expectOk(await w.A('meet.recommend', { crewId }));
    assert.equal(rec.candidateSource, 'geometric-center');
    assert.deepEqual(rec.candidates[0].point, MID);
    assert.equal(rec.search.status, 'failed');
    assert.equal(rec.search.mapApiCalls, failure === 'network' ? 4 : 0);
    assert.ok(rec.search.failures.length > 0);
    assert.match(rec.candidateNote, /检索未完整成功/);
    assert.doesNotMatch(rec.candidateNote, /未找到可用地点/);
  });
}

test('位置过期时提示重新上报，重新上报后中心恢复可用', async () => {
  const { w, crewId } = await pair();
  const later = w.plusMin(3);
  const expired = expectOk(await w.A('meet.recommend', { crewId }, { now: later }));
  assert.equal(expired.reason, 'LOCATION_STALE');
  assert.equal(expired.candidates.length, 0);
  for (const [i, who] of ['A', 'B'].entries()) {
    expectOk(await w[who]('loc.report', { crewId, point: [A, B][i], source: 'gps' }, { now: later }));
  }
  const fresh = expectOk(await w.A('meet.recommend', { crewId }, { now: later }));
  assert.deepEqual(fresh.candidates[0].point, MID);
});

test('历史非法坐标不能参与平均中心计算', () => {
  const now = new Date();
  const rec = meet.recommendMeetPoints({
    members: [{ userId: 'a', point: A, reportedAt: now },
      { userId: 'b', point: { latitude: 45, longitude: 126000 }, reportedAt: now }],
    ctx: { now }, candidatePlaces: [], fallbackToCenter: true,
  });
  assert.equal(rec.reason, 'MEMBER_NO_LOCATION');
  assert.equal(rec.center, null);
  assert.equal(rec.candidates.length, 0);
});

test('不限制队员到集合点的距离，相距较远仍能生成平均中心', async () => {
  const points = [A, { latitude: 45.9, longitude: 126.9 }];
  const { w, crewId } = await pair({}, points);
  const rec = expectOk(await w.A('meet.recommend', { crewId }));
  assert.equal(rec.candidateSource, 'geometric-center');
  assert.equal(rec.searchRadiusMeters, 1000);
  assert.equal(rec.candidates.length, 1);
  assert.ok(rec.candidates[0].estimates.every(e => e.walkMeters > 1000));
  assert.deepEqual(rec.center, {
    latitude: (points[0].latitude + points[1].latitude) / 2,
    longitude: (points[0].longitude + points[1].longitude) / 2,
  });
});

test('显式最晚到达时间仍需遵守，回落中心不能绕过截止时间', async () => {
  const { w, crewId } = await pair();
  const rec = expectOk(await w.A('meet.recommend', { crewId, deadline: w.NOW }));
  assert.equal(rec.reason, 'DEADLINE_EXCEEDED');
  assert.equal(rec.candidates.length, 0);
});

test('中心半径包含 1000 米、排除 1001 米，不限制成员步行且不改行程范围', () => {
  const geo = require('../cloudfunctions/api/lib/geo');
  const now = new Date();
  const offset = meters => ({ latitude: A.latitude + meters / 6371008.8 * 180 / Math.PI,
    longitude: A.longitude });
  const rec = meet.recommendMeetPoints({
    members: [{ userId: 'a', point: A, reportedAt: now }], ctx: { now },
    candidatePlaces: [place('boundary', offset(1000)), place('over', offset(1001))],
  });
  assert.equal(rec.searchRadiusMeters, 1000);
  assert.equal(geo.MAX_WALK_METERS, 3000);
  assert.deepEqual(rec.candidates.map(c => c.placeId), ['boundary']);
  assert.equal(rec.candidates[0].estimates[0].walkMeters, 1300);
  assert.equal(rec.excluded.find(e => e.placeId === 'over').centerDistanceMeters, 1001);
});

test('队伍页经真实推荐接口画出中心，并以坐标发起集合而非虚构地点 ID', async () => {
  const { w, crewId } = await pair();
  const page = loadPage('miniprogram/pages/map/index.js', {
    api: { 'meet.recommend': payload => w.A('meet.recommend', payload) },
  });
  page.setData({ crewId });
  await page.recommendMeetingPoint();
  assert.equal(page.data.teamError, '');
  assert.equal(page.data.meetingPoint.fromGeometricCenter, true);
  assert.equal(page.data.meetingPoint.placeId, null);
  const marker = page.data.markers.find(m => m.id === 3000);
  assert.deepEqual({ latitude: marker.latitude, longitude: marker.longitude }, MID);
  assert.match(page.data.teamNote, /平均中心/);
  assert.match(page.data.teamNote, /估算/);
  let request;
  page.doTeam = (action, payload) => { request = { action, payload }; };
  page.setData({ meetTime: '23:59' });
  page.createMeeting();
  assert.equal(request.action, 'meet.create');
  assert.equal(request.payload.placeId, undefined);
  assert.deepEqual(request.payload.point, MID);
  const created = expectOk(await w.A(request.action, Object.assign({}, request.payload, { crewId, plannedMeetAt: w.plusMin(30) })));
  const saved = await w.repo.get(C.MEET_TASKS, created.meetTaskId);
  assert.equal(saved.placeId, null);
  assert.deepEqual(saved.point, MID);
});

test('从旧面板移交无地点 ID 的推荐时保留坐标，不编造 suggest 地点 ID', () => {
  const page = loadPage('miniprogram/pages/map/index.js', { storage: {
    'zhiyou-meet-suggest': { ...MID, name: '成员位置几何中心', candidateSource: 'geometric-center' },
  } });
  assert.equal(page.applyMeetSuggestion(), true);
  assert.equal(page.data.meetingPoint.placeId, null);
  assert.equal(page.data.meetingPoint.fromGeometricCenter, true);
});

test('队伍页展示实际位置失效原因，兼容旧响应仅含 excluded 的情况', async () => {
  for (const legacy of [true, false]) {
    const page = loadPage('miniprogram/pages/map/index.js', { api: {
      'meet.recommend': { ok: true, data: {
        candidates: [], reason: legacy ? undefined : 'LOCATION_STALE',
        excluded: [{ reason: 'LOCATION_STALE', message: '有成员位置过期' }],
      } },
    } });
    page.setData({ crewId: 'crew' });
    await page.recommendMeetingPoint();
    assert.match(page.data.teamError, /位置已过期/);
    assert.match(page.data.teamError, /立即更新位置/);
    assert.match(page.data.teamError, /前台/);
  }
});

'use strict';

/**
 * 「生成路线 → 去地图选集合点 → 路线还在、视野也对」。
 *
 * ── 这个 bug 的成因（2026-10-14 用户报）────────────────────
 *
 * 用户原话：「我生成路线后再点击在地图上选取集合点就看不到生成的路线了，
 * 而且地图偏移到别的地方去了」。查下来是**两个独立的缺口**：
 *
 *   ① 地图页只有 `onLoad`，而地图是 tab 页 ——
 *      从行程页切过来时页面实例早已存在，`onLoad` 不再触发，
 *      于是地图**永远不知道有一条路线**，也从不画它。
 *   ② `onLoad` 里设的默认中心点（哈尔滨中央大街）留在那儿，
 *      没有任何一步把视野落到路线上 —— 表现就是"偏到别的地方去了"。
 *
 * 所以这组测试盯的是**跨页传递**这条链，而不是单个页面的内部逻辑。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./page-harness');

const NODES = [
  { nodeId: 'n1', placeId: 'p_a', placeName: '中央大街', status: 'pending', location: { latitude: 45.7756, longitude: 126.6175 } },
  { nodeId: 'n2', placeId: 'p_b', placeName: '防洪纪念塔', status: 'pending', location: { latitude: 45.781, longitude: 126.6185 } },
  { nodeId: 'n3', placeId: 'p_c', placeName: '斯大林公园', status: 'pending', location: { latitude: 45.783, longitude: 126.619 } },
];

const PLACES = [
  {
    placeId: 'p_a',
    name: '中央大街',
    category: 'spot',
    location: { latitude: 45.7756, longitude: 126.6175 },
    tripNodeAllowed: true,
    meetingPointAllowed: true,
    verified: true,
  },
];

async function settle(times) {
  for (let i = 0; i < (times || 4); i++) {
    await new Promise((r) => setImmediate(r));
  }
}

function mapPage(opts) {
  opts = opts || {};
  return loadPage('miniprogram/pages/map/index.js', {
    api: Object.assign(
      {
        'place.list': { ok: true, data: { places: PLACES } },
        'trip.get': { ok: true, data: { trip: { tripId: 't_1', title: '哈尔滨一日', nodes: NODES } } },
      },
      opts.api
    ),
    storage: opts.storage,
    wx: opts.wx,
  });
}

test('地图页必须用 onShow 读当前路线 —— onLoad 在 tab 页切回来时不会再触发', async (t) => {
  const p = mapPage({ storage: { 'zhiyou-active-trip': { tripId: 't_1', version: 3 } } });
  t.after(() => p.restore());

  assert.equal(typeof p.onShow, 'function', '地图是 tab 页，必须在 onShow 里刷新路线');

  p.onShow();
  await settle();

  const actions = p.__calls.map((c) => c.action);
  assert.ok(actions.includes('trip.get'), 'onShow 必须去取一次路线');
  assert.equal(p.__calls.find((c) => c.action === 'trip.get').payload.tripId, 't_1');
  assert.ok(p.data.route, '取到路线后要落到 data 里');
  assert.equal(p.data.route.points.length, 3, '三个可定位节点应当都进折线');
});

test('路线会被画成折线（回归：用户看不到生成的路线）', async (t) => {
  const p = mapPage({ storage: { 'zhiyou-active-trip': { tripId: 't_1' } } });
  t.after(() => p.restore());

  p.onShow();
  await settle();

  const routeLine = p.data.polyline.find((l) => l.color === '#0B3C6E');
  assert.ok(routeLine, '地图上必须有一条代表当前路线的折线');
  assert.equal(routeLine.points.length, 3);
  assert.equal(routeLine.points[0].latitude, 45.7756);
});

test('视野必须落到路线上（回归：地图偏到别的地方）', async (t) => {
  const included = [];
  const p = mapPage({
    storage: { 'zhiyou-active-trip': { tripId: 't_1' } },
    wx: {
      createMapContext: () => ({
        includePoints: (o) => {
          included.push(o);
          o.success && o.success();
        },
      }),
    },
  });
  t.after(() => p.restore());

  p.onShow();
  await settle();

  assert.equal(included.length, 1, '必须调用一次 includePoints 把视野收到路线上');
  assert.equal(included[0].points.length, 3);
});

test('视野缩放失败要说出来 —— 因为它看起来就是"地图偏了"', async (t) => {
  const p = mapPage({
    storage: { 'zhiyou-active-trip': { tripId: 't_1' } },
    wx: {
      createMapContext: () => ({
        includePoints: (o) => {
          o.fail && o.fail({ errMsg: 'harness: includePoints failed' });
        },
      }),
    },
  });
  t.after(() => p.restore());

  p.onShow();
  await settle();

  assert.match(p.data.note, /视野缩放失败/, '失败必须留痕，否则又变成"静默偏了"');
});

test('没有路线时不画线，也不去取 trip.get', async (t) => {
  const p = mapPage();
  t.after(() => p.restore());
  await settle(2);

  p.__calls.length = 0;
  p.onShow();
  await settle();

  assert.equal(p.data.route, null);
  assert.equal(
    p.__calls.filter((c) => c.action === 'trip.get').length,
    0,
    '没生成过路线就不该白调一次接口'
  );
  assert.equal(p.data.polyline.length, 0, '没有路线就不该有折线');
});

test('路线取不到时静默降级但**留下 note** —— 静默失败正是这个 bug 的特征', async (t) => {
  const p = mapPage({
    storage: { 'zhiyou-active-trip': { tripId: 't_1' } },
    api: { 'trip.get': { ok: false, error: { code: 'NOT_FOUND', message: '行程不存在' } } },
  });
  t.after(() => p.restore());

  p.onShow();
  await settle();

  assert.equal(p.data.route, null);
  assert.match(p.data.note, /行程不存在/, '要把后端的原因透出来，而不是无声无息');
});

test('可定位节点少于 2 个时不画线，并说明原因', async (t) => {
  const p = mapPage({
    storage: { 'zhiyou-active-trip': { tripId: 't_1' } },
    api: {
      'trip.get': {
        ok: true,
        data: { trip: { tripId: 't_1', nodes: [{ nodeId: 'n1', placeName: '只有一个点', location: { latitude: 45.7, longitude: 126.6 } }] } },
      },
    },
  });
  t.after(() => p.restore());

  p.onShow();
  await settle();

  assert.equal(p.data.route, null);
  assert.match(p.data.note, /少于 2 个/);
});

test('行程页生成路线后会把 tripId 写到本地，供地图页读取', async (t) => {
  // 只验这一个方法的契约：它负责跨页传递的那一半
  const p = loadPage('miniprogram/pages/trip/index.js', {
    api: { 'place.list': { ok: true, data: { places: [] } } },
  });
  t.after(() => p.restore());

  p.rememberActiveTrip('t_abc', 7);
  assert.deepEqual(p.__storage['zhiyou-active-trip'], { tripId: 't_abc', version: 7 });
});

test('没有 tripId 时不写本地 —— 避免留下一个指向不存在路线的 key', async (t) => {
  const p = loadPage('miniprogram/pages/trip/index.js', {
    api: { 'place.list': { ok: true, data: { places: [] } } },
  });
  t.after(() => p.restore());

  p.rememberActiveTrip(null, 1);
  assert.equal(p.__storage['zhiyou-active-trip'], undefined);
});

'use strict';

/**
 * 地图页的"镜头与当前路线"。
 *
 * ── 这一组盯的是两个先后报出来的问题 ─────────────────────
 *
 * ① 用户：「生成路线后再点击在地图上选取集合点就看不到生成的路线了，
 *    而且地图偏移到别的地方去了」——成因是地图页只有 onLoad（tab 页切回来
 *    不触发），而且默认中心点是写死的。
 * ② 用户：「应该默认镜头是自己的当前位置啊」——这是对的。
 *    **"我在哪"每一刻都要用，路线一眼看全就够。**
 *
 * 两者会打架，所以本文件的重点在**优先级**：
 *   定位可用 → 镜头跟我；定位不可用但有路线 → 退到把路线收进视野。
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
  for (let i = 0; i < (times || 5); i++) {
    await new Promise((r) => setImmediate(r));
  }
}

/** 让 `place.list` 加载完成 —— 没有 places 就选不中任何地点 */
async function loaded(p) {
  p.loadPlaces();
  await settle(3);
  return p;
}

/** 模拟"用户已经授过定位权限" */
function grantedWx(extra) {
  return Object.assign(
    {
      getSetting: (o) => o.success({ authSetting: { 'scope.userLocation': true } }),
      getLocation: (o) => o.success({ latitude: 45.776, longitude: 126.618, accuracy: 20 }),
    },
    extra || {}
  );
}

/** 记录 includePoints / moveToLocation 调用 */
function spyMapCtx(store) {
  return () => ({
    includePoints: (o) => {
      store.includePoints.push(o);
      o.success && o.success();
    },
    moveToLocation: (o) => {
      store.moveToLocation.push(o);
      o.success && o.success();
    },
  });
}

function mapPage(opts) {
  opts = opts || {};
  const store = { includePoints: [], moveToLocation: [] };
  const p = loadPage('miniprogram/pages/map/index.js', {
    api: Object.assign(
      {
        'place.list': { ok: true, data: { places: PLACES } },
        'trip.get': { ok: true, data: { trip: { tripId: 't_1', title: '哈尔滨一日', nodes: NODES } } },
      },
      opts.api
    ),
    storage: opts.storage,
    wx: Object.assign({ createMapContext: spyMapCtx(store) }, opts.wx),
  });
  p.__mapSpy = store;
  return p;
}

test('地图页必须用 onShow 读当前路线 —— onLoad 在 tab 页切回来时不会再触发', async (t) => {
  const p = mapPage({ storage: { 'zhiyou-active-trip': { tripId: 't_1', version: 3 } } });
  t.after(() => p.restore());

  assert.equal(typeof p.onShow, 'function', '地图是 tab 页，必须在 onShow 里刷新');

  p.onShow();
  await settle();

  const actions = p.__calls.map((c) => c.action);
  assert.ok(actions.includes('trip.get'), 'onShow 必须去取一次路线');
  assert.equal(p.__calls.find((c) => c.action === 'trip.get').payload.tripId, 't_1');
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

test('已授权时镜头跟我 —— 而不是收到整条路线上', async (t) => {
  const p = mapPage({
    storage: { 'zhiyou-active-trip': { tripId: 't_1' } },
    wx: grantedWx(),
  });
  t.after(() => p.restore());

  p.onShow();
  await settle();

  assert.equal(p.data.mySource, 'gps', '应当静默取到位置');
  assert.ok(p.data.myPoint, '位置要落到 data，图钉才画得出来');
  /**
   * 只要求**至少一次**，不锁死次数：`onShow` 里 autoLocate 与 loadActiveTrip
   * 都会重定位（前者取到位置、后者画完路线），锁死次数会让测试对实现顺序过敏。
   */
  assert.ok(p.__mapSpy.moveToLocation.length >= 1, '镜头必须回到"我"');
  assert.equal(
    p.__mapSpy.includePoints.length,
    0,
    '有定位时不该把镜头交给整条路线 —— 那正是用户抱怨的"偏到别的地方"'
  );
});

test('未授权时不弹权限框 —— 地图是 tab，不能每次点进来都问一遍', async (t) => {
  const asked = [];
  const p = mapPage({
    storage: { 'zhiyou-active-trip': { tripId: 't_1' } },
    wx: {
      getSetting: (o) => o.success({ authSetting: {} }), // 没授权
      getLocation: () => asked.push('getLocation'),
    },
  });
  t.after(() => p.restore());

  p.onShow();
  await settle();

  assert.equal(asked.length, 0, '未授权时不该调用 getLocation（那会弹权限框）');
  assert.equal(p.data.myPoint, null, '拿不到位置就不该假装有');
  // 路线照常显示
  assert.ok(p.data.polyline.find((l) => l.color === '#0B3C6E'), '路线该照常画出来');
});

test('拿不到定位但地图上下文可用时，镜头仍交给地图（不硬塞一个默认点）', async (t) => {
  const p = mapPage({
    storage: { 'zhiyou-active-trip': { tripId: 't_1' } },
    wx: grantedWx({ getLocation: (o) => o.fail({ errMsg: 'harness: locate failed' }) }),
  });
  t.after(() => p.restore());

  p.onShow();
  await settle();

  assert.equal(p.data.myPoint, null, '定位失败就不该有位置');
  /**
   * ⚠️ 这里**期望 0 次 includePoints**，而不是 1 次（第一版测试写错了）。
   *
   * `recenterOnMe()` 在 `moveToLocation` 存在时就返回 true，
   * 所以即便拿不到定位，走的也是"让地图自己决定怎么显示我"，
   * 而不是把视野硬框到路线上。
   *
   * `fitRoute()` 是**真正的降级路径**：只有地图上下文不可用
   * （基础库过低、拿不到 tripmap）时才会走到，见下一条测试。
   */
  assert.equal(p.__mapSpy.includePoints.length, 0, '上下文可用时不该退到"把路线框进视野"');
  assert.ok(p.__mapSpy.moveToLocation.length >= 1, '镜头仍应交给地图');
  /**
   * 自动定位失败**不写 note** —— 用户没点任何按钮，
   * 给一个正常打开的页面加错误提示只会让人以为坏了。
   */
  assert.equal(p.data.note, '', '自动定位失败不该留下提示');
});

test('地图上下文不可用时，退到把路线收进视野并说明失败原因', async (t) => {
  /**
   * ⚠️ 这里用 `loadPage` 而不是 `mapPage()`：后者的地图上下文替身**总是带
   * `moveToLocation`**（它要记录镜头调用），会把本测试要模拟的"基础库过低"覆盖掉，
   * 于是永远走不到降级分支。
   *
   * 教训与 page-harness 里那几条注释同源：**替身的形状决定了代码走哪条分支**，
   * 用一个功能齐全的替身去测降级路径，测的是另一回事。
   */
  const includeCalls = []
  const p = loadPage('miniprogram/pages/map/index.js', {
    api: {
      'place.list': { ok: true, data: { places: PLACES } },
      'trip.get': { ok: true, data: { trip: { tripId: 't_1', nodes: NODES } } },
    },
    storage: { 'zhiyou-active-trip': { tripId: 't_1' } },
    wx: {
      getSetting: (o) => o.success({ authSetting: {} }),
      createMapContext: () => ({
        // 刻意只有 includePoints —— 模拟拿不到 moveToLocation 的老基础库
        includePoints: (o) => {
          includeCalls.push(o)
          o.fail && o.fail({ errMsg: 'harness: includePoints failed' })
        },
      }),
    },
  })
  t.after(() => p.restore())

  p.onShow()
  await settle()

  assert.equal(includeCalls.length, 1, '这才是真正的降级路径')
  assert.match(p.data.note, /视野缩放失败/, '降级失败也必须留痕，否则又变成"静默偏了"')
});

test('用户主动点「获取我的位置」后，镜头跟过去', async (t) => {
  const p = mapPage({ wx: grantedWx() });
  t.after(() => p.restore());
  await settle(2);

  p.__mapSpy.moveToLocation.length = 0;
  p.useGps();
  await settle();

  assert.equal(p.data.mySource, 'gps');
  assert.equal(p.__mapSpy.moveToLocation.length, 1, '刚给了位置就该把镜头落过去，不该让用户自己拖地图找');
});

test('没有路线时不画线，也不去取 trip.get', async (t) => {
  const p = mapPage({ wx: grantedWx() });
  t.after(() => p.restore());
  await settle(2);

  p.__calls.length = 0;
  p.onShow();
  await settle();

  assert.equal(p.data.route, null);
  assert.equal(p.__calls.filter((c) => c.action === 'trip.get').length, 0, '没生成过路线就不该白调接口');
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

test('默认不选中任何集合点 —— 选中必须是用户动作的结果', async (t) => {
  const p = mapPage({ wx: grantedWx() });
  t.after(() => p.restore());
  await loaded(p);

  // 先模拟用户点选了一个地点
  p.selectMeeting({ currentTarget: { dataset: { placeid: 'p_a' } } });
  assert.equal(p.data.meetingPoint.placeId, 'p_a');

  // 再回到地图（tab 切回来）—— 应当回到"没有集合点"的默认样子
  p.onShow();
  assert.equal(p.data.meetingPoint, null, '默认视图不该挂着上一次的选中');
  assert.equal(p.data.photoNote, '');
});

test('用户能主动取消选中 —— 否则点错了退不回默认视图', async (t) => {
  const p = mapPage({});
  t.after(() => p.restore());
  await loaded(p);

  p.selectMeeting({ currentTarget: { dataset: { placeid: 'p_a' } } });
  assert.ok(p.data.meetingPoint);

  assert.equal(typeof p.clearMeeting, 'function', '要有取消选择的出口');
  p.clearMeeting();
  assert.equal(p.data.meetingPoint, null);
});

test('已有进行中的集合时，默认把它显示出来（这是信息，不是我替他选）', async (t) => {
  const p = mapPage({});
  t.after(() => p.restore());
  await loaded(p);

  // 模拟 team-panel 报上来一场进行中的集合，地点正好在库里
  p.onTeamState({
    detail: {
      locations: [],
      meeting: { point: { latitude: 45.7756, longitude: 126.6175 }, name: '中央大街' },
    },
  });
  assert.equal(p.data.meetingPoint.placeId, 'p_a', '库里有这个地点就该选中它');

  // 再切回地图，进行中的集合仍应显示
  p.onShow();
  assert.ok(p.data.meetingPoint, '进行中的集合不该被默认清掉');
});

test('集合点不在 places 库里时也要能标出来（手动选点的坐标不对应任何地点记录）', async (t) => {
  const p = mapPage({});
  t.after(() => p.restore());
  await loaded(p);

  p.onTeamState({
    detail: {
      locations: [],
      meeting: { point: { latitude: 45.7999, longitude: 126.6399 }, name: '南门指示牌旁' },
    },
  });

  assert.equal(p.data.meetingPoint.name, '南门指示牌旁');
  assert.equal(p.data.meetingPoint.fromTeamTask, true, '要能区分"我选的"与"队里定的"');
  const pin = p.data.markers.find((m) => m.latitude === 45.7999);
  assert.ok(pin, '不在库里的集合点也必须出现在地图上');
});

test('行程页生成路线后会把 tripId 写到本地，供地图页读取', async (t) => {
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

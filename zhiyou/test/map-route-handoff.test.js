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

/** `trip.legRoute` 的成功返回：解码后的真实步行路径 */
function legRouteOk(from, to) {
  return {
    ok: true,
    data: {
      ok: true,
      tripId: 't_1',
      nodeId: to.nodeId,
      placeName: to.placeName,
      distanceMeters: 815,
      durationMinutes: 12,
      route: {
        decoded: true,
        pointCount: 3,
        // 真实路径会沿街道拐弯 —— 用它区分"真实路径"和"两点直连"
        points: [
          { latitude: from.location.latitude, longitude: from.location.longitude },
          { latitude: (from.location.latitude + to.location.latitude) / 2, longitude: from.location.longitude + 0.0009 },
          { latitude: to.location.latitude, longitude: to.location.longitude },
        ],
        steps: [{ instruction: '从起点朝西北行进62米右转进入上游街' }],
      },
      to: { latitude: to.location.latitude, longitude: to.location.longitude, name: to.placeName },
    },
  };
}

function mapPage(opts) {
  opts = opts || {};
  const store = { includePoints: [], moveToLocation: [] };
  const p = loadPage('miniprogram/pages/map/index.js', {
    api: Object.assign(
      {
        'place.list': { ok: true, data: { places: PLACES } },
        'trip.get': { ok: true, data: { trip: { tripId: 't_1', title: '哈尔滨一日', nodes: NODES } } },
        /**
         * 逐段真实路径。默认返回"解码成功"的路径 ——
         * 因为契约是"**有真实路径才画线**"，不给它就没有线可断言。
         */
        'trip.legRoute': (payload) => {
          const to = NODES.find((n) => n.nodeId === payload.nodeId);
          const idx = NODES.indexOf(to);
          return legRouteOk(NODES[idx - 1], to);
        },
      },
      opts.api
    ),
    storage: opts.storage,
    wx: Object.assign({ createMapContext: spyMapCtx(store) }, opts.wx),
  });
  p.__mapSpy = store;
  return p;
}

/**
 * ⚠️⚠️ 这里原有四条测试（约 80 行）：onShow 读路线、画真实步行路径、
 * 取不到就什么都不画、路线画成折线。
 *
 * **已全部删除**（2026-10-14 用户要求："队伍页面地图上显示的路线也删了"）。
 * 它们测的是"地图页把路线画出来"，而那是**行程页**的职责了 ——
 * 留着只会让它们继续"通过"，掩盖本页已经不再读路线这件事。
 *
 * 行程页那边的等价值守卫在 `trip-page.test.js` 与
 * `map-route-handoff.test.js` 末尾的"传值"两条（行程页写 tripId、
 * 队伍页读它去关联集合）。
 */
test('队伍页**完全不读路线** —— 路线是行程页的事', async (t) => {
  const p = mapPage({ storage: { 'zhiyou-active-trip': { tripId: 't_1', version: 3 } } });
  t.after(() => p.restore());

  p.onShow();
  await settle(8);

  const actions = p.__calls.map((c) => c.action);
  assert.equal(actions.includes('trip.get'), false, '不该取路线');
  assert.equal(actions.includes('trip.legRoute'), false, '更不该逐段取真实路径（那要花地图配额）');
  assert.equal(p.data.route, undefined, '本页没有 route 这个 state');
  assert.deepEqual(p.data.polyline, [], '没有集合点连线时折线应当为空');
});
test('已授权时镜头跟我', async (t) => {
  const p = mapPage({ wx: grantedWx() });
  t.after(() => p.restore());

  p.onShow();
  await settle();

  assert.equal(p.data.mySource, 'gps', '应当静默取到位置');
  assert.ok(p.data.myPoint, '位置要落到 data，图钉才画得出来');
  assert.ok(p.__mapSpy.moveToLocation.length >= 1, '镜头必须回到"我"');
  /**
   * ⚠️ 本页不再有"把路线框进视野"这个降级路径（路线已不在本页画）。
   * `includePoints` 现在只可能来自别处，这里期望一次都没有。
   */
  assert.equal(p.__mapSpy.includePoints.length, 0, '本页不框路线');
});

test('未授权时不弹权限框 —— 地图是 tab，不能每次点进来都问一遍', async (t) => {
  const asked = [];
  const p = mapPage({
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
});

test('拿不到定位时**什么都不做** —— 不框视野、不挪镜头、不写提示', async (t) => {
  const p = mapPage({ wx: grantedWx({ getLocation: (o) => o.fail({ errMsg: 'harness: locate failed' }) }) });
  t.after(() => p.restore());

  p.onShow();
  await settle();

  assert.equal(p.data.myPoint, null, '定位失败就不该有位置');
  /**
   * ⚠️ 期望值**改过**（2026-10-14）：原来期望"镜头仍交给地图"，
   * 因为那时本页还画路线，`recenterOnMe()` 在"上下文可用"时无论如何
   * 都会调一次 `moveToLocation`（让地图自己决定怎么显示我）。
   *
   * 路线已从本页删除，`recenterOnMe()` 现在只在**取到位置之后**调 ——
   * 没有位置时"回到我的位置"本身就没有意义。正确的行为是：什么都不做。
   */
  assert.equal(p.__mapSpy.moveToLocation.length, 0, '没有位置就不该挪镜头');
  assert.equal(p.__mapSpy.includePoints.length, 0, '更不该硬框一个视野');
  /**
   * 自动定位失败**不写 note** —— 用户没点任何按钮，
   * 给一个正常打开的页面加错误提示只会让人以为坏了。
   */
  assert.equal(p.data.note, '', '自动定位失败不该留下提示');
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

  /**
   * 模拟"已经有一场进行中的集合" —— 地点正好在库里。
   *
   * ⚠️ 数据来源**改过**（2026-10-14）：地图页删掉 `team-panel` 之后，
   * 集合点不再来自组件事件，而是 `loadCrew()` 调 `meet.get` 填的
   * `meetTask`。所以这里直接设 `meetTask`，与页面真实读的字段一致。
   */
  p.setData({
    meetTask: { placeName: '中央大街', point: { latitude: 45.7756, longitude: 126.6175 } },
  });
  p.syncMeetingSelection();
  assert.equal(p.data.meetingPoint.placeId, 'p_a', '库里有这个地点就该选中它');

  // 再切回地图，进行中的集合仍应显示
  p.onShow();
  assert.ok(p.data.meetingPoint, '进行中的集合不该被默认清掉');
});

test('集合点不在 places 库里时也要能标出来（手动选点的坐标不对应任何地点记录）', async (t) => {
  const p = mapPage({});
  t.after(() => p.restore());
  await loaded(p);

  /**
   * ⚠️ 数据来源改过（2026-10-14）：删掉 `team-panel` 之后集合点来自
   * `meetTask`（`loadCrew()` 调 `meet.get` 填），不再是组件事件。
   *
   * 这条测的是**拖动/手动选点出来的集合点**（坐标不对应任何地点记录）——
   * 那种点必须也能画在地图上，否则用户辛苦拖出来的点"看不见"。
   */
  p.setAutoMeetingPoint({
    placeId: 'map_1',
    name: '南门指示牌旁',
    latitude: 45.7999,
    longitude: 126.6399,
    fromMapPick: true,
  });

  assert.equal(p.data.meetingPoint.name, '南门指示牌旁');
  assert.equal(p.data.meetingPoint.fromMapPick, true, '要能区分"我拖的"与"队里定的"');
  const pin = p.data.markers.find((m) => m.latitude === 45.7999);
  assert.ok(pin, '不在库里的集合点也必须出现在地图上');
});

test('精度必须在 data 里声明 —— 否则"精度约 X 米"永远不显示（已坏过一次）', async (t) => {
  const p = mapPage({ wx: grantedWx() });
  t.after(() => p.restore());

  /**
   * ⚠️ 这条守的是一个**静默失效**：`myAccuracyM` 原先只在 `setData` 里赋值、
   * 没进 `data`，模板 `wx:if="{{myAccuracyM}}"` 于是永远为假。
   *
   * 界面看上去完全正常，只是**从来不显示精度** —— 而精度是判断
   * "这次定位能不能信"的唯一依据（30 米和 2000 米在界面上长得一样）。
   * 用户只能说"定位不准"，没法说清有多不准。
   */
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'miniprogram', 'pages', 'map', 'index.js'),
    'utf8'
  );
  const dataBlock = source.slice(source.indexOf('data: {'), source.indexOf('onLoad()'));
  assert.match(dataBlock, /myAccuracyM:\s*null/, 'myAccuracyM 必须在 data 里声明');
  assert.match(dataBlock, /myLocatedAt:\s*''/, '定位时刻也要声明 —— 用来分辨是不是拿了一份旧位置');

  p.autoLocate();
  await settle();
  assert.equal(p.data.myAccuracyM, 20, '取到位置后应当带上精度');
  assert.ok(p.data.myLocatedAt, '并记下取得时刻');
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

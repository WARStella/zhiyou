'use strict';

/**
 * 跳到地图页并聚焦景点（2026-10-14 用户要求）。
 *
 * 用户原话（先说错、后更正）：
 *   先说："地图界面再点击到达后展开占据全屏并放大为景点的地图"
 *   更正："额是我说错了，应该是点击到了以后**跳转到地图页面**，然后地图放大"
 *
 * 所以是**真实页面跳转**，不是覆盖层。两个页面各测各的：
 *   行程页 → 写聚焦请求、`switchTab` 到地图
 *   地图页 → 读聚焦请求、移镜头、清掉它
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadPage, node } = require('./page-harness');

const KEY = 'zhiyou-focus-place';

const WITH_LOCATION = node('n0', '哈工大', 'pending', 0);
WITH_LOCATION.location = { latitude: 45.7556, longitude: 126.6183 };

/** 测量替身：地图卡在文档里离顶部 800px、高 500px，视口 1200px 高 */
const SCROLL_OPTS = {
  systemInfo: { windowHeight: 1200 },
  rects: { '.map-card': { top: 800, height: 500 } },
};

function tripPage(nodes, opts) {
  const page = loadPage('miniprogram/pages/trip/index.js', opts || SCROLL_OPTS);
  page.applyTrip(
    {
      tripId: 't1',
      version: 1,
      nodes: nodes,
      saved: true,
      summary: { endAt: '2026-10-20T05:00:00.000Z', totalWalkMin: 8, totalStayMin: 90 },
      startPoint: { latitude: 45.75, longitude: 126.6, label: '我的位置' },
      startLeg: { minutes: 12, meters: 900, mode: 'walking', toPlaceName: '哈工大' },
      legOptions: [],
    },
    ''
  );
  return page;
}

// ── 行程页：写聚焦请求 + 跳转 ──────────────────────────────

test('点某一站 → 写聚焦请求并 switchTab 到地图', () => {
  const page = tripPage([WITH_LOCATION]);
  page.focusNodeOnMap({ currentTarget: { dataset: { nodeid: 'n0' } } });

  /** ⚠️ 地图是 tab 页，`switchTab` 不支持 URL 参数，所以走 storage */
  const wrote = page.__storage[KEY];
  assert.ok(wrote, '要写聚焦请求');
  assert.equal(wrote.placeName, '哈工大');
  assert.equal(wrote.latitude, 45.7556);
  assert.equal(wrote.longitude, 126.6183);
  assert.equal(wrote.scale, 16, '放大到步行导航常用层级');
  assert.equal(typeof wrote.at, 'number', '要带时间戳 —— 地图页据此判断过期');

  const jumped = page.__wx.filter((c) => c.fn === 'switchTab');
  assert.equal(jumped.length, 1);
  assert.equal(jumped[0].args.url, '/pages/map/index');
});

test('**没有坐标的站点不跳转** —— 跳过去看不到聚焦，用户会以为按钮坏了', () => {
  const noLoc = node('n1', '没有坐标的地方', 'pending', 1);
  delete noLoc.location;
  const page = tripPage([noLoc]);

  page.focusNodeOnMap({ currentTarget: { dataset: { nodeid: 'n1' } } });

  assert.equal(page.__storage[KEY], undefined, '不该写聚焦请求');
  assert.equal(page.__wx.filter((c) => c.fn === 'switchTab').length, 0, '不该跳转');
  assert.match(page.data.note, /没有坐标/, '要说清为什么没反应');
});

test('认不出的 nodeId 不崩、也不跳转', () => {
  const page = tripPage([WITH_LOCATION]);
  page.focusNodeOnMap({ currentTarget: { dataset: { nodeid: '不存在' } } });
  assert.equal(page.__wx.filter((c) => c.fn === 'switchTab').length, 0);
});

test('点站名与点「到了」都走同一条聚焦逻辑', () => {
  const page = tripPage([WITH_LOCATION]);
  page.goToMapFocus(WITH_LOCATION);
  assert.ok(page.__storage[KEY], '「到了」路径也要写聚焦请求');
});

// ── 地图页：读聚焦请求并移镜头 ─────────────────────────────

function mapPage(storage) {
  return loadPage('miniprogram/pages/map/index.js', { storage: storage || {} });
}

test('地图页读到聚焦请求 → 移镜头并放大', () => {
  const page = mapPage({
    [KEY]: { placeName: '哈工大', latitude: 45.7556, longitude: 126.6183, scale: 16, at: Date.now() },
  });
  page.onShow();

  assert.ok(page.data.focusPlace, '要显示聚焦提示条');
  assert.equal(page.data.focusPlace.placeName, '哈工大');
  /** 地图是受控组件：改 `center` 与 `scale` 镜头就会移过去 */
  assert.equal(page.data.center.latitude, 45.7556);
  assert.equal(page.data.center.longitude, 126.6183);
  assert.equal(page.data.scale, 16);
});

test('读完**立刻清掉** —— 不清的话下次切到地图又会飞过去', () => {
  const page = mapPage({
    [KEY]: { placeName: '哈工大', latitude: 45.7556, longitude: 126.6183, scale: 16, at: Date.now() },
  });
  page.onShow();

  assert.equal(page.__storage[KEY], undefined, '聚焦请求是一次性的');
  assert.ok(page.data.focusPlace, '但提示条还在 —— 用户要能看见在看哪一站');
});

test('**过期的聚焦请求不执行** —— 几天前的请求会让镜头突然飞走', () => {
  /**
   * storage 是持久的。若某次写完就再没打开过地图页（比如跳转失败），
   * 这个值会一直躺着 —— 几天后用户切到地图页，镜头突然飞到一个
   * 早就去过的景点。那是"过期的数据比没有更糟"。
   */
  const page = mapPage({
    [KEY]: {
      placeName: '很久以前的站',
      latitude: 45.7556,
      longitude: 126.6183,
      scale: 16,
      at: Date.now() - 10 * 60 * 1000,
    },
  });
  page.onShow();

  assert.equal(page.data.focusPlace, null, '过期请求不该执行');
  assert.equal(page.__storage[KEY], undefined, '但仍要清掉，免得一直躺着');
});

test('没有聚焦请求时走原来的默认逻辑（回到我的位置）', () => {
  const page = mapPage({});
  page.onShow();
  assert.equal(page.data.focusPlace, null, '不该凭空聚焦');
});

test('坐标不完整的聚焦请求被忽略，不崩', () => {
  const page = mapPage({ [KEY]: { placeName: '坏数据' } });
  page.onShow();
  assert.equal(page.data.focusPlace, null);
});

test('提示条的「知道了」只关提示，不改镜头', () => {
  const page = mapPage({
    [KEY]: { placeName: '哈工大', latitude: 45.7556, longitude: 126.6183, scale: 16, at: Date.now() },
  });
  page.onShow();
  const cam = { lat: page.data.center.latitude, lng: page.data.center.longitude };

  page.clearFocusPlace();

  assert.equal(page.data.focusPlace, null, '提示条关掉');
  assert.deepEqual(
    { lat: page.data.center.latitude, lng: page.data.center.longitude },
    cam,
    '镜头不该跟着变 —— 用户只是想关掉那句话'
  );
});

test('focusPlace 要在初始 data 里声明 —— 否则首帧读它会把整页打白', () => {
  const page = mapPage({});
  assert.equal(page.data.focusPlace, null);
});

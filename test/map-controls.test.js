'use strict';

/**
 * 地图右下角控件 + 拖动选点（2026-10-14 用户要求）。
 *
 * 用户原话：
 *   "把地图页面的获取我的位置改为在地图上右下角的一个小控件，
 *    点击会获取位置并将镜头挪到当前位置；
 *    手动选点同样改为小控件，但是点击后只需拖动地图即可确定图钉的位置，
 *    图钉在拖动时保持在屏幕中心不动，
 *    再次点击控件退出模式时才会随地图拖动一起移动"
 *
 * ── 为什么"拖动对中心图钉"比"点地图"好 ──────────────────────
 *
 * 旧实现是点地图上的某一点。手机上手指按下去就遮住了目标位置，
 * 而景区里 20 米的偏差足以让人站到马路对面。
 * 拖动对中心图钉天然精确 —— 手指在屏幕任何地方，图钉始终在正中间。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadPage } = require('./page-harness');

const CENTER = { latitude: 45.7556, longitude: 126.6183 };

function mapPage(opts) {
  return loadPage('miniprogram/pages/map/index.js', opts || { mapCenter: CENTER });
}

// ── 定位控件 ───────────────────────────────────────────────

test('定位成功后镜头挪到当前位置', () => {
  const page = mapPage({
    mapCenter: CENTER,
    wx: {
      getLocation: (o) => o.success({ latitude: 45.8, longitude: 126.5, accuracy: 20 }),
    },
  });

  page.useGps();

  assert.equal(page.data.mySource, 'gps');
  assert.equal(page.data.myPoint.latitude, 45.8);
  /** 除了 moveToLocation，还要更新**受控属性** center */
  assert.equal(page.data.center.latitude, 45.8, 'center 要跟着更新');
  assert.ok(
    page.__wx.some((c) => c.fn === 'moveToLocation'),
    '要让镜头真的移过去'
  );
});

test('定位失败时给出可行动的退路（指向新的拖动选点控件）', () => {
  const page = mapPage({
    mapCenter: CENTER,
    wx: {
      getLocation: (o) => o.fail({ errMsg: 'getLocation:fail auth deny' }),
    },
  });

  page.useGps();

  assert.equal(page.data.mySource, null, '失败不该留下一个假来源');
  /** 提示要指向**新**的入口（右下角的 ✛），而不是已经不存在的卡片按钮 */
  assert.match(page.data.note, /✛|拖动选点/);
});

// ── 拖动选点 ───────────────────────────────────────────────

test('进入选点模式：标记 pickMode，并**先读一次地图中心**', () => {
  /**
   * ⚠️ 一定要先读：用户可能进来后什么都没拖就直接点「好了」。
   * 不读的话 `myPoint` 还是旧的（甚至为空），而他以为已经选好了。
   */
  const page = mapPage();
  page.startPick();

  assert.equal(page.data.pickMode, true);
  assert.ok(
    page.__wx.some((c) => c.fn === 'getCenterLocation'),
    '进入模式时要读一次中心'
  );
});

test('拖动过程中**不做 setData** —— 否则界面发涩', () => {
  /**
   * `bindregionchange` 每秒能触发几十次。拖动中最不需要的就是界面更新
   * （图钉本来就不动），真正的坐标留到「好了」那一下读。
   */
  const page = mapPage();
  page.startPick();
  const before = page.__setDataLog.length;

  page.onMapRegionChange();
  page.onMapRegionChange();
  page.onMapRegionChange();

  assert.equal(page.__setDataLog.length, before, '拖动期间不该有新 setData');
});

test('非选点模式下拖动不产生任何影响', () => {
  const page = mapPage();
  const before = page.__setDataLog.length;
  page.onMapRegionChange();
  assert.equal(page.__setDataLog.length, before);
});

test('点「好了」→ 用**当前中心**作为我的位置，退出模式', () => {
  const page = mapPage({ mapCenter: { latitude: 45.79, longitude: 126.53 } });
  page.startPick();

  page.confirmPick();

  assert.equal(page.data.myPoint.latitude, 45.79, '要用刚读到的中心，不是进来时的旧值');
  assert.equal(page.data.myPoint.longitude, 126.53);
  assert.equal(page.data.mySource, 'manual');
  assert.equal(page.data.pickMode, false, '退出模式');
});

test('读不到地图中心时**如实说**，不编一个坐标', () => {
  /**
   * 编一个坐标是最糟的：用户以为选好了，而位置其实是错的 ——
   * 基于它算的"到集合点要走多久"全错。
   */
  const page = mapPage({ mapCenter: null });
  page.startPick();
  page.confirmPick();

  assert.equal(page.data.myPoint, null, '不该凭空得到一个位置');
  assert.match(page.data.note, /没能读到地图中心/);
  assert.equal(page.data.pickMode, false, '读不到也要能退出模式');
});

test('取消选点不改变已有的位置', () => {
  const page = mapPage({ mapCenter: CENTER });
  page.setData({ myPoint: { latitude: 1, longitude: 2 }, mySource: 'gps' });

  page.startPick();
  page.cancelPick();

  assert.equal(page.data.pickMode, false);
  assert.equal(page.data.myPoint.latitude, 1, '取消不该把之前的位置改掉');
  assert.equal(page.data.mySource, 'gps');
});

test('选点模式下点地图**不再改变位置** —— 那会与拖动打架', () => {
  /**
   * ⚠️ 旧实现是"点地图选点"。现在选点由拖动完成，
   * 若 `onMapTap` 还改位置，用户在拖动时随手一点就会把位置设到别处。
   */
  const page = mapPage();
  page.startPick();
  page.setData({ myPoint: null });

  page.onMapTap({ detail: { latitude: 1, longitude: 2 } });

  assert.equal(page.data.myPoint, null, '选点模式下点地图不该设位置');
});

test('定位成功会退出选点模式 —— 否则两个图钉同时存在', () => {
  const page = mapPage({
    mapCenter: CENTER,
    wx: { getLocation: (o) => o.success({ latitude: 45.8, longitude: 126.5, accuracy: 20 }) },
  });
  page.startPick();
  assert.equal(page.data.pickMode, true);

  page.useGps();

  assert.equal(page.data.pickMode, false, '定位给了位置就不该还在拖图钉');
});

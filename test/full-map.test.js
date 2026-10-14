'use strict';

/**
 * 全屏地图（2026-10-14 用户要求）。
 *
 * 用户原话："行程生成路线后页面移到地图卡面居中，其它卡面均折叠，
 *           地图界面再点击到达后展开占据全屏并放大为景点的地图"
 *
 * 两件事：
 *   ① 生成路线后 → 滚到地图卡面居中，其它卡面折叠
 *   ② 点「到了」 → 全屏地图 + 放大到那一站
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadPage, node } = require('./page-harness');

const WITH_LOCATION = node('n0', '哈工大', 'pending', 0);
/** 确保节点带坐标 —— 没有坐标时全屏地图**不该**展开（见下面的测试） */
WITH_LOCATION.location = { latitude: 45.7556, longitude: 126.6183 };

/**
 * 给测试台"地图卡在文档里离顶部 800px、高 500px"的测量结果，
 * 并给一个 1200px 高的视口。
 *
 * ⚠️ 不给的话 `boundingClientRect` 回 null，页面会走**回落分支**
 * （只用 selector 滚动），而那条路测不到"居中"这个要求 ——
 * 测试会绿着，而居中逻辑一行都没跑到。
 */
const SCROLL_OPTS = {
  systemInfo: { windowHeight: 1200 },
  rects: { '.map-card': { top: 800, height: 500 } },
};

function pageWithNodes(nodes, opts) {
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

// ── ① 生成后滚到地图 ───────────────────────────────────────

test('生成路线后把地图卡面滚到**视野居中**，而不是"进入视野就算"', () => {
  /**
   * 用户要的是"页面移到地图卡面**居中**"。
   *
   * 算一下期望值（见 `scrollToRouteMap` 的说明）：
   *   卡片文档坐标 = rect.top 800 + 当前滚动量 0 = 800
   *   居中偏移     = (视口高 1200 − 卡片高 500) / 2 = 350
   *   目标滚动     = 800 − 350 = 450
   *
   * ⚠️ 用像素值而不是 `offsetTop`/`selector`：后者只保证元素
   * **进入视野**，不保证居中，而 `offsetTop` 的正负语义各版本不好确认。
   */
  const page = pageWithNodes([WITH_LOCATION]);
  const scrolled = page.__wx.filter((c) => c.fn === 'pageScrollTo');

  assert.equal(scrolled.length, 1, '应当滚动一次');
  assert.equal(scrolled[0].args.scrollTop, 450, '卡片要落在屏幕正中');
});

test('量不到卡片时回落到 selector 形式 —— 有总比没有好', () => {
  /** 不给 rects，`boundingClientRect` 就回 null */
  const page = pageWithNodes([WITH_LOCATION], { systemInfo: { windowHeight: 1200 } });
  const scrolled = page.__wx.filter((c) => c.fn === 'pageScrollTo');

  assert.equal(scrolled.length, 1);
  assert.equal(scrolled[0].args.selector, '.map-card', '回落分支要用 selector');
});

test('滚动失败**不该弹错** —— 用户自己滑一下就能看到地图', () => {
  const page = pageWithNodes([WITH_LOCATION]);
  page.scrollToRouteMap();
  assert.equal(page.data.error, '', '不该把滚动失败写进 error');
});

// ── ② 点「到了」→ 全屏地图 ─────────────────────────────────

test('点某一站 → 全屏地图聚焦到它的坐标，并放大', () => {
  const page = pageWithNodes([WITH_LOCATION]);
  assert.equal(page.data.mapExpanded, false, '初始不该是全屏');

  page.focusNodeOnMap({ currentTarget: { dataset: { nodeid: 'n0' } } });

  assert.equal(page.data.mapExpanded, true);
  assert.equal(page.data.mapFocus.placeName, '哈工大');
  assert.equal(page.data.mapFocus.latitude, 45.7556);
  assert.equal(page.data.mapFocus.longitude, 126.6183);
  /** 16 是步行导航常用层级：街道名与路口看得清，又不至于只剩几栋楼 */
  assert.equal(page.data.mapFocus.scale, 16);
});

test('**没有坐标的站点不展开全屏地图** —— 展开一个空地图比不展开更让人困惑', () => {
  const noLoc = node('n1', '没有坐标的地方', 'pending', 1);
  delete noLoc.location;
  const page = pageWithNodes([noLoc]);

  page.focusNodeOnMap({ currentTarget: { dataset: { nodeid: 'n1' } } });

  assert.equal(page.data.mapExpanded, false, '没坐标就不该展开');
  assert.equal(page.data.mapFocus, null);
});

test('认不出的 nodeId 不崩、也不展开', () => {
  const page = pageWithNodes([WITH_LOCATION]);
  page.focusNodeOnMap({ currentTarget: { dataset: { nodeid: '不存在' } } });
  assert.equal(page.data.mapExpanded, false);
});

test('收起全屏地图会连 mapFocus 一起清掉 —— 否则下次展开会闪一下旧站', () => {
  const page = pageWithNodes([WITH_LOCATION]);
  page.focusNodeOnMap({ currentTarget: { dataset: { nodeid: 'n0' } } });
  assert.ok(page.data.mapFocus);

  page.closeFullMap();

  assert.equal(page.data.mapExpanded, false);
  assert.equal(page.data.mapFocus, null);
});

test('时间线节点带上坐标 —— 点站名要用它，不必回查 rawNodes', () => {
  /**
   * ⚠️ `buildTimelineView` 原来**没带 location**。
   * 而我第一版 `focusNodeOnMap` 是去 `rawNodes` 里找 ——
   * 那等于绕开时间线自己再查一次，多一个出错点。
   */
  const page = pageWithNodes([WITH_LOCATION]);
  assert.ok(page.data.timeline[0].location, '时间线节点要带坐标');
  assert.equal(page.data.timeline[0].location.latitude, 45.7556);
});

// ── 初始状态（防白屏）──────────────────────────────────────

test('mapExpanded / mapFocus 要在初始 data 里声明', () => {
  /**
   * ⚠️ 只在 setData 时赋值的话，模板首帧读 `undefined.xxx` 会抛异常
   * 并把**整页打白** —— 「我的」页刚因为同一类问题白过一次。
   */
  const page = loadPage('miniprogram/pages/trip/index.js', {});
  assert.equal(page.data.mapExpanded, false);
  assert.equal(page.data.mapFocus, null);
});

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

test('点「定这里」→ 把当前中心定为**集合点**，退出模式', () => {
  /**
   * ⚠️⚠️ 这条断言的对象被用户纠正过一次，值得记下来：
   *
   * 我第一版写成了 `myPoint` + `mySource: 'manual'`，那是"**我在哪**"。
   * 用户原话："还是不对，我是想把这个选点**当作集合点**用"
   *
   * 两者是不同的东西：
   *   `myPoint`      我的位置 —— 算"我要走多久"、作为集合候选的排序基准
   *   `meetingPoint` 集合点   —— 画集合点图钉、与我的位置连虚线、
   *                             传给 team-panel 发起集合
   *
   * 所以这里断言 `meetingPoint`，并确认 `myPoint` **没有被动过**。
   */
  const page = mapPage({ mapCenter: { latitude: 45.79, longitude: 126.53 } });
  page.setData({ myPoint: { latitude: 1, longitude: 2 }, mySource: 'gps' });
  page.startPick();

  page.confirmPick();

  assert.ok(page.data.meetingPoint, '要落成集合点');
  assert.equal(page.data.meetingPoint.latitude, 45.79, '用刚读到的中心，不是进来时的旧值');
  assert.equal(page.data.meetingPoint.longitude, 126.53);
  assert.equal(page.data.meetingPoint.fromMapPick, true, '要标明是地图上拖出来的，未核验');
  assert.equal(page.data.pickMode, false, '退出模式');

  /** 我的位置不该被这次操作改掉 —— 那是另一个概念 */
  assert.equal(page.data.myPoint.latitude, 1, 'myPoint 不该被选点改掉');
  assert.equal(page.data.mySource, 'gps');
});

test('读不到地图中心时**如实说**，不编一个坐标', () => {
  /**
   * 编一个坐标是最糟的：用户以为集合点定好了，而位置其实是错的 ——
   * 同伴按一个错误的地点赶过去。
   */
  const page = mapPage({ mapCenter: null });
  page.startPick();
  page.confirmPick();

  assert.equal(page.data.meetingPoint, null, '不该凭空得到一个集合点');
  assert.match(page.data.note, /没能读到地图中心/);
  assert.equal(page.data.pickMode, false, '读不到也要能退出模式');
});

test('取消选点不改变已有的集合点', () => {
  const page = mapPage({ mapCenter: CENTER });
  page.setAutoMeetingPoint({ placeId: 'p1', name: '原集合点', latitude: 1, longitude: 2 });

  page.startPick();
  page.cancelPick();

  assert.equal(page.data.pickMode, false);
  assert.equal(page.data.meetingPoint.name, '原集合点', '取消不该把已选的集合点弄丢');
});

test('选点模式下点地图**不再改变任何东西** —— 那会与拖动打架', () => {
  /**
   * ⚠️ 旧实现是"点地图选点"。现在选点由拖动完成，
   * 若 `onMapTap` 还改位置，用户在拖动时随手一点就会把点设到别处。
   */
  const page = mapPage();
  page.startPick();
  page.setData({ myPoint: null, meetingPoint: null });

  page.onMapTap({ detail: { latitude: 1, longitude: 2 } });

  assert.equal(page.data.meetingPoint, null, '选点模式下点地图不该设集合点');
  assert.equal(page.data.myPoint, null, '也不该设我的位置');
});

test('定位成功退出选点模式 —— 否则两个图钉同时存在', () => {
  const page = mapPage({
    mapCenter: CENTER,
    wx: { getLocation: (o) => o.success({ latitude: 45.8, longitude: 126.5, accuracy: 20 }) },
  });
  page.startPick();
  assert.equal(page.data.pickMode, true);

  page.useGps();

  assert.equal(page.data.pickMode, false, '定位给了位置就不该还在拖图钉');
});

test('定位**不覆盖**已选好的集合点 —— 那是两件事', () => {
  /**
   * ⚠️ 用户点「◎」只是想更新"我在哪"（用来算走多久），
   *    不该把他刚才辛苦拖出来的集合点冲掉。
   */
  const page = mapPage({
    mapCenter: CENTER,
    wx: { getLocation: (o) => o.success({ latitude: 45.8, longitude: 126.5, accuracy: 20 }) },
  });
  page.setAutoMeetingPoint({ placeId: 'map_1', name: '地图选点', latitude: 45.79, longitude: 126.53, fromMapPick: true });

  page.useGps();

  assert.equal(page.data.myPoint.latitude, 45.8, '我的位置更新了');
  assert.equal(page.data.meetingPoint.latitude, 45.79, '集合点不该被定位冲掉');
});

// ── 先自动生成，再拖动微调（2026-10-14 用户要求）──────────────

const SUGGEST_KEY = 'zhiyou-meet-suggest';

test('读回推荐的集合点：落成 meetingPoint、挪镜头、说清理由', () => {
  /**
   * 用户原话："应该是**点击集合后先自动生成集合点**，
   *           然后再用这个装置能拖动选点"
   *
   * 让人从零开始找"大家都不太远的点"很难：他不知道同伴在哪、谁离得最远。
   * 而后端早有 `meet.recommend`（minimax），只是界面上从来没有入口。
   */
  const page = loadPage('miniprogram/pages/map/index.js', {
    storage: {
      [SUGGEST_KEY]: {
        placeId: 'p_zhongyang',
        name: '中央大街',
        latitude: 45.7756,
        longitude: 126.6175,
        maxWalkMin: 12,
        rule: 'minimax：先让最远的成员步行时间最短',
        at: Date.now(),
      },
    },
  });

  const applied = page.applyMeetSuggestion();

  assert.equal(applied, true);
  assert.ok(page.data.meetingPoint, '要落成集合点');
  assert.equal(page.data.meetingPoint.name, '中央大街');
  assert.equal(page.data.meetingPoint.latitude, 45.7756);
  assert.equal(page.data.meetingPoint.fromSuggestion, true, '要标明是算法推荐的、未核验');
  /** 镜头要挪过去 —— 用户接着就在这儿拖动微调 */
  assert.equal(page.data.center.latitude, 45.7756);
  assert.equal(page.data.scale, 16);
  /** 理由要说出来，不做黑箱 */
  assert.match(page.data.note, /12 分钟|最远/);
});

test('推荐结果**一次性**：读完立刻清掉', () => {
  const page = loadPage('miniprogram/pages/map/index.js', {
    storage: {
      [SUGGEST_KEY]: { name: 'X', latitude: 45.7, longitude: 126.6, at: Date.now() },
    },
  });
  page.applyMeetSuggestion();
  assert.equal(page.__storage[SUGGEST_KEY], undefined, '不清的话下次切过来又变回推荐点');
});

test('**过期的推荐不执行** —— 半小时前的推荐点早就不合适了', () => {
  const page = loadPage('miniprogram/pages/map/index.js', {
    storage: {
      [SUGGEST_KEY]: {
        name: '很久以前的推荐',
        latitude: 45.7,
        longitude: 126.6,
        at: Date.now() - 30 * 60 * 1000,
      },
    },
  });
  const applied = page.applyMeetSuggestion();

  assert.equal(applied, false);
  assert.equal(page.data.meetingPoint, null, '过期就不该动集合点');
});

test('没有推荐时什么都不做，不崩', () => {
  const page = loadPage('miniprogram/pages/map/index.js', {});
  assert.equal(page.applyMeetSuggestion(), false);
  assert.equal(page.data.meetingPoint, null);
});

test('推荐点与**拖动微调**共用同一条路：微调后 fromSuggestion 仍在，便于追溯', () => {
  /**
   * ⚠️ 微调**不改变来源标记**：它是"从推荐点改过来的"，
   *    追溯时要知道这一点（"用户认可了算法的位置，只挪了一点点"）。
   */
  const page = loadPage('miniprogram/pages/map/index.js', {
    storage: { [SUGGEST_KEY]: { name: '推荐点', latitude: 45.7, longitude: 126.6, at: Date.now() } },
    mapCenter: { latitude: 45.71, longitude: 126.61 },
  });
  page.applyMeetSuggestion();
  page.startPick();
  page.confirmPick();

  assert.equal(page.data.meetingPoint.latitude, 45.71, '用了微调后的坐标');
  assert.equal(page.data.meetingPoint.fromMapPick, true, '标明是用户拖过的');
});
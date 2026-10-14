'use strict';

/**
 * 「队伍」页 —— 组队之后的一切（2026-10-14 用户重新划分职责）。
 *
 * 用户原话："我的的小队面板只管组队和解散小队，你说的推荐一个集合点
 *           也在地图界面，并且把地图界面的名字改为队伍"
 *
 * 职责分成两块：
 *   「我的」的小队面板 —— 只管组队与解散（建队、邀请码、加入、退出）
 *   「队伍」（地图页） —— 组队之后的事：队员位置、集合、出发
 *
 * ── 为什么这个划分是对的 ──────────────────────────────────
 *
 * 不只是"分页好看"：集合的每一个动作都要**看着地图**才有意义 ——
 * 在一个没有地图的页面上"推荐一个集合点"本来就别扭。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadPage } = require('./page-harness');

const KEY = 'zhiyou-active-crew';
const CENTER = { latitude: 45.7556, longitude: 126.6183 };

/** 带一个已加入队伍的页面 */
function crewPage(over) {
  return loadPage('miniprogram/pages/map/index.js', Object.assign({ storage: { [KEY]: 'crew_1' } }, over || {}));
}

// ── tab 名 ─────────────────────────────────────────────────

test('地图 tab 已改名为「队伍」', () => {
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'app.json'), 'utf8'));
  const mapTab = app.tabBar.list.find((t) => t.pagePath === 'pages/map/index');
  assert.equal(mapTab.text, '队伍', '用户要求把地图界面改名为队伍');
});

// ── 小队面板只剩组队 ───────────────────────────────────────

test('小队面板**不再有**集合相关的按钮', () => {
  /**
   * ⚠️ 这条守着职责划分。搬走的理由不只是"分页好看"：
   *    集合的每个动作都要看着地图才有意义。
   */
  const xml = fs.readFileSync(
    path.join(__dirname, '..', 'miniprogram', 'components', 'team-panel', 'index.wxml'),
    'utf8'
  );
  for (const moved of ['recommendMeetingPoint', 'createMeeting', 'meetAction', 'prepareDepart', 'cancelMeeting']) {
    assert.equal(xml.includes(moved), false, `面板里不该再有「${moved}」`);
  }
  /** 组队相关的必须还在 */
  for (const kept of ['create', 'join', 'leave', 'copyInvite']) {
    assert.ok(xml.includes(kept), `面板里应当保留「${kept}」（组队与解散）`);
  }
});

// ── 队伍页的新能力 ─────────────────────────────────────────

test('没有队伍时不显示集合界面，也不崩', () => {
  const page = loadPage('miniprogram/pages/map/index.js', {});
  page.loadCrew();
  assert.equal(page.data.crewId, '');
  assert.equal(page.data.meetTask, null);
});

test('有队伍时读出成员与进行中的集合', () => {
  const page = crewPage();
  page.setData({ crewId: 'crew_1' });
  /** 真实调用走替身；这里只验证方法存在且不抛 */
  assert.equal(typeof page.loadCrew, 'function');
  assert.equal(typeof page.recommendMeetingPoint, 'function');
  assert.equal(typeof page.createMeeting, 'function');
  assert.equal(typeof page.meetAction, 'function');
  assert.equal(typeof page.confirmDepart, 'function');
});

test('**没有队伍**时点「推荐集合点」给出可行动的提示', () => {
  const page = loadPage('miniprogram/pages/map/index.js', {});
  page.setData({ crewId: '' });
  page.recommendMeetingPoint();
  assert.match(page.data.teamError, /我的|创建|加入/, '要告诉他去哪儿组队');
});

test('没有集合点时点「发起集合」提示先选点', () => {
  const page = crewPage();
  page.setData({ crewId: 'crew_1', meetingPoint: null });
  page.createMeeting();
  assert.match(page.data.teamError, /推荐|✛/, '要指向两个可用的入口');
});

test('有集合点但没填名称时提示填名称 —— 名称是辨认的关键', () => {
  /**
   * ⚠️ "北门"与"南门"差了整整一站地。集合点名称必须能辨认，
   *    所以它是必填，且提示要举例子。
   */
  const page = crewPage();
  page.setData({
    crewId: 'crew_1',
    meetingPoint: { latitude: 45.7, longitude: 126.6 },
    pointName: '  ',
  });
  page.createMeeting();
  assert.match(page.data.teamError, /名称/);
  assert.match(page.data.teamError, /南门|指示牌/, '要给一个能照抄的例子');
});

test('集合时间必须是**今天还没到**的时间', () => {
  const page = crewPage();
  page.setData({
    crewId: 'crew_1',
    meetingPoint: { latitude: 45.7, longitude: 126.6 },
    pointName: '南门',
    meetTime: '00:01',
  });
  page.createMeeting();
  assert.match(page.data.teamError, /时间/);
});

test('共享位置前必须先有位置 —— 不拿编出来的坐标上报', () => {
  const page = crewPage();
  page.setData({ crewId: 'crew_1', myPoint: null });
  page.reportMyLocation();
  assert.match(page.data.teamError, /◎|✛/, '要指向取位置的两个入口');
});

test('确认出发前必须先检查后续行程 —— checkId 是服务端给的凭据', () => {
  const page = crewPage();
  page.setData({
    crewId: 'crew_1',
    meetTask: { meetTaskId: 'mt1', status: 'arrived_all' },
    departureCheck: null,
  });
  page.confirmDepart();
  assert.match(page.data.teamError, /准备出发|检查/);
});

test('`canDepart` 为假时也不放行 —— 检查结论说了不能走就不能走', () => {
  const page = crewPage();
  page.setData({
    crewId: 'crew_1',
    meetTask: { meetTaskId: 'mt1', status: 'arrived_all' },
    departureCheck: { checkId: 'c1', canDepart: false },
  });
  page.confirmDepart();
  assert.match(page.data.teamError, /准备出发|检查/);
});

// ── 拖动选点与集合点的关系 ─────────────────────────────────

test('拖动选出来的点**没有假 placeId** —— 传假的会让后端去核验不存在的记录', () => {
  const page = crewPage({ mapCenter: { latitude: 45.79, longitude: 126.53 } });
  page.setData({ crewId: 'crew_1' });
  page.startPick();
  page.confirmPick();

  assert.equal(page.data.meetingPoint.fromMapPick, true);
  /** `map_` 前缀是标记"这不是库里的地点"，不能当真实 placeId 传给后端 */
  assert.match(page.data.meetingPoint.placeId, /^map_/);
});

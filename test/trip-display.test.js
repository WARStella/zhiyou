'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { greetingView, buildTripDisplay } = require('../miniprogram/utils/trip-display');
const { loadPage, node } = require('./page-harness');
const now = () => new Date(2026, 9, 19, 10, 0);
const iso = (hour, minute = 0, day = 19) => new Date(2026, 9, day, hour, minute).toISOString();
const tap = dataset => ({ currentTarget: { dataset } });
function nodes() {
  return [node('a', '中央大街', 'done', 0, { plannedArriveAt: iso(9, 30), plannedLeaveAt: iso(10, 30), plannedStayMin: 60 }),
    node('b', '圣索菲亚教堂', 'pending', 1, { travelMode: 'walking', travelFromPrevMin: 8, travelFromPrevMeters: 620,
      plannedArriveAt: iso(10, 38), plannedLeaveAt: iso(11, 23) }),
    node('c', '防洪纪念塔', 'skipped', 2, { travelFromPrevMin: 200, plannedArriveAt: iso(12), plannedLeaveAt: iso(13) }),
    node('d', '松花江畔', 'pending', 3, { location: null, travelMode: 'driving', travelFromPrevMin: 10,
      plannedArriveAt: iso(12, 24), plannedLeaveAt: iso(13, 9) })];
}

test('进度按所有节点统计，缺少坐标和重复地点不丢站，跳过与到达分开', () => {
  const ns = nodes(); ns[3].placeId = ns[0].placeId;
  const original = JSON.stringify(ns);
  const view = buildTripDisplay(ns, null, now());
  assert.equal(view.totalCount, 4);
  assert.equal(view.reachedCount, 1);
  assert.equal(view.skippedCount, 1);
  assert.equal(view.progressPct, 25);
  assert.equal(view.rightRotation, 270);
  assert.equal(view.leftRotation, 180);
  assert.equal(view.walkMinText, '8');
  assert.equal(view.walkMetersText, '620');
  assert.equal(view.focusName, '圣索菲亚教堂');
  assert.equal(view.focusNodeId, 'b');
  assert.equal(view.departureText, '09:30');
  assert.equal(view.endText, '13:09');
  assert.equal(JSON.stringify(ns), original);
});

test('出发段计入步行，其他方式不当成步行；缺失耗时不能显示成0', () => {
  const ns = nodes();
  let view = buildTripDisplay(ns, { rawMode: 'walking', minutes: 10, meters: 800 }, now());
  assert.equal(view.walkMinText, '18');
  assert.equal(view.departureText, '09:20');
  view = buildTripDisplay(ns, { rawMode: 'driving', minutes: 10, meters: 800 }, now());
  assert.equal(view.walkMinText, '8');
  ns[1].travelFromPrevMin = null;
  view = buildTripDisplay(ns, null, now());
  assert.equal(view.walkMinText, '待计算');
  assert.match(view.subtitle, /步行时间待计算/);
});

test('圆环空行程、半程、过半和完成时角度有界，全部跳过不冒充到达', () => {
  const empty = buildTripDisplay([], null, now());
  assert.equal(empty.rightRotation, 180);
  assert.equal(empty.leftRotation, 180);
  assert.equal(empty.allResolved, false);
  const ns = nodes();
  ns[1].status = 'arrived';
  let view = buildTripDisplay(ns, null, now());
  assert.equal(view.progressPct, 50);
  assert.equal(view.rightRotation, 360);
  assert.equal(view.leftRotation, 180);
  assert.equal(view.focusLabel, '正在游览');
  ns[2].status = 'done';
  view = buildTripDisplay(ns, null, now());
  assert.equal(view.leftRotation, 270);
  ns.forEach(n => { n.status = 'done'; });
  view = buildTripDisplay(ns, null, now());
  assert.equal(view.allResolved, true);
  assert.equal(view.allReached, true);
  assert.equal(view.leftRotation, 360);
  ns.forEach(n => { n.status = 'skipped'; });
  view = buildTripDisplay(ns, null, now());
  assert.equal(view.allResolved, true);
  assert.equal(view.allReached, false);
  assert.equal(view.reachedCount, 0);
  assert.equal(view.skippedCount, 4);
  assert.equal(view.endText, '--:--');
});

test('日期按真实计划展示，跨天结束明确写次日；非法日期不给假时间', () => {
  const ns = [node('a', '夜游', 'pending', 0, { plannedArriveAt: iso(23, 30), plannedLeaveAt: iso(1, 30, 20) })];
  assert.equal(buildTripDisplay(ns, null, now()).endText, '次日 01:30');
  assert.equal(buildTripDisplay(ns, null, new Date(2026, 9, 18)).sectionLabel, '行程安排');
  assert.match(buildTripDisplay(ns, null, new Date(2026, 9, 18)).subtitle, /10月19日/);
  ns[0].plannedArriveAt = 'bad'; ns[0].plannedLeaveAt = 'bad';
  const view = buildTripDisplay(ns, null, now());
  assert.equal(view.departureText, '--:--');
  assert.equal(view.endText, '--:--');
});

test('问候使用真实昵称，未填写时不虚构姓名，早晚时间均可更新', () => {
  assert.equal(greetingView('', now()).title, '上午好');
  assert.equal(greetingView('  欢实  ', now()).title, '上午好，欢实');
  assert.equal(greetingView(null, new Date(2026, 9, 19, 23)).title, '晚上好');
  assert.equal(greetingView('', new Date(2026, 9, 19, 3)).title, '夜深了');
  assert.equal(greetingView('', now()).dateLabel, '10月19日 · 周一');
});

test('昵称读取失败不阻塞行程，切页后的旧昵称响应不更新页面', async () => {
  let release;
  const page = loadPage('miniprogram/pages/trip/index.js', { api: {
    'user.getProfile': () => new Promise(resolve => { release = resolve; }),
  } });
  try {
    const request = page.loadGreetingProfile();
    page.onHide();
    release({ ok: true, data: { profile: { nickname: '旧响应' } } });
    await request;
    assert.equal(page.data.viewerNickname, '');
    page.navigationVisible = true;
    const second = page.loadGreetingProfile();
    release({ ok: false, error: { message: '离线' } });
    await second;
    assert.equal(page.data.error, '');
    const third = page.loadGreetingProfile();
    release({ ok: true, data: { profile: { nickname: '真实昵称' } } });
    await third;
    assert.equal(page.data.viewerNickname, '真实昵称');
    assert.match(page.data.greeting.title, /真实昵称/);
  } finally { page.restore(); }
});

test('地图默认展开并适配视野，手动折叠跨刷新保持，重新查看不重复请求', () => {
  const page = loadPage('miniprogram/pages/trip/index.js');
  try {
    page.applyTrip({ tripId: 't', version: 1, nodes: nodes() });
    assert.ok(page.data.routeMap);
    assert.equal(page.data.routeMapOpen, true);
    assert.ok(page.__wx.some(c => c.fn === 'includePoints'));
    page.toggleRouteMap();
    page.applyTrip({ tripId: 't', version: 2, nodes: nodes() });
    assert.equal(page.data.routeMapOpen, false);
    page.focusRouteMap();
    assert.equal(page.data.routeMapOpen, true);
    assert.ok(page.__wx.some(c => c.fn === 'includePoints'));
    const route = { routeKey: 'saved', steps: [] };
    page.setData({ navLeg: route });
    page.toggleRouteMap();
    assert.equal(page.data.routeMapOpen, false);
    assert.equal(page.data.navLeg, route);
    page.viewCurrentRoute();
    assert.equal(page.data.routeMapOpen, true);
    assert.equal(page.data.navLeg, route);
    assert.equal(page.__calls.length, 0);
    page.setData({ changeText: '停留五十分钟' });
    page.toggleChangePanel(tap({ focus: true }));
    assert.equal(page.data.changePanelOpen, true);
    assert.equal(page.data.changeText, '停留五十分钟');
    assert.equal(page.__wx.at(-1).args.selector, '#trip-change-panel');
    page.applyTrip({ tripId: 'new', version: 1, nodes: nodes() });
    assert.equal(page.data.routeMapOpen, true);
  } finally { page.restore(); }
});

test('原进度接口更新圆环和当前状态，完成后不把最后一站标成当前；新行程重置折叠状态', async () => {
  const ns = nodes();
  const page = loadPage('miniprogram/pages/trip/index.js', { api: { 'trip.progress': () => ({ ok: true,
    data: { version: 2, nodes: ns.map(n => n.nodeId === 'b' ? { ...n, status: 'arrived' } : n) } }) } });
  try {
    page.applyTrip({ tripId: 't', version: 1, nodes: ns });
    page.nodeProgress(tap({ nodeid: 'b', status: 'arrived' }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.data.tripDisplay.reachedCount, 2);
    assert.equal(page.data.tripDisplay.progressPct, 50);
    assert.equal(page.data.tripDisplay.focusLabel, '正在游览');
    assert.equal(page.data.timeline[1].statusLabel, '游览中');
    const completed = ns.map(n => ({ ...n, status: 'done' }));
    page.applyTrip({ tripId: 't', version: 3, nodes: completed });
    assert.equal(page.data.tripDisplay.allResolved, true);
    assert.ok(page.data.timeline.every(n => !n.isCurrent && !n.canAdjust));
    assert.ok(page.data.timeline.every(n => n.progressActions[0].label === '撤销'));
    page.setData({ sourcePanelOpen: true });
    page.applyTrip({ tripId: 'new', version: 1, nodes: ns });
    assert.ok(page.data.routeMap);
    assert.equal(page.data.sourcePanelOpen, false);
  } finally { page.restore(); }
});

test('仅刷新地图不丢失本段修改草稿；版本变化后旧草稿不得提交', () => {
  const page = loadPage('miniprogram/pages/trip/index.js');
  try {
    page.applyTrip({ tripId: 't', version: 1, nodes: nodes() });
    page.openLegEditor(tap({ nodeid: 'b' }));
    page.onInlineLegModeTap(tap({ mode: 'driving' }));
    page.rebuildFromNodes({ refreshNavigation: false });
    assert.equal(page.data.legEditor.selected, 'driving');
    page.setData({ trip: { tripId: 't', version: 2 } });
    page.applyInlineLegMode();
    assert.equal(page.data.legEditor, null);
    assert.match(page.data.error, /行程已更新/);
    assert.equal(page.__calls.length, 0);
  } finally { page.restore(); }
});

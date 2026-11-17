'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, node } = require('./page-harness');
const { makeWorld, expectOk, C, defaultMapFactory } = require('./helpers');

const tap = dataset => ({ currentTarget: { dataset } });
function plan() {
  const nodes = [node('a', '甲', 'pending', 0), node('b', '乙', 'pending', 1), node('c', '丙', 'pending', 2)];
  return { tripId: 't', version: 1, nodes,
    startPoint: { latitude: 45.75, longitude: 126.60, label: '出发位置' },
    startLeg: { mode: 'walking', minutes: 8, toPlaceName: '甲' },
    legOptions: nodes.map((n, i) => ({ toNodeId: n.nodeId, toPlaceId: n.placeId,
      toPlaceName: n.placeName, fromPlaceName: nodes[i - 1] && nodes[i - 1].placeName,
      isFirstLeg: i === 0, chosenMode: 'walking', recommendedMode: 'driving',
      options: [{ mode: 'walking', minutes: 8 }, { mode: 'driving', minutes: 3, isRecommended: true }],
      unavailable: [{ mode: 'transit', modeLabel: '公交', reason: '暂未取得公交路线' }],
    })),
  };
}
function pageWithPlan(options) {
  const page = loadPage('miniprogram/pages/trip/index.js', options);
  page.applyTrip(plan());
  return page;
}
function choose(page, mode) {
  page.onLegModeTap(tap({ inline: true, legkey: page.data.legEditor.legKey, mode }));
}

test('新路线集中选择一次，关闭后修改入口位于各路段；重新生成相同地点仍会询问', () => {
  const page = pageWithPlan();
  try {
    assert.equal(page.data.legPickerOpen, true);
    assert.ok(page.__wx.some(c => c.fn === 'pageScrollTo' && c.args.selector === '#initial-leg-picker'));
    page.finishInitialLegPicker();
    assert.equal(page.data.legPickerOpen, false);
    page.applyTrip({ ...plan(), version: 2 });
    assert.equal(page.data.legPickerOpen, false);
    assert.equal(page.data.startLeg.toNodeId, 'a');
    assert.equal(page.data.timeline[0].legToNext.toNodeId, 'b');
    assert.equal(page.data.timeline[0].legToNext.editable, true);
    page.resetTrip();
    page.applyTrip({ ...plan(), tripId: 'new' });
    assert.equal(page.data.legPickerOpen, true);
  } finally { page.restore(); }
});

test('整卡展开收起保留所有路段和草稿，确认后可再次展开完整列表', () => {
  const page = pageWithPlan();
  try {
    assert.equal(page.data.legPicker.length, 3);
    const original = JSON.stringify(page.data.rawNodes);
    const legKey = page.data.legPicker.find(row => row.toNodeId === 'c').legKey;
    page.onLegModeTap(tap({ legkey: legKey, mode: 'driving' }));
    assert.equal(page.data.legPicker.find(row => row.toNodeId === 'c').selected, 'driving');
    page.toggleLegPicker();
    assert.equal(page.data.legPickerOpen, false);
    page.toggleLegPicker();
    assert.equal(page.data.legPickerOpen, true);
    assert.equal(page.data.legPicker.length, 3);
    assert.equal(page.data.legModes[legKey], 'driving');
    assert.equal(JSON.stringify(page.data.rawNodes), original);
    assert.equal(page.__calls.length, 0);
    page.resetLegModes();
    assert.deepEqual(page.data.legModes, {});
    page.finishInitialLegPicker();
    page.toggleLegPicker();
    assert.equal(page.data.legPickerOpen, true);
    assert.equal(page.data.legPicker.length, 3);
    page.resetTrip();
    assert.equal(page.data.legPickerOpen, false);
    assert.equal(page.data.legPicker.length, 0);
  } finally { page.restore(); }
});

test('单段草稿独立于集中选择，取消和切换路段都不写入原行程', () => {
  const page = pageWithPlan();
  try {
    const original = JSON.stringify(page.data.rawNodes);
    page.onLegModeTap(tap({ placeid: 'p_c', mode: 'driving' }));
    page.openLegEditor(tap({ nodeid: 'b' }));
    assert.equal(page.data.legPickerOpen, false);
    assert.deepEqual(page.data.legModes, {});
    assert.equal(page.data.legEditor.fromName, '甲');
    assert.equal(page.data.legEditor.toName, '乙');
    choose(page, 'driving');
    assert.equal(page.data.legEditor.changed, true);
    assert.equal(page.data.timeline[0].legToNext.mode, 'walking');
    assert.equal(page.__calls.length, 0);
    page.openLegEditor(tap({ nodeid: 'c' }));
    assert.equal(page.data.legEditor.selected, 'walking');
    page.cancelLegEditor();
    assert.equal(page.data.legEditor, null);
    assert.equal(JSON.stringify(page.data.rawNodes), original);
    assert.deepEqual(page.data.legModes, {});
  } finally { page.restore(); }
});

test('出发段能独立修改；重复游览同一地点按节点定位，候选和请求不串段', async () => {
  const page = pageWithPlan({ api: { 'trip.adjust': { ok: true, data: { proposalId: 'p', candidates: [] } } } });
  try {
    const d = plan();
    d.nodes[2] = { ...d.nodes[2], placeId: d.nodes[0].placeId, placeName: '甲' };
    d.legOptions[2] = { ...d.legOptions[2], toPlaceId: d.nodes[0].placeId, toPlaceName: '甲',
      options: [{ mode: 'walking', minutes: 50 }, { mode: 'driving', minutes: 15 }] };
    page.applyTrip(d);
    page.openLegEditor(tap({ nodeid: 'a' }));
    assert.equal(page.data.legEditor.fromName, '出发位置');
    assert.equal(page.data.legEditor.options[1].minutes, 3);
    page.openLegEditor(tap({ nodeid: 'c' }));
    assert.equal(page.data.legEditor.fromName, '乙');
    assert.equal(page.data.legEditor.options[1].minutes, 15);
    choose(page, 'driving');
    await page.applyInlineLegMode();
    assert.deepEqual(page.__calls.at(-1).payload.trigger.payload.operations,
      [{ type: 'change_travel_mode', payload: { nodeId: 'c', mode: 'driving' } }]);
  } finally { page.restore(); }
});

test('已到达、已完成和跳过的路段不可修改；更新进度时关闭旧草稿', () => {
  const page = pageWithPlan();
  try {
    for (const status of ['arrived', 'done', 'skipped']) {
      const d = plan();
      d.nodes[1].status = status;
      page.applyTrip(d);
      assert.equal(page.data.timeline[0].legToNext.editable, false);
      page.openLegEditor(tap({ nodeid: 'b' }));
      assert.equal(page.data.legEditor, null);
    }
    page.applyTrip(plan());
    page.openLegEditor(tap({ nodeid: 'b' }));
    choose(page, 'driving');
    page.setData({ rawNodes: page.data.rawNodes.map(n => n.nodeId === 'b' ? { ...n, status: 'arrived' } : n) });
    page.rebuildFromNodes();
    assert.equal(page.data.legEditor, null);
    assert.equal(page.data.timeline[0].legToNext.editable, false);
  } finally { page.restore(); }
});

test('恢复的行程没有候选耗时也能申请修改，不能编造分钟数或显示无起点的第一段', () => {
  const page = loadPage('miniprogram/pages/trip/index.js');
  try {
    page.applyTrip({ tripId: 'restored', version: 1, nodes: plan().nodes });
    page.openLegEditor(tap({ nodeid: 'a' }));
    assert.equal(page.data.legEditor, null);
    page.openLegEditor(tap({ nodeid: 'b' }));
    assert.equal(page.data.legEditor.options.length, 5);
    assert.ok(page.data.legEditor.options.every(o => o.minutes === null));
    choose(page, 'subway');
    assert.equal(page.data.legEditor.selected, 'subway');
    choose(page, 'teleport');
    assert.equal(page.data.legEditor.selected, 'subway');
    choose(page, 'walking');
    assert.equal(page.data.legEditor.changed, false);
  } finally { page.restore(); }
});

test('单段计算失败保留草稿；提交期间不能改方式、换段或重复请求', async () => {
  let release;
  const page = pageWithPlan({ api: { 'trip.adjust': () => new Promise(resolve => { release = resolve; }) } });
  try {
    page.openLegEditor(tap({ nodeid: 'b' }));
    choose(page, 'driving');
    const request = page.applyInlineLegMode();
    choose(page, 'walking');
    page.openLegEditor(tap({ nodeid: 'c' }));
    page.cancelLegEditor();
    page.applyInlineLegMode();
    assert.equal(page.data.legEditor.selected, 'driving');
    assert.equal(page.data.legEditor.toNodeId, 'b');
    assert.equal(page.__calls.length, 1);
    release({ ok: false, error: { message: '地图查询失败' } });
    await request;
    assert.equal(page.data.busy, '');
    assert.equal(page.data.legEditor.changed, true);
    assert.match(page.data.error, /地图查询失败/);
    assert.equal(page.data.rawNodes[1].travelMode, 'walking');
  } finally { page.restore(); }
});

test('切换行程后旧的单段响应不能覆盖新行程或弹出旧方案', async () => {
  let release;
  const page = pageWithPlan({ api: { 'trip.adjust': () => new Promise(resolve => { release = resolve; }) } });
  try {
    page.openLegEditor(tap({ nodeid: 'b' }));
    choose(page, 'driving');
    const request = page.applyInlineLegMode();
    page.applyTrip({ ...plan(), tripId: 'another' });
    release({ ok: true, data: { proposalId: 'stale', candidates: [] } });
    await request;
    assert.equal(page.data.trip.tripId, 'another');
    assert.equal(page.data.proposal, null);
    assert.equal(page.data.legEditor, null);
  } finally { page.restore(); }
});

test('放弃调整方案后，重新打开本段仍以已保存方式为准', async () => {
  const page = pageWithPlan({ api: { 'trip.adjust': { ok: true, data: { proposalId: 'p', candidates: [] } } } });
  try {
    page.openLegEditor(tap({ nodeid: 'b' }));
    choose(page, 'driving');
    await page.applyInlineLegMode();
    page.discardProposal();
    page.openLegEditor(tap({ nodeid: 'b' }));
    assert.equal(page.data.legEditor.selected, 'walking');
    assert.equal(page.data.legEditor.changed, false);
    assert.deepEqual(page.data.legModes, {});
  } finally { page.restore(); }
});

test('从路段修改到生效端到端：无取舍时不弹二次确认，只改目标段方式并重算后续时间', async () => {
  const w = await makeWorld({ createMapProvider: (...args) => ({ ...defaultMapFactory(...args),
    distanceMatrix: async (origin, destinations, mode) => ({ ok: true, requestCount: 1,
      elements: destinations.map(() => ({ usable: true, distanceMeters: 1500,
        durationMinutes: mode === 'bicycling' ? 10 : 25 })) }),
  }) });
  const d = expectOk(await w.A('trip.plan', { placeIds: ['p_zhongyang', 'p_sofia', 'p_fanghong'],
    startAt: w.NOW, preferredMode: 'walking' }));
  expectOk(await w.A('trip.progress', { tripId: d.tripId, nodeId: d.nodes[0].nodeId, status: 'done' }, { expectedVersion: 1 }));
  const before = await w.repo.get(C.TRIPS, d.tripId);
  const page = loadPage('miniprogram/pages/trip/index.js', { api: {
    'trip.adjust': (p, o) => w.A('trip.adjust', p, o),
    'trip.confirmChange': (p, o) => w.A('trip.confirmChange', p, o),
  } });
  try {
    page.applyTrip({ ...d, version: 2, nodes: before.nodes });
    page.finishInitialLegPicker();
    page.openLegEditor(tap({ nodeid: d.nodes[1].nodeId }));
    choose(page, 'bicycling');
    await page.applyInlineLegMode();
    const call = page.__calls.at(-1);
    assert.equal(call.action, 'trip.adjust');
    /** 没有取舍时不再强制走"再点一次确认"，由后端直接生效 */
    assert.equal(call.payload.autoApply, undefined);
    assert.equal(call.options.expectedVersion, 2);
    const after = await w.repo.get(C.TRIPS, d.tripId);
    assert.equal(after.version, 3, '无取舍应直接生效，版本前进一步');
    assert.equal(after.nodes[1].travelMode, 'bicycling');
    assert.equal(after.nodes[0].status, 'done', '完成记录要保留');
    assert.equal(page.data.rawNodes[1].travelMode, 'bicycling');
    assert.equal(page.data.rawNodes[1].travelFromPrevMin, 10);
    assert.equal(page.data.rawNodes[2].travelMode, before.nodes[2].travelMode);
    assert.notEqual(new Date(page.data.rawNodes[2].plannedArriveAt).getTime(), new Date(before.nodes[2].plannedArriveAt).getTime());
    assert.equal(page.data.timeline[0].legToNext.mode, 'bicycling');
    assert.equal(page.data.legPickerOpen, false);
    assert.equal(page.data.legEditor, null);
    assert.equal(page.data.proposalCandidates.length, 0, '直接生效时不应再弹确认卡');
    page.openLegEditor(tap({ nodeid: d.nodes[1].nodeId }));
    assert.equal(page.data.legEditor.selected, 'bicycling');
    assert.equal(page.data.legEditor.options.find(o => o.mode === 'bicycling').minutes, 10);
  } finally { page.restore(); }
});

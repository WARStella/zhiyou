'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, makeCrew, expectOk, C, defaultMapFactory } = require('./helpers');
const { loadPage, loadComponent } = require('./page-harness');
const { autoPick } = require('../cloudfunctions/api/actions/place');
const rules = require('../cloudfunctions/api/lib/ai/rulebased');
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
const point = { latitude: 45.77, longitude: 126.62 };
const places = ['中央大街', '索菲亚教堂'].map((name, i) => ({ name, poiId: 'feedback-' + i,
  location: { latitude: 45.77 + i * 0.004, longitude: 126.62 },
  visitDurationMin: { default: 30, min: 5, max: 120 } }));

test('A→B→A 保留三个独立节点，首程与返程的交通方式和导航目标不串站', async () => {
  const w = await makeWorld({ createMapProvider: () => ({ ...defaultMapFactory(),
    async distanceMatrix(_from, tos, mode) {
      const minutes = { walking: 12, bicycling: 4, driving: 2 }[mode];
      return { ok: true, elements: tos.map(() => ({ usable: true, distanceMeters: 700,
        durationMinutes: minutes, durationSeconds: minutes * 60 })) };
    },
  }) });
  const spec = { places: [places[0], places[1], places[0]], startAt: w.NOW,
    startPoint: { latitude: 45.765, longitude: 126.62 } };
  const first = expectOk(await w.A('trip.plan', spec));
  assert.equal(first.nodes.length, 3);
  assert.equal(new Set(first.nodes.map(n => n.nodeId)).size, 3);
  assert.equal(first.nodes[0].placeId, first.nodes[2].placeId);
  const plan = expectOk(await w.A('trip.plan', { ...spec, legModes: {
    [first.nodes[0].nodeId]: 'walking', [first.nodes[2].nodeId]: 'bicycling',
  } }));
  assert.equal(plan.nodes[0].travelMode, 'walking');
  assert.equal(plan.nodes[2].travelMode, 'bicycling');
  assert.notEqual(plan.nodes[0].travelFromPrevMin, plan.nodes[2].travelFromPrevMin);
  assert.equal(plan.startLeg.minutes, plan.nodes[0].travelFromPrevMin);
  assert.deepEqual(plan.legOptions.map(l => l.toNodeId), plan.nodes.map(n => n.nodeId));
  const p = loadPage('miniprogram/pages/trip/index.js');
  try {
    p.applyTrip(plan);
    assert.equal(p.data.currentLeg.toNodeId, plan.nodes[0].nodeId);
    const nodes = plan.nodes.map((n, i) => ({ ...n, status: i < 2 ? 'arrived' : 'pending' }));
    p.applyTrip({ ...plan, nodes });
    assert.equal(p.data.currentLeg.toNodeId, plan.nodes[2].nodeId);
    assert.equal(p.data.currentLeg.to, places[0].name);
    assert.equal(p.data.navLeg, null);
    p.applyTrip({ ...plan, nodes: nodes.map(n => ({ ...n, status: 'arrived' })) });
    assert.equal(p.data.currentLeg, null);
  } finally { p.restore(); }
});

test('明确再次到访保留搜索顺序并复用同一候选，不误选另一个同名 POI', () => {
  const parsed = rules.parse('先去中央大街，再去索菲亚教堂，最后回到中央大街', {
    knownPlaceNames: ['中央大街', '索菲亚教堂'],
  });
  assert.deepEqual(parsed.searchKeywords, ['中央大街', '索菲亚教堂', '中央大街']);
  assert.deepEqual(rules.parse('第一站中央大街，第二站索菲亚教堂，第三站中央大街', {
    knownPlaceNames: ['中央大街', '索菲亚教堂'],
  }).searchKeywords, parsed.searchKeywords);
  const candidates = places.map((p, i) => ({ ...p, itemId: 'c' + i, visitable: true }));
  const picked = autoPick(candidates, { keywords: parsed.searchKeywords });
  assert.deepEqual(picked.itemIds, ['c0', 'c1', 'c0']);
});

test('末尾再去一次和移除只改变指定站次，重复目的地分别选择交通方式', async () => {
  const p = loadPage('miniprogram/pages/trip/index.js');
  try {
    p.applyAutoSelect(places.map((x, i) => ({ ...x, itemId: 'p' + i, tripNodeAllowed: true })),
      { itemIds: ['p0', 'p1'], note: '', items: [] });
    p.appendVisit({ currentTarget: { dataset: { index: 0 } } });
    assert.deepEqual(p.data.selected.map(x => x.itemId), ['p0', 'p1', 'p0']);
    assert.equal(new Set(p.data.selected.map(x => x.visitId)).size, 3);
    assert.equal(p.data.unselectedCandidateCount, 0);
    assert.deepEqual((await p.chooseRouteOrder(point)).map(x => x.itemId), ['p0', 'p1', 'p0']);
    const options = [{ mode: 'walking', minutes: 10 }, { mode: 'bicycling', minutes: 3 }];
    p.setData({ legPicker: p.buildLegPicker({ legOptions: [
      { toPlaceId: 'p0', toNodeId: 'n0', options, chosenMode: 'walking' },
      { toPlaceId: 'p0', toNodeId: 'n2', options, chosenMode: 'walking' },
    ] }) });
    p.onLegModeTap({ currentTarget: { dataset: { legkey: 'n2', mode: 'bicycling' } } });
    assert.equal(p.data.legPicker[0].selected, 'walking');
    assert.equal(p.data.legPicker[1].selected, 'bicycling');
    p.removeSelected({ currentTarget: { dataset: { id: 'p0', visitid: p.data.selected[2].visitId } } });
    assert.deepEqual(p.data.selected.map(x => x.itemId), ['p0', 'p1']);
    assert.equal(p.data.candidates[0].selected, true);
  } finally { p.restore(); }
});

async function meetingWorld() {
  const w = await makeWorld(), crew = await makeCrew(w);
  const task = expectOk(await w.A('meet.create', { crewId: crew.crewId, point, placeName: '南门',
    plannedMeetAt: new Date(w.NOW.getTime() + 30 * 60000).toISOString() }));
  const payload = { meetTaskId: task.meetTaskId, decision: 'confirm' };
  for (const who of ['B', 'C']) expectOk(await w[who]('meet.confirm', payload, { expectedVersion: task.version }));
  return { w, ...crew, task };
}

test('集合中成员退队后，其他成员到达可检查并确认出发，重入队不恢复旧参与资格', async () => {
  const { w, crewId, inviteCode, task } = await meetingWorld();
  expectOk(await w.C('crew.leave', { crewId }));
  const after = expectOk(await w.A('meet.get', { meetTaskId: task.meetTaskId })).meetTask;
  assert.equal(after.participants.length, 2);
  const stored = await w.repo.get(C.MEET_TASKS, task.meetTaskId);
  assert.equal(stored.withdrawnParticipants[0].userId, 'openid_C');
  expectOk(await w.C('crew.join', { inviteCode }));
  assert.equal(expectOk(await w.A('meet.get', { meetTaskId: task.meetTaskId })).meetTask.participants.length, 2);
  for (const who of ['A', 'B']) expectOk(await w[who]('meet.arrive', { meetTaskId: task.meetTaskId }));
  const check = expectOk(await w.A('meet.prepareDepart', { meetTaskId: task.meetTaskId }, { expectedVersion: 1 }));
  assert.equal(check.canDepart, true);
  const departed = expectOk(await w.A('meet.depart', { meetTaskId: task.meetTaskId, checkId: check.checkId }, { expectedVersion: 1 }));
  assert.equal(departed.status, 'departed');
});

test('仅剩未到者退出或被移除时自动重算全员到齐；与到达并发不丢进度', async () => {
  for (const removed of [false, true]) {
    const { w, crewId, task } = await meetingWorld();
    expectOk(await w.A('meet.arrive', { meetTaskId: task.meetTaskId }));
    const results = await Promise.all([
      w.B('meet.arrive', { meetTaskId: task.meetTaskId }),
      removed ? w.A('crew.remove', { crewId, userId: 'openid_C' }) : w.C('crew.leave', { crewId }),
    ]);
    results.forEach(expectOk);
    const after = expectOk(await w.A('meet.get', { meetTaskId: task.meetTaskId })).meetTask;
    assert.equal(after.status, 'arrived_all');
    assert.equal(after.participants.length, 2);
    assert.ok(after.allArrivedAt);
  }
});

test('升级前遗留的退队参与者由集合读取修复；发起人退出后剩余成员可继续出发', async () => {
  const { w, crewId, task } = await meetingWorld();
  const member = await w.repo.findOne(C.CREW_MEMBERS, { crewId, userId: 'openid_C' });
  await w.repo.update(C.CREW_MEMBERS, member._id, { status: 'left' });
  assert.equal(expectOk(await w.A('meet.get', { meetTaskId: task.meetTaskId })).meetTask.participants.length, 2);
  expectOk(await w.A('crew.leave', { crewId }));
  const after = expectOk(await w.B('meet.get', { meetTaskId: task.meetTaskId })).meetTask;
  assert.equal(after.initiatorUserId, 'openid_B');
  expectOk(await w.B('meet.arrive', { meetTaskId: task.meetTaskId }));
  assert.equal(expectOk(await w.B('meet.prepareDepart', { meetTaskId: task.meetTaskId }, { expectedVersion: 1 })).canDepart, true);
});

test('已知断网不发出云请求，恢复网络也不自动发送，手动重试复用消息编号', async () => {
  let networkType = 'none';
  const owner = loadPage('miniprogram/pages/map/index.js', { api: {
    'chat.send': payload => ({ ok: true, data: { message: { ...payload, messageId: 'm' } } }),
  } });
  const c = loadComponent('miniprogram/components/team-chat-composer/index.js', { properties: { crewId: 'crew' },
    storage: { 'zhiyou-active-crew': 'crew' }, wx: { getNetworkType: o => o.success({ networkType }) } });
  try {
    c.__attached(); c.onText({ detail: { value: '等等我' } });
    await c.sendMessage();
    assert.equal(owner.__calls.length, 0);
    assert.equal(c.data.text, '等等我'); assert.equal(c.data.uncertain, true);
    const id = c.pending.clientMessageId;
    networkType = 'wifi'; await settle();
    assert.equal(owner.__calls.length, 0);
    await c.sendMessage();
    assert.equal(owner.__calls.length, 1);
    assert.equal(owner.__calls[0].payload.clientMessageId, id);
    assert.equal(c.data.text, '');
  } finally { c.dispose(); c.__restoreGlobals(); owner.restore(); }
});

function noticePage(options = {}) {
  const p = loadPage('miniprogram/pages/map/index.js', { storage: { 'zhiyou-active-crew': 'crew' },
    api: { 'crew.get': { ok: true, data: { crew: {}, members: [] } },
      'team.current': { ok: true, data: {} },
      'subscribe.status': { ok: true, data: { intents: [{ kind: 'meet_created', label: '活动集合通知', templateId: 'template' }] } },
      'subscribe.report': { ok: true, data: {} }, ...options.api }, wx: options.wx });
  p.setData({ crewId: 'crew' });
  return p;
}

test('订阅入口模板未就绪、微信能力缺失或同步抛错均给出提示，不会卡在处理中', async () => {
  const p = noticePage({ wx: { requestSubscribeMessage: () => { throw new Error('unsupported'); } } });
  try {
    const event = { currentTarget: { dataset: { kind: 'meet_created' } } };
    p.requestNotify(event); assert.match(p.data.notifyNote, /模板尚未就绪/);
    await p.loadNotifyStatus(); p.requestNotify(event);
    assert.equal(p.data.notifyBusy, false); assert.match(p.data.notifyNote, /无法打开/);
    const original = wx.requestSubscribeMessage;
    wx.requestSubscribeMessage = undefined; p.requestNotify(event);
    assert.match(p.data.notifyNote, /更新微信/);
    wx.requestSubscribeMessage = original;
  } finally { p.restore(); }
});

test('集合通知由点击直接调起微信授权，保存失败不假称已开启；状态读取失败可重试', async () => {
  let called = false;
  const p = noticePage({ wx: { requestSubscribeMessage: o => { called = true; o.success({ template: 'accept' }); } },
    api: { 'subscribe.report': { ok: false, error: { message: '断网' } } } });
  try {
    await p.loadNotifyStatus();
    p.requestNotify({ currentTarget: { dataset: { kind: 'meet_created' } } });
    assert.equal(called, true);
    await settle();
    assert.equal(p.data.notifyBusy, false); assert.match(p.data.notifyNote, /未保存成功/);
  } finally { p.restore(); }
  const failed = noticePage({ api: { 'subscribe.status': { ok: false, error: { message: '网络中断' } } } });
  try {
    await failed.loadNotifyStatus();
    assert.equal(failed.data.notifyLoading, false); assert.match(failed.data.notifyLoadError, /网络中断/);
  } finally { failed.restore(); }
});

test('重复点击同队通知作为不同事件处理，提示独立于订阅结果且可在地图上方看到', async () => {
  const p = noticePage();
  try {
    for (const at of [Date.now() - 100, Date.now() - 50]) {
      p.__storage['zhiyou-notice-landing'] = { crewId: 'crew', at };
      const landing = p.readNoticeLanding(); assert.equal(landing.at, at);
      assert.equal(p.applyNoticeLanding(landing), true);
      await p.noticeLandingLoad;
    }
    assert.equal(p.__wx.filter(c => c.fn === 'showToast').length, 2);
    assert.match(p.data.noticeLandingNote, /已从提醒回到队伍/);
    p.setData({ notifyNote: '订阅没有成功' });
    assert.match(p.data.noticeLandingNote, /已从提醒回到队伍/);
    p.dismissNoticeLanding(); assert.equal(p.data.noticeLandingNote, '');
  } finally { p.restore(); }
});

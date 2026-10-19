'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./page-harness');
const { makeWorld, makeCrew, expectOk } = require('./helpers');

const crewId = 'crew';
const meeting = (id, latitude = 45.77) => ({ meetTaskId: id, placeName: '集合地点' + id,
  point: { latitude, longitude: 126.62 }, status: 'confirmed', participants: [] });
const crewInfo = { ok: true, data: { me: 'owner', myRole: 'owner', members: [] } };
const currentMeeting = id => ({ ok: true, data: { meetTaskId: id } });
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

test('旧的无集合响应迟到，不能清除新刷新已经显示的集合任务与图钉', async () => {
  let releaseOld, requests = 0;
  const task = meeting('new');
  const page = loadPage('miniprogram/pages/map/index.js', { storage: { 'zhiyou-active-crew': crewId }, api: {
    'crew.get': crewInfo,
    'team.current': () => ++requests === 1 ? new Promise(resolve => { releaseOld = resolve }) : currentMeeting(task.meetTaskId),
    'meet.get': { ok: true, data: { meetTask: task } },
  } });
  try {
    const old = page.loadCrew();
    await page.loadCrew();
    const marker = structuredClone(page.data.markers.find(m => m.id === 3000));
    assert.ok(marker);
    releaseOld(currentMeeting(null));
    await old;
    assert.equal(page.data.meetTask.meetTaskId, task.meetTaskId);
    assert.deepEqual(page.data.markers.find(m => m.id === 3000), marker);
  } finally { page.stopChatPreview(); page.restore(); }
});

test('旧集合详情迟到不能把新集合图钉移回旧坐标，旧错误也不能覆盖成功状态', async () => {
  for (const failOld of [false, true]) {
    let releaseOld, requests = 0;
    const latest = meeting('latest', 45.8);
    const page = loadPage('miniprogram/pages/map/index.js', { storage: { 'zhiyou-active-crew': crewId }, api: {
      'crew.get': crewInfo,
      'team.current': () => currentMeeting(++requests === 1 ? 'old' : latest.meetTaskId),
      'meet.get': payload => payload.meetTaskId === 'old' ? new Promise(resolve => { releaseOld = resolve })
        : { ok: true, data: { meetTask: latest } },
    } });
    try {
      const old = page.loadCrew();
      await flush();
      await page.loadCrew();
      releaseOld(failOld ? { ok: false, error: { message: '旧请求失败' } }
        : { ok: true, data: { meetTask: meeting('old', 45.7) } });
      await old;
      assert.equal(page.data.meetTask.meetTaskId, latest.meetTaskId);
      assert.equal(page.data.markers.find(m => m.id === 3000).latitude, latest.point.latitude);
      assert.equal(page.data.teamError, '');
    } finally { page.stopChatPreview(); page.restore(); }
  }
});

test('队长与队员点击立即更新位置后都保留集合图钉，不把成员定位覆盖到集合点', async () => {
  for (const isOwner of [true, false]) {
    let listener, sequence = 0;
    const point = { latitude: 45.75, longitude: 126.60 };
    const service = { subscribe(callback) { listener = callback; return () => { listener = null } },
      async refresh() {
        const state = { crewId, sharing: true, active: true, point, sampledAt: ++sequence, error: '' };
        if (listener) listener(state);
        return state;
      } };
    const page = loadPage('miniprogram/pages/map/index.js', { storage: { 'zhiyou-active-crew': crewId },
      app: { getLocationSharing: () => service }, api: { 'loc.list': { ok: true, data: { members: [] } } } });
    try {
      const task = meeting('active');
      page.setData({ crewId, isOwner, meetTask: task, meetingPoint: { placeId: task.meetTaskId,
        name: task.placeName, ...task.point, fromTeamTask: true } });
      page.refreshMarkers();
      const before = structuredClone(page.data.markers.find(m => m.id === 3000));
      await page.watchAutomaticLocation(service, false);
      await page.refreshSharedLocation();
      assert.deepEqual(page.data.myPoint, point);
      assert.deepEqual(page.data.markers.find(m => m.id === 3000), before);
      assert.equal(page.data.meetTask.meetTaskId, task.meetTaskId);
    } finally { page.stopWatchingAutomaticLocation(); page.restore(); }
  }
});

test('最新刷新明确取消集合时仍移除图钉，切换队伍后旧响应不回填', async () => {
  const task = meeting('active');
  const page = loadPage('miniprogram/pages/map/index.js', { storage: { 'zhiyou-active-crew': crewId }, api: {
    'crew.get': crewInfo, 'team.current': currentMeeting(null),
  } });
  try {
    page.setData({ crewId, meetTask: task, meetingPoint: { name: task.placeName, ...task.point, fromTeamTask: true } });
    page.refreshMarkers();
    await page.loadCrew();
    assert.equal(page.data.meetTask, null);
    assert.ok(!page.data.markers.some(m => m.id === 3000));
  } finally { page.stopChatPreview(); page.restore(); }

  let release;
  const switched = loadPage('miniprogram/pages/map/index.js', { storage: { 'zhiyou-active-crew': crewId }, api: {
    'crew.get': crewInfo, 'team.current': () => new Promise(resolve => { release = resolve }),
  } });
  try {
    const old = switched.loadCrew();
    switched.__storage['zhiyou-active-crew'] = 'another';
    release(currentMeeting(task.meetTaskId));
    await old;
    assert.equal(switched.data.meetTask, null);
    assert.ok(!switched.__calls.some(call => call.action === 'meet.get'));
  } finally { switched.stopChatPreview(); switched.restore(); }
});

test('队长和队员从同一服务端集合任务显示同一名称与坐标，本地选点和更新位置不能改写', async () => {
  const world = await makeWorld();
  const group = await makeCrew(world);
  const sharedPoint = { latitude: 45.78, longitude: 126.65 };
  const task = expectOk(await world.A('meet.create', { crewId: group.crewId, point: sharedPoint,
    placeName: '公园东门', plannedMeetAt: world.plusMin(30) }));
  const pageFor = client => {
    const api = {};
    for (const action of ['crew.get', 'team.current', 'meet.get', 'loc.list', 'team.cancelMeeting']) {
      api[action] = (payload, options) => client(action, payload, options);
    }
    return loadPage('miniprogram/pages/map/index.js', { api, storage: { 'zhiyou-active-crew': group.crewId },
      app: { getLocationSharing: () => ({ refresh: async () => ({ sharing: true }) }) } });
  };
  const owner = pageFor(world.A);
  const member = pageFor(world.B);
  const pin = page => page.data.markers.find(m => m.id === 3000);
  const assertShared = page => {
    assert.equal(page.data.meetTask.meetTaskId, task.meetTaskId);
    assert.equal(page.data.meetingPoint.name, '公园东门');
    assert.equal(pin(page).latitude, sharedPoint.latitude);
    assert.equal(pin(page).longitude, sharedPoint.longitude);
    assert.equal(pin(page).iconPath, '/assets/pin-meeting.png');
    assert.equal(page.data.pickMode, false);
  };
  try {
    owner.setData({ myPoint: { latitude: 45.75, longitude: 126.60 }, pickMode: true,
      meetingPoint: { latitude: 45.7, longitude: 126.5, name: '队长未发布的选点' } });
    member.setData({ myPoint: { latitude: 45.81, longitude: 126.66 },
      meetingPoint: { latitude: 45.8, longitude: 126.7, name: '队员本地旧选点' } });
    await Promise.all([owner.loadCrew(), member.loadCrew()]);
    assert.equal(owner.data.isOwner, true);
    assert.equal(member.data.isOwner, false);
    assertShared(owner); assertShared(member);
    owner.setData({ photoUrls: { [owner.data.meetingPoint.placeId]: { photo: 'https://expired.example/photo.jpg' } } });
    for (const page of [owner, member]) {
      page.setAutoMeetingPoint({ latitude: 45.6, longitude: 126.4, name: '另一个点' });
      page.startPick();
      page.clearMeeting();
      assertShared(page);
      // 即使本地选点被清空，重绘也从已公布的集合任务恢复，不能丢掉集合图钉。
      page.setData({ meetingPoint: null });
      page.refreshMarkers();
      assertShared(page);
      await page.refreshSharedLocation();
      assertShared(page);
    }
    assert.deepEqual([pin(owner).latitude, pin(owner).longitude, pin(owner).callout.content],
      [pin(member).latitude, pin(member).longitude, pin(member).callout.content]);
    await owner.doTeam('team.cancelMeeting', { meetTaskId: task.meetTaskId }, '已取消本次集合');
    await member.loadCrew();
    for (const page of [owner, member]) {
      assert.equal(page.data.meetTask, null);
      assert.equal(pin(page), undefined);
    }
  } finally { owner.stopChatPreview(); member.stopChatPreview(); member.restore(); owner.restore(); }
});

test('同名地点库坐标不能替代已公布的集合点坐标，无效服务端坐标也不能回退到各自选点', () => {
  const page = loadPage('miniprogram/pages/map/index.js');
  try {
    const task = meeting('shared', 45.79);
    page.setData({ meetTask: task, places: [{ placeId: 'same-name', name: task.placeName,
      latitude: 45.6, longitude: 126.4 }] });
    page.syncMeetingSelection();
    assert.equal(page.data.markers.find(m => m.id === 3000).latitude, task.point.latitude);
    page.setData({ meetTask: { ...task, point: { latitude: 999, longitude: 126.62 } },
      meetingPoint: { latitude: 45.6, longitude: 126.4, name: '本地选点' } });
    page.refreshMarkers();
    assert.equal(page.data.meetingPoint, null);
    assert.ok(!page.data.markers.some(m => m.id === 3000));
    assert.match(page.data.coordinateError, /集合点坐标异常/);
  } finally { page.restore(); }
});

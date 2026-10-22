'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLocationSharing, INTERVAL_MS, HEARTBEAT_MS, MOVEMENT_METERS } = require('../miniprogram/utils/location-sharing');
const { makeWorld, expectOk, C } = require('./helpers');
const { loadPage } = require('./page-harness');
const point = { latitude: 45.7756, longitude: 126.6175, accuracy: 8 };
const KEY = 'zhiyou-active-crew';
const flush = () => new Promise(resolve => setImmediate(resolve));

async function setup(overrides = {}) {
  const w = await makeWorld();
  const created = expectOk(await w.A('crew.create', { name: '自动位置', shareLocationDefault: false }));
  let clock = w.NOW.getTime();
  const storage = { [KEY]: created.crewId };
  const timers = new Map();
  const listeners = new Set();
  const calls = [];
  let timerId = 0;
  const wxCalls = [];
  let gps = point;
  const wx = {
    getStorageSync: key => storage[key] || '',
    setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: key => { delete storage[key]; },
    getSetting: options => options.success({ authSetting: { 'scope.userLocation': true } }),
    getLocation: options => { wxCalls.push('getLocation'); options.success(gps); },
    onLocationChange: fn => { wxCalls.push('onLocationChange'); listeners.add(fn); },
    offLocationChange: fn => { wxCalls.push('offLocationChange'); listeners.delete(fn); },
    startLocationUpdate: options => { wxCalls.push('startLocationUpdate'); options.success({}); },
    stopLocationUpdate: () => { wxCalls.push('stopLocationUpdate'); },
    ...overrides.wx,
  };
  const service = createLocationSharing({ wx, now: () => clock,
    callApi: async (action, payload) => {
      calls.push({ action, payload, at: clock });
      if (overrides.callApi) {
        const replaced = await overrides.callApi(action, payload);
        if (replaced) return replaced;
      }
      return w.A(action, payload, { now: new Date(clock) });
    },
    timers: {
      setInterval: (fn, delay) => { assert.equal(delay, 15000); timers.set(++timerId, fn); return timerId; },
      clearInterval: id => timers.delete(id),
    },
  });
  const reports = () => calls.filter(c => c.action === 'loc.report');
  const tick = async (delta, nextPoint) => {
    clock += delta;
    if (nextPoint) { gps = nextPoint; for (const fn of listeners) fn(nextPoint); }
    for (const fn of [...timers.values()]) fn();
    await flush();
  };
  return { w, crewId: created.crewId, service, storage, wxCalls, wx, timers, listeners, calls, reports, tick,
    setGPS: value => { gps = value; }, advance: delta => { clock += delta; },
  };
}

test('关闭共享时启动小程序不会定位或上传，显式开启后立即定位上传并启动一次监听', async () => {
  const s = await setup();
  await s.service.setForeground(true);
  assert.equal(s.wxCalls.length, 0);
  assert.equal(s.reports().length, 0);
  await s.service.setEnabled(true);
  assert.equal(s.reports().length, 1);
  assert.equal(s.listeners.size, 1);
  assert.equal(s.timers.size, 1);
  assert.equal(s.service.snapshot().active, true);
  const row = await s.w.repo.findOne(C.LOCATIONS, { crewId: s.crewId });
  assert.equal(row.source, 'gps');
  assert.equal(row.accuracyM, 8);
  assert.deepEqual(row.point, { latitude: point.latitude, longitude: point.longitude });
  const consent = await s.w.repo.findOne(C.PRIVACY_CONSENTS, { crewId: s.crewId, granted: true });
  assert.equal(consent.policyVersion, require('../miniprogram/utils/location-consent').POLICY_VERSION);
  assert.equal(consent.source, 'sharing_switch');
  assert.ok(s.calls.find(c => c.action === 'loc.stopSharing' && c.payload.sharing).payload.policyVersion);
});

test('15 秒处理定位、移动 20 米触发上传；静止每 60 秒取得新定位并更新', async () => {
  const s = await setup();
  await s.service.setForeground(true);
  await s.service.setEnabled(true);
  assert.equal(INTERVAL_MS, 15000);
  assert.equal(HEARTBEAT_MS, 60000);
  assert.equal(MOVEMENT_METERS, 20);
  await s.tick(15000, point);
  assert.equal(s.reports().length, 1);
  const moved = { ...point, latitude: point.latitude + 0.0003 };
  await s.tick(15000, moved);
  assert.equal(s.reports().length, 2);
  for (let i = 0; i < 3; i++) await s.tick(15000, moved);
  assert.equal(s.reports().length, 2);
  await s.tick(15000, moved);
  assert.equal(s.reports().length, 3);
  assert.equal(s.reports()[2].at - s.reports()[1].at, 60000);
});

test('后台立即停止定位及计时，后台返回的旧定位回调不能继续上传；回前台立即更新', async () => {
  const s = await setup();
  await s.service.setForeground(true);
  await s.service.setEnabled(true);
  const oldCallback = [...s.listeners][0];
  await s.service.setForeground(false);
  assert.equal(s.listeners.size, 0);
  assert.equal(s.timers.size, 0);
  oldCallback({ ...point, latitude: 45.78 });
  await s.tick(60000);
  assert.equal(s.reports().length, 1);
  await s.service.setForeground(true);
  assert.equal(s.reports().length, 2);
  assert.equal(s.listeners.size, 1);
  assert.equal(s.timers.size, 1);
});

test('关闭共享写入云端并停止定位，重新进入队伍不能自行开启', async () => {
  const s = await setup();
  await s.service.setForeground(true);
  await s.service.setEnabled(true);
  await s.service.setEnabled(false);
  await s.service.refresh();
  await s.tick(60000);
  assert.equal(s.service.snapshot().sharing, false);
  assert.equal(s.reports().length, 1);
  assert.equal(s.listeners.size, 0);
  const member = await s.w.repo.findOne(C.CREW_MEMBERS, { crewId: s.crewId, userId: 'openid_A' });
  assert.equal(member.locationSharing, false);
});

test('云端关闭失败后本机仍停止上传，随后同步会重试云端关闭，不自动重新开启', async () => {
  let failClosing = true;
  const s = await setup({ callApi: (action, payload) => {
    if (action === 'loc.stopSharing' && payload.sharing === false && failClosing) {
      return { ok: false, error: { code: 'NETWORK', message: 'test offline' } };
    }
  } });
  await s.service.setForeground(true);
  await s.service.setEnabled(true);
  await assert.rejects(s.service.setEnabled(false), /offline/);
  await s.tick(60000);
  assert.equal(s.reports().length, 1);
  assert.equal(s.listeners.size, 0);
  failClosing = false;
  await s.service.refresh();
  const member = await s.w.repo.findOne(C.CREW_MEMBERS, { crewId: s.crewId, userId: 'openid_A' });
  assert.equal(member.locationSharing, false);
  assert.equal(s.service.snapshot().sharing, false);
});

test('切换/退出队伍立即丢弃旧坐标、停监听，不将旧队伍位置上传到新队伍', async () => {
  const s = await setup();
  await s.service.setForeground(true);
  await s.service.setEnabled(true);
  const oldCallback = [...s.listeners][0];
  delete s.storage[KEY];
  await s.service.sync();
  oldCallback(point);
  assert.equal(s.service.snapshot().point, null);
  assert.equal(s.service.snapshot().crewId, '');
  assert.equal(s.listeners.size, 0);
  assert.equal(s.timers.size, 0);
  assert.equal(s.reports().length, 1);
});

test('定位被拒绝或坐标非法时不启用服务端共享，也不上报虚假位置', async () => {
  for (const invalid of [false, true]) {
    const s = await setup({ wx: { getLocation: options => invalid
      ? options.success({ latitude: 45, longitude: 126000 }) : options.fail({ errMsg: 'auth deny' }) } });
    await s.service.setForeground(true);
    await assert.rejects(s.service.setEnabled(true), invalid ? /坐标无效/ : /auth deny/);
    assert.equal(s.reports().length, 0);
    assert.equal(s.calls.filter(c => c.action === 'loc.stopSharing' && c.payload.sharing).length, 0);
    assert.equal(s.service.snapshot().active, false);
  }
});

test('上传失败不推进成功时间，下一轮可重试', async () => {
  let fail = true;
  const s = await setup({ callApi: action => action === 'loc.report' && fail
    ? { ok: false, error: { code: 'NETWORK', message: 'test offline' } } : undefined });
  await s.service.setForeground(true);
  await s.service.setEnabled(true);
  assert.equal(s.service.snapshot().uploadedAt, null);
  assert.match(s.service.snapshot().error, /offline/);
  fail = false;
  await s.tick(15000, point);
  assert.ok(s.service.snapshot().uploadedAt);
  assert.equal(s.service.snapshot().error, '');
});

test('进入队伍触发立即定位上传，普通轮询不抢镜头，不重复创建监听', async () => {
  const s = await setup();
  await s.service.setForeground(true);
  await s.service.setEnabled(true);
  s.advance(5000);
  const next = { ...point, latitude: 45.776 };
  s.setGPS(next);
  const page = loadPage('miniprogram/pages/map/index.js', { storage: { [KEY]: s.crewId },
    app: { getLocationSharing: () => s.service } });
  page.loadCrew = () => page.setData({ crewId: s.crewId });
  page.refreshTeamLocations = () => Promise.resolve();
  page.autoLocate = () => assert.fail('统一服务可用时页面不应另行定位');
  await page.onShow();
  assert.equal(s.reports().length, 2);
  assert.deepEqual(s.reports()[1].payload.point, { latitude: next.latitude, longitude: next.longitude });
  assert.equal(page.data.myPoint.latitude, next.latitude);
  assert.equal(s.listeners.size, 1);
  page.onHide();
  assert.equal(s.service.snapshot().active, true, '切页面继续前台共享；仅 App 隐藏时停止');
  await s.service.setForeground(false);
});

test('共享开关只在我的设置里，页面使用服务端状态并可关闭共享', async () => {
  const s = await setup();
  await s.service.setForeground(true);
  const page = loadPage('miniprogram/pages/profile/index.js', { app: { getLocationSharing: () => s.service } });
  await page.watchLocationSharing();
  assert.equal(page.data.locationSharing, false);
  await page.onLocationSharingChange({ detail: { value: true } });
  assert.equal(page.data.locationSharing, true);
  assert.equal(page.data.locationSharingActive, true);
  await page.onLocationSharingChange({ detail: { value: false } });
  assert.equal(page.data.locationSharing, false);
  page.onHide();
  const mapXml = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/map/index.wxml'), 'utf8');
  const profileXml = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/index.wxml'), 'utf8');
  assert.doesNotMatch(mapXml, /bindtap="toggleSharing"|bindtap="reportMyLocation"/);
  assert.match(profileXml, /bindchange="onLocationSharingChange"/);
});

test('集合时间默认为当前时分，用户手动修改后保留；默认值未调整时仍校验未来时间', () => {
  const page = loadPage('miniprogram/pages/map/index.js');
  page.onShow();
  const now = new Date();
  assert.equal(page.data.meetTime, String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'));
  page.setData({ crewId: 'crew', meetingPoint: { ...point, name: '集合点' }, pointName: '集合点' });
  page.createMeeting();
  assert.match(page.data.teamError, /集合时间/);
  page.onMeetTimeChange({ detail: { value: '23:59' } });
  page.onShow();
  assert.equal(page.data.meetTime, '23:59');
  page.onHide();
});

test('后台时仍未返回的单次定位不能阻塞关闭，晚到结果不能重新开启共享', async () => {
  let request;
  const s = await setup({ wx: { getLocation: options => { request = options; } } });
  await s.service.setForeground(true);
  const enabling = s.service.setEnabled(true).catch(error => error);
  await flush();
  assert.ok(request);
  await s.service.setForeground(false);
  const disabling = s.service.setEnabled(false);
  await enabling;
  await disabling;
  request.success(point);
  await flush();
  assert.equal(s.service.snapshot().sharing, false);
  assert.equal(s.reports().length, 0);
  assert.equal(s.calls.some(c => c.action === 'loc.stopSharing' && c.payload.sharing), false);
});

test('SDK 在后台才完成前台定位启动时立即停止，不残留定位监听', async () => {
  let start;
  const s = await setup({ wx: { startLocationUpdate: options => { start = options; } } });
  await s.service.setForeground(true);
  const enabling = s.service.setEnabled(true);
  await flush();
  assert.ok(start);
  await s.service.setForeground(false);
  start.success({});
  await enabling;
  await flush();
  assert.equal(s.service.snapshot().active, false);
  assert.equal(s.listeners.size, 0);
  assert.equal(s.timers.size, 0);
  assert.equal(s.reports().length, 0);
  assert.ok(s.wxCalls.includes('stopLocationUpdate'));
});

test('App 生命周期在页面之外统一恢复、暂停共享', async () => {
  const vm = require('node:vm');
  const s = await setup();
  let app;
  const wx = { ...s.wx, cloud: { init: () => {} } };
  const api = { callApi: (action, payload) => s.w.A(action, payload) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/app.js'), 'utf8'), {
    App: value => { app = value; }, wx, console,
    require: name => name === './utils/api' ? api : { createLocationSharing },
  });
  app.onLaunch();
  await app.onShow();
  await app.getLocationSharing().setEnabled(true);
  assert.equal(app.getLocationSharing().snapshot().active, true);
  await app.onHide();
  assert.equal(app.getLocationSharing().snapshot().active, false);
  await app.onShow();
  assert.equal(app.getLocationSharing().snapshot().active, true);
  await app.onHide();
});

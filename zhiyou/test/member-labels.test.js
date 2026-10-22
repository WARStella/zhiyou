'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, loadComponent } = require('./page-harness');
const { makeWorld, makeCrew, expectOk, expectFail, C } = require('./helpers');

const MAP = 'miniprogram/pages/map/index.js';
const PANEL = 'miniprogram/components/team-panel/index.js';
const KEY = 'zhiyou-active-crew';
const ids = ['A', 'B', 'C'];
const point = id => ({ latitude: 45.7 + ids.indexOf(id) * 0.01, longitude: 126.6 });
const members = ['C', 'A', 'B'].map(userId => ({ userId, nickname: userId === 'C' ? null : '小明', role: 'member', locationSharing: true }));
const ok = data => ({ ok: true, data: structuredClone(data) });
const expected = (id, viewer) => {
  const nickname = members.find(m => m.userId === id).nickname || '未命名';
  return id === viewer ? '我（' + nickname + '）' : nickname;
};

function responses(viewer, positions) {
  return {
    'crew.get': ok({ crew: { crewId: 'c1' }, members, me: viewer, myRole: 'member' }),
    'team.current': ok({ meetTaskId: 'm1' }),
    // 集合名单是全队的子集，且顺序与名册不同，名称必须按用户 ID 匹配。
    'meet.get': ok({ meetTask: { meetTaskId: 'm1', status: 'proposed', participants:
      ['C', 'B', 'former'].map(userId => ({ userId, status: 'invited' })) } }),
    'loc.list': ok({ members: positions }),
  };
}

test('三个查看者的地图、成员列表和集合子名单显示昵称，重名用户保留独立标记', async () => {
  for (const viewer of ids) {
    const positions = [...members].reverse().map(m => ({ ...m, point: point(m.userId), hasLocation: true, source: 'gps' }));
    const page = loadPage(MAP, { storage: { [KEY]: 'c1' }, api: responses(viewer, positions) });
    try {
      page.setData({ myPoint: point(viewer), mySource: 'gps' });
      await page.loadCrew();
      await page.refreshTeamLocations();
      assert.equal(page.data.teamError, '');
      assert.equal(page.data.markers.length, 3);
      assert.equal(new Set(page.data.markers.map(m => m.id)).size, 3);
      for (const id of ids) {
        assert.equal(page.data.members.find(m => m.userId === id).label, expected(id, viewer));
        const marker = page.data.markers.find(m => m.latitude === point(id).latitude);
        assert.equal(marker.callout.content, members.find(m => m.userId === id).nickname || '未命名');
      }
      for (const p of page.data.meetTask.participants) {
        assert.equal(p.label, p.userId === 'former' ? '已退出队员' : expected(p.userId, viewer));
      }
    } finally { page.restore(); }
  }
});

test('位置接口先返回时也能显示昵称，未共享或缺少位置不影响身份，改名刷新生效', async () => {
  let positions = [
    { userId: 'A', nickname: '小明', sharingOff: true },
    { userId: 'B', nickname: '小明', hasLocation: false },
    { userId: 'C', nickname: null, hasLocation: true, point: point('C'), source: 'gps' },
  ];
  const page = loadPage(MAP, { api: { 'loc.list': () => ok({ members: positions }) } });
  try {
    page.setData({ crewId: 'c1', me: 'B', myPoint: point('B'), mySource: 'gps' });
    await page.refreshTeamLocations();
    assert.equal(page.data.markers.find(m => m.id === 999).callout.content, '小明');
    assert.equal(page.data.markers.find(m => m.latitude === point('C').latitude).callout.content.split(' · ')[0], '未命名');
    positions = [...positions].reverse().map(m => ({ ...m, sharingOff: false, point: point(m.userId), hasLocation: true, source: 'gps' }));
    await page.refreshTeamLocations();
    for (const id of ids) {
      assert.equal(page.data.markers.find(m => m.latitude === point(id).latitude).callout.content, positions.find(m => m.userId === id).nickname || '未命名');
    }
    const markerIds = page.data.markers.map(m => m.id);
    positions.find(m => m.userId === 'A').nickname = '小红';
    await page.refreshTeamLocations();
    assert.equal(page.data.markers.find(m => m.latitude === point('A').latitude).callout.content.split(' · ')[0], '小红');
    assert.deepEqual(page.data.markers.map(m => m.id), markerIds, '改名不改变标记身份');
  } finally { page.restore(); }
});

test('我的小队面板和集合名单显示同一昵称，自己保留我标注', async () => {
  const panel = loadComponent(PANEL);
  const data = responses('C', members.map(m => ({ userId: m.userId, sharingOff: true })));
  panel.call = async action => action === 'user.login' ? { openid: 'C' } : structuredClone(data[action].data);
  try {
    panel.setData({ crewId: 'c1' });
    await panel.read();
    for (const id of ids) assert.equal(panel.data.members.find(m => m.userId === id).label, expected(id, 'C'));
    assert.equal(panel.data.task.participants.find(m => m.userId === 'C').label, '我（未命名）');
    assert.equal(panel.data.task.participants.find(m => m.userId === 'B').label, '小明');
    assert.equal(panel.data.task.participants.find(m => m.userId === 'former').label, '已退出队员');
  } finally { panel.restore(); }
});

test('真实云端链路允许重名，队伍和位置返回当前昵称且不泄露其他资料，关闭共享仍保护坐标', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);
  for (const who of ['A', 'B']) {
    expectOk(await w[who]('user.login'));
    expectOk(await w[who]('user.updateProfile', { nickname: '  小明  ', avatarFileId: 'cloud://private-avatar', defaultTravelMode: 'walking' }));
    expectOk(await w[who]('loc.report', { crewId, point: point(who), source: 'gps' }));
  }
  expectOk(await w.A('loc.stopSharing', { crewId, sharing: false }));
  for (const action of ['crew.get', 'loc.list']) {
    const data = expectOk(await w.B(action, { crewId }));
    assert.equal(data.members.find(m => m.userId === 'openid_A').nickname, '小明');
    assert.equal(data.members.find(m => m.userId === 'openid_B').nickname, '小明');
    assert.equal(data.members.find(m => m.userId === 'openid_C').nickname, null);
    for (const m of data.members) {
      for (const field of ['defaultTravelMode', 'shortId', 'openid']) assert.equal(m[field], undefined);
      if (action === 'crew.get') assert.equal(m.avatarFileId, undefined);
      else assert.equal(m.avatarFileId, m.userId === 'openid_C' ? null : 'cloud://private-avatar');
    }
    if (action === 'loc.list') {
      const hidden = data.members.find(m => m.userId === 'openid_A');
      assert.equal(hidden.sharingOff, true);
      assert.equal(hidden.point, undefined);
      assert.equal(hidden.reportedAt, undefined);
      assert.equal(data.members.find(m => m.userId === 'openid_B').hasLocation, true);
    }
    expectFail(await w.clientFor('outsider')(action, { crewId }), 'FORBIDDEN_NOT_MEMBER');
  }
  expectOk(await w.A('user.updateProfile', { nickname: '小红' }));
  for (const action of ['crew.get', 'loc.list']) {
    const data = expectOk(await w.B(action, { crewId }));
    assert.equal(data.members.find(m => m.userId === 'openid_A').nickname, '小红');
    assert.equal(data.members.find(m => m.userId === 'openid_B').nickname, '小明');
  }
  const task = expectOk(await w.C('meet.create', { crewId, point: point('C'), placeName: '集合点', plannedMeetAt: w.plusMin(30) }));
  expectOk(await w.B('meet.confirm', { meetTaskId: task.meetTaskId, decision: 'confirm' }, { expectedVersion: 1 }));
  const stored = await w.repo.get(C.MEET_TASKS, task.meetTaskId);
  assert.equal(stored.participants.find(p => p.userId === 'openid_B').status, 'confirmed');
  assert.equal(stored.participants.find(p => p.userId === 'openid_A').status, 'invited');
});

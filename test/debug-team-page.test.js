const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./page-harness');
const { makeWorld } = require('./helpers');
let sequence = 0;
function pageFor(w, who) {
  const handlers = {};
  for (const action of ['ops.health', 'user.login', 'crew.create', 'crew.join', 'crew.get', 'meet.create', 'meet.get', 'meet.confirm', 'meet.arrive', 'meet.depart']) {
    handlers[action] = (payload, options) => w[who](action, payload, options);
  }
  return loadPage('miniprogram/pages/debug-team/index.js', {
    api: handlers, newRequestId: () => 'page-debug-' + (++sequence),
  });
}
const event = kind => ({ currentTarget: { dataset: { kind } } });

test('三台联调页面经真实业务入口完成建队、并发确认、到达、权限检查与出发', async () => {
  const w = await makeWorld();
  const a = pageFor(w, 'A'), b = pageFor(w, 'B'), c = pageFor(w, 'C');
  for (const p of [a, b, c]) await p.onLoad();
  assert.equal(new Set([a.data.identity, b.data.identity, c.data.identity]).size, 3);
  await a.createCrew();
  for (const p of [b, c]) { p.setData({ inviteCode: a.data.inviteCode }); await p.joinCrew(); }
  a.setData({ placeName: '测试手动点', latitude: '45.77', longitude: '126.62' });
  await a.createMeeting();
  for (const p of [b, c]) { p.setData({ taskInput: a.data.taskInput }); await p.refresh(); }
  await Promise.all([b.mutate(event('confirm')), c.mutate(event('confirm'))]);
  await a.refresh();
  assert.equal(a.data.task.status, 'confirmed');
  assert.equal(a.data.task.tripId, null);
  await a.mutate(event('arrive'));
  await a.mutate(event('depart'));
  assert.match(a.data.error, /INVALID_PARAM/);
  await Promise.all([b.mutate(event('arrive')), c.mutate(event('arrive'))]);
  await b.mutate(event('depart'));
  assert.match(b.data.error, /FORBIDDEN_NOT_MEMBER/);
  await a.refresh();
  await a.mutate(event('depart'));
  assert.equal(a.data.task.status, 'departed');
  const departed = a.data.task.departedAt;
  const requestId = a.data.lastWriteId;
  await a.replay();
  assert.equal(a.data.task.departedAt, departed);
  assert.ok(a.data.logs.some(l => l.request.options.requestId === requestId && l.response.meta.replayed));
  assert.equal(a.lastWrite.action, 'meet.depart', '刷新不得覆盖可重试写请求');
});

test('刷新始终使用新请求编号；共享编号只用于明确的异常测试', async () => {
  const w = await makeWorld(); const a = pageFor(w, 'A');
  await a.onLoad(); await a.createCrew();
  await a.refresh(); await a.refresh();
  const ids = a.__calls.filter(x => x.action === 'crew.get').map(x => x.options.requestId);
  assert.equal(new Set(ids).size, ids.length);
});

test('非开发环境禁用写操作', async () => {
  const w = await makeWorld({ env: 'prod' }); const p = pageFor(w, 'A');
  await p.onLoad(); await p.createCrew();
  assert.equal(p.data.ready, false);
  assert.ok(!p.__calls.some(x => x.action === 'crew.create'));
});

test('修改任务 ID 清空旧版本，未重新加载前不允许提交', async () => {
  const w = await makeWorld(); const p = pageFor(w, 'A');
  await p.onLoad();
  p.setData({ task: { meetTaskId: 'old', version: 1 }, version: 1 });
  p.input({ currentTarget: { dataset: { field: 'taskInput' } }, detail: { value: 'new' } });
  await p.mutate(event('confirm'));
  assert.equal(p.data.task, null);
  assert.equal(p.data.version, null);
  assert.ok(!p.__calls.some(x => x.action === 'meet.confirm'));
});

test('无效坐标不创建集合，请求异常后释放 busy', async () => {
  const w = await makeWorld(); const p = pageFor(w, 'A');
  await p.onLoad(); await p.createCrew();
  p.setData({ placeName: '测试', latitude: '91', longitude: '126' });
  await p.createMeeting();
  assert.ok(!p.__calls.some(x => x.action === 'meet.create'));
  assert.equal(p.data.busy, false);
  assert.match(p.data.error, /有效纬度/);
});

test('新页路由已注册，WXML 的事件处理函数都存在', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const p = loadPage('miniprogram/pages/debug-team/index.js');
  const app = require('../miniprogram/app.json');
  assert.ok(app.pages.includes('pages/debug-team/index'));
  const xml = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/debug-team/index.wxml'), 'utf8');
  for (const match of xml.matchAll(/bind(?:tap|input)="([^"]+)"/g)) assert.equal(typeof p[match[1]], 'function', match[1]);
});

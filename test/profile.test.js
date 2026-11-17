'use strict';

/**
 * 个人资料（2026-10-14 用户要求）。
 *
 * 用户原话："我的界面还需包含用户id与头像，用户名，默认出行方式等"
 *
 * ── 这个模块的设计取舍 ────────────────────────────────────
 *
 * `users` 原来是"只有 openid 的登录记录"（`login` 只写
 * openid/createdAt/lastSeenAt）。这一批把它扩成真正的资料档案。
 *
 * 三个字段都是**可选**的：新用户第一次进「我的」时全是空的，
 * 界面要显示兜底文案而不是报错。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeWorld, C, expectOk, expectFail } = require('./helpers');
const userActions = require('../cloudfunctions/api/actions/user');
const modeChoice = require('../cloudfunctions/api/lib/mode-choice');

test('首次读资料会建档 —— 与 login 同一个兜底，不让界面拿到空对象', async () => {
  const w = await makeWorld();
  const r = expectOk(await w.A('user.getProfile', {}));

  assert.ok(r.profile, '要有 profile');
  assert.ok(r.profile.userId, '要有用户 ID');
  assert.equal(r.profile.nickname, null, '昵称未设置为 null —— 界面显示兜底文案，不要编一个');
  assert.equal(r.profile.avatarFileId, null);
  assert.equal(r.profile.defaultTravelMode, 'auto', '未设置时回 auto（它有默认语义，与昵称为 null 不同）');
});

test('资料里带上出行方式选项 —— 避免前后端两份表漂移', async () => {
  const w = await makeWorld();
  const r = expectOk(await w.A('user.getProfile', {}));

  assert.deepEqual(
    r.travelModeOptions.map((o) => o.value),
    modeChoice.MODE_OPTIONS.map((o) => o.value),
    '选项必须与 lib/mode-choice.js 同源'
  );
});

test('改昵称与默认出行方式', async () => {
  const w = await makeWorld();
  await w.A('user.getProfile', {});

  const r = expectOk(await w.A('user.updateProfile', { nickname: '小明', defaultTravelMode: 'walking' }));
  assert.equal(r.profile.nickname, '小明');
  assert.equal(r.profile.defaultTravelMode, 'walking');
  assert.deepEqual(r.updated.sort(), ['defaultTravelMode', 'nickname']);

  /** 回读确认真的落库了 */
  const again = expectOk(await w.A('user.getProfile', {}));
  assert.equal(again.profile.nickname, '小明');
  assert.equal(again.profile.defaultTravelMode, 'walking');
});

test('部分更新：只传昵称不会把头像清掉', async () => {
  /**
   * ⚠️ 这条是"按字段更新"的核心。若实现写成"整条覆盖"，
   * 用户改个昵称就会把头像弄丢，而且他不知道为什么。
   */
  const w = await makeWorld();
  await w.A('user.getProfile', {});
  expectOk(await w.A('user.updateProfile', { avatarFileId: 'cloud://x/avatar.png' }));

  expectOk(await w.A('user.updateProfile', { nickname: '小红' }));

  const p = expectOk(await w.A('user.getProfile', {})).profile;
  assert.equal(p.nickname, '小红');
  assert.equal(p.avatarFileId, 'cloud://x/avatar.png', '头像必须还在');
});

test('昵称去掉首尾空白；全是空白等于没填', async () => {
  /**
   * ⚠️ 用户输入一串空格时，若原样存下，界面会显示成
   * "有名字但看不见" —— 比直接当没填更糟。
   */
  const w = await makeWorld();
  await w.A('user.getProfile', {});

  assert.equal(expectOk(await w.A('user.updateProfile', { nickname: '  小明  ' })).profile.nickname, '小明');
  assert.equal(expectOk(await w.A('user.updateProfile', { nickname: '   ' })).profile.nickname, null, '全空白当没填');
});

test('昵称超长要拒，且错误信息说清上限', async () => {
  const w = await makeWorld();
  await w.A('user.getProfile', {});

  const r = await w.A('user.updateProfile', { nickname: 'x'.repeat(userActions.NICKNAME_MAX + 1) });
  assert.equal(r.ok, false);
  assert.match(r.error.message, new RegExp(String(userActions.NICKNAME_MAX)), '要说清上限是多少');
});

test('不认识的出行方式要拒，并列出可选值', async () => {
  const w = await makeWorld();
  await w.A('user.getProfile', {});

  const r = await w.A('user.updateProfile', { defaultTravelMode: 'teleport' });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /teleport/);
  assert.match(r.error.message, /walking/, '要把可选值列出来，用户才知道该怎么改');
});

test('空串可以清空昵称与头像', async () => {
  const w = await makeWorld();
  await w.A('user.getProfile', {});
  await w.A('user.updateProfile', { nickname: '小明', avatarFileId: 'cloud://x/a.png' });

  const r = expectOk(await w.A('user.updateProfile', { nickname: '', avatarFileId: '' }));
  assert.equal(r.profile.nickname, null);
  assert.equal(r.profile.avatarFileId, null);
});

test('什么都没传时如实说"没有可更新的字段"，不假装成功', async () => {
  const w = await makeWorld();
  await w.A('user.getProfile', {});
  const r = expectOk(await w.A('user.updateProfile', {}));

  assert.deepEqual(r.updated, []);
  assert.match(r.note, /没有需要更新的字段/);
});

test('没有用户记录时给出可行动的提示，而不是静默建一条', async () => {
  /**
   * ⚠️ 与 `getProfile` 的区别是**有意的**：
   * 读资料时可以顺手建档（用户只是想看看），
   * 但"改资料"失败要说明原因，不该悄悄替他建一条空记录然后说改成功了。
   */
  const w = await makeWorld();
  const r = await w.A('user.updateProfile', { nickname: '小明' });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /user\.login|user\.getProfile/, '要告诉他先做什么');
});

test('返回值用服务端回读的结果，不是提交的值', async () => {
  /**
   * ⚠️ 服务端会做 trim 与校验。若拿 `patch` 当结果返回，
   * 界面会显示一个库里并不存在的值（比如带空格的昵称）。
   */
  const w = await makeWorld();
  await w.A('user.getProfile', {});
  const r = expectOk(await w.A('user.updateProfile', { nickname: '  带空格  ' }));

  assert.equal(r.profile.nickname, '带空格', '返回的必须是处理后存进去的值');
  /** ⚠️ openid 是 `openid_A`（下划线），不是 `openid-A` —— 我第一版猜错了 */
  const stored = await w.repo.findOne(C.USERS, { openid: 'openid_A' });
  assert.ok(stored, '用户记录要查得到');
  assert.equal(stored.nickname, r.profile.nickname, '返回值与库里的必须一致');
});

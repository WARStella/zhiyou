'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, expectOk, expectFail, C } = require('./helpers');
const { createInviteProvider } = require('../cloudfunctions/api/lib/invitation');
const { fail } = require('../cloudfunctions/api/lib/errors');
const { invitationToken, scanToken } = require('../miniprogram/utils/invitation-link');
const { loadPage, loadComponent } = require('./page-harness');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=', 'base64');
async function setup(options) {
  const w = await makeWorld(options), crew = expectOk(await w.A('crew.create', { name: '周末同游' }));
  const invitation = expectOk(await w.A('crew.inviteCreate', { crewId: crew.crewId })).invitation;
  return { w, ...crew, invitation };
}
test('邀请预览不入队也不透露成员/位置，确认入队幂等且默认不共享位置', async () => {
  const { w, crewId, invitation } = await setup();
  assert.match(invitation.token, /^[A-Za-z0-9_-]{24}$/); assert.ok(invitation.scene.length <= 32);
  const preview = expectOk(await w.B('crew.invitePreview', { token: invitation.token }));
  assert.equal(preview.name, '周末同游'); assert.equal(preview.alreadyMember, false);
  assert.equal(await w.repo.count(C.CREW_MEMBERS, { crewId }), 1);
  for (const key of ['ownerUserId', 'members', 'locations', 'inviteCode']) assert.equal(preview[key], undefined);
  const [one, two] = await Promise.all([w.B('crew.inviteJoin', { token: invitation.token }), w.B('crew.inviteJoin', { token: invitation.token })]);
  expectOk(one); expectOk(two); assert.equal(await w.repo.count(C.CREW_MEMBERS, { crewId }), 2);
  assert.equal((await w.repo.get(C.CREWS, crewId)).memberCount, 2);
  const member = await w.repo.findOne(C.CREW_MEMBERS, { crewId, userId: 'openid_B' });
  assert.equal(member.locationSharing, false); assert.equal(member.locationConsentId, null);
});
test('邀请7天到期，撤销和更新立即生效，普通成员只可分享已有邀请', async () => {
  const { w, crewId, invitation, inviteCode } = await setup();
  expectFail(await w.B('crew.inviteGet', { crewId }), 'FORBIDDEN_NOT_MEMBER');
  expectFail(await w.B('crew.inviteJoin', { token: invitation.token }, { now: w.plusMin(7 * 24 * 60) }), 'NOT_FOUND');
  expectOk(await w.B('crew.join', { inviteCode }));
  expectFail(await w.B('crew.inviteCreate', { crewId }), 'FORBIDDEN_NOT_MEMBER');
  assert.equal(expectOk(await w.B('crew.inviteGet', { crewId })).invitation.token, invitation.token);
  const fresh = expectOk(await w.A('crew.inviteCreate', { crewId, refresh: true, previousToken: invitation.token })).invitation;
  assert.notEqual(fresh.token, invitation.token);
  expectFail(await w.C('crew.invitePreview', { token: invitation.token }), 'NOT_FOUND');
  expectFail(await w.A('crew.inviteRevoke', { crewId, token: invitation.token }), 'VERSION_CONFLICT');
  expectOk(await w.A('crew.inviteRevoke', { crewId, token: fresh.token }));
  expectFail(await w.C('crew.inviteJoin', { token: fresh.token }), 'NOT_FOUND');
});
test('离队后相同请求号不能重放旧权限；解散和邀请发起人失去成员资格使邀请失效', async () => {
  const { w, crewId, invitation, inviteCode } = await setup();
  expectOk(await w.B('crew.join', { inviteCode }));
  expectOk(await w.B('crew.inviteGet', { crewId }, { requestId: 'same-read' }));
  expectOk(await w.B('crew.leave', { crewId }));
  expectFail(await w.B('crew.inviteGet', { crewId }, { requestId: 'same-read' }), 'FORBIDDEN_NOT_MEMBER');
  expectOk(await w.A('crew.leave', { crewId }));
  expectFail(await w.C('crew.inviteJoin', { token: invitation.token }), 'NOT_FOUND');
  const another = await setup(); expectOk(await another.w.A('team.close', { crewId: another.crewId }));
  expectFail(await another.w.B('crew.invitePreview', { token: another.invitation.token }), 'NOT_FOUND');
});
test('事务前撤销邀请时入队拒绝，不因旧预览插入成员', async () => {
  const { w, crewId, invitation } = await setup();
  const original = w.repo.runTransaction.bind(w.repo); let once = true;
  w.repo.runTransaction = async (...args) => {
    if (once) { once = false; await w.repo.update(C.CREWS, crewId, { invitationStatus: 'revoked', revision: 3 }); }
    return original(...args);
  };
  expectFail(await w.B('crew.inviteJoin', { token: invitation.token }), 'NOT_FOUND');
  assert.equal(await w.repo.count(C.CREW_MEMBERS, { crewId }), 1);
});
test('小程序码工具限定页面/scene和环境，拒绝非图片结果，不回显上游错误', async () => {
  let received;
  const provider = createInviteProvider({ env: { WX_CODE_ENV_VERSION: 'trial' }, cloud: { openapi: { wxacode: {
    getUnlimited: async args => { received = args; return { buffer: image }; },
  } } } });
  const result = await provider.generate('i' + 'A'.repeat(24), 'dev');
  assert.equal(result.contentType, 'image/png'); assert.equal(result.envVersion, 'trial');
  assert.equal(received.page, 'pages/invite/index'); assert.equal(received.checkPath, false); assert.equal(received.envVersion, 'trial');
  await assert.rejects(createInviteProvider({ env: {}, cloud: { openapi: { wxacode: { getUnlimited: async () => ({ buffer: Buffer.from('{"errcode":1}') }) } } } }).generate('iA', 'prod'), /图片/);
  await assert.rejects(createInviteProvider({ env: {}, cloud: { openapi: { wxacode: { getUnlimited: async () => { throw new Error('private access token'); } } } } }).generate('iA', 'prod'), e => !e.message.includes('private access token'));
});
test('生成小程序码期间撤销邀请或移除调用成员，不返回旧二维码', async () => {
  for (const action of ['revoke', 'leave']) {
    let release;
    const { w, crewId, invitation, inviteCode } = await setup({ createInviteProvider: () => ({ generate: () => new Promise(r => { release = r; }) }) });
    expectOk(await w.B('crew.join', { inviteCode }));
    const pending = w.B('crew.inviteQr', { crewId, token: invitation.token }); await new Promise(r => setImmediate(r));
    if (action === 'revoke') expectOk(await w.A('crew.inviteRevoke', { crewId, token: invitation.token }));
    else expectOk(await w.B('crew.leave', { crewId }));
    release({ imageBase64: image.toString('base64'), contentType: 'image/png' });
    expectFail(await pending, action === 'revoke' ? 'NOT_FOUND' : 'FORBIDDEN_NOT_MEMBER');
  }
});
test('邀请卡参数与微信小程序码scene解析一致，拒绝外部网址和其他页面', () => {
  const token = 'A'.repeat(24);
  assert.equal(invitationToken({ token }), token); assert.equal(invitationToken({ scene: 'i' + token }), token);
  assert.equal(scanToken({ path: 'pages/invite/index?scene=i' + token }), token);
  assert.equal(scanToken({ path: '/pages/invite/index?token=' + token }), token);
  assert.equal(scanToken({ result: 'https://example.com/?token=' + token }), '');
  assert.equal(scanToken({ path: 'pages/map/index?token=' + token }), '');
  assert.equal(invitationToken({ scene: '%E0%A4%A' }), '');
});
test('邀请落地页只预览，点击确认才加入，跳转失败重开不重复入队', async () => {
  const token = 'A'.repeat(24); let opens = 0;
  const page = loadPage('miniprogram/pages/invite/index.js', { api: {
    'user.login': { ok: true, data: {} },
    'crew.invitePreview': { ok: true, data: { crewId: 'crew', name: '同游', memberCount: 2, expiresAt: new Date(Date.now() + 60000).toISOString() } },
    'crew.inviteJoin': { ok: true, data: { crewId: 'crew', joined: true } },
  }, wx: { switchTab: o => { if (++opens === 1) o.fail({}); else o.success({}); } } });
  try {
    page.onLoad({ scene: 'i' + token }); await page.onShow();
    assert.equal(page.__calls.some(c => c.action === 'crew.inviteJoin'), false);
    await page.join(); assert.match(page.data.error, /打开队伍页失败/); assert.equal(page.__storage['zhiyou-active-crew'], 'crew');
    await page.join(); assert.equal(page.__calls.filter(c => c.action === 'crew.inviteJoin').length, 1); assert.equal(opens, 2);
  } finally { page.onUnload(); page.restore(); }
});
test('管理页分享使用邀请路径，取消更新/撤销不写，隐藏后确认回调不执行', async () => {
  let modal;
  const token = 'A'.repeat(24), invitation = { token, path: '/pages/invite/index?token=' + token, expiresAt: new Date(Date.now() + 60000).toISOString() };
  const page = loadPage('miniprogram/pages/invite/index.js', { storage: { 'zhiyou-active-crew': 'crew' }, api: {
    'user.login': { ok: true, data: {} }, 'crew.inviteGet': { ok: true, data: { name: '同游', canManage: true, invitation } },
  }, wx: { showModal: o => { modal = o; } } });
  try {
    page.onLoad({ crewId: 'crew' }); await page.onShow(); assert.equal(page.onShareAppMessage().path, invitation.path);
    const pending = page.changeInvitation({ currentTarget: { dataset: { refresh: true } } });
    page.onHide(); modal.success({ confirm: true }); await pending;
    assert.equal(page.__calls.some(c => c.action === 'crew.inviteCreate'), false);
    assert.equal(page.onShareAppMessage().path, '/pages/trip/index');
  } finally { page.onUnload(); page.restore(); }
});
test('页面隐藏/切队后不回填邀请信息，不恢复旧二维码或自动加入队伍', async () => {
  for (const action of ['hide', 'switch']) {
    let release;
    const page = loadPage('miniprogram/pages/invite/index.js', { storage: { 'zhiyou-active-crew': 'crew' }, api: {
      'user.login': { ok: true, data: {} }, 'crew.inviteGet': () => new Promise(r => { release = r; }),
    } });
    try {
      page.onLoad({ crewId: 'crew' }); const pending = page.onShow(); await new Promise(r => setImmediate(r));
      if (action === 'hide') page.onHide(); else page.__storage['zhiyou-active-crew'] = 'other';
      release({ ok: true, data: { name: 'old', invitation: { token: 'A'.repeat(24), expiresAt: new Date(Date.now() + 60000).toISOString() } } });
      await pending; assert.equal(page.data.invitation, null); assert.equal(page.data.name, '');
    } finally { page.onUnload(); page.restore(); }
  }
});

test('邀请创建、更新与撤销通过页面完成，取消操作保留现有邀请', async () => {
  const { w, crewId } = await setup(); let confirm = false;
  const api = Object.fromEntries(['user.login', 'crew.inviteGet', 'crew.inviteCreate', 'crew.inviteRevoke'].map(action => [action, p => w.A(action, p)]));
  const page = loadPage('miniprogram/pages/invite/index.js', { storage: { 'zhiyou-active-crew': crewId }, api,
    wx: { showModal: o => o.success({ confirm }) } });
  try {
    page.onLoad({ crewId }); await page.onShow(); const old = page.data.invitation.token;
    await page.changeInvitation({ currentTarget: { dataset: { refresh: true } } });
    assert.equal(page.data.invitation.token, old);
    await page.revoke(); assert.equal(page.data.invitation.token, old);
    confirm = true;
    await page.changeInvitation({ currentTarget: { dataset: { refresh: true } } });
    assert.notEqual(page.data.invitation.token, old);
    expectFail(await w.B('crew.inviteJoin', { token: old }), 'NOT_FOUND');
    await page.revoke(); assert.equal(page.data.invitation, null);
    await page.changeInvitation(); assert.ok(page.data.invitation); assert.equal(page.data.busy, false);
  } finally { page.onUnload(); page.restore(); }
});

test('小程序码写入失败或隐藏后写入才完成均清理文件，正常生成支持保存', async () => {
  for (const outcome of ['fail', 'hide', 'ok']) {
    let write; const removed = [], saved = [];
    const token = 'A'.repeat(24), invitation = { token, expiresAt: new Date(Date.now() + 60000).toISOString() };
    const page = loadPage('miniprogram/pages/invite/index.js', { storage: { 'zhiyou-active-crew': 'crew' }, api: {
      'user.login': { ok: true, data: {} }, 'crew.inviteGet': { ok: true, data: { name: '同游', canManage: true, invitation } },
      'crew.inviteQr': { ok: true, data: { imageBase64: image.toString('base64'), contentType: 'image/png' } },
    }, wx: { env: { USER_DATA_PATH: '/user' }, getFileSystemManager: () => ({ writeFile: o => { write = o; }, unlink: o => removed.push(o.filePath) }),
      saveImageToPhotosAlbum: o => { saved.push(o.filePath); o.success({}); } } });
    try {
      page.onLoad({ crewId: 'crew' }); await page.onShow();
      const pending = page.generateQr(); await new Promise(r => setImmediate(r));
      assert.equal(write.encoding, 'base64');
      if (outcome === 'hide') page.onHide();
      if (outcome === 'fail') write.fail({ errMsg: 'disk full' }); else write.success({});
      await pending;
      if (outcome === 'ok') {
        assert.equal(page.data.qrPath, write.filePath); await page.saveQr();
        assert.deepEqual(saved, [write.filePath]); assert.equal(page.data.busy, false);
        page.setInvitation(null); assert.equal(page.data.qrPath, '');
      } else assert.equal(page.data.qrPath, '');
      assert.ok(removed.includes(write.filePath));
    } finally { page.onUnload(); page.restore(); }
  }
});

test('相册授权返回页面恢复到期处理，错误邀请不发请求，切队后刷新解除忙碌', async () => {
  const page = loadPage('miniprogram/pages/invite/index.js');
  try {
    page.onLoad({}); await page.refresh(); assert.equal(page.__calls.length, 0);
    page.setInvitation({ token: 'A'.repeat(24), expiresAt: new Date(Date.now() + 60000).toISOString() });
    page.previewing = true; page.onHide(); page.onShow(); assert.ok(page.expiryTimer);
    page.setData({ managing: true, crewId: 'old', busy: true });
    await page.refresh(); assert.equal(page.data.busy, false); assert.equal(page.data.invitation, null);
  } finally { page.onUnload(); page.restore(); }
});

test('扫码入口只跳转邀请预览，取消不报错，不接受其他二维码', async () => {
  const token = 'A'.repeat(24), urls = []; let result = { path: 'pages/invite/index?scene=i' + token };
  const component = loadComponent('miniprogram/components/team-panel/index.js', { wx: {
    scanCode: o => result ? o.success(result) : o.fail({ errMsg: 'scanCode:fail cancel' }),
    navigateTo: o => { urls.push(o.url); o.success({}); },
  } });
  try {
    await component.scanInvitation(); assert.deepEqual(urls, ['/pages/invite/index?token=' + token]);
    result = null; await component.scanInvitation(); assert.equal(component.data.error, '');
    result = { result: 'https://example.com' }; await component.scanInvitation();
    assert.match(component.data.error, /邀请小程序码/); assert.equal(urls.length, 1);
  } finally { component.__restoreGlobals(); }
});

test('二维码上游失败可重试，近期六次记录后限频；日志和幂等缓存不存邀请令牌/图片', async () => {
  let calls = 0;
  const { w, crewId, invitation } = await setup({ createInviteProvider: () => ({ generate: async () => {
    calls++; if (calls === 1) throw fail('INSUFFICIENT_DATA', '稍后重试');
    return { imageBase64: image.toString('base64'), contentType: 'image/png' };
  } }) });
  const payload = { crewId, token: invitation.token };
  assert.equal((await w.A('crew.inviteQr', payload, { requestId: 'retry-qr' })).ok, false);
  for (let i = 0; i < 5; i++) expectOk(await w.A('crew.inviteQr', payload, { requestId: 'retry-qr' }));
  expectFail(await w.A('crew.inviteQr', payload), 'RATE_LIMITED'); assert.equal(calls, 6);
  const audit = JSON.stringify(await w.repo.find(C.EVENTS, {}));
  assert.ok(!audit.includes(invitation.token)); assert.ok(!audit.includes(image.toString('base64')));
  assert.equal((await w.repo.find(C.OPERATIONS, {})).some(e => /^crew\.invite/.test(e.action)), false);
});

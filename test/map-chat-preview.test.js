'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMapChatPreview } = require('../miniprogram/utils/map-chat-preview');
const { makeWorld, makeCrew, expectOk, C } = require('./helpers');
const { loadPage } = require('./page-harness');

const messages = [1, 2].map(i => ({ messageId: 'message-' + i, seq: i, nickname: '同名队友',
  text: i === 1 ? '我在一号口' : '等我一下', avatarFileId: 'cloud://avatar-' + i }));
function environment(extra) {
  let room = 'room-A', clock = 0, timerSeq = 0;
  const state = {}, timers = new Map(), calls = [], photoCalls = [];
  const options = { getCrewId: () => room, now: () => clock, onState: patch => Object.assign(state, patch),
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    callApi: async (action, payload) => { calls.push({ action, payload }); return { ok: true, data: { messages } }; },
    wx: { cloud: { getTempFileURL: input => {
      photoCalls.push(input.fileList);
      input.success({ fileList: input.fileList.map(fileID => ({ fileID, tempFileURL: 'https://temp.example/' + fileID, status: 0 })) });
    } } }, ...extra };
  const controller = createMapChatPreview(options);
  return { controller, state, timers, calls, photoCalls,
    room: id => { room = id; }, advance: ms => { clock += ms; },
    async tick() { const [id, task] = timers.entries().next().value; timers.delete(id); await task.fn(); } };
}

test('地图气泡展示最近两条，允许重名；云头像转换临时 URL 并缓存，全文仍留在聊天页', async () => {
  const e = environment();
  try {
    await e.controller.start('room-A');
    assert.deepEqual(e.state.chatPreview.map(m => m.messageId), ['message-1', 'message-2']);
    assert.equal(e.state.chatPreview[0].avatarUrl, 'https://temp.example/cloud://avatar-1');
    assert.equal(e.state.chatPreview[0].initial, '同'); assert.equal(e.calls[0].payload.limit, 2);
    await e.tick(); assert.equal(e.calls.length, 2); assert.equal(e.photoCalls.length, 1);
    e.advance(61000); await e.tick(); assert.equal(e.photoCalls.length, 2);
    e.controller.imageError('message-1'); assert.equal(e.state.chatPreview[0].avatarUrl, '');
    assert.equal(e.state.chatPreview[1].avatarUrl.startsWith('https://'), true);
  } finally { e.controller.stop(); }
});

test('头像无效、服务失败或超时仍显示首字；气泡压缩长文本但不改后端原文', async () => {
  const row = { ...messages[0], text: '😀'.repeat(50) + '\n\t继续', avatarFileId: 'https://untrusted/avatar.png', isMine: true };
  const e = environment({ callApi: async () => ({ ok: true, data: { messages: [row] } }) });
  await e.controller.start('room-A');
  assert.equal(e.state.chatPreview[0].avatarUrl, ''); assert.equal(e.state.chatPreview[0].name, '同名队友（我）');
  assert.equal(Array.from(e.state.chatPreview[0].text).length, 43); assert.equal(row.text.includes('\n'), true);
  assert.equal(e.photoCalls.length, 0); e.controller.stop();
  const timeout = environment({ wx: { cloud: { getTempFileURL() {} } } });
  const loading = timeout.controller.start('room-A');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(timeout.state.chatPreview.length, 2); // 头像未返回时已有正文。
  await timeout.tick(); await loading;
  assert.equal(timeout.state.chatPreview[0].avatarUrl, '');
  assert.equal(timeout.timers.size, 1); timeout.controller.stop();
});

test('地图隐藏或切队后丢弃迟到消息与头像，停止所有计时器，重进恢复同步', async () => {
  let finishPhoto;
  const e = environment({ wx: { cloud: { getTempFileURL: input => { finishPhoto = input.success; } } } });
  const first = e.controller.start('room-A');
  while (!finishPhoto) await Promise.resolve();
  e.controller.stop(); await first;
  finishPhoto({ fileList: [{ fileID: 'cloud://avatar-1', tempFileURL: 'https://late.example' }] });
  assert.deepEqual(e.state.chatPreview, []); assert.equal(e.timers.size, 0);
  let release;
  const q = environment({ callApi: () => new Promise(resolve => { release = resolve; }) });
  const pending = q.controller.start('room-A'); q.room('room-B');
  release({ ok: true, data: { messages } }); await pending;
  assert.deepEqual(q.state.chatPreview, []); assert.equal(q.timers.size, 0); q.controller.stop();
});

test('离线保留上次消息并标注未更新；撤权后清空并隐藏入口，不再轮询', async () => {
  let count = 0;
  const e = environment({ callApi: async () => {
    count++;
    if (count === 1) return { ok: true, data: { messages } };
    return { ok: false, error: { code: count === 2 ? 'CLOUD_CALL_FAILED' : 'FORBIDDEN_NOT_MEMBER' } };
  } });
  await e.controller.start('room-A'); await e.tick();
  assert.equal(e.state.chatPreview.length, 2); assert.match(e.state.chatPreviewNote, /暂未更新/);
  assert.equal([...e.timers.values()][0].ms, 6000);
  await e.tick(); assert.equal(e.state.chatPreviewAvailable, false);
  assert.deepEqual(e.state.chatPreview, []); assert.equal(e.timers.size, 0);
});

test('当前头像来自服务端用户资料：旧消息也显示头像，更新头像后跟随变化，不暴露 openid', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w);
  expectOk(await w.A('user.login'));
  expectOk(await w.A('user.updateProfile', { nickname: '头像队友', avatarFileId: 'cloud://old-avatar' }));
  const sent = expectOk(await w.A('chat.send', { crewId, clientMessageId: 'avatar-message', text: '到了', avatarFileId: 'cloud://forged' }));
  assert.equal(sent.message.avatarFileId, 'cloud://old-avatar');
  expectOk(await w.A('user.updateProfile', { avatarFileId: 'cloud://new-avatar' }));
  const read = expectOk(await w.B('chat.list', { crewId, limit: 2 }));
  assert.equal(read.messages[0].avatarFileId, 'cloud://new-avatar');
  assert.equal(JSON.stringify(read).includes('openid_'), false);
  assert.equal((await w.repo.findOne(C.CREW_MESSAGES, { crewId })).text, '到了');
});

test('真实地图页展示气泡但不跳转二级聊天，隐藏与无队伍时清空', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w);
  expectOk(await w.B('chat.send', { crewId, clientMessageId: 'map-bubble-msg', text: '在这里等你' }));
  const p = loadPage('miniprogram/pages/map/index.js', { storage: { 'zhiyou-active-crew': crewId }, api: {
    'chat.list': payload => w.A('chat.list', payload),
  } });
  try {
    p.chatPreviewVisible = true; p.setData({ crewId }); await p.startChatPreview(crewId);
    assert.equal(p.data.chatPreview.length, 1); assert.equal(p.data.chatPreview[0].text, '在这里等你');
    p.holdChatTap(); assert.equal(p.__wx.some(c => c.fn === 'navigateTo'), false);
    assert.equal(p.openTeamChat, undefined);
    assert.equal(require('../miniprogram/app.json').pages.includes('pages/chat/index'), false);
    p.onHide(); assert.deepEqual(p.data.chatPreview, []);
    p.chatPreviewVisible = true; await p.startChatPreview(''); assert.deepEqual(p.data.chatPreview, []);
  } finally { p.onUnload(); p.restore(); }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, makeCrew, expectOk, expectFail, C } = require('./helpers');
const { loadPage } = require('./page-harness');

const post = (crewId, clientMessageId, text = '在地铁口集合', extra) => ({ crewId, clientMessageId, text, ...extra });

test('队伍成员可发送文字和语音转写，昵称取服务端，可重名且不暴露身份字段', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w);
  await w.A('user.login'); await w.B('user.login');
  expectOk(await w.A('user.updateProfile', { nickname: '小明' }));
  expectOk(await w.B('user.updateProfile', { nickname: '小明' }));
  const a = expectOk(await w.A('chat.send', post(crewId, 'client-msg-A', ' 我到了\n在一号口 ', { nickname: '伪造', senderUserId: 'fake' })));
  const b = expectOk(await w.B('chat.send', post(crewId, 'client-msg-B', '马上到', { source: 'speech' })));
  assert.equal(a.message.nickname, '小明'); assert.equal(b.message.nickname, '小明');
  const list = expectOk(await w.B('chat.list', { crewId }));
  assert.deepEqual(list.messages.map(m => m.seq), [1, 2]);
  assert.equal(list.messages[0].text, '我到了\n在一号口');
  assert.equal(list.messages[0].isMine, false); assert.equal(list.messages[0].clientMessageId, null);
  assert.equal(list.messages[1].isMine, true); assert.equal(list.messages[1].source, 'speech');
  assert.equal(JSON.stringify(list).includes('openid_'), false);
});

test('消息发送事务内去重：并发与不同 requestId 重试仅一条，改正文拒绝，不复制到通用幂等缓存或事件', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w);
  const payload = post(crewId, 'one-logical-message');
  const sent = await Promise.all([w.A('chat.send', payload), w.A('chat.send', payload)]);
  assert.equal(sent.map(expectOk).filter(r => !r.replayed).length, 1);
  assert.equal(await w.repo.count(C.CREW_MESSAGES, { crewId }), 1);
  expectOk(await w.A('chat.send', payload));
  expectFail(await w.A('chat.send', { ...payload, text: '另一个内容' }), 'INVALID_PARAM');
  expectFail(await w.A('chat.send', post(crewId, 'another-message')), 'RATE_LIMITED');
  const second = expectOk(await w.A('chat.send', post(crewId, 'another-message'), { now: w.plusMin(1) }));
  assert.equal(second.message.seq, 2);
  assert.equal(await w.repo.count(C.OPERATIONS, { action: 'chat.send' }), 0);
  const events = await w.repo.find(C.EVENTS, { action: 'chat.send' });
  assert.equal(JSON.stringify(events).includes('在地铁口集合'), false);
});

test('消息游标按序号分页：同时间并发、历史翻页和新消息不重复不漏，其他队伍隔离', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w);
  for (let round = 0; round < 12; round++) {
    const replies = await Promise.all(['A', 'B', 'C'].map(who => w[who]('chat.send',
      post(crewId, 'client-' + who + '-round-' + round), { now: new Date(w.NOW.getTime() + round * 1100) })));
    replies.forEach(expectOk);
  }
  const latest = expectOk(await w.A('chat.list', { crewId }));
  assert.equal(latest.messages.length, 30); assert.equal(latest.hasMore, true);
  assert.deepEqual(latest.messages.map(m => m.seq), Array.from({ length: 30 }, (_, i) => i + 7));
  const history = expectOk(await w.A('chat.list', { crewId, beforeSeq: latest.oldestSeq }));
  assert.deepEqual(history.messages.map(m => m.seq), [1, 2, 3, 4, 5, 6]); assert.equal(history.hasMore, false);
  const first = expectOk(await w.A('chat.list', { crewId, afterSeq: 0, limit: 20 }));
  const next = expectOk(await w.A('chat.list', { crewId, afterSeq: first.latestSeq, limit: 20 }));
  assert.deepEqual(first.messages.concat(next.messages).map(m => m.seq), Array.from({ length: 36 }, (_, i) => i + 1));
  const other = expectOk(await w.A('crew.create', { name: '另一个队伍' }));
  assert.deepEqual(expectOk(await w.A('chat.list', { crewId: other.crewId })).messages, []);
});

test('退出、移除和解散后拒绝新旧 requestId 读写，不能从幂等缓存重放原队伍内容', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w);
  const payload = post(crewId, 'member-message');
  expectOk(await w.B('chat.send', payload, { requestId: 'sent-before-leave' }));
  expectOk(await w.B('chat.list', { crewId }, { requestId: 'read-before-leave' }));
  expectOk(await w.B('crew.leave', { crewId }));
  expectFail(await w.B('chat.send', payload, { requestId: 'sent-before-leave' }), 'FORBIDDEN_NOT_MEMBER');
  expectFail(await w.B('chat.list', { crewId }, { requestId: 'read-before-leave' }), 'FORBIDDEN_NOT_MEMBER');
  expectOk(await w.A('crew.remove', { crewId, userId: 'openid_C' }));
  expectFail(await w.C('chat.list', { crewId }), 'FORBIDDEN_NOT_MEMBER');
  expectOk(await w.A('team.close', { crewId }));
  expectFail(await w.A('chat.send', post(crewId, 'closed-crew-msg')), 'FORBIDDEN_NOT_MEMBER');
});

test('发送事务被退出抢先提交时回滚，不留下消息或已消费序号', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w);
  const run = w.repo.runTransaction.bind(w.repo);
  let ready, release, once = false;
  const entered = new Promise(r => { ready = r; }), gate = new Promise(r => { release = r; });
  w.repo.runTransaction = (fn, collections) => run(async tx => {
    if (collections.includes(C.CREW_MESSAGES)) {
      const insert = tx.insert.bind(tx);
      tx.insert = async (...args) => {
        if (!once) { once = true; ready(); await gate; }
        return insert(...args);
      };
    }
    return fn(tx);
  }, collections);
  const sending = w.B('chat.send', post(crewId, 'racing-message'));
  await entered; expectOk(await w.B('crew.leave', { crewId })); release();
  expectFail(await sending, 'FORBIDDEN_NOT_MEMBER');
  assert.equal(await w.repo.count(C.CREW_MESSAGES, { crewId }), 0);
  assert.equal((await w.repo.get(C.CREWS, crewId)).chatSeq, undefined);
});

test('列表查询期间被移除必须丢弃已读正文，入参边界和跨身份访问都拒绝', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w);
  expectOk(await w.A('chat.send', post(crewId, 'private-message')));
  for (const payload of [post(crewId, 'empty-message', '  '), post(crewId, 'too-long-message', '字'.repeat(1001)),
    post(crewId, 'bad'), post(crewId, 'bad-source-msg', '正文', { source: 'audio' })])
    expectFail(await w.A('chat.send', payload), 'INVALID_PARAM');
  for (const extra of [{ afterSeq: 0, beforeSeq: 1 }, { afterSeq: -1 }, { beforeSeq: 0 }, { limit: 51 }])
    expectFail(await w.A('chat.list', { crewId, ...extra }), 'INVALID_PARAM');
  expectFail(await w.clientFor('outside')('chat.list', { crewId }), 'FORBIDDEN_NOT_MEMBER');
  const find = w.repo.find.bind(w.repo); let once = false;
  w.repo.find = async (collection, ...args) => {
    const rows = await find(collection, ...args);
    if (collection === C.CREW_MESSAGES && !once) { once = true; expectOk(await w.A('crew.remove', { crewId, userId: 'openid_B' })); }
    return rows;
  };
  expectFail(await w.B('chat.list', { crewId }), 'FORBIDDEN_NOT_MEMBER');
});

function chatPage(w, crewId, overrides) {
  const p = loadPage('miniprogram/pages/chat/index.js', { storage: { 'zhiyou-active-crew': crewId }, api: {
    'chat.send': (payload, options) => w.A('chat.send', payload, options),
    'chat.list': (payload, options) => w.A('chat.list', payload, options), ...overrides,
  } });
  p.onLoad({ crewId });
  return p;
}

test('真实聊天页面：语音仅追加可编辑文字，手动发送后队友能读到、清空输入、不保存音频', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w), p = chatPage(w, crewId);
  try {
    await p.onShow(); p.onText({ detail: { value: '我在门口' } });
    const count = p.__calls.length;
    p.onVoice({ detail: { text: '等你们五分钟', contextKey: p.data.voiceContext } });
    assert.equal(p.data.text, '我在门口，等你们五分钟'); assert.equal(p.__calls.length, count);
    p.onText({ detail: { value: '我在门口，等你们十分钟' } }); await p.sendMessage();
    assert.equal(p.data.text, ''); assert.equal(p.data.sending, false);
    const list = expectOk(await w.B('chat.list', { crewId }));
    assert.equal(list.messages[0].text, '我在门口，等你们十分钟'); assert.equal(list.messages[0].source, 'speech');
    assert.equal(p.data.messages.length, 1);
  } finally { p.onUnload(); p.restore(); }
});

test('发送成功但响应丢失：重试沿用消息 ID 不重复，失败保留原文，重复点击不并发发送', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w); let count = 0, release;
  const p = chatPage(w, crewId, { 'chat.send': async payload => {
    const result = await w.A('chat.send', payload);
    if (++count === 1) { await new Promise(r => { release = r; }); return { ok: false, error: { code: 'CLOUD_CALL_FAILED' } }; }
    return result;
  } });
  try {
    await p.onShow(); p.onText({ detail: { value: '别重复这条' } });
    const first = p.sendMessage(); await p.sendMessage();
    while (!release) await new Promise(r => setImmediate(r)); release(); await first;
    assert.equal(count, 1); assert.equal(p.data.uncertain, true); assert.equal(p.data.text, '别重复这条');
    const id = p.pending.clientMessageId;
    p.onText({ detail: { value: '不允许改变待重试内容' } }); assert.equal(p.data.text, '别重复这条');
    await p.sendMessage(); assert.equal(p.data.uncertain, false); assert.equal(p.pending, null);
    assert.equal(await w.repo.count(C.CREW_MESSAGES, { crewId }), 1);
    assert.equal((await w.repo.findOne(C.CREW_MESSAGES, { crewId })).clientMessageId, id);
  } finally { p.onUnload(); p.restore(); }
});

test('发送自己的消息不推进拉取游标，队友同时到来的消息仍能拉全且去重', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w), p = chatPage(w, crewId);
  try {
    await p.onShow(); expectOk(await w.B('chat.send', post(crewId, 'simultaneous-B')));
    p.onText({ detail: { value: '我也到了' } }); await p.sendMessage();
    for (let i = 0; i < 25; i++) await Promise.resolve();
    await p.refreshMessages();
    assert.deepEqual(p.data.messages.map(m => m.seq), [1, 2]); assert.equal(p.cursor, 2);
    await p.refreshMessages(); assert.equal(p.data.messages.length, 2);
  } finally { p.onUnload(); p.restore(); }
});

test('聊天隐藏后丢弃迟到消息，返回可重新同步；切换或被移除后清空聊天并禁用发送', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w); let release;
  const p = chatPage(w, crewId, { 'chat.list': async payload => {
    const data = await w.A('chat.list', payload);
    await new Promise(r => { release = r; }); return data;
  } });
  try {
    expectOk(await w.B('chat.send', post(crewId, 'before-hide-msg')));
    const loading = p.onShow(); while (!release) await new Promise(r => setImmediate(r));
    p.onHide(); release(); await loading; assert.equal(p.data.messages.length, 0); assert.equal(p.pollTimer, null);
    p.__storage['zhiyou-active-crew'] = 'different-crew'; await p.onShow(); assert.equal(p.data.locked, true);
    p.onVoice({ detail: { text: '旧录音', contextKey: crewId + ':1' } }); assert.equal(p.data.text, '');
  } finally { p.onUnload(); p.restore(); }
  const q = chatPage(w, crewId);
  try {
    await q.onShow(); expectOk(await w.A('team.close', { crewId }));
    await q.refreshMessages(); assert.equal(q.data.locked, true); assert.deepEqual(q.data.messages, []);
    assert.equal(q.data.voiceContext, ''); assert.equal(q.pollTimer, null);
  } finally { q.onUnload(); q.restore(); }
});

test('语音过长或来自旧会话时保留原文，地图气泡不再打开二级聊天', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w), p = chatPage(w, crewId);
  try {
    await p.onShow(); p.onText({ detail: { value: '字'.repeat(999) } });
    p.onVoice({ detail: { text: '超长', contextKey: p.data.voiceContext } }); assert.equal(p.data.text.length, 999);
    p.onVoice({ detail: { text: '旧结果', contextKey: 'old-context' } }); assert.equal(p.data.text.length, 999);
    p.onHide(); await p.onShow(); assert.equal(p.data.locked, false); assert.equal(p.data.text.length, 999);
  } finally { p.onUnload(); p.restore(); }
  const map = loadPage('miniprogram/pages/map/index.js');
  try {
    map.holdChatTap(); assert.equal(map.__wx.length, 0);
    map.setData({ crewId }); map.holdChatTap(); assert.equal(map.__wx.some(c => c.fn === 'navigateTo'), false);
  } finally { map.restore(); }
});

test('切后台时正在发送：回来能重试同一条，迟到失败不会卡住按钮或覆盖新会话', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w); let release;
  const p = chatPage(w, crewId, { 'chat.send': () => new Promise(r => { release = r; }) });
  try {
    await p.onShow(); p.onText({ detail: { value: '保留待发草稿' } });
    const sending = p.sendMessage(); const id = p.pending.clientMessageId;
    p.onHide(); assert.equal(p.data.sending, false); assert.equal(p.data.uncertain, true);
    await p.onShow(); assert.equal(p.pending.clientMessageId, id); assert.equal(p.data.text, '保留待发草稿');
    release({ ok: false, error: { code: 'CLOUD_CALL_FAILED' } }); await sending;
    assert.equal(p.data.sending, false); assert.equal(p.data.uncertain, true);
  } finally { p.onUnload(); p.restore(); }
});

test('聊天历史加载保持旧消息，新消息按页接续，不因空轮询跳过消息', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w);
  for (let i = 0; i < 35; i++) expectOk(await w.B('chat.send', post(crewId, 'history-row-' + i),
    { now: new Date(w.NOW.getTime() + i * 1100) }));
  const p = chatPage(w, crewId);
  try {
    await p.onShow(); assert.equal(p.data.hasHistory, true); assert.equal(p.cursor, 35);
    await p.loadHistory(); assert.equal(p.data.messages.length, 35); assert.equal(p.data.hasHistory, false);
    assert.equal(p.cursor, 35);
    await p.refreshMessages(); assert.equal(p.cursor, 35);
    expectOk(await w.C('chat.send', post(crewId, 'after-history-row')));
    await p.refreshMessages(); assert.equal(p.cursor, 36); assert.equal(p.data.messages.length, 36);
    assert.equal(p.data.newCount, 1);
  } finally { p.onUnload(); p.restore(); }
});

test('消息首次加载失败或限频拒绝保留草稿，重新连接成功后可继续手动发送', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w); let reads = 0;
  const p = chatPage(w, crewId, { 'chat.list': payload => ++reads === 1
    ? { ok: false, error: { code: 'CLOUD_CALL_FAILED', message: '网络暂不可用' } } : w.A('chat.list', payload) });
  try {
    await p.onShow(); assert.equal(p.data.initialized, false); assert.match(p.data.syncError, /网络/);
    await p.refreshMessages(); assert.equal(p.data.initialized, true); assert.equal(p.data.syncError, '');
    expectOk(await w.A('chat.send', post(crewId, 'rate-limit-first')));
    p.onText({ detail: { value: '稍后再试这条' } }); await p.sendMessage();
    assert.equal(p.data.text, '稍后再试这条'); assert.equal(p.data.uncertain, false); assert.equal(p.pending, null);
    assert.match(p.data.error, /发送太快/);
  } finally { p.onUnload(); p.restore(); }
});

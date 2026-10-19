'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMapChatCallouts, DISPLAY_MS } = require('../miniprogram/utils/map-chat-callouts');
const { createMapChatPreview } = require('../miniprogram/utils/map-chat-preview');
const { makeWorld, makeCrew, expectOk, C } = require('./helpers');
const { loadPage } = require('./page-harness');

const BASE = Date.parse('2026-10-16T08:00:00Z');
const point = { latitude: 45.77, longitude: 126.62 };
const message = (senderKey, seq, extra) => ({ senderKey, seq, messageId: 'msg-' + seq,
  text: '在这里等你', sentAt: new Date(BASE).toISOString(), ...extra });
function timerWorld(onChange) {
  let now = BASE, seq = 0, changes = 0;
  const timers = new Map();
  const options = { now: () => now, onChange: () => { changes++; if (onChange) onChange(); },
    setTimeout: (fn, delay) => { const id = ++seq; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id) };
  return { options, timers, changes: () => changes,
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    }, now: () => now };
}

test('坐标消息按服务端时间只显示剩余 8 秒，重复拉取和重试不延长；旧消息不弹', () => {
  const t = timerWorld(), bubbles = createMapChatCallouts(t.options);
  bubbles.receive([message('member-A', 1)], new Date(BASE).toISOString());
  assert.equal(bubbles.get('member-A').text, '在这里等你');
  t.advance(5000);
  bubbles.receive([message('member-A', 1)], new Date(BASE + 5000).toISOString());
  assert.equal(t.changes(), 1); t.advance(3000);
  assert.equal(bubbles.get('member-A'), null); assert.equal(t.timers.size, 0);
  bubbles.receive([message('member-A', 1), message('member-B', 2)], new Date(BASE + 9000).toISOString());
  assert.equal(bubbles.get('member-B'), null);
  bubbles.clear();
});

test('同一人新消息覆盖旧消息，迟到旧消息不能覆盖；长文本按三行摘要，切页清理计时器', () => {
  const t = timerWorld(), bubbles = createMapChatCallouts(t.options);
  bubbles.receive([message('A', 1)], new Date(BASE).toISOString()); t.advance(2000);
  bubbles.receive([message('A', 2, { sentAt: new Date(BASE + 2000), text: '😀'.repeat(100) })], new Date(BASE + 2000));
  assert.equal(bubbles.get('A').messageId, 'msg-2'); assert.equal(bubbles.get('A').text.split('\n').length, 3);
  assert.equal(bubbles.get('A').text.endsWith('…'), true);
  bubbles.receive([message('A', 1)], new Date(BASE + 2000)); assert.equal(bubbles.get('A').messageId, 'msg-2');
  bubbles.clear(); assert.equal(bubbles.get('A'), null); assert.equal(t.timers.size, 0);
});

test('客户端时钟不准仍按 serverTime 判断新鲜度，迟收到的消息不重获完整 8 秒', () => {
  const t = timerWorld(), bubbles = createMapChatCallouts(t.options);
  bubbles.receive([message('A', 1, { sentAt: new Date(BASE - 3600000) })], new Date(BASE - 3600000 + 6000));
  assert.ok(bubbles.get('A')); t.advance(2000); assert.equal(bubbles.get('A'), null);
  bubbles.receive([message('B', 2, { sentAt: 'invalid' }), message('C', 3, { sentAt: new Date(BASE + 60000) })], new Date(BASE));
  assert.equal(bubbles.get('B'), null); assert.equal(bubbles.get('C'), null);
});

test('聊天和位置使用同一稳定成员键，重名、不同查看者及伪造 senderKey 不会串人', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w);
  for (const who of ['A', 'B']) {
    expectOk(await w[who]('user.login')); expectOk(await w[who]('user.updateProfile', { nickname: '同名' }));
    expectOk(await w[who]('loc.report', { crewId, point, source: 'gps' }));
  }
  const sent = expectOk(await w.A('chat.send', { crewId, clientMessageId: 'stable-key-A', text: 'A 的消息', senderKey: 'forged' }));
  const locations = expectOk(await w.B('loc.list', { crewId })).members;
  assert.equal(sent.message.senderKey, locations.find(m => m.userId === 'openid_A').memberKey);
  assert.notEqual(sent.message.senderKey, locations.find(m => m.userId === 'openid_B').memberKey);
  const read = expectOk(await w.B('chat.list', { crewId }));
  assert.equal(read.messages[0].senderKey, sent.message.senderKey); assert.equal(JSON.stringify(read).includes('openid_'), false);
  expectOk(await w.A('loc.stopSharing', { crewId, sharing: false }));
  const off = expectOk(await w.B('loc.list', { crewId })).members.find(m => m.userId === 'openid_A');
  assert.equal(off.memberKey, sent.message.senderKey); assert.equal(off.point, undefined);
});

test('消息气泡附着对应成员原坐标，重名/同坐标也不串人，过期恢复原标签', () => {
  const p = loadPage('miniprogram/pages/map/index.js');
  const t = timerWorld(() => p.refreshMarkers());
  try {
    p.setData({ me: 'A', myPoint: point, mySource: 'gps' });
    p.teamLocations = ['A', 'B', 'C'].map(userId => ({ userId, memberKey: 'key-' + userId, nickname: '同名',
      point, source: 'gps', hasLocation: true, stale: false }));
    p.locationMembers = p.teamLocations;
    p.chatCallouts = createMapChatCallouts(t.options); p.refreshMarkers();
    const original = p.data.markers.map(m => ({ id: m.id, lat: m.latitude, lng: m.longitude, text: m.callout.content }));
    const originalNames = p.data.markers.map(m => structuredClone(m.callout));
    p.chatCallouts.receive([message('key-B', 1), message('key-A', 2, { text: '我也在这儿' })], new Date(BASE));
    assert.match(p.data.markers.find(m => m.id === 999).chatBubble.content, /我也在这儿/);
    assert.match(p.data.markers.find(m => m.id === 2000).chatBubble.content, /在这里等你/);
    assert.equal(p.data.markers.find(m => m.id === 2000).callout.content, '同名');
    assert.equal(p.data.markers.find(m => m.id === 2001).chatBubble, undefined);
    p.data.markers.forEach((marker, i) => {
      for (const field of ['content', 'color', 'bgColor', 'padding']) {
        assert.equal(marker.callout[field], originalNames[i][field], '消息不能改变用户名的内容和样式');
      }
      if (marker.chatBubble) {
        assert.equal(marker.customCallout.display, 'ALWAYS');
        assert.equal(marker.customCallout.anchorY, marker.callout.anchorY);
      }
    });
    assert.deepEqual(p.data.memberChatCallouts.map(row => ({ id: row.id, name: row.name, lines: row.lines })),
      [{ id: 999, name: '同名', lines: ['我也在这儿'] }, { id: 2000, name: '同名', lines: ['在这里等你'] }]);
    assert.equal(new Set(p.data.markers.map(m => m.callout.anchorY)).size, 3);
    assert.deepEqual(p.data.markers.map(m => ({ id: m.id, lat: m.latitude, lng: m.longitude })),
      original.map(({ id, lat, lng }) => ({ id, lat, lng })));
    t.advance(DISPLAY_MS);
    assert.deepEqual(p.data.markers.map(m => m.callout.content), original.map(m => m.text));
    assert.deepEqual(p.data.memberChatCallouts, []);
    assert.ok(p.data.markers.every(m => !m.customCallout && !m.chatBubble));
  } finally { if (p.chatCallouts) p.chatCallouts.clear(); p.restore(); }
});

test('过期位置、关闭共享、缺失坐标不承载消息；刷新坐标后气泡随原成员移动，隐藏清除', () => {
  const p = loadPage('miniprogram/pages/map/index.js');
  const t = timerWorld(() => p.refreshMarkers());
  try {
    p.setData({ me: 'A', myPoint: point });
    p.teamLocations = ['B', 'C'].map((userId, i) => ({ userId, memberKey: 'key-' + userId,
      point, hasLocation: true, stale: i === 1, source: 'gps' }));
    p.chatCallouts = createMapChatCallouts(t.options);
    p.chatCallouts.receive([message('key-B', 1), message('key-C', 2), message('missing', 3)], new Date(BASE));
    assert.equal(p.data.markers.filter(m => m.chatBubble).length, 1);
    p.teamLocations[0].point = { latitude: 45.8, longitude: 126.7 }; p.teamLocations.reverse(); p.refreshMarkers();
    const marker = p.data.markers.find(m => m.chatBubble);
    assert.equal(marker.latitude, 45.8); assert.equal(marker.longitude, 126.7);
    p.teamLocations[1].sharingOff = true; p.refreshMarkers();
    assert.equal(p.data.markers.filter(m => m.chatBubble).length, 0);
    p.onHide(); assert.equal(t.timers.size, 0);
  } finally { p.onUnload(); p.restore(); }
});

test('增量拉取超过两条新消息也全部通知坐标气泡，左下预览仍只有两条；主动刷新不重置游标', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w), received = [], timers = new Map();
  let tid = 0;
  const controller = createMapChatPreview({ wx: {}, getCrewId: () => crewId,
    onState() {}, onMessages: rows => received.push(...rows),
    callApi: (action, payload) => w.A(action, payload),
    setTimeout: (fn, ms) => { timers.set(++tid, { fn, ms }); return tid; }, clearTimeout: id => timers.delete(id) });
  try {
    await controller.start(crewId);
    for (const who of ['A', 'B', 'C']) expectOk(await w[who]('chat.send', { crewId, clientMessageId: 'batch-msg-' + who, text: who }));
    await controller.refresh();
    assert.deepEqual(received.map(m => m.seq), [1, 2, 3]);
    await controller.refresh(); assert.equal(received.length, 3);
    assert.equal(await w.repo.count(C.CREW_MESSAGES, { crewId }), 3);
  } finally { controller.stop(); }
});

test('真实接口到地图：队友新消息与本人发送回调均出现在各自标记，隐藏即恢复标签', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w);
  for (const [who, location] of [['A', point], ['B', { latitude: 45.78, longitude: 126.63 }]])
    expectOk(await w[who]('loc.report', { crewId, point: location, source: 'gps' }));
  const peers = expectOk(await w.A('loc.list', { crewId })).members;
  const p = loadPage('miniprogram/pages/map/index.js', { storage: { 'zhiyou-active-crew': crewId }, api: {
    'chat.list': payload => w.A('chat.list', payload),
  } });
  try {
    p.setData({ crewId, me: 'openid_A', myPoint: point, mySource: 'gps' });
    p.chatPreviewVisible = true; p.locationMembers = peers; p.teamLocations = peers.filter(m => m.hasLocation);
    expectOk(await w.B('chat.send', { crewId, clientMessageId: 'real-map-peer', text: '我在另一边' }));
    await p.startChatPreview(crewId);
    const b = p.data.markers.find(m => m.latitude === 45.78);
    assert.match(b.chatBubble.content, /我在另一边/); assert.equal(b.longitude, 126.63);
    // 本机定位早于位置列表同步，自己的共享记录暂时不在列表中。
    p.locationMembers = peers.filter(m => m.userId !== 'openid_A');
    p.teamLocations = p.locationMembers.filter(m => m.hasLocation);
    const sent = await w.A('chat.send', { crewId, clientMessageId: 'real-map-own', text: '这就过来' });
    await p.onMapChatSent({ detail: { message: expectOk(sent).message, serverTime: sent.meta.serverTime } });
    assert.match(p.data.markers.find(m => m.id === 999).chatBubble.content, /这就过来/);
    p.onHide();
    assert.equal(p.data.markers.some(m => m.chatBubble), false);
  } finally { p.onUnload(); p.restore(); }
});

test('本人发送成功后无需等待位置列表；缺少成员键或云端位置过期仍附着本机图钉', async () => {
  const p = loadPage('miniprogram/pages/map/index.js', { storage: { 'zhiyou-active-crew': 'crew-self' } });
  const t = timerWorld(() => p.refreshMarkers());
  try {
    p.setData({ crewId: 'crew-self', me: 'A', myPoint: point, mySource: 'gps' });
    p.chatPreviewVisible = true;
    p.chatCallouts = createMapChatCallouts(t.options);
    p.refreshMarkers();
    // loc.list 尚未返回；旧版接口的本人消息也有可信 isMine，但没有 senderKey。
    p.onMapChatSent({ detail: { message: message(undefined, 1, { isMine: true, text: '你好' }), serverTime: new Date(BASE) } });
    assert.match(p.data.markers.find(m => m.id === 999).chatBubble.content, /你好/);
    p.locationMembers = [{ userId: 'A', memberKey: 'key-A', point, hasLocation: true, stale: true }];
    p.refreshMarkers();
    assert.match(p.data.markers.find(m => m.id === 999).chatBubble.content, /你好/);
    p.chatCallouts.receive([message('key-A', 2, { isMine: true, text: '这就过来' })], new Date(BASE));
    assert.match(p.data.markers.find(m => m.id === 999).chatBubble.content, /这就过来/);
    p.setData({ myPoint: { latitude: 45.78, longitude: 126.63 } }); p.refreshMarkers();
    assert.equal(p.data.markers.find(m => m.id === 999).latitude, 45.78);
    assert.match(p.data.markers.find(m => m.id === 999).chatBubble.content, /这就过来/);
    p.setData({ myPoint: null }); p.refreshMarkers();
    assert.equal(p.data.markers.some(m => m.id === 999), false);
    p.setData({ myPoint: point }); p.refreshMarkers();
    t.advance(5000);
    // 发送回调与增量列表重复返回本人消息，即使关联键字段变化也不续时。
    p.chatCallouts.receive([message(undefined, 2, { isMine: true, text: '这就过来' })], new Date(BASE + 5000));
    t.advance(DISPLAY_MS - 5000);
    assert.equal(p.data.markers.find(m => m.id === 999).chatBubble, undefined);
  } finally { p.onUnload(); p.restore(); }
});

test('本人关联只信任服务端布尔 isMine；队友缺少关联键不按昵称或同坐标误挂本人', () => {
  const p = loadPage('miniprogram/pages/map/index.js');
  const t = timerWorld(() => p.refreshMarkers());
  try {
    p.setData({ me: 'A', myPoint: point, mySource: 'gps' });
    p.chatCallouts = createMapChatCallouts(t.options);
    p.chatCallouts.receive([message(undefined, 1, { nickname: '同名', isMine: false }),
      message(undefined, 2, { isMine: 'true' }), message('key-B', 3, { isMine: false })], new Date(BASE));
    p.refreshMarkers();
    assert.equal(p.data.markers.find(m => m.id === 999).chatBubble, undefined);
    p.chatCallouts.receive([message('key-A', 4, { isMine: true })], new Date(BASE));
    assert.match(p.data.markers.find(m => m.id === 999).chatBubble.content, /在这里等你/);
    p.onHide();
    assert.equal(p.data.markers.find(m => m.id === 999).chatBubble, undefined);
    assert.equal(t.timers.size, 0);
  } finally { p.onUnload(); p.restore(); }
});

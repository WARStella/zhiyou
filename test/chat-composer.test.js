'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, makeCrew, expectOk, C } = require('./helpers');
const { loadComponent } = require('./page-harness');

function composer(w, crewId, transform) {
  // 其他页面测试可能保留 API 替身；本组明确装入真实封装，结束时恢复。
  const apiPath = require.resolve('../miniprogram/utils/api');
  const savedApi = require.cache[apiPath];
  delete require.cache[apiPath];
  require(apiPath);
  const calls = [];
  const component = loadComponent('miniprogram/components/team-chat-composer/index.js', {
    properties: { crewId }, storage: { 'zhiyou-active-crew': crewId }, wx: { cloud: {
      callFunction: async ({ data }) => {
        calls.push(data);
        const result = await w.A(data.action, data.payload, { requestId: data.requestId });
        return { result: transform ? await transform(result) : result };
      },
    } },
  });
  component.__attached();
  component.close = () => {
    component.dispose(); component.__restoreGlobals();
    if (savedApi) require.cache[apiPath] = savedApi; else delete require.cache[apiPath];
  };
  component.calls = calls;
  return component;
}

async function untilReady(getReady) {
  for (let i = 0; i < 50 && !getReady(); i++) await new Promise(r => setImmediate(r));
  assert.ok(getReady(), '发送替身应进入等待响应阶段');
}

test('地图下方输入组件手动发送文字，使用真实 API 封装与云端 action，通知地图刷新气泡', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w), c = composer(w, crewId);
  try {
    c.onText({ detail: { value: '我在地铁出口等你' } }); assert.equal(c.calls.length, 0);
    await c.sendMessage();
    const messages = expectOk(await w.B('chat.list', { crewId })).messages;
    assert.equal(messages[0].text, '我在地铁出口等你'); assert.equal(c.data.text, '');
    assert.equal(c.__wx.find(e => e.fn === 'triggerEvent').args.name, 'sent');
    assert.equal(c.data.sending, false);
  } finally { c.close(); }
});

test('内嵌输入框丢响应可重试且不重复，等待结果时禁止编辑或并发发送', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w); let count = 0, release;
  const c = composer(w, crewId, async result => {
    if (++count === 1) { await new Promise(r => { release = r; }); return { ok: false, error: { code: 'CLOUD_CALL_FAILED' } }; }
    return result;
  });
  try {
    c.onText({ detail: { value: '不要发两遍' } }); const pending = c.sendMessage();
    await untilReady(() => release);
    await c.sendMessage(); release(); await pending;
    assert.equal(c.data.uncertain, true); assert.equal(c.data.text, '不要发两遍');
    const id = c.pending.clientMessageId;
    c.onText({ detail: { value: '不应改写重试正文' } }); assert.equal(c.data.text, '不要发两遍');
    await c.sendMessage(); assert.equal(c.data.text, ''); assert.equal(c.data.uncertain, false);
    assert.equal(await w.repo.count(C.CREW_MESSAGES, { crewId }), 1);
    assert.equal((await w.repo.findOne(C.CREW_MESSAGES, { crewId })).clientMessageId, id);
  } finally { c.close(); }
});

test('地图状态刷新不清空同队草稿，切队清空并拒绝旧录音回填，超长语音保留原文', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w), c = composer(w, crewId);
  try {
    c.onText({ detail: { value: '还没发送' } }); c.resetCrew(); assert.equal(c.data.text, '还没发送');
    c.focusText(); assert.equal(c.data.inputFocused, true);
    c.blurText(); assert.equal(c.data.inputFocused, false);
    c.recordCrew = crewId; c.recordGeneration = c.generation;
    c.onVoiceResult('等等我'); assert.equal(c.data.text, '还没发送，等等我'); assert.equal(c.calls.length, 0);
    c.onText({ detail: { value: '字'.repeat(999) } }); c.onVoiceResult('长语音'); assert.equal(c.data.text.length, 999);
    c.properties.crewId = 'new-crew'; c.__storage['zhiyou-active-crew'] = 'new-crew'; c.resetCrew();
    c.onVoiceResult('旧队伍语音'); assert.equal(c.data.text, ''); assert.equal(c.pending, null);
  } finally { c.close(); }
});

test('内嵌发送时隐藏页面，不回填迟到结果；返回重试同一编号可确认已送达', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w); let release, count = 0;
  const c = composer(w, crewId, async result => {
    if (++count === 1) await new Promise(r => { release = r; }); return result;
  });
  try {
    c.onText({ detail: { value: '隐藏时正在发' } }); const sending = c.sendMessage();
    await untilReady(() => release);
    c.suspend(); release(); await sending;
    assert.equal(c.data.text, '隐藏时正在发'); assert.equal(c.data.uncertain, true); assert.equal(c.data.sending, false);
    assert.equal(c.__wx.filter(e => e.fn === 'triggerEvent').length, 0);
    c.activate(); await c.sendMessage(); assert.equal(c.data.text, '');
    assert.equal(await w.repo.count(C.CREW_MESSAGES, { crewId }), 1);
  } finally { c.close(); }
});

test('地图输入框退队后拒绝发送并清空，权限事件用于隐藏地图气泡', async () => {
  const w = await makeWorld(), { crewId } = await makeCrew(w), c = composer(w, crewId);
  try {
    c.onText({ detail: { value: '不能继续发' } }); expectOk(await w.A('team.close', { crewId }));
    await c.sendMessage(); assert.equal(c.data.blocked, true); assert.equal(c.data.text, '');
    assert.equal(c.__wx.find(e => e.fn === 'triggerEvent').args.name, 'accessdenied');
    assert.equal(await w.repo.count(C.CREW_MESSAGES, { crewId }), 0);
  } finally { c.close(); }
});

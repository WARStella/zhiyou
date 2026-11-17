'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSpeechInput, appendSpeech, MAX_DURATION_MS } = require('../miniprogram/utils/speech-input');
const { loadPage, loadComponent } = require('./page-harness');
const { makeWorld, expectOk, C } = require('./helpers');

function environment(extra) {
  const calls = [], states = [], results = [], timers = new Map();
  let seq = 0;
  const manager = { start: o => calls.push(['start', o]), stop: () => calls.push(['stop']) };
  const listeners = {}, nativeCalls = [], socketListeners = {};
  let spoken = '', completed;
  const voiceId = 'b'.repeat(32);
  const message = value => socketListeners.message({ data: JSON.stringify({ code: 0, voice_id: voiceId, ...value }) });
  const socket = { onOpen: fn => { socketListeners.open = fn; }, onMessage: fn => { socketListeners.message = fn; }, onClose: fn => { socketListeners.close = fn; },
    onError: fn => { socketListeners.error = fn; }, close: () => {}, send: o => {
      o.success(); if (typeof o.data === 'string') {
        message({ result: { index: 0, slice_type: 2, voice_text_str: spoken } }); message({ final: 1 });
        if (completed) completed();
      }
    } };
  const native = { onStart: fn => { listeners.start = fn; }, onStop: fn => { listeners.stop = fn; },
    onError: fn => { listeners.error = fn; }, onFrameRecorded: fn => { listeners.frame = fn; },
    onInterruptionBegin: fn => { listeners.interrupt = fn; },
    start: o => nativeCalls.push(['start', o]), stop: () => nativeCalls.push(['stop']) };
  const wx = { getSetting: o => o.success({ authSetting: { 'scope.record': true } }),
    authorize: o => o.success(), getRecorderManager: () => native,
    getFileSystemManager: () => ({ readFile: o => o.success({ data: 'SUQzAA==' }), unlink: o => nativeCalls.push(['unlink', o.filePath]) }),
    connectSocket: () => socket,
    cloud: { callFunction: async () => ({ result: { ok: true, data: { voiceId,
      url: 'wss://asr.cloud.tencent.com/asr/v2/1234567890?signature=test' } } }) }, ...(extra || {}) };
  const create = more => createSpeechInput({ wx, getManager: () => manager,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), onState: s => states.push(s), onResult: r => results.push(r), ...more });
  return { manager, wx, native, nativeCalls, listeners, states, results, calls, timers, create,
    async ready() {
      for (let i = 0; i < 8; i++) await Promise.resolve();
      message({}); listeners.start();
    },
    async final(text) {
      spoken = text; listeners.frame({ frameBuffer: new ArrayBuffer(12800) });
      const done = new Promise(resolve => { completed = resolve; });
      listeners.stop({ tempFilePath: 'wxfile://tmp/voice.pcm', duration: 1500, fileSize: 12800 });
      await done;
    }, state: () => states[states.length - 1] };
}

test('点击才申请录音：实时结果只预览，最终结果回填一次，停止后清理计时器', () => {
  const e = environment(), s = e.create();
  assert.equal(e.calls.length, 0);
  s.start(); assert.equal(e.state().status, 'starting');
  assert.deepEqual(e.calls[0], ['start', { duration: MAX_DURATION_MS, lang: 'zh_CN' }]);
  e.manager.onStart(); e.manager.onRecognize({ result: '去哈工' });
  assert.equal(e.state().preview, '去哈工'); assert.deepEqual(e.results, []);
  s.stop(); assert.equal(e.state().status, 'recognizing');
  e.manager.onStop({ result: '去哈工大' });
  assert.deepEqual(e.results, ['去哈工大']); assert.equal(e.state().status, 'done');
  e.manager.onStop({ result: '不能重复' }); assert.equal(e.results.length, 1);
  assert.equal(e.timers.size, 0); s.dispose();
});

test('隐私授权先于麦克风授权；拒绝、读设置失败与旧微信都可继续文字输入', () => {
  const order = [];
  const e = environment({ requirePrivacyAuthorize: o => { order.push('privacy'); o.success(); },
    getSetting: o => { order.push('setting'); o.success({ authSetting: {} }); },
    authorize: o => { order.push(o.scope); o.fail(); } });
  const s = e.create(); s.start();
  assert.deepEqual(order, ['privacy', 'setting', 'scope.record']);
  assert.equal(e.state().permissionDenied, true); assert.equal(e.calls.length, 0); s.dispose();
  for (const wx of [{ requirePrivacyAuthorize: o => o.fail() }, { getSetting: o => o.fail() },
    { getSetting: o => o.success({ authSetting: {} }), authorize: null },
    { getSetting: o => o.success({ authSetting: { 'scope.record': false } }) }]) {
    const f = environment(wx), engine = f.create(); engine.start();
    assert.equal(f.state().status, 'error'); assert.equal(f.calls.length, 0); engine.dispose();
  }
});

test('授权期间取消或组件销毁，迟到的授权成功不能打开麦克风', () => {
  for (const action of ['cancel', 'dispose']) {
    let granted;
    const e = environment({ getSetting: o => { granted = o.success; } }), s = e.create();
    s.start(); s[action](); granted({ authSetting: { 'scope.record': true } });
    assert.equal(e.calls.length, 0); assert.equal(e.timers.size, 0); s.dispose();
  }
});

test('取消录音后迟到的最终文本不会回填；启动中取消会在 onStart 再次停止', () => {
  const e = environment(), s = e.create();
  s.start(); s.cancel(); assert.equal(e.state().status, 'canceling');
  e.manager.onStart(); assert.equal(e.calls.filter(c => c[0] === 'stop').length, 2);
  e.manager.onRecognize({ result: '不能出现' }); e.manager.onStop({ result: '不能回填' });
  assert.deepEqual(e.results, []); assert.equal(e.state().status, 'idle'); assert.equal(e.timers.size, 0);
  s.start(); e.manager.onStart(); s.stop(); e.manager.onStop({ result: '再次录音可用' });
  assert.deepEqual(e.results, ['再次录音可用']); s.dispose();
});

test('全局麦克风互斥，取消会话结束前另一个输入框不可抢占', () => {
  const a = environment(), b = environment(), first = a.create(), second = b.create();
  first.start(); first.cancel(); assert.equal(second.start(), false); assert.match(b.state().error, /另一个/);
  a.manager.onStop({ result: '作废' }); assert.equal(second.start(), true);
  b.manager.onStart(); b.manager.onStop({ result: '第二个输入框' });
  assert.deepEqual(b.results, ['第二个输入框']); first.dispose(); second.dispose();
});

test('空最终结果不拿未完成预览冒充，网络错误或原生录音不可用时释放会话', () => {
  const e = environment(), s = e.create();
  s.start(); e.manager.onStart(); e.manager.onRecognize({ result: '仅中间结果' }); e.manager.onStop({ result: '' });
  assert.equal(e.state().status, 'error'); assert.deepEqual(e.results, []);
  s.start(); e.manager.onError({ retcode: -1, msg: 'network disconnected' });
  assert.equal(e.state().status, 'error'); assert.equal(e.timers.size, 0); s.dispose();
  const unavailable = e.create({ getManager: () => { throw new Error('recorder unavailable'); } });
  assert.equal(unavailable.start(), false); assert.match(e.state().error, /录音/); unavailable.dispose();
  const broken = e.create({ getManager: () => ({}) });
  assert.equal(broken.start(), false); broken.dispose();
});

test('授权超时后不能迟到启动；识别超时先请求停止，终止前不复用麦克风', () => {
  let ready;
  const auth = environment({ getSetting: o => { ready = o.success; } }), waiting = auth.create();
  waiting.start(); Array.from(auth.timers.values())[0].fn(); ready({ authSetting: { 'scope.record': true } });
  assert.equal(auth.calls.length, 0); assert.equal(auth.state().status, 'error'); waiting.dispose();
  const e = environment(), s = e.create(); s.start(); e.manager.onStart();
  const limit = Array.from(e.timers.values())[0]; assert.equal(limit.ms, MAX_DURATION_MS + 5000); limit.fn();
  assert.equal(e.state().status, 'recognizing');
  Array.from(e.timers.values()).find(t => t.ms === 30000).fn();
  assert.match(e.state().error, /超时/);
  const other = e.create(); assert.equal(other.start(), false);
  e.manager.onStop({ result: '超时作废' }); assert.deepEqual(e.results, []);
  assert.equal(other.start(), true); e.manager.onStop({ result: '重试成功' });
  assert.deepEqual(e.results, ['重试成功']); s.dispose(); other.dispose();
});

test('语音追加保留已有文字，空内容及超限不截断，标点不会重复拼接', () => {
  assert.equal(appendSpeech('先去中央大街', ' 再去哈工大 '), '先去中央大街，再去哈工大');
  assert.equal(appendSpeech('先去中央大街，', '再去哈工大'), '先去中央大街，再去哈工大');
  assert.equal(appendSpeech('', '最后一站少停十分钟'), '最后一站少停十分钟');
  assert.equal(appendSpeech('保留', ' '), null); assert.equal(appendSpeech('一'.repeat(999), '新内容'), null);
});

function componentWith(e, onResult, onState) {
  let definition;
  const previous = { wx: global.wx, Component: global.Component };
  global.wx = e.wx; global.Component = d => { definition = d; };
  const file = require.resolve('../miniprogram/components/voice-input/index');
  delete require.cache[file]; require(file); global.Component = previous.Component;
  const instance = { properties: { disabled: false, contextKey: 'planning' }, data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); }, triggerEvent(name, detail) {
      if (name === 'result') onResult({ detail });
      else if (name === 'state' && onState) onState({ detail });
    } };
  for (const [k, fn] of Object.entries(definition.methods)) instance[k] = fn.bind(instance);
  return { instance, definition, restore() {
    definition.lifetimes.detached.call(instance);
    if (e.listeners.stop) e.listeners.stop({ tempFilePath: 'wxfile://tmp/voice.mp3', duration: 1500, fileSize: 4 });
    Object.assign(global, previous);
  } };
}

test('真实语音组件回填队伍聊天，只有手动发送才让队友读到文字', async () => {
  const { makeCrew } = require('./helpers');
  const w = await makeWorld(), { crewId } = await makeCrew(w);
  const p = loadPage('miniprogram/pages/chat/index.js', { storage: { 'zhiyou-active-crew': crewId }, api: {
    'chat.list': payload => w.A('chat.list', payload),
    'chat.send': payload => w.A('chat.send', payload),
  } });
  let component;
  try {
    p.onLoad({ crewId }); await p.onShow(); p.onText({ detail: { value: '我在入口' } });
    const e = environment(); e.wx.getStorageSync = key => p.__storage[key];
    component = componentWith(e, event => p.onVoice(event));
    component.instance.properties.contextKey = p.data.voiceContext;
    const calls = p.__calls.length;
    component.instance.tapVoice(); await e.ready(); component.instance.tapVoice(); await e.final('等你们过来');
    assert.equal(p.data.text, '我在入口，等你们过来'); assert.equal(p.__calls.length, calls);
    assert.equal(await w.repo.count(C.CREW_MESSAGES, { crewId }), 0);
    component.restore(); component = null;
    await p.sendMessage();
    const received = expectOk(await w.B('chat.list', { crewId }));
    assert.equal(received.messages[0].text, '我在入口，等你们过来'); assert.equal(p.data.text, '');
  } finally { if (component) component.restore(); p.onUnload(); p.restore(); }
});

test('真实 PCM→语音组件→游览助手草稿，识别中禁止提问，手动提交后才检索', async () => {
  const w = await makeWorld({ createGuideProvider: () => ({ modelAvailable: false, visionAvailable: false }),
    createMapProvider: () => ({ searchPlaces: async () => ({ ok: true, items: [{ title: '中央大街', address: '哈尔滨', location: { latitude: 45.77, longitude: 126.62 } }] }) }) });
  const p = loadPage('miniprogram/pages/guide/index.js', { api: { 'guide.ask': (payload, options) => w.A('guide.ask', payload, options) } });
  let component;
  try {
    p.onLoad(); p.onShow();
    const e = environment(); e.wx.getStorageSync = key => p.__storage[key];
    component = componentWith(e, event => p.onVoice(event), event => p.onVoiceState(event));
    component.instance.properties.contextKey = p.data.voiceContext;
    component.instance.tapVoice(); await e.ready(); assert.equal(p.data.voiceActive, true);
    await p.ask(); assert.equal(p.__calls.length, 0);
    component.instance.tapVoice(); await e.final('介绍中央大街');
    assert.equal(p.data.text, '介绍中央大街'); assert.equal(p.data.voiceActive, false); assert.equal(p.__calls.length, 0);
    component.restore(); component = null;
    await p.ask(); assert.equal(p.data.result.candidates[0].name, '中央大街');
  } finally { if (component) component.restore(); p.onUnload(); p.restore(); }
});

test('地图下方左侧语音按钮通过真实 PCM 和官方 SDK 转写，纠错后手动发送', async () => {
  const { makeCrew } = require('./helpers');
  const w = await makeWorld(), { crewId } = await makeCrew(w);
  const p = loadPage('miniprogram/pages/map/index.js', { api: { 'chat.send': payload => w.A('chat.send', payload) } });
  const e = environment(), c = loadComponent('miniprogram/components/team-chat-composer/index.js', {
    properties: { crewId }, storage: { 'zhiyou-active-crew': crewId }, wx: e.wx,
  });
  try {
    c.__attached(); c.onText({ detail: { value: '我在入口' } });
    c.focusText(); assert.equal(c.data.inputFocused, true);
    c.tapVoice(); await e.ready(); assert.equal(c.data.voiceCanStop, true);
    assert.equal(c.data.inputFocused, false);
    c.tapVoice(); await e.final('等你们五分钟');
    assert.equal(c.data.text, '我在入口，等你们五分钟'); assert.equal(c.data.voiceActive, false);
    assert.equal(await w.repo.count(C.CREW_MESSAGES, { crewId }), 0);
    c.onText({ detail: { value: '我在入口，等你们十分钟' } }); await c.sendMessage();
    assert.equal(expectOk(await w.B('chat.list', { crewId })).messages[0].text, '我在入口，等你们十分钟');
    c.onText({ detail: { value: '改用键盘输入' } });
    c.tapVoice(); await e.ready(); c.focusText();
    e.listeners.stop({ tempFilePath: 'wxfile://tmp/cancel.pcm', duration: 500, fileSize: 0 });
    assert.equal(c.data.inputFocused, true); assert.equal(c.data.voiceActive, false);
    assert.equal(c.data.text, '改用键盘输入');
  } finally { c.dispose(); c.__restoreGlobals(); p.restore(); }
});

test('真实原生实时录音组件经 WebSocket 回填生成输入框，保持原文字且不自动规划', async () => {
  const p = loadPage('miniprogram/pages/trip/index.js'), e = environment();
  const component = componentWith(e, event => p.onKeywordVoice(event)), v = component.instance;
  try {
    p.onKeyword({ detail: { value: '我想去中央大街' } });
    v.tapVoice(); await e.ready();
    assert.equal(p.data.keyword, '我想去中央大街');
    assert.equal(e.nativeCalls[0][1].format, 'PCM');
    v.tapVoice(); await e.final('下午五点前结束');
    assert.equal(p.data.keyword, '我想去中央大街，下午五点前结束'); assert.equal(p.__calls.length, 0);
    assert.equal(v.data.active, false); assert.match(v.data.message, /检查/);
  } finally { component.restore(); p.restore(); }
});

test('组件隐藏、销毁或禁用均丢弃录音结果；录音设置只在用户点击时打开', () => {
  for (const reason of ['hide', 'detach', 'disabled']) {
    const results = [], e = environment(), c = componentWith(e, r => results.push(r));
    try {
      c.instance.tapVoice(); e.listeners.start();
      if (reason === 'hide') c.definition.pageLifetimes.hide.call(c.instance);
      else if (reason === 'detach') c.definition.lifetimes.detached.call(c.instance);
      else { c.instance.properties.disabled = true; c.definition.observers.disabled.call(c.instance, true); }
      e.listeners.stop({ tempFilePath: 'wxfile://tmp/cancel.mp3', duration: 1500, fileSize: 4 }); assert.deepEqual(results, []);
    } finally { c.restore(); }
  }
  let opened = 0;
  const e = environment({ getSetting: o => o.success({ authSetting: { 'scope.record': false } }),
    openSetting: () => { opened++; } }), c = componentWith(e, () => {});
  try {
    c.instance.tapVoice(); assert.equal(c.instance.data.permissionDenied, true); assert.equal(opened, 0);
    c.instance.openRecordSettings(); assert.equal(opened, 1);
  } finally { c.restore(); }
});

test('语音动态修改复用真实自然语言接口与确认，回填时旧追问失效但不自动执行', async () => {
  const w = await makeWorld();
  const plan = expectOk(await w.A('trip.plan', { startAt: w.NOW, places: [{ name: '中央大街',
    location: { latitude: 45.77, longitude: 126.62 }, visitDurationMin: { default: 60, min: 5, max: 180 } }] }));
  const p = loadPage('miniprogram/pages/trip/index.js', { api: {
    'trip.adjustText': (payload, o) => w.A('trip.adjustText', { ...payload, preferModel: false }, o),
    'trip.confirmChange': (payload, o) => w.A('trip.confirmChange', payload, o),
  } });
  let component;
  try {
    p.applyTrip(plan, ''); p.setData({ changeDraftId: 'old-draft', changeNeedsRewrite: true,
      changeQuestions: [{ kind: 'rewrite' }], changeAnswers: { '0.node': 'old' } });
    const e = environment(); component = componentWith(e, event => p.onChangeVoice(event));
    component.instance.properties.contextKey = p.data.trip.tripId + ':' + p.data.trip.version;
    component.instance.tapVoice(); await e.ready(); component.instance.tapVoice(); await e.final('第一站少停十分钟');
    assert.equal(p.data.changeText, '第一站少停十分钟'); assert.equal(p.data.changeDraftId, '');
    assert.deepEqual(p.data.changeAnswers, {}); assert.equal(p.data.changeNeedsRewrite, false);
    assert.equal(p.__calls.length, 0); assert.equal(p.data.rawNodes[0].plannedStayMin, 60);
    component.restore(); component = null; // 恢复页面 wx 替身后继续验证地图与确认路径
    await p.submitTextChange(); assert.equal(p.data.rawNodes[0].plannedStayMin, 60);
    await p.confirmCandidate({ currentTarget: { dataset: { cid: p.data.proposalCandidates.find(c => c.feasible).candidateId } } });
    assert.equal(p.data.rawNodes[0].plannedStayMin, 50);
  } finally { if (component) component.restore(); p.restore(); }
});

test('回填守卫：操作中或目标输入框已消失时不改写，超长不截断原文字', () => {
  const p = loadPage('miniprogram/pages/trip/index.js');
  try {
    p.setData({ keyword: '原内容', loading: true }); p.onKeywordVoice({ detail: { text: '不应追加' } });
    assert.equal(p.data.keyword, '原内容'); p.setData({ loading: false, keyword: '一'.repeat(999) });
    p.onKeywordVoice({ detail: { text: '不能截断' } }); assert.equal(p.data.keyword.length, 999);
    p.onChangeVoice({ detail: { text: '没有行程' } }); assert.equal(p.data.changeText, '');
    p.setData({ trip: { tripId: 't' }, busy: 'progress' }); p.onChangeVoice({ detail: { text: '正在操作' } });
    assert.equal(p.data.changeText, ''); p.onKeywordVoice({ detail: { text: '输入框已经隐藏' } });
    assert.equal(p.data.keyword.length, 999); assert.equal(p.__calls.length, 0);
    p.setData({ busy: '', trip: { tripId: 'new-trip', version: 2 } });
    p.onChangeVoice({ detail: { text: '旧行程录音', contextKey: 'old-trip:1' } });
    p.onChangeVoice({ detail: { text: '旧版本录音', contextKey: 'new-trip:1' } });
    assert.equal(p.data.changeText, '');
  } finally { p.restore(); }
});

test('两个输入框都引用真实语音组件，不依赖插件且组件四件套完整', () => {
  const root = path.join(__dirname, '..', 'miniprogram');
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json')));
  assert.ok(!app.plugins || !app.plugins.WechatSI);
  const page = JSON.parse(fs.readFileSync(path.join(root, 'pages/trip/index.json')));
  assert.equal(page.usingComponents['voice-input'], '/components/voice-input/index');
  for (const ext of ['js', 'json', 'wxml', 'wxss']) assert.ok(fs.existsSync(path.join(root, 'components/voice-input/index.' + ext)));
  const wxml = fs.readFileSync(path.join(root, 'pages/trip/index.wxml'), 'utf8');
  assert.equal((wxml.match(/<voice-input /g) || []).length, 2);
  assert.match(wxml, /bindresult="onKeywordVoice"/); assert.match(wxml, /bindresult="onChangeVoice"/);
});

test('连接失败的安全诊断传到组件状态，再次开始或取消不残留上次诊断', () => {
  const e = environment(), s = e.create(); s.start();
  e.manager.onError({ userMessage: '尚未建立连接（HTTP 403）',
    diagnostic: { phase: 'connecting', source: 'error', httpStatus: 403 } });
  assert.equal(e.state().status, 'error'); assert.equal(e.state().diagnostic.httpStatus, 403);
  assert.deepEqual(e.results, []); s.start(); assert.equal(e.state().diagnostic, null);
  s.cancel(); e.manager.onStop({ result: '' }); assert.equal(e.state().diagnostic, null); s.dispose();
});

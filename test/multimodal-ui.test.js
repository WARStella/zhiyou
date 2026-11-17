const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function component(name, options = {}) {
  let definition, plays = 0, stops = 0, timers = 0, calls = 0;
  const stored = {}, files = new Set();
  const wx = { env: { USER_DATA_PATH: '/tmp' }, getStorageSync: key => stored[key], setStorageSync: (key, value) => { stored[key] = value; },
    getFileSystemManager: () => ({ writeFile(o) { files.add(o.filePath); o.success(); }, unlink(o) { files.delete(o.filePath); } }),
    createInnerAudioContext: () => ({ play() { plays++; }, stop() { stops++; }, destroy() {}, onEnded() {}, onError() {} }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/components', name, 'index.js'), 'utf8'), {
    Component: d => { definition = d; }, wx, console,
    setTimeout: () => { timers++; return timers; }, clearTimeout() {},
    require: id => id.endsWith('/api') ? { callApiStrict: async (action, payload) => { calls++; return options.call(action, payload); } }
      : { readSettings: () => ({ image: 'aliyun-image', video: 'aliyun-video', tts: options.tts || 'aliyun-tts', autoSpeak: options.autoSpeak || false }) },
  });
  const instance = { data: { ...definition.data, tripId: 'trip', version: 2, sessionId: 'session', crewId: '', available: true },
    setData(patch) { Object.assign(this.data, patch); }, ...definition.methods };
  definition.lifetimes.attached.call(instance);
  return { instance, definition, stored, files, stats: () => ({ plays, stops, calls, timers }),
    hide() { definition.pageLifetimes.hide.call(instance); },
    detach() { definition.lifetimes.detached.call(instance); } };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const spoken = { taskId: 'task', status: 'succeeded', text: '最新安排', audioBase64: 'YXVkaW8=', format: 'mp3' };

test('旧设备已移除选项回退默认，旧云端兼容文字条目被过滤', () => {
  const storage = { 'zhiyou-ai-settings-v1': { text: 'compatible-text', image: 'volcano-image', video: 'volcano-video', tts: 'volcano-tts', autoSpeak: true } };
  const wx = { getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = value; } };
  const exports = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/ai-settings.js'), 'utf8'), { wx, module: exports });
  const settings = exports.exports.readSettings();
  assert.equal(settings.text, 'deepseek'); assert.equal(settings.image, 'aliyun-image');
  assert.equal(settings.video, 'aliyun-video'); assert.equal(settings.tts, 'aliyun-tts'); assert.equal(settings.autoSpeak, true);
  let page;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/ai-settings/index.js'), 'utf8'), {
    Page: p => { page = p; }, require: id => id.endsWith('/api') ? {} : exports.exports,
  });
  page.data = { ...page.data }; page.setData = patch => Object.assign(page.data, patch);
  page.options = require('../cloudfunctions/api/lib/media/catalog').catalog({});
  page.options.push({ id: 'compatible-text', kind: 'text', label: '旧选项', model: 'old', configured: true });
  page.render();
  assert.equal(page.data.rows.find(r => r.kind === 'text').options.some(o => o.id === 'compatible-text'), false);
  assert.equal(page.data.rows.length, 5);
  for (const row of page.data.rows) assert.equal(row.options.length, row.kind === 'text' ? 4 : row.kind === 'tts' ? 4 : 3);
  const tts = page.data.rows.find(r => r.kind === 'tts'); assert.match(tts.value, /qwen3-tts-flash/);
  page.change({ currentTarget: { dataset: { kind: 'text' } }, detail: { value: '1' } });
  assert.equal(exports.exports.readSettings().text, 'aliyun-text');
  assert.equal(exports.exports.readSettings().tts, 'aliyun-tts');
  page.change({ currentTarget: { dataset: { kind: 'tts' } }, detail: { value: '1' } });
  assert.equal(exports.exports.readSettings().tts, 'tencent-tts');
  assert.equal(exports.exports.readSettings().text, 'aliyun-text');
  page.change({ currentTarget: { dataset: { kind: 'tts' } }, detail: { value: '2' } });
  assert.equal(exports.exports.readSettings().tts, 'doubao-tts');
  assert.equal(page.data.rows.find(r => r.kind === 'tts').name, '豆包语音播报');
  page.change({ currentTarget: { dataset: { kind: 'text' } }, detail: { value: '3' } });
  assert.equal(exports.exports.readSettings().text, 'zhipu-text');
  assert.equal(page.data.rows.find(r => r.kind === 'text').name, '4.7flash');
  for (const [kind, index, id] of [['image', 1, 'zhipu-image'], ['video', 2, 'doubao-video'], ['asr', 1, 'zhipu-asr']]) {
    page.change({ currentTarget: { dataset: { kind } }, detail: { value: String(index) } });
    assert.equal(exports.exports.readSettings()[kind], id);
  }
});

test('自动播报默认关闭，主动播放前重新核对版本，停止后清除临时文件', async () => {
  const e = component('route-voice', { call: async () => spoken });
  assert.equal(e.stats().calls, 0);
  await e.instance.play();
  assert.equal(e.stats().calls, 2); assert.equal(e.stats().plays, 1); assert.equal(e.files.size, 1);
  e.hide(); assert.equal(e.files.size, 0); assert.equal(e.instance.data.playing, false);
});

test('豆包播报按设置传参、显示正确服务名并播放临时MP3', async () => {
  const e = component('route-voice', { tts: 'doubao-tts', call: async (action, payload) => {
    if (action === 'media.speakTrip') assert.equal(payload.optionId, 'doubao-tts');
    return spoken;
  } });
  assert.equal(e.instance.data.providerLabel, '豆包语音播报');
  await e.instance.play();
  assert.equal(e.stats().plays, 1); assert.equal(e.instance.data.playing, true);
  assert.equal(e.files.size, 1); e.hide(); assert.equal(e.files.size, 0);
});

test('智谱播报使用WAV扩展名播放，切页清理临时音频', async () => {
  const e = component('route-voice', { tts: 'zhipu-tts', call: async (action, payload) => {
    if (action === 'media.speakTrip') assert.equal(payload.optionId, 'zhipu-tts');
    return { ...spoken, format: 'wav' };
  } });
  await e.instance.play();
  assert.equal(e.instance.data.providerLabel, 'GLM-TTS');
  assert.equal(e.stats().plays, 1); assert.match([...e.files][0], /\.wav$/);
  e.hide(); assert.equal(e.files.size, 0);
});
test('合成过程中切页或切换路线，迟到响应不能开始播放', async () => {
  for (const hide of [true, false]) {
    const pending = deferred(), e = component('route-voice', { call: () => pending.promise });
    const task = e.instance.play();
    if (hide) e.hide(); else { e.instance.data.version = 3; e.instance.changed(); }
    pending.resolve(spoken); await task;
    assert.equal(e.stats().plays, 0); assert.equal(e.files.size, 0); e.detach();
  }
});
test('播放前校验发现服务端版本变化，不能播放已生成的旧音频', async () => {
  const e = component('route-voice', { call: async action => {
    if (action === 'media.get') throw Object.assign(new Error('行程已更新'), { code: 'VERSION_CONFLICT' }); return spoken;
  } });
  await e.instance.play(); assert.equal(e.stats().plays, 0); assert.match(e.instance.data.error, /行程已更新/); e.detach();
});
test('用户主动开启自动播报时才调用接口', async () => {
  const e = component('route-voice', { autoSpeak: true, call: async () => spoken });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(e.stats().plays, 1); e.detach();
});
test('视频任务切换会话后响应仅保存到原会话，不能回填当前会话', async () => {
  const pending = deferred(), e = component('guide-media', { call: () => pending.promise });
  const generating = e.instance.generate({ currentTarget: { dataset: { kind: 'video' } } });
  e.instance.data.sessionId = 'other-session'; e.instance.reset();
  pending.resolve({ taskId: 'video-task', kind: 'video', status: 'pending', optionId: 'aliyun-video' });
  await generating;
  assert.equal(e.instance.data.tasks.length, 0);
  assert.equal(e.stored['zhiyou-media-session-2'][0].taskId, 'video-task');
  assert.equal(e.stored['zhiyou-media-other-session-2'], undefined); e.detach();
});
test('切页后不继续查询视频，返回时恢复原任务查询', async () => {
  const e = component('guide-media', { call: async action => ({ taskId: 'video-task', optionId: 'aliyun-video', kind: 'video', status: action === 'media.create' ? 'pending' : 'succeeded', url: 'https://example.com/video' }) });
  await e.instance.generate({ currentTarget: { dataset: { kind: 'video' } } });
  assert.equal(e.stats().calls, 1); assert.equal(e.stats().timers, 1);
  e.hide(); await e.instance.refresh(); assert.equal(e.stats().calls, 1);
  e.definition.pageLifetimes.show.call(e.instance); await new Promise(resolve => setImmediate(resolve));
  assert.equal(e.stats().calls, 2); assert.equal(e.instance.data.tasks[0].status, 'succeeded'); e.detach();
});

test('已有生成任务重复点击只查询状态，不再次提交付费创建', async () => {
  const actions = [], e = component('guide-media', { call: async action => {
    actions.push(action); return { taskId: 'existing', optionId: 'aliyun-video', kind: 'video', status: 'pending' };
  } });
  try {
    const event = { currentTarget: { dataset: { kind: 'video' } } };
    await e.instance.generate(event); await e.instance.generate(event);
    assert.deepEqual(actions, ['media.create', 'media.get']);
    assert.equal(e.instance.data.tasks.length, 1);
    assert.equal(e.instance.data.videoLabel, '查看短片状态');
  } finally { e.detach(); }
});

test('历史回答仍可查询既有任务，但不能发起新生成', async () => {
  const e = component('guide-media', { call: async () => ({ taskId: 'old', optionId: 'aliyun-video', kind: 'video', status: 'succeeded', url: 'https://example.com/video' }) });
  try {
    e.instance.updateTasks([{ taskId: 'old', optionId: 'aliyun-video', kind: 'video', status: 'pending' }]);
    e.instance.data.available = false;
    await e.instance.generate({ currentTarget: { dataset: { kind: 'image' } } });
    assert.equal(e.stats().calls, 0);
    await e.instance.refresh(); assert.equal(e.stats().calls, 1);
    assert.equal(e.instance.data.tasks[0].completed, true);
  } finally { e.detach(); }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeSpeechManager } = require('../miniprogram/utils/native-speech');

function setup(overrides) {
  const handlers = {}, calls = [], files = [], out = [], errors = [];
  const recorder = { onStart: f => { handlers.start = f; }, onStop: f => { handlers.stop = f; },
    onError: f => { handlers.error = f; }, onInterruptionBegin: f => { handlers.interrupt = f; },
    start: o => calls.push(['start', o]), stop: () => calls.push(['stop']) };
  const fs = { readFile: o => o.success({ data: 'SUQzAA==' }), unlink: o => files.push(o.filePath), ...overrides };
  const wx = { getRecorderManager: () => recorder, getFileSystemManager: () => fs };
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const api = [];
  const manager = createNativeSpeechManager(wx, async (action, payload) => { api.push({ action, payload }); return pending; });
  manager.onStop = r => out.push(r.result); manager.onError = e => errors.push(e.userMessage);
  const stop = extra => handlers.stop({ tempFilePath: 'wxfile://voice.mp3', duration: 1600, fileSize: 4, ...extra });
  return { wx, fs, manager, recorder, handlers, calls, files, out, errors, api, resolve, stop };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test('原生 MP3 文件经 base64 转写，返回文字后清理临时录音，不上传云存储', async () => {
  const e = setup(); e.manager.start(); e.handlers.start(); e.manager.stop(); e.stop();
  assert.equal(e.calls[0][1].format, 'mp3'); assert.equal(e.calls[0][1].sampleRate, 16000);
  assert.equal(e.calls[0][1].encodeBitRate, 24000); assert.equal(e.api[0].action, 'speech.recognize');
  assert.deepEqual(e.api[0].payload, { format: 'mp3', durationMs: 1600, audioBase64: 'SUQzAA==' });
  e.resolve({ ok: true, data: { text: '改去哈工大' } }); await settle();
  assert.deepEqual(e.out, ['改去哈工大']); assert.deepEqual(e.files, ['wxfile://voice.mp3']);
});

test('录音中取消不调用转写；读文件晚到或识别晚到不能回填', async () => {
  const e = setup(); e.manager.start(); e.manager.cancel(); e.stop();
  assert.equal(e.api.length, 0); assert.deepEqual(e.out, ['']);
  let read;
  const delayed = setup({ readFile: o => { read = o; } });
  delayed.manager.start(); delayed.stop(); delayed.manager.cancel(); read.success({ data: 'SUQzAA==' });
  assert.equal(delayed.api.length, 0); assert.deepEqual(delayed.out, ['']);
  const late = setup(); late.manager.start(); late.stop(); late.manager.cancel();
  late.resolve({ ok: true, data: { text: '不能回填' } }); await settle();
  assert.deepEqual(late.out, ['']); assert.equal(late.files.length, 1);
});

test('取消上一段的云端转写后可重新录音，旧结果不能污染新会话', async () => {
  const e = setup(); e.manager.start(); e.stop(); e.manager.cancel(); e.manager.start();
  e.resolve({ ok: true, data: { text: '旧结果' } }); await settle();
  assert.deepEqual(e.out, ['']); e.manager.cancel(); e.stop();
});

test('录音中断不转写，空文件、过短、过长、过大、读取失败均提示且清理', () => {
  const e = setup(); e.manager.start(); e.handlers.interrupt(); e.stop();
  assert.equal(e.api.length, 0); assert.match(e.errors[0], /中断/);
  for (const extra of [{ tempFilePath: '' }, { duration: 100 }, { duration: 60001 }, { fileSize: 512 * 1024 + 1 }]) {
    const f = setup(); f.manager.start(); f.stop(extra); assert.equal(f.api.length, 0); assert.equal(f.errors.length, 1);
  }
  const read = setup({ readFile: o => o.fail() }); read.manager.start(); read.stop();
  assert.match(read.errors[0], /读取/); assert.equal(read.files.length, 1);
});

test('同一个原生管理器只注册一次监听，两个适配器不串音；服务未配置有可读提示', async () => {
  const e = setup(), previous = e.handlers.stop;
  const other = createNativeSpeechManager(e.wx, async () => ({ ok: false }));
  assert.equal(e.handlers.stop, previous); e.manager.start(); assert.throws(() => other.start(), /busy/);
  e.stop(); e.resolve({ ok: false, error: { code: 'ASR_NOT_CONFIGURED' } }); await settle();
  assert.match(e.errors[0], /尚未启用/); assert.equal(e.files.length, 1);
  other.onStop = () => {}; other.start(); other.cancel(); e.stop();
});

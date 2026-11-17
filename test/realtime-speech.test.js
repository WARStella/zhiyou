'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createRealtimeSpeechManager, connectionFailure } = require('../miniprogram/utils/realtime-speech');
const voiceId = 'a'.repeat(32);
const session = { ok: true, data: { voiceId, url: 'wss://asr.cloud.tencent.com/asr/v2/1234567890?signature=test' } };
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function setup(options) {
  const opts = options || {}, h = {}, socketHandlers = {}, calls = [], sent = [], results = [], previews = [], errors = [], files = [];
  const timers = new Map(); let seq = 0, now = 0;
  const clock = { setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); } };
  function tick(ms) {
    const end = now + ms;
    for (;;) {
      const entry = Array.from(timers.entries()).filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      const [id, t] = entry; timers.delete(id); now = t.at; t.fn();
    }
    now = end;
  }
  const recorder = { onStart: f => { h.start = f; }, onStop: f => { h.stop = f; },
    onFrameRecorded: f => { h.frame = f; }, onError: f => { h.error = f; },
    onInterruptionBegin: f => { h.interrupt = f; },
    start: o => { calls.push(['record', o]); if (!opts.delayStart) h.start(); }, stop: () => calls.push(['stop']) };
  const socket = { onOpen: f => { socketHandlers.open = f; }, onMessage: f => { socketHandlers.message = f; }, onClose: f => { socketHandlers.close = f; },
    onError: f => { socketHandlers.error = f; },
    send: o => { sent.push({ at: now, data: o.data }); if (opts.sendFails) o.fail(); else o.success(); },
    close: () => calls.push(['close']) };
  const wx = { getRecorderManager: () => recorder, connectSocket: o => { calls.push(['connect', o]); return socket; },
    getFileSystemManager: () => ({ unlink: o => files.push(o.filePath) }) };
  const api = [];
  const manager = createRealtimeSpeechManager(wx, async (action, payload) => {
    api.push({ action, payload }); return opts.response || session;
  }, clock);
  manager.onStop = e => results.push(e.result); manager.onRecognize = e => previews.push(e.result);
  manager.onError = e => errors.push(e.userMessage);
  const message = data => socketHandlers.message({ data: JSON.stringify({ code: 0, voice_id: voiceId, ...data }) });
  const frame = (n, fill) => { const bytes = new Uint8Array(n); bytes.fill(fill || 0); h.frame({ frameBuffer: bytes.buffer }); };
  const stopped = () => h.stop({ tempFilePath: 'wxfile://voice.pcm' });
  return { manager, wx, recorder, socket, h, socketHandlers, calls, sent, results, previews, errors, files, api, timers, tick,
    message, frame, stopped, async ready() { manager.start(); await settle(); message({}); } };
}

test('等待云端签名与服务鉴权后才录 PCM；分片按200ms节奏发送，尾包先于 end', async () => {
  const e = setup(); e.manager.start(); assert.equal(e.calls.length, 0); await settle();
  assert.equal(e.api[0].action, 'speech.session'); assert.deepEqual(e.api[0].payload, {});
  assert.equal(e.calls.filter(c => c[0] === 'record').length, 0);
  e.message({});
  const options = e.calls.find(c => c[0] === 'record')[1];
  assert.equal(options.format, 'PCM'); assert.equal(options.sampleRate, 16000); assert.equal(options.numberOfChannels, 1);
  e.frame(4096, 1); e.tick(200); assert.equal(e.sent.length, 0);
  e.frame(8704, 2); e.tick(200); assert.equal(e.sent[0].data.byteLength, 6400);
  const bytes = new Uint8Array(e.sent[0].data); assert.equal(bytes[4095], 1); assert.equal(bytes[4096], 2);
  e.manager.stop(); e.stopped(); e.tick(600);
  assert.equal(e.sent[1].data.byteLength, 6400); assert.ok(e.sent[1].at - e.sent[0].at >= 200);
  assert.equal(e.sent[2].data, '{"type":"end"}'); assert.deepEqual(e.files, ['wxfile://voice.pcm']);
  e.message({ result: { index: 0, slice_type: 2, voice_text_str: '去中央大街' } });
  assert.deepEqual(e.results, []); e.message({ final: 1 }); assert.deepEqual(e.results, ['去中央大街']);
  assert.equal(e.timers.size, 0); assert.equal(e.calls.filter(c => c[0] === 'close').length, 1);
});

test('同一句预览按索引替换，稳定片段不被迟到预览覆盖，多句只在 final 回填一次', async () => {
  const e = setup(); await e.ready();
  e.message({ result: { index: 0, slice_type: 1, voice_text_str: '去哈工' } });
  e.message({ result: { index: 0, slice_type: 1, voice_text_str: '去哈工大，' } });
  e.message({ result: { index: 0, slice_type: 2, voice_text_str: '去哈工大，' } });
  e.message({ result: { index: 0, slice_type: 1, voice_text_str: '错误旧文本' } });
  e.message({ result: { index: 1, slice_type: 2, voice_text_str: '五点前结束。' } });
  assert.equal(e.previews[e.previews.length - 1], '去哈工大，五点前结束。'); assert.deepEqual(e.results, []);
  e.frame(10000); e.manager.stop(); e.stopped(); e.tick(1000); e.message({ final: 1 }); e.message({ final: 1 });
  assert.deepEqual(e.results, ['去哈工大，五点前结束。']);
});

test('取消签名等待不连网；取消连接或录音后迟到消息不能回填、不自动重连或转调一句话接口', async () => {
  const early = setup(); early.manager.start(); early.manager.cancel(); await settle(); assert.equal(early.calls.length, 0);
  const e = setup(); await e.ready(); e.manager.cancel();
  e.message({ result: { index: 0, slice_type: 2, voice_text_str: '作废' } }); e.message({ final: 1 });
  e.stopped(); assert.deepEqual(e.results, ['']); assert.equal(e.api.length, 1); assert.equal(e.timers.size, 0);
  e.manager.start(); await settle(); e.message({}); e.manager.cancel(); e.stopped();
  assert.equal(e.calls.filter(c => c[0] === 'connect').length, 2);
});

test('启动迟到时取消不抢占旧录音；单例监听只注册一次且收到停止后可重新使用', async () => {
  const e = setup({ delayStart: true }); await e.ready(); const listener = e.h.frame;
  const second = createRealtimeSpeechManager(e.wx, async () => session);
  assert.equal(e.h.frame, listener); e.manager.cancel(); assert.throws(() => second.start(), /busy/);
  e.h.start(); assert.ok(e.calls.filter(c => c[0] === 'stop').length >= 2); e.stopped();
  e.manager.start(); e.manager.cancel(); await settle(); assert.equal(e.timers.size, 0);
});

test('断线、中断、发送失败、服务拒绝均关闭连接并丢弃预览，原始错误不回传', async () => {
  for (const mode of ['close', 'error', 'interrupt', 'send', 'auth']) {
    const e = setup({ sendFails: mode === 'send' }); await e.ready();
    e.message({ result: { index: 0, slice_type: 1, voice_text_str: '仅预览' } });
    if (mode === 'interrupt') e.h.interrupt();
    else if (mode === 'send') { e.frame(10000); e.tick(200); }
    else if (mode === 'auth') e.message({ code: 4002, message: 'sensitive upstream message' });
    else e.socketHandlers[mode]({ errMsg: 'sensitive signed url' });
    assert.equal(e.errors.length, 1); assert.doesNotMatch(e.errors[0], /sensitive/); assert.deepEqual(e.results, []);
    e.stopped(); assert.equal(e.timers.size, 0);
  }
});

test('没有音频分片、无最终结果、未稳定结果或缺句均失败，不拿预览顶替最终结果', async () => {
  const noFrames = setup(); await noFrames.ready(); noFrames.tick(5000);
  assert.match(noFrames.errors[0], /分片/); noFrames.stopped();
  for (const mode of ['timeout', 'unstable', 'gap', 'premature']) {
    const e = setup(); await e.ready();
    e.message({ result: { index: mode === 'gap' ? 1 : 0, slice_type: mode === 'unstable' ? 1 : 2, voice_text_str: '预览' } });
    if (mode === 'premature') e.message({ final: 1 });
    else { e.frame(10000); e.manager.stop(); e.stopped(); e.tick(1000);
      if (mode === 'timeout') e.tick(10000); else e.message({ final: 1 }); }
    assert.equal(e.errors.length, 1); assert.deepEqual(e.results, []);
  }
});

test('坏服务地址、缺配置、限频、超长文字和异常分片均提示而不泄露签名', async () => {
  for (const response of [{ ok: false, error: { code: 'ASR_NOT_CONFIGURED' } }, { ok: false, error: { code: 'RATE_LIMITED' } },
    { ok: true, data: { ...session.data, url: 'wss://untrusted.invalid/?signature=secret' } }]) {
    const e = setup({ response }); e.manager.start(); await settle(); assert.equal(e.errors.length, 1);
    assert.equal(e.calls.length, 0); assert.doesNotMatch(e.errors[0], /secret/);
  }
  const long = setup(); await long.ready(); long.message({ result: { index: 0, slice_type: 1, voice_text_str: '字'.repeat(1001) } });
  assert.equal(long.errors.length, 1); long.stopped();
  const invalid = setup(); await invalid.ready(); invalid.h.frame({ frameBuffer: null });
  assert.equal(invalid.errors.length, 1); invalid.stopped();
});

test('握手超时或连接中取消后，迟到的 socket open 仍会关闭且不能启动录音', async () => {
  for (const mode of ['cancel', 'timeout']) {
    const e = setup(); e.manager.start(); await settle();
    if (mode === 'cancel') e.manager.cancel(); else e.tick(15000);
    e.socketHandlers.open(); e.message({});
    assert.equal(e.calls.filter(c => c[0] === 'close').length, 2);
    assert.equal(e.calls.filter(c => c[0] === 'record').length, 0); assert.equal(e.timers.size, 0);
  }
});

test('自动限录60秒后仍发送尾音并等待最终结果，积压音频则停止而非突发补传', async () => {
  const e = setup(); await e.ready();
  for (let i = 0; i < 300; i++) { e.frame(6400); e.tick(200); }
  assert.ok(e.calls.some(c => c[0] === 'stop')); assert.equal(e.errors.length, 0);
  e.stopped(); e.tick(600); e.message({ result: { index: 0, slice_type: 2, voice_text_str: '完整录音' } }); e.message({ final: 1 });
  assert.deepEqual(e.results, ['完整录音']); assert.equal(e.sent.filter(s => s.data instanceof ArrayBuffer).length, 300);
  const over = setup(); await over.ready(); over.frame(96002);
  assert.match(over.errors[0], /积压/); assert.equal(over.sent.length, 0); over.stopped();
});

test('刚点击时连接/鉴权断开和录音中断开分开显示，保留数字状态但不泄露签名 URL', async () => {
  const secret = 'wss://asr.cloud.tencent.com/asr/v2/1234567890?secretid=private-id&signature=private-signature';
  for (const opened of [false, true]) {
    const e = setup(); e.manager.start(); await settle();
    if (opened) e.socketHandlers.open();
    e.socketHandlers.close({ code: 1006, reason: secret });
    assert.match(e.errors[0], opened ? /未通过服务鉴权/ : /尚未建立/);
    assert.match(e.errors[0], /1006/); assert.doesNotMatch(e.errors[0], /private|signature|1234567890/);
    assert.equal(e.calls.filter(c => c[0] === 'record').length, 0);
  }
  const http = connectionFailure({}, { errMsg: 'Unexpected response code: 403 ' + secret, errno: 600001 }, 'error');
  assert.equal(http.diagnostic.httpStatus, 403); assert.equal(http.diagnostic.errno, 600001);
  assert.match(http.message, /服务拒绝连接/); assert.match(http.message, /403/);
  assert.doesNotMatch(JSON.stringify(http), /private|signature|1234567890/);
  const domain = connectionFailure({}, { errMsg: 'url not in domain list: ' + secret }, 'connect');
  assert.equal(domain.diagnostic.category, 'domain'); assert.match(domain.message, /合法域名/);
  const tls = connectionFailure({}, { errMsg: 'SSL certificate failed ' + secret }, 'error');
  assert.equal(tls.diagnostic.category, 'tls'); assert.match(tls.message, /安全连接/);
});

test('服务鉴权错误缺少 voice_id 也展示服务码，成功消息仍不能混入其他会话', async () => {
  for (const id of [undefined, '']) {
    const e = setup(); e.manager.start(); await settle();
    e.message({ code: 4002, voice_id: id, message: 'secret upstream body' });
    assert.match(e.errors[0], /鉴权失败/); assert.match(e.errors[0], /4002/);
    assert.doesNotMatch(e.errors[0], /secret/); assert.equal(e.calls.filter(c => c[0] === 'record').length, 0);
  }
  const other = setup(); other.manager.start(); await settle(); other.message({ voice_id: 'other' });
  assert.equal(other.errors.length, 1); assert.equal(other.calls.filter(c => c[0] === 'record').length, 0);
});

test('直接使用官方 SDK：连接保留云端完整签名及官方请求头，不在客户端取时或签名', async () => {
  const e = setup();
  e.wx.request = () => { throw new Error('unexpected client server_time request'); };
  e.wx.arrayBufferToBase64 = () => { throw new Error('unexpected client signing'); };
  e.manager.start(); await settle();
  const config = e.calls.find(c => c[0] === 'connect')[1];
  assert.equal(config.url, session.data.url);
  assert.equal(config.header['X-TC-Version'], 'miniProgram-plugin-2.2.6');
  assert.equal(e.calls.filter(c => c[0] === 'record').length, 0);
  e.socketHandlers.open(); assert.equal(e.calls.filter(c => c[0] === 'record').length, 0);
  e.message({}); assert.equal(e.calls.filter(c => c[0] === 'record').length, 1);
  assert.deepEqual(e.errors, []); e.manager.cancel(); e.stopped();
});

test('SDK 解析前拦截坏 JSON、超长帧及错误会话，异常不会从 socket 回调逃逸', async () => {
  for (const data of ['{bad json', 'null', '[]', 'x'.repeat(100001),
    JSON.stringify({ code: 0, voice_id: 'another-session' })]) {
    const e = setup(); e.manager.start(); await settle();
    assert.doesNotThrow(() => e.socketHandlers.message({ data }));
    assert.equal(e.errors.length, 1); assert.deepEqual(e.results, []);
    assert.equal(e.calls.filter(c => c[0] === 'record').length, 0);
    assert.equal(e.timers.size, 0);
  }
});

test('SDK 异步启动的各阶段取消均不会迟到录音或回填', async () => {
  for (let steps = 0; steps <= 8; steps++) {
    const e = setup(); e.manager.start();
    for (let i = 0; i < steps; i++) await Promise.resolve();
    e.manager.cancel(); await settle();
    if (e.socketHandlers.message) {
      e.socketHandlers.open(); e.message({}); e.message({ final: 1 });
    }
    assert.equal(e.calls.filter(c => c[0] === 'record').length, 0);
    assert.deepEqual(e.results, ['']); assert.deepEqual(e.errors, []);
    assert.equal(e.timers.size, 0);
  }
});

test('SDK 因连接未就绪而不能 write 时立即失败，不静默丢音频并等待超时', async () => {
  const e = setup(); await e.ready(); e.socket.readyState = 0;
  e.frame(10000); e.tick(200);
  assert.equal(e.errors.length, 1); assert.match(e.errors[0], /发送失败/);
  assert.equal(e.sent.length, 0); assert.deepEqual(e.results, []);
  e.stopped(); assert.equal(e.timers.size, 0);
});

test('跨 JavaScript 环境的真实 ArrayBuffer 不误判，音频字节完整进入 SDK 并最终回填', async () => {
  const data = vm.runInNewContext('Uint8Array.from({ length: 12800 }, (_, i) => i % 251).buffer');
  assert.equal(data instanceof ArrayBuffer, false); // 真机桥接/独立上下文的复现，不靠同构假对象。
  const e = setup(); await e.ready();
  e.h.frame({ frameBuffer: data });
  assert.deepEqual(e.errors, []);
  e.manager.stop(); e.stopped(); e.tick(1000);
  const packets = e.sent.filter(p => p.data instanceof ArrayBuffer);
  assert.deepEqual(packets.map(p => p.data.byteLength), [6400, 6400]);
  assert.deepEqual(Buffer.concat(packets.map(p => Buffer.from(p.data))), Buffer.from(new Uint8Array(data)));
  e.message({ result: { index: 0, slice_type: 2, voice_text_str: '去中央大街' } }); e.message({ final: 1 });
  assert.deepEqual(e.results, ['去中央大街']); assert.equal(e.timers.size, 0);
});

test('二进制视图只读取有效区间，不混入底层缓冲区的前后字节', async () => {
  for (const make of [data => data.subarray(3, 12803), data => new DataView(data.buffer, 3, 12800),
    () => vm.runInNewContext('new Uint16Array(Uint8Array.from({length: 12804}, (_, i) => i % 251).buffer, 2, 6400)')]) {
    const data = Uint8Array.from({ length: 12806 }, (_, i) => i % 251), view = make(data);
    const expected = Buffer.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    const e = setup(); await e.ready(); e.h.frame({ frameBuffer: view });
    assert.deepEqual(e.errors, []); e.manager.stop(); e.stopped(); e.tick(1000);
    const actual = Buffer.concat(e.sent.filter(p => p.data instanceof ArrayBuffer).map(p => Buffer.from(p.data)));
    assert.deepEqual(actual, expected); assert.equal(actual.length, 12800);
    e.manager.cancel();
  }
});

test('PCM 采样跨回调边界时保留半个采样，拼接后按偶数字节发送且不补零丢字节', async () => {
  const expected = Uint8Array.from({ length: 12800 }, (_, i) => i % 251);
  const e = setup(); await e.ready();
  e.h.frame({ frameBuffer: expected.slice(0, 6401).buffer }); e.tick(200);
  assert.deepEqual(e.errors, []); assert.equal(e.sent[0].data.byteLength, 6400);
  e.h.frame({ frameBuffer: expected.slice(6401).buffer }); e.manager.stop(); e.stopped(); e.tick(1000);
  const packets = e.sent.filter(p => p.data instanceof ArrayBuffer);
  assert.ok(packets.every(p => p.data.byteLength % 2 === 0));
  assert.deepEqual(Buffer.concat(packets.map(p => Buffer.from(p.data))), Buffer.from(expected));
  assert.equal(e.sent[e.sent.length - 1].data, '{"type":"end"}');
  e.message({ result: { index: 0, slice_type: 2, voice_text_str: '少停十分钟' } }); e.message({ final: 1 });
  assert.deepEqual(e.results, ['少停十分钟']);
});

test('只在录音结束后拒绝不完整的 PCM 尾采样，不发坏尾包或拿预览冒充成功', async () => {
  const e = setup(); await e.ready(); e.frame(12801); assert.deepEqual(e.errors, []);
  e.message({ result: { index: 0, slice_type: 1, voice_text_str: '不能回填' } });
  e.manager.stop(); e.stopped(); e.tick(1000);
  assert.equal(e.errors.length, 1); assert.match(e.errors[0], /末尾.*不完整/);
  assert.ok(e.sent.every(p => p.data instanceof ArrayBuffer && p.data.byteLength % 2 === 0));
  assert.deepEqual(e.results, []); assert.equal(e.timers.size, 0);
});

test('空二进制分片可忽略，缺失、字符串、普通数组及伪造缓冲区仍拒绝且不暴露内容', async () => {
  for (const value of [undefined, null, 'private-audio', [1, 2], { byteLength: 12800 },
    { [Symbol.toStringTag]: 'ArrayBuffer', byteLength: 12800 }]) {
    const e = setup(); await e.ready();
    assert.doesNotThrow(() => e.h.frame({ frameBuffer: value }));
    assert.equal(e.errors.length, 1); assert.doesNotMatch(e.errors[0], /private-audio|升级微信/);
    assert.deepEqual(e.sent, []); assert.deepEqual(e.results, []); e.stopped(); assert.equal(e.timers.size, 0);
  }
  const e = setup(); await e.ready(); e.frame(0); e.h.frame({ frameBuffer: new Uint8Array(0) });
  assert.deepEqual(e.errors, []); e.tick(5000); assert.match(e.errors[0], /分片/); e.stopped();
});

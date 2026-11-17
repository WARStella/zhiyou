'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { parseAudio } = require('../cloudfunctions/api/lib/media/doubao-tts');
function mockTransport(events, written = []) {
  const module = { exports: {} };
  const https = { request(_, callback) {
    const req = new EventEmitter(); req.write = data => written.push(data); req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = 200; res.headers = {};
      callback(res);
      events(res);
    });
    return req;
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/api/lib/http.js'), 'utf8'), {
    module, require: id => id === 'https' ? https : require(id), Buffer, URL,
  });
  return module.exports.defaultTransport;
}

test('TTS HTTP任意网络分片重组后解析，包括JSON与中文跨字节分片', async () => {
  const bytes = Buffer.from('{"code":0,"data":"YQ==","sentence":{"text":"出发"}}\n{"code":20000000,"data":null}\n');
  const transport = mockTransport(res => {
    for (let i = 0; i < bytes.length; i++) res.emit('data', bytes.subarray(i, i + 1));
    res.emit('end');
  });
  const response = await transport('https://example.com', { binary: true, maxBytes: 1000 });
  assert.deepEqual(parseAudio(response.buffer), { audioBase64: 'YQ==', format: 'mp3' });
});

test('TTS HTTP响应中断或超过体积上限时拒绝，不返回局部音频', async () => {
  for (const kind of ['aborted', 'error', 'oversized']) {
    const transport = mockTransport(res => {
      res.emit('data', Buffer.from('partial'));
      if (kind === 'oversized') res.emit('data', Buffer.alloc(100));
      else res.emit(kind, kind === 'error' ? new Error('private') : undefined);
      res.emit('end');
    });
    await assert.rejects(transport('https://example.com', { binary: true, maxBytes: 50 }), e => !e.message.includes('private'));
  }
});

test('ASR multipart二进制请求保持字节不变，并保留豆包状态码响应头', async () => {
  const sent = [], bytes = Buffer.from([0, 255, 128, 65]);
  const transport = mockTransport(res => {
    res.headers['x-api-status-code'] = '20000000';
    res.emit('data', Buffer.from('{"result":{"text":"行程"}}')); res.emit('end');
  }, sent);
  const result = await transport('https://example.com', { method: 'POST', body: bytes });
  assert.ok(Buffer.isBuffer(sent[0])); assert.deepEqual(sent[0], bytes);
  assert.equal(result.headers['x-api-status-code'], '20000000');
});

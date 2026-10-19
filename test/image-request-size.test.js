'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readImageForRequest } = require('../miniprogram/utils/request-image');
const { createGuideAssistant } = require('../miniprogram/utils/guide-assistant');
const { createPhotoMeeting } = require('../miniprogram/utils/photo-meeting');
const { IMAGE_REQUEST_BUDGET_BYTES, utf8Bytes, cloudRequestBytes, imageRequestBytes } = require('../miniprogram/utils/cloud-request-size');

function imageWx(sizes, extra = {}) {
  const compressed = [], reads = [], removed = [];
  const paths = new Map();
  const wx = {
    chooseMedia: args => args.success({ tempFiles: [{ tempFilePath: '/original.jpg' }] }),
    getImageInfo: args => args.success({ width: 1200, height: 3000 }),
    compressImage(args) {
      const index = compressed.length;
      const path = '/compressed-' + index + '.jpg';
      compressed.push(args); paths.set(path, sizes[Math.min(index, sizes.length - 1)]);
      args.success({ tempFilePath: path });
    },
    getFileSystemManager: () => ({
      stat: args => args.success({ stats: { size: paths.get(args.path) } }),
      readFile: args => { reads.push(args.filePath); args.success({ data: Buffer.alloc(paths.get(args.filePath), 10).toString('base64') }); },
      unlink: args => { removed.push(args.filePath); args.success(); },
    }), ...extra,
  };
  return { wx, compressed, reads, removed };
}

test('请求体按 UTF-8 JSON 字节计数，中文、emoji、转义与真实发送封装一致', () => {
  for (const value of ['', 'ASCII', '哈尔滨😀', '换行\n引号"', '\ud800']) {
    const json = JSON.stringify({ value });
    assert.equal(utf8Bytes(json), Buffer.byteLength(json, 'utf8'));
  }
  const data = { action: 'guide.ask', requestId: 'request', payload: { text: '这是什么地方？😀', imageBase64: 'AAAA' }, expectedVersion: 3 };
  assert.equal(imageRequestBytes(data.action, data.payload, { requestId: data.requestId, expectedVersion: 3 }),
    Buffer.byteLength(JSON.stringify({ name: 'api', data }), 'utf8'));
});

test('原文件不足1MB但Base64请求超限时继续压缩，保持长图比例且不放大小图', async () => {
  const e = imageWx([900 * 1024, 300 * 1024]);
  const payload = { text: '识别这个地点', crewId: 'crew', center: { latitude: 45.7, longitude: 126.6 } };
  const imageBase64 = await readImageForRequest(e.wx, '/original.jpg', { action: 'guide.ask', payload });
  assert.equal(e.compressed.length, 2);
  assert.deepEqual(e.reads, ['/compressed-1.jpg'], '超限大图不读入内存');
  assert.deepEqual(e.compressed.map(c => [c.compressedWidth, c.compressedHeight]), [[640, 1600], [560, 1400]]);
  assert.ok(e.compressed[1].quality < e.compressed[0].quality);
  assert.ok(e.compressed.every(c => c.src === '/original.jpg'));
  assert.ok(imageRequestBytes('guide.ask', { ...payload, imageBase64 }) <= IMAGE_REQUEST_BUDGET_BYTES);
  assert.deepEqual(e.removed, ['/compressed-0.jpg', '/compressed-1.jpg']);
  assert.ok(!e.removed.includes('/original.jpg'));

  const small = imageWx([100], { getImageInfo: args => args.success({ width: 320, height: 200 }) });
  await readImageForRequest(small.wx, '/original.jpg');
  assert.equal(small.compressed[0].compressedWidth, 320);
  assert.equal(small.compressed[0].compressedHeight, 200);
});

test('问题与版本等字段占用同一预算，文件stat偏小时仍会复核实际Base64长度', async () => {
  const e = imageWx([350 * 1024, 280 * 1024]);
  const payload = { text: '文'.repeat(30000) };
  const imageBase64 = await readImageForRequest(e.wx, '/original.jpg', { action: 'guide.ask', payload, requestOptions: { expectedVersion: 6 } });
  assert.equal(e.compressed.length, 2);
  assert.ok(imageRequestBytes('guide.ask', { ...payload, imageBase64 }, { expectedVersion: 6 }) <= IMAGE_REQUEST_BUDGET_BYTES);

  const unreliable = imageWx([100]);
  let reads = 0;
  const fs = unreliable.wx.getFileSystemManager();
  unreliable.wx.getFileSystemManager = () => ({ ...fs, readFile: args => args.success({ data: 'A'.repeat(++reads === 1 ? IMAGE_REQUEST_BUDGET_BYTES : 100) }) });
  const actual = await readImageForRequest(unreliable.wx, '/original.jpg');
  assert.equal(unreliable.compressed.length, 2);
  assert.equal(actual.length, 100);
});

test('所有压缩尝试仍超限时有限停止，删除所有副本；中途取消同样不发送与不删原图', async () => {
  const e = imageWx([2 * 1024 * 1024]);
  await assert.rejects(readImageForRequest(e.wx, '/original.jpg'), /发送大小限制.*裁剪/);
  assert.ok(e.compressed.length > 1 && e.compressed.length < 10);
  assert.equal(e.reads.length, 0);
  assert.equal(e.removed.length, e.compressed.length);
  let current = true;
  const canceled = imageWx([100]);
  const compress = canceled.wx.compressImage;
  canceled.wx.compressImage = args => { current = false; compress(args); };
  await assert.rejects(readImageForRequest(canceled.wx, '/original.jpg', { current: () => current }), /取消/);
  assert.equal(canceled.reads.length, 0);
  assert.deepEqual(canceled.removed, ['/compressed-0.jpg']);
});

test('游览助手识图、YOLO计数和照片选集合点均发送压缩后的安全请求', async () => {
  for (const action of ['guide.ask', 'guide.countPeople', 'ocr.recognize']) {
    const e = imageWx([900 * 1024, 300 * 1024]);
    const state = {}, calls = [];
    const options = { wx: e.wx, getCrewId: () => 'crew', onState: patch => Object.assign(state, patch),
      callApi: async (name, payload, config) => {
        calls.push(name);
        assert.ok(imageRequestBytes(name, payload, config) <= IMAGE_REQUEST_BUDGET_BYTES);
        return { ok: true, data: { sessionId: 'session', version: 1, candidates: [], lines: [], boxes: [] } };
      } };
    const controller = action === 'ocr.recognize' ? createPhotoMeeting(options) : createGuideAssistant(options);
    await controller.choose();
    if (action === 'guide.ask') { controller.setText('哈西服装城'); await controller.ask(); }
    else if (action === 'guide.countPeople') await controller.countPeople();
    else await controller.recognize();
    assert.deepEqual(calls, [action]);
    assert.equal(state.busy, false);
    assert.equal(state.error, '');
    assert.equal(e.compressed.length, 2);
    controller.dispose();
  }
});

test('压不下来的图片不调用后端，并保留问题及照片供用户裁剪重试', async () => {
  const e = imageWx([900 * 1024]);
  const state = {}, calls = [];
  const controller = createGuideAssistant({ wx: e.wx, getCrewId: () => null,
    onState: patch => Object.assign(state, patch), callApi: async action => { calls.push(action); } });
  await controller.choose(); controller.setText('请识别这张照片'); await controller.ask();
  assert.equal(calls.length, 0);
  assert.equal(state.text, '请识别这张照片');
  assert.equal(state.imagePath, '/original.jpg');
  assert.equal(state.busy, false);
  assert.match(state.error, /发送大小限制/);
  controller.dispose();
});

test('统一发送入口拦截最终超限请求，SDK仍报大小限制时转成可操作提示且不重试', async () => {
  const apiPath = require.resolve('../miniprogram/utils/api');
  const previousModule = require.cache[apiPath], previousWx = global.wx;
  delete require.cache[apiPath];
  const api = require(apiPath);
  let calls = 0, transmitted;
  global.wx = { cloud: { callFunction: async args => { calls++; transmitted = args; return { result: { ok: true } }; } } };
  try {
    const tooLarge = await api.callApi('guide.ask', { imageBase64: 'A'.repeat(IMAGE_REQUEST_BUDGET_BYTES) });
    assert.equal(tooLarge.error.code, 'REQUEST_TOO_LARGE');
    assert.equal(calls, 0);
    const payload = { imageBase64: 'A'.repeat(100), text: '中文😀' };
    const sent = await api.callApi('guide.ask', payload, { requestId: 'fixed', expectedVersion: 3 });
    assert.equal(sent.ok, true);
    assert.equal(cloudRequestBytes(transmitted.data), Buffer.byteLength(JSON.stringify(transmitted), 'utf8'));
    global.wx.cloud.callFunction = async () => { calls++; throw new Error('cloud.callFunction:fail Error: data exceed max size (retry, retry, abort)'); };
    const failed = await api.callApi('guide.ask', payload);
    assert.equal(calls, 2);
    assert.equal(failed.error.code, 'REQUEST_TOO_LARGE');
    assert.match(failed.error.message, /裁剪/);
    assert.ok(!failed.error.message.includes('cloud.callFunction'));
    assert.ok(!JSON.stringify(failed).includes(payload.imageBase64));
  } finally {
    global.wx = previousWx;
    if (previousModule) require.cache[apiPath] = previousModule;
    else delete require.cache[apiPath];
  }
});

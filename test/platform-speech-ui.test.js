'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpeechInput } = require('../miniprogram/utils/speech-input');
for (const asr of ['zhipu-asr', 'doubao-asr']) {
  test(asr + '设置控制实际录音及请求，识别后仅回填草稿并清理录音', async () => {
    const handlers = {}, received = [], results = [], deleted = [];
    let selected = asr, recorded;
    const native = { onStart: cb => { handlers.start = cb; }, onStop: cb => { handlers.stop = cb; }, onError: cb => { handlers.error = cb; },
      start: opts => { recorded = opts; }, stop() {} };
    const wx = { getStorageSync: () => ({ asr: selected }), getSetting: o => o.success({ authSetting: { 'scope.record': true } }),
      getRecorderManager: () => native, getFileSystemManager: () => ({ readFile: o => o.success({ data: 'SUQzAA==' }), unlink: o => deleted.push(o.filePath) }) };
    const input = createSpeechInput({ wx, onResult: text => results.push(text), callApi: async (action, payload) => {
      received.push({ action, payload }); return { ok: true, data: { text: '帮我修改行程' } };
    } });
    assert.equal(input.start(), true); assert.equal(recorded.format, 'mp3');
    assert.equal(recorded.duration, asr === 'zhipu-asr' ? 30000 : 60000);
    handlers.start(); selected = 'tencent-asr'; // Changing preferences cannot reroute the in-flight recording.
    input.stop(); handlers.stop({ tempFilePath: 'wxfile://sample.mp3', duration: 1500, fileSize: 4 });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(received.length, 1); assert.equal(received[0].action, 'speech.recognize');
    assert.equal(received[0].payload.optionId, asr); assert.deepEqual(results, ['帮我修改行程']);
    assert.deepEqual(deleted, ['wxfile://sample.mp3']); input.dispose();
  });
}

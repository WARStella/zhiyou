'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlatformSpeech } = require('../cloudfunctions/api/lib/speech/platforms');
const { makeWorld, C } = require('./helpers');
const audio = Buffer.from('ID3\0\xff\x80\0test-audio');
const env = { ZHIPU_API_KEY: 'zhipu-test', DOUBAO_ASR_API_KEY: 'speech-test', ARK_API_KEY: 'ark-test' };
for (const optionId of ['zhipu-asr', 'doubao-asr']) {
  test(optionId + '发送本次录音并解析对应协议，不携带用户身份或其他Key', async () => {
    const provider = createPlatformSpeech({ env, optionId, http: async (url, o) => {
      if (optionId === 'zhipu-asr') {
        assert.equal(url, 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions');
        assert.equal(o.headers.Authorization, 'Bearer zhipu-test'); assert.ok(Buffer.isBuffer(o.body));
        assert.ok(o.body.includes(audio)); assert.match(o.headers['Content-Type'], /^multipart\/form-data; boundary=/);
        assert.match(o.body.toString('utf8'), /glm-asr-2512/);
        return { json: { text: ' 修改行程 ' } };
      }
      assert.match(url, /\/auc\/bigmodel\/recognize\/flash$/); assert.equal(o.headers['X-Api-Key'], 'speech-test');
      assert.equal(o.headers['X-Api-Resource-Id'], 'volc.bigasr.auc_turbo'); assert.equal(o.headers['X-Api-Sequence'], '-1');
      const body = JSON.parse(o.body); assert.equal(body.audio.data, audio.toString('base64')); assert.equal(body.audio.url, undefined);
      return { json: { result: { text: ' 修改行程 ' } }, headers: { 'x-api-status-code': '20000000' } };
    } });
    assert.deepEqual(await provider.recognize(audio), { text: '修改行程', provider: optionId });
  });

  test(optionId + '鉴权失败、异常结果和网络失败不泄露原始正文，不自动重试', async () => {
    let calls = 0;
    for (const response of [{ json: { error: { message: 'PRIVATE' } } }, { json: { result: { text: 'bad' } }, headers: { 'x-api-status-code': '55000000' } }, { json: {} }, null]) {
      const service = createPlatformSpeech({ env, optionId, http: async () => { calls++; if (!response) throw new Error('PRIVATE'); return response; } });
      await assert.rejects(service.recognize(audio), e => e.code === 'UPSTREAM_SPEECH_FAILED' && !e.message.includes('PRIVATE'));
    }
    assert.equal(calls, 4);
    const missing = createPlatformSpeech({ env: { ARK_API_KEY: 'unrelated' }, optionId, http: () => assert.fail('不得请求') });
    await assert.rejects(missing.recognize(audio), { code: 'ASR_NOT_CONFIGURED' });
  });
}

test('ASR动作按选项路由，智谱超过30秒及非法选项在上游前拦截，不持久化原音频', async () => {
  let calls = 0;
  const w = await makeWorld({ createSpeechProvider: ({ optionId }) => ({ recognize: async () => { calls++; return { text: '修改行程', provider: optionId }; } }) });
  const p = { optionId: 'zhipu-asr', format: 'mp3', durationMs: 30000, audioBase64: audio.toString('base64') };
  const ok = await w.A('speech.recognize', p); assert.equal(ok.ok, true); assert.equal(ok.data.provider, 'zhipu-asr');
  assert.equal((await w.A('speech.recognize', { ...p, durationMs: 30001 })).error.code, 'INVALID_PARAM');
  assert.equal((await w.A('speech.recognize', { ...p, optionId: 'https://evil' })).error.code, 'INVALID_PARAM');
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(await w.repo.find(C.EVENTS)).includes(p.audioBase64));
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, expectOk, expectFail, C } = require('./helpers');
const { invoke } = require('../cloudfunctions/api/lib/invoke');
const { createSpeechProvider, signedHeaders, MAX_AUDIO_BYTES } = require('../cloudfunctions/api/lib/speech/tencent');
const { dependencyStatus } = require('../cloudfunctions/api/lib/config-health');
const audio = Buffer.from('ID3\x04\x00\x00\x00unit-test-audio');
const payload = { format: 'mp3', durationMs: 1500, audioBase64: audio.toString('base64') };
const env = { ASR_SECRET_ID: 'unit-id', ASR_SECRET_KEY: 'unit-key', ASR_APP_ID: '1234567890' };

test('真实 action 调用签名 ASR 协议，音频与未提交转写不持久化；鉴权与注入均生效', async () => {
  let sent, count = 0;
  const w = await makeWorld({ createSpeechProvider: () => createSpeechProvider({ env, http: async (url, opts) => {
    sent = { url, opts }; count++;
    return { json: { Response: { Result: '不去最后一站了，改去哈工大', RequestId: 'upstream-test' } } } } }) });
  const result = expectOk(await w.A('speech.recognize', payload));
  assert.equal(result.text, '不去最后一站了，改去哈工大'); assert.equal(result.provider, 'tencent-asr');
  assert.equal(count, 1); assert.equal(sent.url, 'https://asr.tencentcloudapi.com/');
  const body = JSON.parse(sent.opts.body);
  assert.equal(body.Data, payload.audioBase64); assert.equal(body.DataLen, audio.length);
  assert.equal(body.SourceType, 1); assert.equal(body.EngSerViceType, '16k_zh'); assert.equal(body.VoiceFormat, 'mp3');
  assert.equal(sent.opts.headers['X-TC-Action'], 'SentenceRecognition');
  assert.match(sent.opts.headers.Authorization, /^TC3-HMAC-SHA256 Credential=unit-id\/2026-10-20\/asr\/tc3_request,/);
  assert.doesNotMatch(sent.opts.body, /openid_A/);
  const stored = JSON.stringify({ events: await w.repo.find(C.EVENTS), operations: await w.repo.find(C.OPERATIONS) });
  for (const secret of [payload.audioBase64, result.text, 'unit-key']) assert.ok(!stored.includes(secret));
  assert.equal(await w.repo.count(C.OPERATIONS, { action: 'speech.recognize' }), 0);
  const missing = await invoke({ action: 'speech.recognize', payload }, { repo: w.repo, openid: null });
  expectFail(missing, 'AUTH_REQUIRED'); assert.equal(count, 1);
});

test('坏音频、伪造 URL 和格式、过长时长及过大体积均不发上游请求', async () => {
  const w = await makeWorld({ createSpeechProvider: () => { assert.fail('坏请求不能初始化上游'); } });
  for (const change of [{ audioBase64: '' }, { audioBase64: 'not base64' }, { audioBase64: 'YWJj=' },
    { audioBase64: Buffer.from('not-mp3').toString('base64') }, { format: 'wav' }, { durationMs: 60001 },
    { durationMs: 100 }, { audioBase64: Buffer.alloc(MAX_AUDIO_BYTES + 1).toString('base64') },
    { audioBase64: undefined, url: 'https://untrusted.invalid/audio.mp3' }]) {
    expectFail(await w.A('speech.recognize', { ...payload, ...change }), 'INVALID_PARAM');
  }
});

test('缺凭据、鉴权/额度失败、网络错误和非法响应不会回传上游正文或密钥', async () => {
  const missing = createSpeechProvider({ env: {}, http: () => assert.fail('缺配置不能发请求') });
  await assert.rejects(missing.recognize(audio), e => e.code === 'ASR_NOT_CONFIGURED');
  for (const response of [null, { Response: {} }, { Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: 'unit-key ' + payload.audioBase64 } } },
    { Response: { Error: { Code: 'ResourceUnavailable', Message: '敏感正文' } } }]) {
    const provider = createSpeechProvider({ env, http: async () => ({ json: response }) });
    await assert.rejects(provider.recognize(audio), e => {
      assert.equal(e.code, 'UPSTREAM_SPEECH_FAILED'); assert.doesNotMatch(JSON.stringify(e), /unit-key|敏感正文/);
      return true;
    });
  }
  const network = createSpeechProvider({ env, http: async () => { throw new Error('unit-key ' + payload.audioBase64); } });
  await assert.rejects(network.recognize(audio), e => e.code === 'UPSTREAM_SPEECH_FAILED' && !e.message.includes('unit-key'));
});

test('签名绑定音频与 UTC 日期，临时凭据可带 Token；健康检查不曝光任何值', () => {
  const credentials = { secretId: 'unit-id', secretKey: 'unit-key', token: 'unit-token' };
  const a = signedHeaders('one', credentials, Date.parse('2026-10-15T23:59:59Z') / 1000);
  const b = signedHeaders('two', credentials, Date.parse('2026-10-15T23:59:59Z') / 1000);
  const c = signedHeaders('one', credentials, Date.parse('2026-10-16T00:00:00Z') / 1000);
  assert.notEqual(a.Authorization, b.Authorization); assert.match(c.Authorization, /2026-10-16\/asr/);
  assert.equal(a['X-TC-Token'], 'unit-token'); assert.ok(!a.Authorization.includes('unit-key'));
  assert.equal(dependencyStatus({}).speechService.configured, false);
  const health = dependencyStatus(env).speechService;
  assert.equal(health.configured, true); assert.equal(health.connectivity, 'not_probed');
  assert.doesNotMatch(JSON.stringify(health), /unit-id|unit-key/);
});

test('语音基础限频按用户和最近时间计算，不限制其他用户或把历史记录算进窗口', async () => {
  let calls = 0;
  const w = await makeWorld({ createSpeechProvider: () => ({ recognize: async () => { calls++; return { text: '测试', provider: 'test' }; } }) });
  for (let i = 0; i < 10; i++) await w.repo.insert(C.EVENTS, { action: 'speech.recognize', type: 'api_call',
    userId: 'openid_A', ts: w.NOW });
  expectFail(await w.A('speech.recognize', payload), 'RATE_LIMITED'); assert.equal(calls, 0);
  expectOk(await w.B('speech.recognize', payload)); assert.equal(calls, 1);
  expectOk(await w.A('speech.recognize', payload, { now: w.plusMin(2) })); assert.equal(calls, 2);
});

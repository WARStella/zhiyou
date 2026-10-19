'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { makeWorld, expectOk, expectFail, C } = require('./helpers');
const { invoke } = require('../cloudfunctions/api/lib/invoke');
const { createSpeechProvider } = require('../cloudfunctions/api/lib/speech/tencent');
const { createRealtimeSession } = require('../cloudfunctions/api/lib/speech/realtime');
const { dependencyStatus } = require('../cloudfunctions/api/lib/config-health');
const env = { ASR_APP_ID: '1234567890', ASR_SECRET_ID: 'test-id', ASR_SECRET_KEY: 'test-key' };

test('实时签名 action 绑定服务端账号、固定域名和模型，HMAC-SHA1 与官方协议一致', async () => {
  const w = await makeWorld({ createSpeechProvider: () => createSpeechProvider({ env }) });
  const data = expectOk(await w.A('speech.session', { model: 'evil', expired: 99999999999, appid: 'wx-client', url: 'https://evil.invalid' }));
  const url = new URL(data.url), p = url.searchParams;
  assert.equal(url.protocol, 'wss:'); assert.equal(url.host, 'asr.cloud.tencent.com');
  assert.equal(url.pathname, '/asr/v2/1234567890'); assert.equal(p.get('secretid'), 'test-id');
  assert.equal(p.get('engine_model_type'), '16k_zh'); assert.equal(p.get('voice_format'), '1');
  assert.equal(p.get('needvad'), '1'); assert.equal(+p.get('expired') - +p.get('timestamp'), 90);
  assert.equal(+p.get('timestamp'), w.NOW.getTime() / 1000);
  assert.match(data.voiceId, /^[a-f0-9]{32}$/); assert.equal(p.get('voice_id'), data.voiceId);
  assert.equal(data.maxDurationMs, 60000); assert.ok(!data.url.includes('test-key'));
  const canonical = 'asr.cloud.tencent.com/asr/v2/1234567890?' +
    ['engine_model_type', 'expired', 'filter_dirty', 'filter_modal', 'filter_punc', 'needvad', 'nonce', 'secretid', 'timestamp', 'voice_format', 'voice_id']
      .map(k => k + '=' + p.get(k)).join('&');
  const expected = crypto.createHmac('sha1', 'test-key').update(canonical).digest('base64');
  assert.equal(p.get('signature'), expected); assert.equal(data.expiresAt, +p.get('expired'));
});

test('签名 URL 不写业务日志或幂等缓存，同一 requestId 重发也产生不同 voice_id；缺身份被拒', async () => {
  const w = await makeWorld({ createSpeechProvider: () => createSpeechProvider({ env }) });
  const first = expectOk(await w.A('speech.session', {}, { requestId: 'same' }));
  const second = expectOk(await w.A('speech.session', {}, { requestId: 'same' }));
  assert.notEqual(first.voiceId, second.voiceId); assert.equal(await w.repo.count(C.OPERATIONS, { action: 'speech.session' }), 0);
  const stored = JSON.stringify(await w.repo.find(C.EVENTS));
  for (const secret of [first.url, first.voiceId, 'test-key', 'test-id', 'signature=']) assert.ok(!stored.includes(secret));
  const result = await invoke({ action: 'speech.session', payload: {} }, { repo: w.repo, openid: null });
  expectFail(result, 'AUTH_REQUIRED');
});

test('配置缺失、微信 AppID、异常模型或临时密钥未适配均明确拒绝；健康检查仅配置检查且脱敏', () => {
  for (const bad of [{}, { ...env, ASR_APP_ID: '' }, { ...env, ASR_APP_ID: 'wx123456' },
    { ...env, ASR_SECRET_KEY: '' }, { ...env, ASR_ENGINE_MODEL: 'unknown' }, { ...env, ASR_SESSION_TOKEN: 'temp' }]) {
    assert.throws(() => createRealtimeSession(bad), e => e.code === 'ASR_NOT_CONFIGURED');
    assert.equal(dependencyStatus(bad).speechService.configured, false);
  }
  const health = dependencyStatus(env).speechService;
  assert.equal(health.configured, true); assert.equal(health.provider, 'tencent-asr-realtime');
  assert.equal(health.connectivity, 'not_probed'); assert.doesNotMatch(JSON.stringify(health), /test-key|test-id|1234567890/);
  for (const model of ['16k_zh_en', 'Hy-ASR-3.0-preview']) {
    const data = createRealtimeSession({ ...env, ASR_ENGINE_MODEL: model });
    assert.equal(data.model, model); assert.equal(new URL(data.url).searchParams.get('engine_model_type'), model);
  }
});

test('实时签名基础限频隔离用户和时间，不发上游请求；超限不产生凭据', async () => {
  let calls = 0;
  const w = await makeWorld({ createSpeechProvider: () => ({ createSession() { calls++; return createRealtimeSession(env); } }) });
  for (let i = 0; i < 10; i++) await w.repo.insert(C.EVENTS, { action: 'speech.session', type: 'api_call', userId: 'openid_A', ts: w.NOW });
  expectFail(await w.A('speech.session'), 'RATE_LIMITED'); assert.equal(calls, 0);
  expectOk(await w.B('speech.session')); assert.equal(calls, 1);
  expectOk(await w.A('speech.session', {}, { now: w.plusMin(2) })); assert.equal(calls, 2);
});

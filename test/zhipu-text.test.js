'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGuideProvider } = require('../cloudfunctions/api/lib/guide/provider');
const { catalog } = require('../cloudfunctions/api/lib/media/catalog');

test('4.7flash使用智谱固定模型、独立Key和Chat Completions，不调用其他平台', async () => {
  const env = { ZHIPU_API_KEY: 'test-zhipu-only', ARK_API_KEY: 'test-ark-only' };
  const row = catalog(env).find(r => r.id === 'zhipu-text');
  assert.equal(row.label, '4.7flash'); assert.equal(row.model, 'glm-4.7-flash');
  assert.equal(row.configured, true); assert.ok(!JSON.stringify(catalog(env)).includes('test-zhipu-only'));
  const provider = createGuideProvider({ env, textProvider: 'zhipu-text', http: async (url, o) => {
    assert.equal(url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
    assert.equal(o.headers.Authorization, 'Bearer test-zhipu-only');
    const body = JSON.parse(o.body);
    assert.equal(body.model, 'glm-4.7-flash'); assert.equal(body.thinking.type, 'disabled');
    assert.equal(body.max_tokens, 1024); assert.equal(body.response_format.type, 'json_object');
    assert.equal(body.messages[0].role, 'system'); assert.equal(body.messages[1].role, 'user');
    return { json: { choices: [{ finish_reason: 'stop', message: { content: '{"tool":"finish"}' } }] } };
  } });
  assert.deepEqual(await provider.decide({}), { ok: true, data: { tool: 'finish' } });
});

test('4.7flash未配置不回退其他密钥，截断和异常JSON不作为有效结果', async () => {
  assert.throws(() => createGuideProvider({ env: { ARK_API_KEY: 'other' }, textProvider: 'zhipu-text' }), { code: 'MEDIA_NOT_CONFIGURED' });
  assert.equal(catalog({ ZHIPU_API_KEY: ' ' }).find(r => r.id === 'zhipu-text').configured, false);
  for (const choice of [ { finish_reason: 'length', message: { content: '{"tool":"finish"}' } }, { finish_reason: 'stop', message: { content: 'invalid' } } ]) {
    const service = createGuideProvider({ env: { ZHIPU_API_KEY: 'test' }, textProvider: 'zhipu-text', http: async () => ({ json: { choices: [choice] } }) });
    assert.equal((await service.decide({})).ok, false);
  }
});

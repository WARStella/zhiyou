'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGuideProvider } = require('../cloudfunctions/api/lib/guide/provider');
const { catalog } = require('../cloudfunctions/api/lib/media/catalog');
const env = { ARK_API_KEY: 'test-ark-only', DEEPSEEK_API_KEY: 'test-deepseek-only' };
const completed = text => ({ status: 'completed', output: [
  { type: 'reasoning', content: [{ type: 'output_text', text: 'ignore reasoning' }] },
  { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] },
] });

test('豆包文字使用独立Ark凭据与Responses协议，工具及排序结果可解析', async () => {
  let calls = 0;
  const service = createGuideProvider({ env, textProvider: 'doubao-text', http: async (url, options) => {
    calls++;
    assert.equal(url, 'https://ark.cn-beijing.volces.com/api/v3/responses');
    assert.equal(options.headers.Authorization, 'Bearer test-ark-only');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'doubao-seed-2-0-mini-260428');
    assert.equal(body.store, false);
    assert.equal(body.thinking.type, 'disabled');
    assert.equal(body.messages, undefined);
    assert.ok(body.instructions);
    assert.equal(body.input[0].content[0].type, 'input_text');
    assert.deepEqual(JSON.parse(body.input[0].content[0].text), { question: '安排' });
    return { json: completed('{"tool":"finish"}') };
  } });
  assert.equal(service.provider, 'doubao-text');
  assert.deepEqual(await service.decide({ question: '安排' }), { ok: true, data: { tool: 'finish' } });
  assert.equal((await service.rankMerchants({ question: '安排' })).ok, true);
  assert.equal((await service.selectEvidence({ question: '安排' })).ok, true);
  assert.equal(calls, 3);
});

test('豆包缺少专用凭据拒绝调用，目录不返回密钥，模型可云端覆盖', () => {
  assert.throws(() => createGuideProvider({ env: { DEEPSEEK_API_KEY: 'unrelated' }, textProvider: 'doubao-text' }), { code: 'MEDIA_NOT_CONFIGURED' });
  assert.equal(catalog({ ARK_API_KEY: ' ' }).find(r => r.id === 'doubao-text').configured, false);
  const rows = catalog({ ...env, ARK_TEXT_MODEL: 'custom-ark-model' });
  assert.equal(rows.find(r => r.id === 'doubao-text').model, 'custom-ark-model');
  assert.ok(!JSON.stringify(rows).includes('test-ark-only'));
});

test('豆包拒绝截断、失败、拒答与异常JSON，不回传上游敏感正文，不自动重试', async () => {
  const bad = [
    { ...completed('{"tool":"finish"}'), status: 'incomplete' },
    { ...completed('{"tool":"finish"}'), error: { message: 'PRIVATE' } },
    completed('not json PRIVATE'), completed('[]'), completed(''),
    { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'PRIVATE' }] }] },
  ];
  for (const result of bad) {
    const service = createGuideProvider({ env, textProvider: 'doubao-text', http: async () => ({ json: result }) });
    const response = await service.decide({});
    assert.equal(response.ok, false);
    assert.ok(!JSON.stringify(response).includes('PRIVATE'));
  }
  let calls = 0;
  const service = createGuideProvider({ env, textProvider: 'doubao-text', http: async () => { calls++; throw new Error('PRIVATE'); } });
  assert.deepEqual(await service.decide({}), { ok: false, reason: 'unavailable' });
  assert.equal(calls, 1);
});

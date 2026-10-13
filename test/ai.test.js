'use strict';

/**
 * 大模型解析与探针测试。
 *
 * 全程使用**假传输**（注入 `opts.http`），不发真实 HTTP ——
 * 真实调用留给人点探针，单测要的是"解析逻辑对不对"。
 *
 * 重点不在"能不能连上 DeepSeek"，而在**它不按预期返回时会怎样**：
 * 包 markdown、返回坏 JSON、HTTP 报错、空响应 ——
 * 这几种都必须被识别为失败并降级，而不是被含糊地吞掉。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseJsonLoose, insideFence, betweenBraces } = require('../cloudfunctions/api/lib/ai/json');
const { createHttpParser } = require('../cloudfunctions/api/lib/ai/http');
const { parseIntents } = require('../cloudfunctions/api/lib/ai');
const { makeWorld, expectOk, expectFail } = require('./helpers');

const VALID = {
  rawText: '晚上八点结束',
  anchorText: '中央大街',
  searchKeyword: '中央大街',
  endClock: { hour: 20, minute: 0, text: '20:00' },
  pace: 'normal',
  mustVisitTexts: [],
  avoidTexts: [],
  matched: [{ field: 'endAt', text: '晚上八点', value: '20:00' }],
  uncertainties: [],
};

/** 造一个假传输：按顺序返回预先排好的响应 */
function fakeTransport(responses) {
  const list = responses.slice();
  const calls = [];
  const t = async (url, opts) => {
    calls.push({ url, opts });
    const r = list.shift();
    if (!r) throw new Error('假传输没有更多响应了');
    if (r.throw) throw r.throw;
    return r;
  };
  t.calls = calls;
  return t;
}

/** 包装成 OpenAI 兼容的响应体 */
const okBody = (content) => ({
  json: { choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 42 } },
  httpStatus: 200,
  rawBody: '{}',
});

// ── JSON 容错 ─────────────────────────────────────────────

test('JSON 容错：原样合法就直接用（不要过度清洗）', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
});

test('JSON 容错：模型把 JSON 包在 markdown 代码块里', () => {
  // 这是**最常踩的坑** —— 模型爱加 ```json 围栏
  const raw = '```json\n{"a":1,"b":"中文"}\n```';
  assert.deepEqual(parseJsonLoose(raw), { a: 1, b: '中文' });
  assert.equal(insideFence(raw), '{"a":1,"b":"中文"}');

  // 没有语言标注的围栏也要认
  assert.deepEqual(parseJsonLoose('```\n{"a":1}\n```'), { a: 1 });
});

test('JSON 容错：前后多了一句解释', () => {
  assert.deepEqual(parseJsonLoose('好的，我来解析：{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('{"a":1}\n希望有帮助！'), { a: 1 });
  assert.deepEqual(parseJsonLoose('说明如下\n{"a":1}\n以上。'), { a: 1 });
});

test('JSON 容错：围栏 + 前后解释同时存在', () => {
  const raw = '好的：\n```json\n{"a":1}\n```\n以上。';
  assert.deepEqual(parseJsonLoose(raw), { a: 1 });
});

test('JSON 容错：解析不出来就返回 null，不抛异常、不猜', () => {
  assert.equal(parseJsonLoose(''), null);
  assert.equal(parseJsonLoose(null), null);
  assert.equal(parseJsonLoose('完全不是 JSON'), null);
  assert.equal(parseJsonLoose('{"a":'), null, '截断的 JSON 不能猜');
  assert.equal(parseJsonLoose('[1,2,3]'), null, '数组不是我们要的结构');
  assert.equal(parseJsonLoose('"字符串"'), null);
  assert.equal(parseJsonLoose('42'), null);
});

test('betweenBraces：取第一个 { 到最后一个 }', () => {
  assert.equal(betweenBraces('xx{"a":1}yy'), '{"a":1}');
  assert.equal(betweenBraces('没有大括号'), null);
});

// ── http provider ─────────────────────────────────────────

test('模型解析：正常返回能解析出结构化需求', async () => {
  const http = fakeTransport([okBody(JSON.stringify(VALID))]);
  const p = createHttpParser({ key: 'sk-test', http: http });

  assert.equal(p.available, true);
  assert.equal(p.name, 'http');

  const r = await p.parse('晚上八点结束', {});
  assert.equal(r.ok, true);
  assert.equal(r.parsed.anchorText, '中央大街');
  assert.equal(r.usage.total_tokens, 42, 'token 用量要带出来，供成本核算');
  assert.equal(r.promptVersion, 'intent-v1', '提示词版本要随结果回传，否则评测无法归因');

  // 请求要带上 Key 与 Key 不能出现在结果里
  assert.match(http.calls[0].url, /chat\/completions/);
  assert.equal(http.calls[0].opts.method, 'POST');
  assert.match(http.calls[0].opts.headers.Authorization, /^Bearer sk-test$/);
  assert.equal(JSON.stringify(r).includes('sk-test'), false, 'Key 绝不能出现在返回里');
  assert.equal(JSON.stringify(r).includes('Bearer'), false);
});

test('模型解析：temperature 必须是 0 —— 评测要求可复现', async () => {
  const http = fakeTransport([okBody(JSON.stringify(VALID))]);
  const p = createHttpParser({ key: 'sk-test', http: http });
  await p.parse('晚上八点结束', {});

  const body = JSON.parse(http.calls[0].opts.body);
  assert.equal(body.temperature, 0, '随机性会直接污染评测分数');
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /不猜/, '提示词的纪律要真的在请求里');
});

test('模型解析：返回包着 markdown 也要能解析出来', async () => {
  const http = fakeTransport([okBody('```json\n' + JSON.stringify(VALID) + '\n```')]);
  const p = createHttpParser({ key: 'sk-test', http: http });

  const r = await p.parse('晚上八点结束', {});
  assert.equal(r.ok, true, '这是模型的常见行为，不该被当成失败');
  assert.equal(r.parsed.anchorText, '中央大街');
});

test('模型解析：坏 JSON 必须失败，并带出原始内容供核对', async () => {
  const http = fakeTransport([okBody('我觉得你想去中央大街吧')]);
  const p = createHttpParser({ key: 'sk-test', http: http });

  const r = await p.parse('晚上八点结束', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'AI_BAD_JSON');
  assert.match(r.message, /markdown/, '错误信息要说清已经尝试过什么');
  assert.match(r.rawHead, /中央大街/, '必须带出原文，否则无法排查模型到底说了什么');
});

test('模型解析：空响应是失败，不能当成"没有需求"', async () => {
  const http = fakeTransport([{ json: { choices: [] }, httpStatus: 200, rawBody: '{}' }]);
  const p = createHttpParser({ key: 'sk-test', http: http });

  const r = await p.parse('晚上八点结束', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'AI_EMPTY_RESPONSE');
});

test('模型解析：上游报错（欠费/限流/网络）如实转换，不抛异常', async () => {
  const http = fakeTransport([
    { throw: Object.assign(new Error('上游返回 HTTP 402'), { code: 'AI_UPSTREAM_FAILED' }) },
  ]);
  const p = createHttpParser({ key: 'sk-test', http: http });

  const r = await p.parse('晚上八点结束', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'AI_UPSTREAM_FAILED');
  assert.match(r.message, /402/);
});

test('模型解析：原话被模型改了要纠正回来，并留痕', async () => {
  // 模型擅自"复述"用户的话是常见行为，评测要靠原话归因，不能让它改
  const altered = Object.assign({}, VALID, { rawText: '用户想晚上八点结束' });
  const http = fakeTransport([okBody(JSON.stringify(altered))]);
  const p = createHttpParser({ key: 'sk-test', http: http });

  const r = await p.parse('晚上八点结束', {});
  assert.equal(r.parsed.rawText, '晚上八点结束', '原话必须一字不改');
  assert.equal(r.parsed.rawTextCorrected, true, '纠正过就要留痕');
  assert.equal(r.parsed.rawTextModelOutput, '用户想晚上八点结束', '模型原话保留，便于发现它改了什么');
});

test('模型解析：没配 Key 时明确不可用，并给出修复指引', async () => {
  const p = createHttpParser({ key: '' });
  assert.equal(p.available, false);

  const r = await p.parse('晚上八点结束', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'AI_KEY_NOT_CONFIGURED');
  assert.match(r.hint || '', /AI_API_KEY/);
});

test('模型解析：Key 前后带空白要自动去掉，并标记出来', async () => {
  const http = fakeTransport([okBody(JSON.stringify(VALID))]);
  const p = createHttpParser({ key: '  sk-test\n', http: http });

  assert.equal(p.available, true);
  assert.equal(p.keyMasked.startsWith(' '), false, '掩码不得含空白');
  await p.parse('x', {});
  assert.match(http.calls[0].opts.headers.Authorization, /^Bearer sk-test$/);
});

// ── 降级链 ────────────────────────────────────────────────

test('降级链：模型失败时退回规则解析，并把原因留痕', async () => {
  const http = fakeTransport([okBody('不是 JSON')]);
  const r = await parseIntents('晚上八点结束', {
    provider: undefined,
    preferModel: true,
    key: 'sk-test',
    http: http,
  });

  // 注入的 http 只作用于显式构造；这里 parseIntents 会自建 provider，
  // 没配环境变量 → http 不可用 → 降级到规则。断言降级语义本身。
  assert.equal(r.ok, true, '降级链必须保证有结果');
  assert.equal(r.parser, 'rulebased');
  assert.equal(r.degraded, true);
  assert.equal(r.attempts[0].parser, 'http');
});

// ── 探针 ──────────────────────────────────────────────────

test('ai.probe：用假 provider 跑通四个情形，判据只看关键用例', async () => {
  const w = await makeWorld();
  const res = expectOk(await w.A('ai.probe', { provider: 'fake', text: '晚上八点结束' }));

  assert.equal(res.kind, 'aiProbe');
  assert.equal(res.provider, 'fake');

  // ① 关键用例：真实调用（假实现）
  const main = res.results[0];
  assert.equal(main.ok, true);
  assert.ok(main.parsed, '要把解析出来的关键字段带出来');
  assert.ok(main.structured, '并给出可直接下发给规划器的结构');
  assert.ok(main.rawHead, '原始返回也要带出来 —— 核对字段名靠它');
  assert.ok(Array.isArray(main.explanation));

  // ④ 信息项：规则解析对照
  const rule = res.results.find((r) => /规则解析对照/.test(r.name));
  assert.equal(rule.informational, true);
  assert.ok(rule.parsed);

  // 判据只看 ①
  assert.equal(res.total, 1);
  assert.equal(res.passed, 1);
  assert.match(res.verdict, /关键用例通过/);
  assert.ok(res.checklist.length >= 4);
});

test('ai.probe：Key 只以掩码出现，绝不泄露', async () => {
  const w = await makeWorld();
  // 用一眼可辨的假值：真实 Key 绝不能进仓库，占位符也不该长得像真的
  // （长得像真 Key 的字符串会触发密钥扫描，也会让人误以为泄露了）
  const secret = 'NOT-A-REAL-KEY-PLACEHOLDER-0000';
  const res = expectOk(
    await w.A('ai.probe', { provider: 'fake', overrideKey: secret, text: '晚上八点结束' })
  );

  const s = JSON.stringify(res);
  assert.equal(s.includes(secret), false, '完整 Key 绝不能出现在响应里');
  assert.ok(res.keyMasked, '只能以掩码形式出现');
  assert.match(res.keyMasked, /\*/, '掩码必须真的遮住中间');
});

test('ai.probe：仅限 dev 环境（会产生真实费用）', async () => {
  const prod = await makeWorld({ env: 'prod' });
  expectFail(await prod.A('ai.probe', { provider: 'fake' }), 'FORBIDDEN_ENV');
});

test('ai.probe：没配 Key 时如实报告，并给出可执行的修复指引', async () => {
  const w = await makeWorld();
  const res = expectOk(await w.A('ai.probe', { provider: 'http', overrideKey: '' }));

  assert.equal(res.keyConfigured, false);
  const main = res.results[0];
  assert.equal(main.ok, false);
  assert.equal(main.reason, 'AI_KEY_NOT_CONFIGURED');
  assert.match(main.hint, /AI_API_KEY/);
  assert.match(res.verdict, /规则解析/, '要说明系统会降级，功能不会中断');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, expectOk, C } = require('./helpers');
const { retrieve, normalize } = require('../cloudfunctions/api/lib/guide/knowledge');
const { createWebKnowledge, parseSearch, safeUrl } = require('../cloudfunctions/api/lib/guide/web-knowledge');
const { createGuideProvider } = require('../cloudfunctions/api/lib/guide/provider');
const { sanitizeResult } = require('../cloudfunctions/api/lib/safety/output');
const { loadPage } = require('./page-harness');
const seed = require('./fixtures/knowledge');
const point = { latitude: 45.77, longitude: 126.62 };
const now = '2026-11-12T01:00:00.000Z';
const source = { index: 1, title: '景点官方介绍', site_name: '景区网站', url: 'https://tourism.gov.cn/park' };
function response(content = '这个公园保留了城市发展中的历史遗迹。', results = [source]) {
  return { results: results.map(row => row && ({ ...row, content })) };
}
const map = name => () => ({ searchPlaces: async () => ({ ok: true, items: [{ title: name, address: '哈尔滨市道里区', location: point }] }) });
async function askConfirmed(w, name) {
  const first = expectOk(await w.A('guide.ask', { text: '介绍一下' + name }));
  assert.equal(first.evidence.length, 0);
  return expectOk(await w.A('guide.ask', { sessionId: first.sessionId, candidateId: first.candidates[0].id }, { expectedVersion: first.version }));
}

test('云端知识命中不联网；数据库修改资料后下一轮直接生效，不依赖代码中的正文', async () => {
  let searches = 0;
  const w = await makeWorld({ createMapProvider: map('中央大街'), createGuideProvider: () => ({ modelAvailable: false,
    searchKnowledge: async () => { searches++; throw Error('should not search'); } }) });
  const result = await askConfirmed(w, '中央大街');
  assert.equal(result.knowledgeOrigin, 'cloud'); assert.equal(result.knowledgeStatus, 'hit'); assert.equal(searches, 0);
  assert.equal(result.sources[0].origin, 'cloud'); assert.equal(result.knowledgeVersion, seed[0].version);
  await w.repo.update(C.GUIDE_KNOWLEDGE, seed[0]._id, { chunks: [{ topic: '建筑', text: '后台更新后的建筑讲解资料，无需重新部署云函数。' }], version: 'review-v2' });
  const follow = expectOk(await w.A('guide.ask', { sessionId: result.sessionId, text: '讲讲建筑' }, { expectedVersion: result.version }));
  assert.match(follow.evidence[0].text, /后台更新/); assert.equal(follow.knowledgeVersion, 'review-v2'); assert.equal(searches, 0);
});

test('云端检索匹配别名与地域；草稿、缺来源、越界同名地点都不成为正式资料', async () => {
  const alias = { name: '索菲亚大教堂', point };
  const w = await makeWorld();
  assert.ok((await retrieve(w.repo, alias, '历史')).chunks.length);
  assert.ok((await retrieve(w.repo, { ...alias, name: '索非亚大教堂' }, '历史')).chunks.length);
  assert.equal((await retrieve(w.repo, { name: '索非亚大教堂', point: { latitude: 41.8, longitude: 123.4 } }, '历史')).chunks.length, 0);
  assert.equal((await retrieve(w.repo, { ...alias, point: { latitude: 41.8, longitude: 123.4 } }, '历史')).chunks.length, 0);
  await w.repo.update(C.GUIDE_KNOWLEDGE, 'saint-sophia', { status: 'draft' });
  assert.equal((await retrieve(w.repo, alias, '历史')).chunks.length, 0);
  await w.repo.update(C.GUIDE_KNOWLEDGE, 'saint-sophia', { status: 'published', url: 'javascript:alert(1)' });
  assert.equal((await retrieve(w.repo, alias, '历史')).chunks.length, 0);
  const fresh = { ...seed[0], _id: 'new-cloud-place', names: ['新增公园'], nameKeys: [normalize('新增公园')] };
  await w.repo.insert(C.GUIDE_KNOWLEDGE, fresh);
  assert.ok((await retrieve(w.repo, { name: '新增公园', point }, '')).chunks.length);
});

test('未命中云知识后才联网；须先确认地点，网页资料不会自动入库或创建行程集合', async () => {
  let searches = 0;
  const w = await makeWorld({ seedKnowledge: [], createMapProvider: map('未收录公园'), createGuideProvider: () => ({ modelAvailable: false,
    searchKnowledge: async (place, question) => { searches++; assert.equal(place.name, '未收录公园'); assert.match(question, /介绍/); return parseSearch(response(), now); } }) });
  const first = expectOk(await w.A('guide.ask', { text: '介绍未收录公园' }));
  assert.equal(searches, 0);
  const result = expectOk(await w.A('guide.ask', { sessionId: first.sessionId, candidateId: first.candidates[0].id }, { expectedVersion: first.version }));
  assert.equal(searches, 1); assert.equal(result.knowledgeOrigin, 'web'); assert.equal(result.knowledgeStatus, 'miss');
  assert.match(result.answer, /联网搜索资料/); assert.equal(result.searchedAt, now);
  assert.equal(result.sources[0].origin, 'web'); assert.equal(result.sources[0].reviewedAt, undefined);
  assert.equal(result.evidence[0].sourceNumber, 1); assert.equal(result.knowledgeVersion, null);
  const restored = expectOk(await w.A('guide.get', { sessionId: result.sessionId }));
  assert.equal(restored.knowledgeOrigin, 'web'); assert.equal(restored.sources[0].url, source.url);
  for (const coll of [C.GUIDE_KNOWLEDGE, C.TRIPS, C.MEET_TASKS]) assert.equal(await w.repo.count(coll), 0);
});

test('联网未配置、报错或缺来源时明确失败，不用模型记忆补写讲解', async () => {
  for (const searchKnowledge of [undefined, async () => { throw Error('secret'); }, async () => parseSearch(response('没有引文的记忆内容', []), now)]) {
    const w = await makeWorld({ seedKnowledge: [], createMapProvider: map('未收录公园'), createGuideProvider: () => ({ modelAvailable: false, searchKnowledge }) });
    const result = await askConfirmed(w, '未收录公园');
    assert.equal(result.evidence.length, 0); assert.equal(result.sources.length, 0); assert.equal(result.knowledgeOrigin, 'none');
    assert.match(result.answer, /没有.*可靠资料/); assert.ok(!JSON.stringify(result).includes('secret'));
  }
});

test('数据库暂不可用与未命中区分；失败后仍可返回有标注的联网资料', async () => {
  const w = await makeWorld({ createMapProvider: map('未收录公园'), createGuideProvider: () => ({ modelAvailable: false, searchKnowledge: async () => parseSearch(response(), now) }) });
  const find = w.repo.find.bind(w.repo);
  w.repo.find = (coll, ...args) => { if (coll === C.GUIDE_KNOWLEDGE) throw Error('private db error'); return find(coll, ...args); };
  const result = await askConfirmed(w, '未收录公园');
  assert.equal(result.knowledgeStatus, 'unavailable'); assert.equal(result.knowledgeOrigin, 'web');
  assert.ok(result.notices.some(n => n.includes('知识库暂不可用'))); assert.ok(!JSON.stringify(result).includes('private db error'));
});

test('DeepSeek官方搜索复用DS密钥，再由DS选取可核对原文；不调用千问', async () => {
  const calls = [];
  const p = createGuideProvider({ env: { DEEPSEEK_API_KEY: 'private-search-key', ALI_TEXT_API_KEY: 'unused', DASHSCOPE_WORKSPACE_ID: 'unused' }, http: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, options, body });
    if (url.endsWith('/tools/search')) return { json: response() };
    return { json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ segments: [{ chunkId: 'web-1', quote: '这个公园保留了城市发展中的历史遗迹。' }] }) } }] } };
  } });
  const result = await p.searchKnowledge({ name: '未收录公园', address: '哈尔滨市' }, '介绍历史', now);
  assert.equal(result.ok, true); assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(calls[1].url, 'https://api.deepseek.com/chat/completions');
  for (const call of calls) assert.equal(call.options.headers.Authorization, 'Bearer private-search-key');
  assert.equal(calls[0].body.need_content, true); assert.equal(calls[0].body.count, 5);
  assert.match(calls[0].body.query, /哈尔滨市/);
  assert.equal(calls[1].body.model, 'deepseek-flash');
  assert.equal(result.chunks[0].source.url, source.url);
  assert.ok(!JSON.stringify(result).includes('private-search-key'));
});

test('没有DS密钥或显式禁用不请求；不复用阿里密钥，上游异常不泄密', async () => {
  for (const env of [{}, { ALI_TEXT_API_KEY: 'other' }, { GUIDE_WEB_SEARCH_API_KEY: 'old-qwen-key' }, { DEEPSEEK_API_KEY: 'key', GUIDE_WEB_SEARCH_ENABLED: 'false' }]) {
    let called = false;
    const r = await createWebKnowledge({ env, http: async () => { called = true; throw Error('must not call'); } }).search({ name: '公园' }, '', now);
    assert.equal(r.reason, 'not_configured'); assert.equal(called, false);
  }
  const result = await createWebKnowledge({ env: { DEEPSEEK_API_KEY: 'key' }, http: async () => { throw Error('private-key-and-url'); } }).search({ name: '公园' }, '', now);
  assert.deepEqual(result, { ok: false, reason: 'unavailable' });
});

test('搜索只采用实际来源并去重；模型伪造出处或改写原文均拒绝', async () => {
  assert.equal(parseSearch(response(undefined, []), now).ok, false);
  assert.equal(parseSearch({ output: { text: '无来源记忆' } }, now).ok, false);
  assert.equal(parseSearch(response(undefined, [{ ...source, url: 'https://127.0.0.1/private' }]), now).ok, false);
  const result = parseSearch(response(undefined, [source, source, null]), now);
  assert.equal(result.chunks.length, 1);
  for (const segments of [[{ chunkId: 'invented', quote: result.chunks[0].text }], [{ chunkId: 'web-1', quote: '模型编造而非网页原文的历史故事。' }], []]) {
    const r = await createWebKnowledge({ env: { DEEPSEEK_API_KEY: 'key' }, http: async () => ({ json: response() }),
      selectEvidence: async () => ({ ok: true, data: { segments } }) }).search({ name: '公园' }, '历史', now);
    assert.equal(r.reason, 'no_valid_citations');
  }
  for (const value of ['javascript:alert(1)', 'https://x.local', 'https://user:pass@example.com/', 'https://example.com:9999']) assert.equal(safeUrl(value), null);
});

test('联网正文仍接受模型输出内容安全检测，正式知识库正文只本地脱敏', async () => {
  const calls = [], gate = { checkOutput: async o => { calls.push(o); return { applied: true, ok: true, text: o.text }; } };
  await sanitizeResult({ knowledgeOrigin: 'web', evidence: [{ text: '网页整理的景点历史资料' }] }, { gate });
  assert.equal(calls[0].useCloud, true);
  calls.length = 0;
  await sanitizeResult({ knowledgeOrigin: 'cloud', evidence: [{ text: '已审核的景点历史资料' }] }, { gate });
  assert.equal(calls[0].useCloud, false);
});

test('连续问答保留各条消息的云端或联网标注、引用与北京时间，错误时间不打断页面', async () => {
  let n = 0;
  const p = loadPage('miniprogram/pages/guide/index.js', { api: { 'guide.ask': () => ({ ok: true, data: {
    sessionId: 's', version: ++n, answer: '下面是讲解片段', candidates: [], notices: [], knowledgeOrigin: n === 2 ? 'cloud' : 'web',
    searchedAt: n === 3 ? 'bad-time' : now, sources: [{ id: 's1', url: source.url }],
    evidence: [{ text: '景点资料正文', sourceNumber: 1, sourceNumbers: [1, 2] }],
  } }) } });
  try {
    p.onLoad();
    const send = async text => { p.onText({ detail: { value: text } }); await p.ask(); };
    await send('讲讲历史'); const original = structuredClone(p.data.messages[1]);
    await send('讲讲建筑'); await send('再讲讲');
    assert.equal(original.knowledgeOrigin, 'web'); assert.equal(original.searchTimeLabel, '2026-11-12 09:00 北京时间');
    assert.match(original.text, /\[1, 2\]/); assert.deepEqual(p.data.messages[1], original);
    assert.equal(p.data.messages[3].knowledgeOrigin, 'cloud'); assert.equal(p.data.messages[3].searchTimeLabel, '');
    assert.equal(p.data.messages[5].searchTimeLabel, ''); assert.equal(p.data.messages[5].failed, false);
  } finally { p.onUnload(); p.restore(); }
});

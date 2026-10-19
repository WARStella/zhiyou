const test = require('node:test');
const assert = require('node:assert/strict');
const { createOcrProvider, signedHeaders, MAX_IMAGE_BYTES } = require('../cloudfunctions/api/lib/ocr/tencent');
const { dependencyStatus } = require('../cloudfunctions/api/lib/config-health');
const { makeWorld, makeCrew, expectOk, expectFail, C } = require('./helpers');
const { invoke } = require('../cloudfunctions/api/lib/invoke');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=', 'base64');
const center = { latitude: 45.7756, longitude: 126.6175 };
const env = { OCR_SECRET_ID: 'test-ocr-id', OCR_SECRET_KEY: 'test-ocr-secret', OCR_SESSION_TOKEN: 'test-token' };

test('真实 OCR action 使用固定腾讯接口及 TC3 签名，返回文字置信度，不持久化照片或识别正文', async () => {
  let count = 0;
  const w = await makeWorld({ createOcrProvider: () => createOcrProvider({ env, http: async (url, options) => {
    count++;
    assert.equal(url, 'https://ocr.tencentcloudapi.com/');
    assert.deepEqual(JSON.parse(options.body), { ImageBase64: image.toString('base64'), LanguageType: 'zh', IsPdf: false });
    assert.equal(options.headers['X-TC-Action'], 'GeneralBasicOCR');
    assert.equal(options.headers['X-TC-Version'], '2018-11-19');
    assert.match(options.headers.Authorization, /\/ocr\/tc3_request/);
    assert.equal(options.headers['X-TC-Token'], 'test-token');
    return { json: { Response: { TextDetections: [{ DetectedText: '哈尔滨学院南门', Confidence: 93 }] } } };
  } }) });
  const { crewId } = await makeCrew(w);
  const result = expectOk(await w.A('ocr.recognize', { crewId, imageBase64: image.toString('base64'), ImageUrl: 'https://evil' }));
  assert.deepEqual(result.lines, [{ text: '哈尔滨学院南门', confidence: 93 }]);
  assert.equal(count, 1);
  const stored = JSON.stringify({ operations: await w.repo.find(C.OPERATIONS), events: await w.repo.find(C.EVENTS) });
  for (const value of [image.toString('base64'), '哈尔滨学院南门', env.OCR_SECRET_KEY]) assert.ok(!stored.includes(value));
  assert.equal(await w.repo.count(C.OPERATIONS, { action: 'ocr.recognize' }), 0);
  expectFail(await invoke({ action: 'ocr.recognize', payload: {} }, { repo: w.repo, openid: null }), 'AUTH_REQUIRED');
  expectFail(await w.clientFor('outsider')('ocr.recognize', { crewId, imageBase64: image.toString('base64') }), 'FORBIDDEN_NOT_MEMBER');
  assert.equal(count, 1);
});

test('超大图片、URL、伪造格式和坏 base64 在调用上游前拒绝', async () => {
  const w = await makeWorld({ createOcrProvider() { assert.fail('无效照片不应调用 OCR'); } });
  const { crewId } = await makeCrew(w);
  for (const value of ['', 'not base64', 'YWJj=', Buffer.from('text').toString('base64'), Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64'), undefined]) {
    expectFail(await w.A('ocr.recognize', { crewId, imageBase64: value, imageUrl: 'https://evil' }), 'INVALID_PARAM');
  }
});

test('缺少配置、网络/鉴权/额度/返回格式错误有可用提示且不泄露上游正文', async () => {
  await assert.rejects(createOcrProvider({ env: {} }).recognize(image), e => e.code === 'OCR_NOT_CONFIGURED');
  for (const response of [null, { Response: {} }, { Response: { Error: { Code: 'AuthFailure', Message: env.OCR_SECRET_KEY } } },
    { Response: { Error: { Code: 'LimitExceeded', Message: image.toString('base64') } } }]) {
    await assert.rejects(createOcrProvider({ env, http: async () => ({ json: response }) }).recognize(image), e => {
      assert.equal(e.code, 'UPSTREAM_OCR_FAILED');
      assert.ok(!JSON.stringify(e).includes(env.OCR_SECRET_KEY));
      assert.ok(!JSON.stringify(e).includes(image.toString('base64')));
      return true;
    });
  }
  await assert.rejects(createOcrProvider({ env, http: async () => { throw new Error(env.OCR_SECRET_KEY); } }).recognize(image),
    e => e.code === 'UPSTREAM_OCR_FAILED' && !e.message.includes(env.OCR_SECRET_KEY));
  const a = signedHeaders('one', { secretId: 'id', secretKey: 'key' }, 1792195200);
  const b = signedHeaders('two', { secretId: 'id', secretKey: 'key' }, 1792195200);
  assert.notEqual(a.Authorization, b.Authorization);
  assert.equal(dependencyStatus(env).ocrService.configured, true);
  assert.equal(dependencyStatus({}).ocrService.configured, false);
  assert.ok(!JSON.stringify(dependencyStatus(env)).includes(env.OCR_SECRET_KEY));
});

test('附近搜索使用真实 POI 坐标，过滤坏坐标、超范围和重复，按距离排序且不写地点库', async () => {
  let query;
  const w = await makeWorld({ createMapProvider: () => ({ searchPlaces: async args => {
    query = args;
    return { ok: true, requestCount: 1, items: [
      { title: '学院南门', location: { latitude: 45.78, longitude: 126.62 }, address: '学府路' },
      { title: '学院东门', location: center, address: '学院路' },
      { title: '学院东门', location: center }, { title: '外地同名', location: { latitude: 39.9, longitude: 116.4 } },
      { title: '坏坐标', location: { latitude: 999, longitude: 0 } }, { title: '', location: center },
    ] };
  } }) });
  const { crewId } = await makeCrew(w), before = await w.repo.count(C.PLACES);
  const response = await w.A('ocr.searchMeeting', { crewId, keyword: '学院', center, radius: 999999, imagePoint: { latitude: 1, longitude: 1 } });
  const data = expectOk(response);
  assert.equal(query.radius, 3000); assert.equal(query.autoExtend, false); assert.equal(query.keyword, '学院');
  assert.deepEqual(data.candidates.map(row => row.name), ['学院东门', '学院南门']);
  assert.deepEqual(data.candidates[0].point, center); assert.equal(data.candidates[0].verified, false);
  assert.equal(response.meta.mapApiCalls, 1); assert.equal(await w.repo.count(C.PLACES), before);
  expectFail(await w.A('ocr.searchMeeting', { crewId, keyword: '学院' }), 'INVALID_PARAM');
  expectFail(await w.A('ocr.searchMeeting', { crewId, keyword: '门', center }), 'INVALID_PARAM');
  assert.equal(await w.repo.count(C.OPERATIONS, { action: 'ocr.searchMeeting' }), 0);
});

test('OCR 和搜索返回前复查成员权限，退出后旧 requestId 不重放结果', async () => {
  for (const action of ['ocr.recognize', 'ocr.searchMeeting']) {
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const wait = () => { started(); return new Promise(resolve => { release = resolve; }); };
    const w = await makeWorld({ createOcrProvider: () => ({ recognize: wait }),
      createMapProvider: () => ({ searchPlaces: wait }) });
    const { crewId } = await makeCrew(w);
    const payload = { crewId, imageBase64: image.toString('base64'), center, keyword: '学院' };
    const pending = w.B(action, payload, { requestId: 'same' });
    await ready; expectOk(await w.B('crew.leave', { crewId }));
    release(action === 'ocr.recognize' ? { provider: 'test', lines: [{ text: '不应返回', confidence: 99 }] }
      : { ok: true, items: [{ title: '不应返回', location: center }] });
    expectFail(await pending, 'FORBIDDEN_NOT_MEMBER');
    expectFail(await w.B(action, payload, { requestId: 'same' }), 'FORBIDDEN_NOT_MEMBER');
  }
});

test('OCR 基础限频隔离用户，空识别和地图失败不会编造地点', async () => {
  const w = await makeWorld({ createOcrProvider: () => ({ recognize: async () => ({ provider: 'test', lines: [] }) }),
    createMapProvider: () => ({ searchPlaces: async () => ({ ok: false }) }) });
  const { crewId } = await makeCrew(w);
  for (let i = 0; i < 10; i++) await w.repo.insert(C.EVENTS, { action: 'ocr.recognize', type: 'api_call', userId: 'openid_A', ts: w.NOW });
  expectFail(await w.A('ocr.recognize', { crewId, imageBase64: image.toString('base64') }), 'RATE_LIMITED');
  assert.deepEqual(expectOk(await w.B('ocr.recognize', { crewId, imageBase64: image.toString('base64') })).lines, []);
  expectFail(await w.A('ocr.searchMeeting', { crewId, keyword: '学院', center }), 'UPSTREAM_MAP_FAILED');
});

module.exports = { image, center };

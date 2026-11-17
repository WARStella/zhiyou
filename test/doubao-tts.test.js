'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDoubaoTts, parseAudio, ENDPOINT, DEFAULT_VOICE } = require('../cloudfunctions/api/lib/media/doubao-tts');
const { createMediaProvider } = require('../cloudfunctions/api/lib/media/provider');
const { catalog } = require('../cloudfunctions/api/lib/media/catalog');
const { makeWorld, C } = require('./helpers');
const env = { DOUBAO_TTS_API_KEY: 'test-speech-private', ARK_API_KEY: 'test-text-private' };
const chunk = bytes => ({ code: 0, data: Buffer.from(bytes).toString('base64') });
const end = { code: 20000000, data: null };
const stream = (...rows) => Buffer.from(rows.map(r => JSON.stringify(r)).join('\r\n') + '\r\n');
const audio = stream(chunk('first'), { code: 0, data: null, sentence: { text: '下一站' } }, chunk('second'), end);
const expected = Buffer.from('firstsecond').toString('base64');

test('豆包TTS按分片解码后拼接，只用独立语音凭据和固定资源/请求格式', async () => {
  let lastId;
  const service = createMediaProvider({ env, http: async (url, o) => {
    assert.equal(url, ENDPOINT); assert.equal(o.binary, true);
    assert.equal(o.headers['X-Api-Key'], 'test-speech-private');
    assert.equal(o.headers.Authorization, undefined);
    assert.equal(o.headers['X-Api-Resource-Id'], 'seed-tts-2.0');
    assert.match(o.headers['X-Api-Request-Id'], /^[\da-f-]{36}$/);
    assert.notEqual(o.headers['X-Api-Request-Id'], lastId); lastId = o.headers['X-Api-Request-Id'];
    const body = JSON.parse(o.body);
    assert.deepEqual(body, { req_params: { text: '最新安排', speaker: DEFAULT_VOICE, audio_params: { format: 'mp3', sample_rate: 24000 } } });
    assert.equal(o.timeoutMs, 25000); assert.equal(o.maxBytes, 768 * 1024);
    return { buffer: audio };
  } });
  const row = service.option('doubao-tts', 'tts');
  assert.deepEqual(await service.synthesize(row, '最新安排'), { audioBase64: expected, format: 'mp3' });
  await service.synthesize(row, '最新安排');
});

test('Ark/腾讯/阿里密钥不能启用豆包TTS，缺配置和非法参数不调用上游', async () => {
  const other = { ARK_API_KEY: 'ark', ALI_TTS_API_KEY: 'ali', TTS_SECRET_ID: 'id', TTS_SECRET_KEY: 'secret' };
  assert.equal(catalog(other).find(r => r.id === 'doubao-tts').configured, false);
  for (const value of ['', ' ']) assert.equal(catalog({ ...other, DOUBAO_TTS_API_KEY: value }).find(r => r.id === 'doubao-tts').configured, false);
  const never = () => assert.fail('不得调用上游');
  await assert.rejects(createDoubaoTts({ env: other, http: never }).synthesize('安排'), { code: 'MEDIA_NOT_CONFIGURED' });
  const service = createDoubaoTts({ env, http: never });
  for (const text of ['', ' ', '字'.repeat(151), null]) await assert.rejects(service.synthesize(text), { code: 'INVALID_PARAM' });
  await assert.rejects(service.synthesize('安排', 'https://invalid'), { code: 'INVALID_PARAM' });
  assert.throws(() => createMediaProvider({ env }).option('doubao-tts', 'image'), { code: 'INVALID_PARAM' });
  assert.ok(!JSON.stringify(catalog(env)).includes('private'));
});

test('豆包TTS拒绝空音频、损坏base64、错误码及超限音频，不泄露上游正文', () => {
  for (const buf of [stream(end), stream(chunk('ok'), { code: 55000000, message: 'PRIVATE' }),
    stream({ code: 0, data: 'invalid base64' }, end), stream({ code: 0, data: 'YR==' }, end),
    stream({ code: '0', data: 'YQ==' }, end), stream(chunk('ok'), end, chunk('extra')),
    stream(chunk(Buffer.alloc(300000)), chunk(Buffer.alloc(225001)), end)]) {
    assert.throws(() => parseAudio(buf), e => e.code === 'MEDIA_UPSTREAM_FAILED' && !e.message.includes('PRIVATE'));
  }
});

test('豆包TTS缺失结束标记或JSON截断视为未知，不把局部音频当成成功', () => {
  for (const buf of [stream(chunk('partial')), Buffer.from('{"code":0'), Buffer.concat([stream(chunk('partial')), Buffer.from('{"code":')])]) {
    assert.throws(() => parseAudio(buf), { code: 'MEDIA_RESULT_UNKNOWN' });
  }
});

test('豆包TTS鉴权拒绝与传输未知分开，均不重试且隐藏原始错误', async () => {
  for (const status of [401, 403, 429, 408, 500, undefined]) {
    let calls = 0;
    const service = createDoubaoTts({ env, http: async () => { calls++; throw Object.assign(new Error('PRIVATE'), { details: { httpStatus: status } }); } });
    await assert.rejects(service.synthesize('安排'), e => e.code === (status && status < 500 && status !== 408 ? 'MEDIA_UPSTREAM_FAILED' : 'MEDIA_RESULT_UNKNOWN') && !e.message.includes('PRIVATE'));
    assert.equal(calls, 1);
  }
});

test('豆包TTS云端音色配置生效，文字与语音可分别启用', async () => {
  const onlyVoice = { DOUBAO_TTS_API_KEY: 'speech', TTS_DOUBAO_VOICE: 'custom_uranus_bigtts' };
  const rows = catalog(onlyVoice);
  assert.equal(rows.find(r => r.id === 'doubao-text').configured, false);
  const service = createMediaProvider({ env: onlyVoice, http: async (_, o) => {
    assert.equal(JSON.parse(o.body).req_params.speaker, 'custom_uranus_bigtts'); return { buffer: audio };
  } });
  assert.equal((await service.synthesize(service.option('doubao-tts', 'tts'), '安排')).audioBase64, expected);
});

test('豆包TTS动作链路复用已生成音频，行程变化后拒绝旧音频', async () => {
  let calls = 0;
  const service = createMediaProvider({ env, http: async () => { calls++; return { buffer: audio }; } });
  const w = await makeWorld({ createGuideProvider: () => ({ media: service }) });
  await w.repo.insert(C.TRIPS, { _id: 'trip-doubao', ownerUserId: 'openid_A', mode: 'solo', status: 'active', version: 2,
    nodes: [{ seq: 1, status: 'pending', placeName: '中央大街', plannedStayMin: 30 }] });
  const payload = { tripId: 'trip-doubao', version: 2, optionId: 'doubao-tts' };
  const first = await w.A('media.speakTrip', payload), second = await w.A('media.speakTrip', payload);
  assert.equal(first.ok, true); assert.equal(first.data.optionId, 'doubao-tts');
  assert.equal(first.data.audioBase64, expected); assert.equal(first.data.format, 'mp3');
  assert.equal(first.data.taskId, second.data.taskId); assert.equal(calls, 1);
  assert.equal((await w.A('media.get', { taskId: first.data.taskId })).data.audioBase64, expected);
  await w.repo.update(C.TRIPS, 'trip-doubao', { version: 3 });
  assert.equal((await w.A('media.get', { taskId: first.data.taskId })).error.code, 'VERSION_CONFLICT');
});

test('豆包TTS未知结果占位阻止再次生成，保留既有防重复计费行为', async () => {
  let calls = 0;
  const service = createMediaProvider({ env, http: async () => { calls++; return { buffer: stream(chunk('partial')) }; } });
  const w = await makeWorld({ createGuideProvider: () => ({ media: service }) });
  await w.repo.insert(C.TRIPS, { _id: 'trip-unknown', ownerUserId: 'openid_A', mode: 'solo', status: 'active', version: 2, nodes: [] });
  const payload = { tripId: 'trip-unknown', version: 2, optionId: 'doubao-tts' };
  const first = await w.A('media.speakTrip', payload), second = await w.A('media.speakTrip', payload);
  assert.equal(first.data.status, 'unknown'); assert.equal(second.data.status, 'unknown'); assert.equal(calls, 1);
});

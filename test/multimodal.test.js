'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, C } = require('./helpers');
const actions = require('../cloudfunctions/api/actions/media');
const { createMediaProvider } = require('../cloudfunctions/api/lib/media/provider');
const { catalog } = require('../cloudfunctions/api/lib/media/catalog');
const { fail, CODES } = require('../cloudfunctions/api/lib/errors');
const env = { DASHSCOPE_API_KEY: 'test-ali' };
const resultUrl = 'https://example.com/result';
const audio = Buffer.from('test-audio').toString('base64');

test('图片视频加入智谱与豆包，播报包含四个平台选项，旧火山选项不可调用', async () => {
  const rows = catalog({ ...env, ARK_API_KEY: 'old-key', VOLC_TTS_API_KEY: 'old-voice' });
  for (const kind of ['image', 'video', 'tts']) assert.equal(rows.filter(r => r.kind === kind).length, kind === 'tts' ? 4 : 3);
  assert.deepEqual(rows.filter(r => r.kind === 'text').map(r => r.id), ['deepseek', 'aliyun-text', 'doubao-text', 'zhipu-text']);
  const service = createMediaProvider({ env, http() { assert.fail('已取消服务不得请求上游'); } });
  for (const [id, kind] of [['volcano-image', 'image'], ['volcano-video', 'video'], ['volcano-tts', 'tts']]) {
    assert.throws(() => service.option(id, kind), { code: 'INVALID_PARAM' });
    if (kind === 'tts') await assert.rejects(service.synthesize({ id, kind }, '安排'), { code: 'INVALID_PARAM' });
    else await assert.rejects(service.create({ id, kind }, '资料'), { code: 'INVALID_PARAM' });
  }
});
test('腾讯TTS读取专用凭据并签名，只有一项凭据或地图/ASR凭据时不可调用', async () => {
  const { signedHeaders } = require('../cloudfunctions/api/lib/media/tencent-tts');
  const headers = signedHeaders('body', { secretId: 'test-id', secretKey: 'test-secret' }, 1700000000);
  assert.match(headers.Authorization, /Credential=test-id\/2023-11-14\/tts\/tc3_request/);
  assert.equal(headers['X-TC-Action'], 'TextToVoice'); assert.equal(headers['X-TC-Version'], '2019-08-23');
  assert.notEqual(headers.Authorization, signedHeaders('different-body', { secretId: 'test-id', secretKey: 'test-secret' }, 1700000000).Authorization);
  for (const partial of [{ MAP_KEY: 'map', ASR_SECRET_ID: 'asr-id', ASR_SECRET_KEY: 'asr-key' }, { TTS_SECRET_ID: 'id' }, { TTS_SECRET_KEY: 'key' }, { TTS_SECRET_ID: ' ', TTS_SECRET_KEY: 'key' }]) {
    const service = createMediaProvider({ env: partial, http() { assert.fail('缺TTS凭据不得发送请求'); } });
    assert.throws(() => service.option('tencent-tts', 'tts'), { code: 'MEDIA_NOT_CONFIGURED' });
  }
  const privateEnv = { TTS_SECRET_ID: ' tts-only-id ', TTS_SECRET_KEY: ' tts-only-secret ', MAP_KEY: 'map', ASR_SECRET_ID: 'asr-id', ASR_SECRET_KEY: 'asr-key' };
  assert.ok(!JSON.stringify(catalog(privateEnv)).includes('tts-only-secret'));
  const service = createMediaProvider({ env: privateEnv, http: async (url, o) => {
    assert.equal(url, 'https://tts.tencentcloudapi.com/');
    assert.match(o.headers.Authorization, /Credential=tts-only-id\//); assert.ok(!o.headers.Authorization.includes('asr-id'));
    const body = JSON.parse(o.body); assert.equal(body.Text, '已更新路线'); assert.equal(body.Codec, 'mp3'); assert.equal(body.VoiceType, 101001);
    assert.equal(body.SampleRate, 16000);
    return { json: { Response: { Audio: audio } } };
  } });
  assert.deepEqual(await service.synthesize(service.option('tencent-tts', 'tts'), '已更新路线'), { audioBase64: audio, format: 'mp3' });
});
test('腾讯TTS拒绝无效音频，区分明确错误与超时未知且不泄露平台正文', async () => {
  const privateEnv = { TTS_SECRET_ID: 'id', TTS_SECRET_KEY: 'secret' };
  for (const response of [{ Error: { Code: 'AuthFailure.InvalidAuthorization', Message: 'SECRET RAW BODY' } },
    { Error: { Code: 'InvalidParameterValue.AppIdNotRegistered', Message: 'SECRET RAW BODY' } },
    { Error: { Code: 'LimitExceeded', Message: 'SECRET RAW BODY' } }, { Audio: '' }, { Audio: 'not base64' }]) {
    const service = createMediaProvider({ env: privateEnv, http: async () => ({ json: { Response: response } }) });
    await assert.rejects(service.synthesize(service.option('tencent-tts', 'tts'), '新安排'), e => e.code === 'MEDIA_UPSTREAM_FAILED' && !e.message.includes('SECRET RAW BODY'));
  }
  let calls = 0;
  const service = createMediaProvider({ env: privateEnv, http: async () => { calls++; throw new Error('SECRET RAW BODY'); } });
  await assert.rejects(service.synthesize(service.option('tencent-tts', 'tts'), '新安排'), { code: 'MEDIA_RESULT_UNKNOWN' });
  assert.equal(calls, 1);
});
test('DeepSeek显示V4.1 Flash并使用官方deepseek-flash标识', async () => {
  const { createGuideProvider } = require('../cloudfunctions/api/lib/guide/provider');
  const row = catalog({ DEEPSEEK_API_KEY: 'deepseek-only' }).find(r => r.id === 'deepseek');
  assert.match(row.label, /V4\.1 Flash/); assert.equal(row.model, 'deepseek-flash'); assert.equal(row.configured, true);
  const service = createGuideProvider({ env: { DEEPSEEK_API_KEY: 'deepseek-only' }, textProvider: 'deepseek', http: async (url, o) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions'); assert.equal(JSON.parse(o.body).model, 'deepseek-flash');
    return { json: { choices: [{ message: { content: '{"tool":"finish"}' } }] } };
  } });
  assert.equal((await service.decide({})).ok, true);
});
test('已移除兼容文字选项，旧客户端显式请求时拒绝且不调用上游', () => {
  const { createGuideProvider } = require('../cloudfunctions/api/lib/guide/provider');
  const configured = { GUIDE_AI_API_KEY: 'old-key', GUIDE_AI_BASE_URL: 'https://text.example/v1', GUIDE_AI_MODEL: 'old-model' };
  assert.equal(catalog(configured).some(r => r.id === 'compatible-text'), false);
  assert.throws(() => createGuideProvider({ env: configured, textProvider: 'compatible-text', http() { assert.fail('不得请求'); } }), { code: 'INVALID_PARAM' });
});

for (const [id, host, key] of [['aliyun-text', 'dashscope.aliyuncs.com', 'test-ali']]) test(id + ' 所选文字平台使用独立凭据，不改变视觉配置', async () => {
  const { createGuideProvider } = require('../cloudfunctions/api/lib/guide/provider');
  const service = createGuideProvider({ env, textProvider: id, http: async (url, options) => {
    assert.equal(new URL(url).hostname, host); assert.equal(options.headers.Authorization, 'Bearer ' + key);
    const body = JSON.parse(options.body); assert.equal(body.stream, false);
    return { json: { choices: [{ finish_reason: 'stop', message: { content: '{"tool":"finish"}' } }] } };
  } });
  assert.equal(service.modelAvailable, true); assert.equal(service.visionAvailable, false);
  assert.deepEqual(await service.decide({}), { ok: true, data: { tool: 'finish' } });
});
test('显式选择的文字平台缺配置时明确拒绝，不静默换平台', () => {
  const { createGuideProvider } = require('../cloudfunctions/api/lib/guide/provider');
  assert.throws(() => createGuideProvider({ env: {}, textProvider: 'zhipu-text' }), { code: 'MEDIA_NOT_CONFIGURED' });
  assert.throws(() => createGuideProvider({ env, textProvider: 'https://other.example' }), { code: 'INVALID_PARAM' });
});

test('目录只返回配置状态，未配置选项不会调用上游，平台不可跨能力使用', async () => {
  const publicData = JSON.stringify(catalog(env));
  for (const secret of Object.values(env)) assert.ok(!publicData.includes(secret));
  const service = createMediaProvider({ env: {}, http() { assert.fail('不应请求'); } });
  assert.throws(() => service.option('aliyun-image', 'image'), { code: 'MEDIA_NOT_CONFIGURED' });
  assert.throws(() => service.option('aliyun-image', 'video'), { code: 'INVALID_PARAM' });
});
test('同厂商各能力可独立配置密钥，提交视频和轮询都使用视频凭据', async () => {
  const overrides = { ...env, ALI_TEXT_API_KEY: 'ali-text-only', ALI_IMAGE_API_KEY: 'ali-image-only',
    ALI_VIDEO_API_KEY: 'ali-video-only', ALI_TTS_API_KEY: 'ali-tts-only' };
  const cases = [ ['aliyun-image', 'image', 'ali-image-only'], ['aliyun-video', 'video', 'ali-video-only'],
    ['aliyun-tts', 'tts', 'ali-tts-only'] ];
  for (const [id, kind, expected] of cases) {
    let calls = 0;
    const service = createMediaProvider({ env: overrides, http: async (_, o) => {
      calls++; assert.equal(o.headers.Authorization, 'Bearer ' + expected);
      if (kind === 'tts') return { json: { output: { audio: { url: resultUrl } } } };
      if (kind === 'image') return { json: { output: { choices: [{ message: { content: [{ image: resultUrl }] } }] } } };
      if (o.method === 'GET') return { json: { output: { task_status: 'RUNNING' } } };
      return { json: { output: { task_id: 'video-only' } } };
    } });
    const row = service.option(id, kind);
    if (kind === 'tts') await service.synthesize(row, '新安排');
    else { await service.create(row, '景点资料'); if (kind === 'video') await service.query(row, 'video-only'); }
    assert.equal(calls, kind === 'video' ? 2 : 1);
  }
  const { createGuideProvider } = require('../cloudfunctions/api/lib/guide/provider');
  for (const [id, key] of [['aliyun-text', 'ali-text-only']]) {
    const service = createGuideProvider({ env: overrides, textProvider: id, http: async (_, o) => {
      assert.equal(o.headers.Authorization, 'Bearer ' + key);
      return { json: { choices: [{ message: { content: '{"tool":"finish"}' } }] } };
    } });
    assert.equal((await service.decide({})).ok, true);
  }
});
test('填写一项独立凭据不会让同厂商其他能力显示已配置，空值不回退共用Key', () => {
  const rows = catalog({ ALI_IMAGE_API_KEY: 'only-image' });
  assert.deepEqual(rows.filter(r => r.configured).map(r => r.id).sort(), ['aliyun-image']);
  const disabled = createMediaProvider({ env: { DASHSCOPE_API_KEY: 'shared', ALI_VIDEO_API_KEY: '' } });
  assert.throws(() => disabled.option('aliyun-video', 'video'), { code: 'MEDIA_NOT_CONFIGURED' });
  assert.equal(disabled.option('aliyun-image', 'image').configured, true);
});

for (const id of ['aliyun-image']) test(id + ' 请求与响应契约', async () => {
  const service = createMediaProvider({ env, http: async (url, o) => {
    const b = JSON.parse(o.body);
    assert.equal(o.headers.Authorization, 'Bearer ' + env.DASHSCOPE_API_KEY);
    assert.match(url, /multimodal-generation\/generation$/); assert.equal(b.input.messages[0].content[0].text, '资料');
    assert.equal(b.parameters.prompt_extend, false);
    return { json: { output: { choices: [{ message: { content: [{ image: resultUrl }] } }] } } };
  } });
  assert.deepEqual(await service.create(service.option(id, 'image'), '资料'), { status: 'succeeded', url: resultUrl });
});
for (const id of ['aliyun-video']) test(id + ' 异步任务创建与查询，不使用图生视频协议', async () => {
  let count = 0;
  const service = createMediaProvider({ env, http: async (url, o) => {
    if (++count === 1) {
      const b = JSON.parse(o.body);
      assert.equal(o.headers['X-DashScope-Async'], 'enable'); assert.equal(b.parameters.resolution, '720P'); assert.equal(b.parameters.duration, 5);
      return { json: { output: { task_id: 'task-1', task_status: 'PENDING' } } };
    }
    assert.equal(o.method, 'GET'); assert.match(url, /\/task-1$/);
    return { json: { output: { task_status: 'SUCCEEDED', video_url: resultUrl } } };
  } });
  const row = service.option(id, 'video');
  assert.deepEqual(await service.create(row, '资料'), { status: 'pending', upstreamId: 'task-1' });
  assert.deepEqual(await service.query(row, 'task-1'), { status: 'succeeded', url: resultUrl });
});
test('千问语音请求使用input.text，OSS的HTTP结果升级为HTTPS', async () => {
  const service = createMediaProvider({ env, http: async (_, o) => {
    const body = JSON.parse(o.body); assert.equal(body.input.voice, 'Cherry'); assert.equal(body.input.text, '新安排');
    return { json: { output: { audio: { url: 'http://result.oss-cn-beijing.aliyuncs.com/a.wav' } } } };
  } });
  assert.match((await service.synthesize(service.option('aliyun-tts', 'tts'), '新安排')).url, /^https:/);
});
test('鉴权失败与超时未知分开，不泄露原始错误', async () => {
  for (const [status, code] of [[401, 'MEDIA_UPSTREAM_FAILED'], [429, 'MEDIA_UPSTREAM_FAILED'], [500, 'MEDIA_RESULT_UNKNOWN'], [null, 'MEDIA_RESULT_UNKNOWN']]) {
    let calls = 0;
    const service = createMediaProvider({ env, http: async () => { calls++; throw Object.assign(new Error('SECRET upstream body'), { details: { httpStatus: status } }); } });
    await assert.rejects(service.create(service.option('aliyun-image', 'image'), '资料'), e => e.code === code && !e.message.includes('SECRET'));
    assert.equal(calls, 1);
  }
});

async function scene(mode = 'ok') {
  let creates = 0, queries = 0, speech = 0, prompt;
  const service = { option(id, kind) { assert.equal(typeof id, 'string'); return { id, kind, model: 'test-model' }; },
    async create(row, text) { creates++; prompt = text; if (mode === 'unknown') throw fail(CODES.MEDIA_RESULT_UNKNOWN, '超时'); return row.kind === 'video' ? { status: 'pending', upstreamId: 'up-1' } : { status: 'succeeded', url: resultUrl }; },
    async query() { queries++; return { status: 'succeeded', url: resultUrl }; },
    async synthesize(_, text) { speech++; return { audioBase64: audio, format: 'mp3' }; } };
  const w = await makeWorld({ createGuideProvider: () => ({ media: service }) });
  await w.repo.insert(C.GUIDE_SESSIONS, { _id: 'session', ownerId: 'openid_A', crewId: null, version: 1,
    place: { name: '中央大街' }, expiresAt: new Date(w.NOW.getTime() + 1800000),
    lastResponse: { answer: '泛化介绍', evidence: [{ text: '真实资料片段' }], sources: [{ id: 'official' }] } });
  const payload = { kind: 'image', optionId: 'aliyun-image', sessionId: 'session', sessionVersion: 1 };
  return { ...w, payload, stats: () => ({ creates, queries, speech, prompt }), service };
}
test('生成绑定真实讲解证据，换requestId与并发点击只调用一次上游', async () => {
  const w = await scene();
  const results = await Promise.all([w.A('media.create', w.payload), w.A('media.create', w.payload)]);
  assert.ok(results.every(r => r.ok)); assert.equal(w.stats().creates, 1);
  assert.match(w.stats().prompt, /真实资料片段/); assert.ok(!w.stats().prompt.includes('泛化介绍'));
  const repeat = await w.A('media.create', w.payload);
  assert.equal(repeat.data.taskId, results[0].data.taskId); assert.equal(w.stats().creates, 1);
  assert.equal((await w.B('media.get', { taskId: repeat.data.taskId })).error.code, 'NOT_FOUND');
});
test('过期、旧版本、缺景点或缺证据会在付费请求前拦截', async () => {
  for (const patch of [{ version: 2 }, { place: null }, { lastResponse: { evidence: [], sources: [] } }, { expiresAt: new Date('2020-01-01') }]) {
    const w = await scene(); await w.repo.update(C.GUIDE_SESSIONS, 'session', patch);
    const result = await w.A('media.create', w.payload); assert.equal(result.ok, false); assert.equal(w.stats().creates, 0);
  }
});
test('生成期间继续追问不丢原版本任务，等待后仍核对所有权', async () => {
  for (const changeOwner of [false, true]) {
    const w = await scene(); let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    w.service.create = async () => { started(); return new Promise(resolve => { release = resolve; }); };
    const pending = w.A('media.create', w.payload); await entered;
    await w.repo.update(C.GUIDE_SESSIONS, 'session', changeOwner ? { ownerId: 'openid_B' } : { version: 2 });
    release({ status: 'succeeded', url: resultUrl });
    const response = await pending;
    if (changeOwner) { assert.equal(response.ok, false); assert.equal(response.error.code, 'NOT_FOUND'); }
    else {
      assert.equal(response.ok, true); assert.equal(response.data.sessionVersion, 1);
      const fetched = await w.A('media.get', { taskId: response.data.taskId });
      assert.equal(fetched.ok, true); assert.equal(fetched.data.url, resultUrl);
      assert.equal((await w.A('media.create', w.payload)).error.code, 'VERSION_CONFLICT');
    }
  }
});
test('未知结果保留占位，刷新或更换requestId不能再次计费', async () => {
  const w = await scene('unknown');
  const first = await w.A('media.create', w.payload);
  assert.equal(first.data.status, 'unknown');
  await w.A('media.create', w.payload);
  await w.A('media.get', { taskId: first.data.taskId });
  assert.equal(w.stats().creates, 1);
});
test('视频轮询成功后不再调用上游，缓存重放仍然重新鉴权', async () => {
  const w = await scene(), p = { ...w.payload, kind: 'video', optionId: 'aliyun-video' };
  const first = await w.A('media.create', p, { requestId: 'same' });
  assert.equal(first.data.status, 'pending');
  const result = await w.A('media.get', { taskId: first.data.taskId }); assert.equal(result.data.status, 'succeeded');
  await w.A('media.get', { taskId: first.data.taskId }); assert.equal(w.stats().queries, 1);
  await w.repo.update(C.GUIDE_SESSIONS, 'session', { ownerId: 'openid_B' });
  assert.equal((await w.A('media.create', p, { requestId: 'same' })).error.code, 'NOT_FOUND');
});
test('TTS只读取已生效的当前行程，旧版本和未授权行程无法播报，重播复用音频', async () => {
  const w = await scene();
  await w.repo.insert(C.TRIPS, { _id: 'trip', ownerUserId: 'openid_A', mode: 'solo', status: 'active', version: 2,
    nodes: [{ seq: 1, status: 'pending', placeName: '索菲亚教堂', plannedStayMin: 30 }] });
  const p = { tripId: 'trip', version: 2, optionId: 'aliyun-tts' };
  const first = await w.A('media.speakTrip', p);
  assert.equal(first.ok, true); assert.match(first.data.text, /索菲亚教堂/);
  await w.A('media.speakTrip', p); assert.equal(w.stats().speech, 1);
  assert.equal((await w.B('media.speakTrip', p)).error.code, 'FORBIDDEN_NOT_MEMBER');
  assert.equal((await w.A('media.speakTrip', { ...p, version: 1 })).error.code, 'VERSION_CONFLICT');
  await w.repo.update(C.TRIPS, 'trip', { version: 3 });
  assert.equal((await w.A('media.get', { taskId: first.data.taskId })).error.code, 'VERSION_CONFLICT');
});
test('内容安全拒绝不会创建付费任务', async () => {
  const w = await scene();
  await assert.rejects(actions.create({ repo: w.repo, openid: 'openid_A', now: w.NOW, payload: w.payload,
    createGuideProvider: () => ({ media: w.service }), safety: { checkText: async () => ({ ok: false, code: 'CONTENT_REJECTED' }) } }), { code: 'CONTENT_REJECTED' });
  assert.equal(w.stats().creates, 0);
});
test('每小时限额在事务内累计，重复任务不占新额度', async () => {
  const w = await scene();
  for (let v = 1; v <= 12; v++) {
    await w.repo.update(C.GUIDE_SESSIONS, 'session', { version: v });
    const p = { ...w.payload, sessionVersion: v };
    assert.equal((await w.A('media.create', p)).ok, true);
    assert.equal((await w.A('media.create', p)).ok, true);
  }
  await w.repo.update(C.GUIDE_SESSIONS, 'session', { version: 13 });
  assert.equal((await w.A('media.create', { ...w.payload, sessionVersion: 13 })).error.code, 'RATE_LIMITED');
  assert.equal(w.stats().creates, 12);
});
test('队伍解散或退出后，同一任务不能重放媒体内容', async () => {
  const w = await scene();
  await w.repo.insert(C.CREWS, { _id: 'crew', status: 'active' });
  await w.repo.insert(C.CREW_MEMBERS, { _id: 'member', crewId: 'crew', userId: 'openid_A', status: 'active' });
  await w.repo.update(C.GUIDE_SESSIONS, 'session', { crewId: 'crew' });
  const p = { ...w.payload, crewId: 'crew' }, created = await w.A('media.create', p);
  assert.equal(created.ok, true);
  await w.repo.update(C.CREW_MEMBERS, 'member', { status: 'left' });
  assert.equal((await w.A('media.get', { taskId: created.data.taskId, crewId: 'crew' })).error.code, 'FORBIDDEN_NOT_MEMBER');
  assert.equal((await w.A('media.create', p)).error.code, 'FORBIDDEN_NOT_MEMBER');
  assert.equal(w.stats().creates, 1);
});
test('旧火山任务连查询也不调用已取消的平台', async () => {
  const w = await scene(), id = 'a'.repeat(64);
  await w.repo.insert(C.MEDIA_TASKS, { _id: id, ownerId: 'openid_A', kind: 'video', optionId: 'volcano-video', status: 'pending', upstreamId: 'old-task', sessionId: 'session' });
  assert.equal((await w.A('media.get', { taskId: id })).error.code, 'INVALID_PARAM');
  assert.equal(w.stats().queries, 0);
});
test('腾讯播报通过真实动作链路保存音频，重复播放复用任务且返回前核对版本', async () => {
  let upstreamCalls = 0;
  const privateEnv = { TTS_SECRET_ID: 'tts-private-id', TTS_SECRET_KEY: 'tts-private-secret' };
  const service = createMediaProvider({ env: privateEnv, http: async () => { upstreamCalls++; return { json: { Response: { Audio: audio } } }; } });
  const w = await makeWorld({ createGuideProvider: () => ({ media: service }) });
  await w.repo.insert(C.TRIPS, { _id: 'trip-tts', ownerUserId: 'openid_A', mode: 'solo', status: 'active', version: 2,
    nodes: [{ seq: 1, status: 'pending', placeName: '中央大街', plannedStayMin: 30 }] });
  const p = { tripId: 'trip-tts', version: 2, optionId: 'tencent-tts' };
  const first = await w.A('media.speakTrip', p);
  assert.equal(first.ok, true); assert.equal(first.data.audioBase64, audio); assert.equal(first.data.format, 'mp3');
  const second = await w.A('media.speakTrip', p);
  assert.equal(first.data.taskId, second.data.taskId); assert.equal(upstreamCalls, 1);
  assert.ok(!JSON.stringify(first).includes('tts-private-secret'));
  assert.equal((await w.A('media.get', { taskId: first.data.taskId })).data.audioBase64, audio);
  await w.repo.update(C.TRIPS, 'trip-tts', { version: 3 });
  assert.equal((await w.A('media.get', { taskId: first.data.taskId })).error.code, 'VERSION_CONFLICT');
});

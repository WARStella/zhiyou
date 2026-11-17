'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMediaProvider } = require('../cloudfunctions/api/lib/media/provider');
const { catalog } = require('../cloudfunctions/api/lib/media/catalog');
const { makeWorld, C } = require('./helpers');
const env = { ZHIPU_API_KEY: 'test-zhipu', ARK_API_KEY: 'test-ark' };
const url = 'https://media.example/result';
const wav = Buffer.alloc(120); wav.write('RIFF'); wav.writeUInt32LE(112, 4); wav.write('WAVE', 8);

for (const platform of ['zhipu', 'doubao']) {
  test(platform + '生图请求对应模型并验证结果URL，不跨厂商或跨能力用Key', async () => {
    const privateEnv = { ...env, [platform === 'zhipu' ? 'ZHIPU_IMAGE_API_KEY' : 'ARK_IMAGE_API_KEY']: 'image-private' };
    const service = createMediaProvider({ env: privateEnv, http: async (target, o) => {
      assert.equal(target, (platform === 'zhipu' ? 'https://open.bigmodel.cn/api/paas/v4' : 'https://ark.cn-beijing.volces.com/api/v3') + '/images/generations');
      assert.equal(o.headers.Authorization, 'Bearer image-private');
      const body = JSON.parse(o.body);
      assert.equal(body.prompt, '讲解资料'); assert.equal(body.size, '1024x1024');
      assert.equal(body.model, platform === 'zhipu' ? 'cogview-3-flash' : 'doubao-seedream-5-0-flash-260915');
      assert.equal(platform === 'zhipu' ? body.watermark_enabled : body.watermark, true);
      return { json: { data: [{ url }] } };
    } });
    assert.deepEqual(await service.create(service.option(platform + '-image', 'image'), '讲解资料'), { status: 'succeeded', url });
    for (const invalid of ['http://media.example/x', 'https://user:pass@media.example/x', undefined]) {
      const bad = createMediaProvider({ env, http: async () => ({ json: { data: [{ url: invalid }] } }) });
      await assert.rejects(bad.create(bad.option(platform + '-image', 'image'), '资料'), { code: 'MEDIA_UPSTREAM_FAILED' });
    }
  });

  test(platform + '视频采用异步创建及对应查询协议，成功失败未知状态均可区分', async () => {
    let mode = 'create', state = '', calls = 0;
    const service = createMediaProvider({ env, http: async (target, o) => {
      calls++;
      if (mode === 'create') {
        const body = JSON.parse(o.body); assert.equal(o.method, 'POST');
        assert.equal(body.duration, 5);
        if (platform === 'doubao') {
          assert.match(target, /\/contents\/generations\/tasks$/); assert.equal(body.resolution, '480p');
          assert.equal(body.model, 'doubao-seedance-1-0-pro-fast-251015'); assert.equal(body.content[0].text, '讲解资料');
        } else { assert.match(target, /\/videos\/generations$/); assert.equal(body.model, 'cogvideox-flash'); assert.equal(body.with_audio, false); }
        return { json: { id: 'task-123' } };
      }
      assert.equal(o.method, 'GET'); assert.match(target, platform === 'zhipu' ? /\/async-result\/task-123$/ : /\/contents\/generations\/tasks\/task-123$/);
      return { json: platform === 'zhipu' ? { task_status: state, video_result: [{ url }] } : { status: state, content: { video_url: url } } };
    } });
    const row = service.option(platform + '-video', 'video');
    assert.deepEqual(await service.create(row, '讲解资料'), { status: 'pending', upstreamId: 'task-123' });
    mode = 'query';
    for (const [upstream, expected] of [[platform === 'zhipu' ? 'SUCCESS' : 'succeeded', 'succeeded'], ['PROCESSING', 'running'], ['failed', 'failed'], ['FAIL', 'failed'], ['unrecognized', 'unknown']]) {
      state = upstream; const result = await service.query(row, 'task-123'); assert.equal(result.status, expected);
      if (expected === 'succeeded') assert.equal(result.url, url);
    }
    const before = calls;
    await assert.rejects(service.query(row, '../evil'), { code: 'INVALID_PARAM' }); assert.equal(calls, before);
  });
}

test('智谱WAV播报检查二进制结果，错误正文不能作为音频播放', async () => {
  const service = createMediaProvider({ env, http: async (target, o) => {
    assert.equal(target, 'https://open.bigmodel.cn/api/paas/v4/audio/speech'); assert.equal(o.binary, true);
    const b = JSON.parse(o.body); assert.equal(b.model, 'glm-tts'); assert.equal(b.voice, 'tongtong'); assert.equal(b.input, '安排');
    assert.equal(b.response_format, 'wav'); return { buffer: wav };
  } });
  assert.deepEqual(await service.synthesize(service.option('zhipu-tts', 'tts'), '安排'), { audioBase64: wav.toString('base64'), format: 'wav' });
  const bad = createMediaProvider({ env, http: async () => ({ buffer: Buffer.from('{"error":"PRIVATE"}') }) });
  await assert.rejects(bad.synthesize(bad.option('zhipu-tts', 'tts'), '安排'), e => e.code === 'MEDIA_UPSTREAM_FAILED' && !e.message.includes('PRIVATE'));
});

test('媒体共享Key可复用，能力显式空值禁用；不向客户端暴露密钥', () => {
  const rows = catalog({ ...env, ZHIPU_IMAGE_API_KEY: '', ARK_VIDEO_API_KEY: '' });
  assert.equal(rows.find(r => r.id === 'zhipu-image').configured, false);
  assert.equal(rows.find(r => r.id === 'zhipu-video').configured, true);
  assert.equal(rows.find(r => r.id === 'doubao-video').configured, false);
  assert.equal(rows.find(r => r.id === 'doubao-image').configured, true);
  assert.ok(!JSON.stringify(rows).includes('test-zhipu'));
  assert.equal(rows.find(r => r.id === 'doubao-asr').configured, false);
  assert.equal(rows.find(r => r.id === 'doubao-tts').configured, false);
});

test('智谱视频真实动作先核验证据，摘要满足512字限制，重复提交不新建任务', async () => {
  let calls = 0;
  const service = createMediaProvider({ env, http: async (_, o) => {
    calls++; assert.ok(JSON.parse(o.body).prompt.length <= 512); return { json: { id: 'task-id' } };
  } });
  const w = await makeWorld({ createGuideProvider: () => ({ media: service }) });
  await w.repo.insert(C.GUIDE_SESSIONS, { _id: 'session-new', ownerId: 'openid_A', crewId: null, version: 1,
    expiresAt: new Date(w.NOW.getTime() + 3600000), place: { name: '中央大街' },
    lastResponse: { evidence: [{ text: '景点资料'.repeat(1000) }], sources: [{ title: '来源' }] } });
  const p = { kind: 'video', optionId: 'zhipu-video', sessionId: 'session-new', sessionVersion: 1 };
  const a = await w.A('media.create', p), b = await w.A('media.create', p);
  assert.equal(a.ok, true); assert.equal(a.data.status, 'pending'); assert.equal(a.data.taskId, b.data.taskId); assert.equal(calls, 1);
});

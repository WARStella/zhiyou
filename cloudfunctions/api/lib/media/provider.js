'use strict';

const { defaultTransport } = require('../http');
const { catalog } = require('./catalog');
const { credential } = require('./credentials');
const { assert, fail, CODES } = require('../errors');
const { createTencentTts } = require('./tencent-tts');

function mediaUrl(value) {
  try {
    const u = new URL(value);
    // Some DashScope responses use http links for OSS; that service also supports HTTPS.
    if (u.protocol === 'http:' && /\.aliyuncs\.com$/.test(u.hostname)) u.protocol = 'https:';
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return null;
    return u.toString();
  } catch (_) { return null; }
}
function createMediaProvider(opts = {}) {
  const env = opts.env || process.env, http = opts.http || defaultTransport;
  const aliBase = env.DASHSCOPE_WORKSPACE_ID && /^[\w-]+$/.test(env.DASHSCOPE_WORKSPACE_ID)
    ? 'https://' + env.DASHSCOPE_WORKSPACE_ID + '.cn-beijing.maas.aliyuncs.com/api/v1' : 'https://dashscope.aliyuncs.com/api/v1';
  async function send(url, key, body, extra = {}) {
    let r;
    try { r = await http(url, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, ...(extra.headers || {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), timeoutMs: 45000, maxBytes: 1024 * 1024, ...extra });
    } catch (e) {
      const status = e.details && e.details.httpStatus;
      if (status >= 400 && status < 500 && status !== 408) throw fail(CODES.MEDIA_UPSTREAM_FAILED,
        status === 401 || status === 403 ? '服务鉴权失败，请检查云端凭据及模型权限' : status === 429 ? '服务额度或并发不足，请检查平台控制台' : '生成请求被平台拒绝，请检查模型开通与配置');
      throw fail(CODES.MEDIA_RESULT_UNKNOWN, '请求超时或连接中断，结果未知；不会自动重新生成，请先核对平台任务及账单');
    }
    const j = r.json || {};
    if (j.code || j.error || (j.Response && j.Response.Error)) throw fail(CODES.MEDIA_UPSTREAM_FAILED, '平台未完成请求，请检查密钥权限、模型开通和可用额度');
    return j;
  }
  function option(id, kind) {
    const row = catalog(env).find(r => r.id === id && r.kind === kind);
    assert(row, CODES.INVALID_PARAM, '平台或模型选项无效');
    assert(row.configured, CODES.MEDIA_NOT_CONFIGURED, '该平台尚未配置，请按多模态接入说明填写云端 API 凭据');
    return row;
  }
  async function create(row, prompt) {
    row = option(row.id, row.kind);
    if (/^(zhipu|doubao)-/.test(row.id)) return platforms.create(row, prompt);
    const key = credential(env, row.id).key;
    if (row.kind === 'image') {
      const j = await send(aliBase + '/services/aigc/multimodal-generation/generation', key,
        { model: row.model, input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
          parameters: { n: 1, size: '1328*1328', prompt_extend: false, watermark: true } });
      const contents = j.output?.choices?.[0]?.message?.content;
      const url = mediaUrl(Array.isArray(contents) && contents.find(c => c.image)?.image);
      assert(url, CODES.MEDIA_UPSTREAM_FAILED, '图片结果格式异常');
      return { status: 'succeeded', url };
    }
    assert(row.kind === 'video', CODES.INVALID_PARAM, '不支持的生成能力');
    const j = await send(aliBase + '/services/aigc/video-generation/video-synthesis', key,
      { model: row.model, input: { prompt }, parameters: { resolution: '720P', ratio: '16:9', duration: 5, prompt_extend: false, watermark: true } },
      { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'X-DashScope-Async': 'enable' } });
    const upstreamId = j.output?.task_id;
    assert(typeof upstreamId === 'string' && /^[\w-]{1,150}$/.test(upstreamId), CODES.MEDIA_RESULT_UNKNOWN, '平台未返回可查询的任务编号，请先核对平台任务');
    return { status: 'pending', upstreamId };
  }
  async function query(row, upstreamId) {
    option(row.id, 'video');
    assert(/^[\w-]{1,150}$/.test(upstreamId), CODES.INVALID_PARAM, '任务编号无效');
    if (/^(zhipu|doubao)-/.test(row.id)) return platforms.query(row, upstreamId);
    const j = await send(aliBase + '/tasks/' + upstreamId, credential(env, row.id).key);
    const out = j.output || {}, state = String(out.task_status).toLowerCase();
    if (state === 'succeeded') {
      const url = mediaUrl(out.video_url);
      assert(url, CODES.MEDIA_UPSTREAM_FAILED, '视频结果格式异常');
      return { status: 'succeeded', url };
    }
    return { status: ({ pending: 'pending', running: 'running', failed: 'failed', canceled: 'failed', cancelled: 'failed', expired: 'expired' })[state] || 'unknown' };
  }
  async function synthesize(row, text) {
    row = option(row.id, 'tts');
    assert(text && text.length <= 150, CODES.INVALID_PARAM, '播报摘要最多150字');
    if (row.id === 'tencent-tts') return createTencentTts({ env, http }).synthesize(text, row.voice);
    if (row.id === 'doubao-tts') return require('./doubao-tts').createDoubaoTts({ env, http }).synthesize(text, row.voice);
    if (row.id === 'zhipu-tts') return platforms.synthesize(row, text);
    const j = await send(aliBase + '/services/aigc/multimodal-generation/generation', credential(env, row.id).key,
      { model: row.model, input: { text, voice: row.voice, language_type: 'Chinese' } });
    const url = mediaUrl(j.output?.audio?.url);
    assert(url, CODES.MEDIA_UPSTREAM_FAILED, '语音结果格式异常');
    return { url, format: 'wav' };
  }
  const platforms = require('./platform-media').createPlatformMedia({ env, http, send, mediaUrl });
  return { option, create, query, synthesize };
}
module.exports = { createMediaProvider, mediaUrl };

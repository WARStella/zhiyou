'use strict';
const { credential } = require('./credentials');
const { assert, fail, CODES } = require('../errors');
const ZHIPU = 'https://open.bigmodel.cn/api/paas/v4';
const ARK = 'https://ark.cn-beijing.volces.com/api/v3';
function createPlatformMedia({ env, http, send, mediaUrl }) {
  const result = value => {
    const url = mediaUrl(value);
    assert(url, CODES.MEDIA_UPSTREAM_FAILED, '平台未返回有效的媒体地址');
    return { status: 'succeeded', url };
  };
  return {
    async create(row, prompt) {
      const key = credential(env, row.id).key;
      const zhipu = row.id.startsWith('zhipu-');
      if (row.kind === 'image') {
        const body = zhipu ? { model: row.model, prompt, size: '1024x1024', quality: 'standard', watermark_enabled: true }
          : { model: row.model, prompt, size: '1024x1024', response_format: 'url', watermark: true, stream: false };
        const j = await send((zhipu ? ZHIPU : ARK) + '/images/generations', key, body);
        return result(j.data && j.data[0] && j.data[0].url);
      }
      assert(row.kind === 'video', CODES.INVALID_PARAM, '不支持的媒体类型');
      if (zhipu) assert(prompt.length <= 512, CODES.INVALID_PARAM, '视频讲解摘要过长');
      const body = zhipu ? { model: row.model, prompt, quality: 'speed', with_audio: false, duration: 5, watermark_enabled: true }
        : { model: row.model, content: [{ type: 'text', text: prompt }], resolution: '480p', ratio: '16:9', duration: 5, watermark: true };
      const j = await send((zhipu ? ZHIPU + '/videos/generations' : ARK + '/contents/generations/tasks'), key, body);
      assert(typeof j.id === 'string' && /^[\w-]{1,150}$/.test(j.id), CODES.MEDIA_RESULT_UNKNOWN, '平台未返回有效任务编号，请先核对平台任务');
      return { status: 'pending', upstreamId: j.id };
    },
    async query(row, id) {
      const zhipu = row.id.startsWith('zhipu-');
      const j = await send(zhipu ? ZHIPU + '/async-result/' + id : ARK + '/contents/generations/tasks/' + id, credential(env, row.id).key);
      const state = String(zhipu ? j.task_status : j.status).toLowerCase();
      if (state === 'success' || state === 'succeeded') return result(zhipu ? j.video_result?.[0]?.url : j.content?.video_url);
      return { status: ({ processing: 'running', queued: 'pending', running: 'running', pending: 'pending', fail: 'failed', failed: 'failed', cancelled: 'failed', canceled: 'failed', expired: 'expired' })[state] || 'unknown' };
    },
    async synthesize(row, text) {
      assert(/^[\w-]{1,100}$/.test(row.voice), CODES.INVALID_PARAM, '智谱音色配置无效');
      let r;
      try {
        r = await http(ZHIPU + '/audio/speech', { method: 'POST', binary: true,
          headers: { 'Content-Type': 'application/json', Accept: 'audio/wav', Authorization: 'Bearer ' + credential(env, row.id).key },
          body: JSON.stringify({ model: row.model, input: text, voice: row.voice, response_format: 'wav', stream: false, watermark_enabled: true }),
          timeoutMs: 25000, maxBytes: 2 * 1024 * 1024 });
      } catch (e) {
        const code = e.details?.httpStatus;
        throw fail(code >= 400 && code < 500 && code !== 408 ? CODES.MEDIA_UPSTREAM_FAILED : CODES.MEDIA_RESULT_UNKNOWN,
          '智谱播报未完成，请核对语音权限、额度和平台调用记录；不会自动重试');
      }
      const b = r && r.buffer;
      assert(Buffer.isBuffer(b) && b.length > 44 && b.length <= 2 * 1024 * 1024 &&
        b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE' &&
        b.readUInt32LE(4) + 8 <= b.length, CODES.MEDIA_UPSTREAM_FAILED, '智谱未返回有效WAV音频');
      return { audioBase64: b.toString('base64'), format: 'wav' };
    },
  };
}
module.exports = { createPlatformMedia };

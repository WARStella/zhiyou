'use strict';

const { randomUUID } = require('crypto');
const { defaultTransport } = require('../http');
const { credential } = require('./credentials');
const { assert, fail, CODES } = require('../errors');
const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const RESOURCE = 'seed-tts-2.0';
const DEFAULT_VOICE = 'zh_female_vv_uranus_bigtts';
const MAX_RESPONSE_BYTES = 768 * 1024;
const MAX_AUDIO_BYTES = 525000;

// HTTP chunks may split a JSON record anywhere. Parse only after the bounded
// transport has received the complete body; never concatenate padded base64.
function parseAudio(buffer) {
  assert(Buffer.isBuffer(buffer) && buffer.length > 0 && buffer.length <= MAX_RESPONSE_BYTES,
    CODES.MEDIA_UPSTREAM_FAILED, '豆包播报响应格式或大小异常');
  const chunks = [];
  let size = 0, ended = false;
  for (const line of buffer.toString('utf8').split(/\r?\n/).filter(s => s.trim())) {
    assert(!ended, CODES.MEDIA_UPSTREAM_FAILED, '豆包播报结束后返回了异常数据');
    let row;
    try { row = JSON.parse(line); }
    catch (_) { throw fail(CODES.MEDIA_RESULT_UNKNOWN, '豆包播报响应不完整，结果待确认；不会自动重新生成'); }
    assert(row && typeof row === 'object' && !Array.isArray(row) && Number.isInteger(row.code),
      CODES.MEDIA_UPSTREAM_FAILED, '豆包播报响应格式异常');
    assert(row.code === 0 || row.code === 20000000, CODES.MEDIA_UPSTREAM_FAILED,
      '豆包播报未成功，请检查语音API Key、服务权限、音色及可用额度');
    if (row.data != null && row.data !== '') {
      const audio = row.data;
      assert(typeof audio === 'string' && audio.length <= 700000 && audio.length % 4 === 0 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(audio), CODES.MEDIA_UPSTREAM_FAILED, '豆包播报音频格式异常');
      const bytes = Buffer.from(audio, 'base64');
      assert(bytes.toString('base64') === audio, CODES.MEDIA_UPSTREAM_FAILED, '豆包播报音频格式异常');
      size += bytes.length;
      assert(size <= MAX_AUDIO_BYTES, CODES.MEDIA_UPSTREAM_FAILED, '豆包播报音频超过大小上限');
      chunks.push(bytes);
    }
    ended = row.code === 20000000;
  }
  assert(ended, CODES.MEDIA_RESULT_UNKNOWN, '豆包播报未收到合成结束标记，结果待确认；不会自动重新生成');
  assert(size > 0, CODES.MEDIA_UPSTREAM_FAILED, '豆包播报未返回有效音频');
  return { audioBase64: Buffer.concat(chunks).toString('base64'), format: 'mp3' };
}

function createDoubaoTts(opts = {}) {
  const env = opts.env || process.env, http = opts.http || defaultTransport;
  return { async synthesize(text, voice = DEFAULT_VOICE) {
    const key = credential(env, 'doubao-tts').key;
    assert(key, CODES.MEDIA_NOT_CONFIGURED, '豆包语音播报未配置，请在api云函数填写DOUBAO_TTS_API_KEY');
    assert(typeof text === 'string' && text.trim() && text.length <= 150, CODES.INVALID_PARAM, '播报摘要最多150字');
    assert(typeof voice === 'string' && /^[A-Za-z0-9_]{1,150}$/.test(voice), CODES.INVALID_PARAM, '豆包播报音色ID无效，请检查TTS_DOUBAO_VOICE');
    let response;
    try {
      response = await http(ENDPOINT, { method: 'POST', binary: true,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json',
          'X-Api-Key': key, 'X-Api-Resource-Id': RESOURCE, 'X-Api-Request-Id': randomUUID() },
        body: JSON.stringify({ req_params: { text, speaker: voice, audio_params: { format: 'mp3', sample_rate: 24000 } } }),
        timeoutMs: 25000, maxBytes: MAX_RESPONSE_BYTES });
    } catch (e) {
      const status = e.details && e.details.httpStatus;
      if (status >= 400 && status < 500 && status !== 408) throw fail(CODES.MEDIA_UPSTREAM_FAILED,
        '豆包播报请求被拒绝，请检查语音API Key、服务权限、音色与额度');
      throw fail(CODES.MEDIA_RESULT_UNKNOWN, '豆包播报超时或连接中断，结果待确认；不会自动重新生成');
    }
    return parseAudio(response && response.buffer);
  } };
}
module.exports = { createDoubaoTts, parseAudio, ENDPOINT, RESOURCE, DEFAULT_VOICE };

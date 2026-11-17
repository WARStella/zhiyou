'use strict';
const { randomUUID } = require('crypto');
const { defaultTransport } = require('../http');
const { credential } = require('../media/credentials');
const { assert, fail, CODES } = require('../errors');
function createPlatformSpeech(opts = {}) {
  const env = opts.env || process.env, http = opts.http || defaultTransport, id = opts.optionId;
  assert(['zhipu-asr', 'doubao-asr'].includes(id), CODES.INVALID_PARAM, '语音识别选项无效');
  return { async recognize(audio) {
    const key = credential(env, id).key;
    assert(key, CODES.ASR_NOT_CONFIGURED, '所选语音识别服务尚未配置，请检查云端专用凭据');
    let url, body, headers;
    if (id === 'zhipu-asr') {
      const boundary = 'zhiyou-' + randomUUID();
      body = Buffer.concat([Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="model"\r\n\r\nglm-asr-2512\r\n--' + boundary +
        '\r\nContent-Disposition: form-data; name="stream"\r\n\r\nfalse\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="recording.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n'),
        audio, Buffer.from('\r\n--' + boundary + '--\r\n')]);
      url = 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions';
      headers = { 'Content-Type': 'multipart/form-data; boundary=' + boundary, Authorization: 'Bearer ' + key };
    } else {
      url = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
      body = JSON.stringify({ audio: { data: audio.toString('base64') }, request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true } });
      headers = { 'Content-Type': 'application/json', 'X-Api-Key': key, 'X-Api-Resource-Id': 'volc.bigasr.auc_turbo',
        'X-Api-Request-Id': randomUUID(), 'X-Api-Sequence': '-1' };
    }
    let r;
    try { r = await http(url, { method: 'POST', headers, body, timeoutMs: 20000, maxBytes: 256 * 1024, errorCode: CODES.UPSTREAM_SPEECH_FAILED }); }
    catch (_) { throw fail(CODES.UPSTREAM_SPEECH_FAILED, '所选语音识别连接失败或超时，请检查权限与额度；可继续输入文字'); }
    const j = r && r.json;
    assert(j && !j.error, CODES.UPSTREAM_SPEECH_FAILED, '语音识别服务未成功，请核对权限、额度与录音');
    if (id === 'doubao-asr') assert(String(r.headers?.['x-api-status-code']) === '20000000', CODES.UPSTREAM_SPEECH_FAILED, '豆包语音识别未成功，请核对语音服务权限与调用记录');
    const text = id === 'zhipu-asr' ? j.text : j.result?.text;
    assert(typeof text === 'string' && text.length <= 10000, CODES.UPSTREAM_SPEECH_FAILED, '语音识别返回格式异常');
    return { text: text.trim(), provider: id };
  } };
}
module.exports = { createPlatformSpeech };

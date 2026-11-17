'use strict';

const crypto = require('crypto');
const { defaultTransport } = require('../http');
const { assert, fail, CODES } = require('../errors');
const HOST = 'tts.tencentcloudapi.com';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value, encoding) => crypto.createHmac('sha256', key).update(value).digest(encoding);

function credentials(env) {
  return { secretId: String(env.TTS_SECRET_ID || '').trim(), secretKey: String(env.TTS_SECRET_KEY || '').trim() };
}
function configured(env) {
  const c = credentials(env);
  return Boolean(c.secretId && c.secretKey);
}
function signedHeaders(body, c, timestamp) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10), scope = date + '/tts/tc3_request';
  const names = 'content-type;host;x-tc-action';
  const canonical = ['POST', '/', '', 'content-type:application/json; charset=utf-8\nhost:' + HOST + '\nx-tc-action:texttovoice\n', names, hash(body)].join('\n');
  const keyDate = hmac('TC3' + c.secretKey, date), keyService = hmac(keyDate, 'tts'), keySigning = hmac(keyService, 'tc3_request');
  const signature = hmac(keySigning, ['TC3-HMAC-SHA256', timestamp, scope, hash(canonical)].join('\n'), 'hex');
  return { 'Content-Type': 'application/json; charset=utf-8', Host: HOST, 'X-TC-Action': 'TextToVoice',
    'X-TC-Version': '2019-08-23', 'X-TC-Timestamp': String(timestamp),
    Authorization: 'TC3-HMAC-SHA256 Credential=' + c.secretId + '/' + scope + ', SignedHeaders=' + names + ', Signature=' + signature };
}
function createTencentTts(opts = {}) {
  const env = opts.env || process.env, http = opts.http || defaultTransport;
  return {
    async synthesize(text, voice) {
      assert(configured(env), CODES.MEDIA_NOT_CONFIGURED, '腾讯语音播报未配置，请在api云函数填写TTS_SECRET_ID和TTS_SECRET_KEY');
      assert(typeof text === 'string' && text.length > 0 && text.length <= 150, CODES.INVALID_PARAM, '播报摘要最多150字');
      assert(/^\d{1,9}$/.test(String(voice)), CODES.INVALID_PARAM, '腾讯播报音色ID无效，请检查TTS_TENCENT_VOICE');
      const body = JSON.stringify({ Text: text, SessionId: crypto.randomUUID(), ModelType: 1,
        VoiceType: Number(voice), Codec: 'mp3', SampleRate: 16000 });
      let response;
      try {
        response = await http('https://' + HOST + '/', { method: 'POST', body,
          headers: signedHeaders(body, credentials(env), Math.floor(Date.now() / 1000)), timeoutMs: 15000, maxBytes: 768 * 1024 });
      } catch (e) {
        const status = e.details && e.details.httpStatus;
        if (status >= 400 && status < 500 && status !== 408) throw fail(CODES.MEDIA_UPSTREAM_FAILED, '腾讯播报请求被拒绝，请检查TTS凭据、服务权限和额度');
        throw fail(CODES.MEDIA_RESULT_UNKNOWN, '腾讯播报请求超时或连接中断，结果未知；请核对平台调用记录后再操作');
      }
      const data = response && response.json && response.json.Response;
      if (data && data.Error) {
        const code = String(data.Error.Code || '').replace(/[^\w.]/g, '').slice(0, 100);
        const message = /AuthFailure|UnauthorizedOperation/.test(code) ? '腾讯播报鉴权失败，请检查TTS_SECRET_ID、TTS_SECRET_KEY及TextToVoice权限'
          : /AppIdNotRegistered/.test(code) ? '腾讯语音合成服务未开通，请在相同腾讯云账号开通TTS'
            : /LimitExceeded|ResourceUnavailable|FailedOperation/.test(code) ? '腾讯播报暂不可用，请检查音色授权、可用额度与并发限制'
              : '腾讯播报未成功，请检查音色配置或平台调用记录';
        throw fail(CODES.MEDIA_UPSTREAM_FAILED, message, { providerCode: code });
      }
      const audio = data && data.Audio;
      assert(typeof audio === 'string' && audio.length > 0 && audio.length <= 700000 && audio.length % 4 === 0 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(audio) && Buffer.from(audio, 'base64').toString('base64') === audio,
      CODES.MEDIA_UPSTREAM_FAILED, '腾讯播报未返回有效音频');
      return { audioBase64: audio, format: 'mp3' };
    },
  };
}
module.exports = { createTencentTts, configured, signedHeaders };

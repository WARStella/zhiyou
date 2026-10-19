'use strict';

// 腾讯云 SentenceRecognition / TC3 v3。音频只在本次请求内存中使用。
const crypto = require('crypto');
const { defaultTransport } = require('../http');
const { fail, CODES } = require('../errors');
const HOST = 'asr.tencentcloudapi.com';
const MAX_AUDIO_BYTES = 512 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value, encoding) => crypto.createHmac('sha256', key).update(value).digest(encoding);

function signedHeaders(body, credentials, timestamp) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const scope = date + '/asr/tc3_request';
  const headers = 'content-type:application/json; charset=utf-8\nhost:' + HOST + '\nx-tc-action:sentencerecognition\n';
  const names = 'content-type;host;x-tc-action';
  const canonical = ['POST', '/', '', headers, names, hash(body)].join('\n');
  const stringToSign = ['TC3-HMAC-SHA256', timestamp, scope, hash(canonical)].join('\n');
  const keyDate = hmac('TC3' + credentials.secretKey, date);
  const keyService = hmac(keyDate, 'asr');
  const keySigning = hmac(keyService, 'tc3_request');
  const signature = hmac(keySigning, stringToSign, 'hex');
  const out = { 'Content-Type': 'application/json; charset=utf-8', Host: HOST,
    'X-TC-Action': 'SentenceRecognition', 'X-TC-Version': '2019-06-14', 'X-TC-Timestamp': String(timestamp),
    Authorization: 'TC3-HMAC-SHA256 Credential=' + credentials.secretId + '/' + scope +
      ', SignedHeaders=' + names + ', Signature=' + signature };
  if (credentials.token) out['X-TC-Token'] = credentials.token;
  return out;
}

function createSpeechProvider(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const credentials = { secretId: String(env.ASR_SECRET_ID || '').trim(),
    secretKey: String(env.ASR_SECRET_KEY || '').trim(), token: String(env.ASR_SESSION_TOKEN || '').trim() };
  const transport = opts.http || defaultTransport;
  return {
    createSession(now) { return require('./realtime').createRealtimeSession(env, now); },
    async recognize(audio, now) {
      if (!credentials.secretId || !credentials.secretKey) throw fail(CODES.ASR_NOT_CONFIGURED,
        '语音识别服务未配置，请在 api 云函数配置 ASR_SECRET_ID 和 ASR_SECRET_KEY，并开通腾讯云语音识别服务。');
      const body = JSON.stringify({ EngSerViceType: '16k_zh', SourceType: 1, VoiceFormat: 'mp3',
        Data: audio.toString('base64'), DataLen: audio.length, FilterDirty: 0, FilterModal: 0, FilterPunc: 0 });
      const timestamp = Math.floor(new Date(now || Date.now()).getTime() / 1000);
      let result;
      try {
        result = await transport('https://' + HOST + '/', { method: 'POST', body,
          headers: signedHeaders(body, credentials, timestamp), timeoutMs: 15000,
          maxBytes: 256 * 1024, errorCode: CODES.UPSTREAM_SPEECH_FAILED });
      } catch (_) {
        // 不把 transport 的响应正文、请求体、签名或凭据写入错误/日志。
        throw fail(CODES.UPSTREAM_SPEECH_FAILED, '语音识别服务连接失败或超时，请稍后重录；仍可直接输入文字。');
      }
      const data = result && result.json && result.json.Response;
      if (data && data.Error) {
        const code = String(data.Error.Code || 'UNKNOWN').replace(/[^\w.]/g, '').slice(0, 100);
        const message = /AuthFailure|UnauthorizedOperation/.test(code)
          ? '语音识别鉴权失败，请检查云端凭据与 SentenceRecognition 权限。'
          : /ResourceUnavailable|FailedOperation.Service|UnsupportedOperation/.test(code)
            ? '语音识别服务当前不可用，请核对是否开通、额度及账号状态。'
            : '语音识别未成功，请检查录音或稍后重试。';
        throw fail(CODES.UPSTREAM_SPEECH_FAILED, message, { providerCode: code });
      }
      if (!data || typeof data.Result !== 'string' || data.Result.length > 10000) {
        throw fail(CODES.UPSTREAM_SPEECH_FAILED, '语音识别服务返回格式异常，请稍后重试。');
      }
      return { text: data.Result.trim(), provider: 'tencent-asr' };
    },
  };
}

module.exports = { createSpeechProvider, signedHeaders, MAX_AUDIO_BYTES };

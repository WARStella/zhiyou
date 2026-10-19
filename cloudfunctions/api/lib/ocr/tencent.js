'use strict';

const crypto = require('crypto');
const { defaultTransport } = require('../http');
const { fail, CODES } = require('../errors');
const HOST = 'ocr.tencentcloudapi.com';
const MAX_IMAGE_BYTES = 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value, encoding) => crypto.createHmac('sha256', key).update(value).digest(encoding);

function signedHeaders(body, credentials, timestamp) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const scope = date + '/ocr/tc3_request';
  const names = 'content-type;host;x-tc-action';
  const headers = 'content-type:application/json; charset=utf-8\nhost:' + HOST + '\nx-tc-action:generalbasicocr\n';
  const canonical = ['POST', '/', '', headers, names, hash(body)].join('\n');
  const stringToSign = ['TC3-HMAC-SHA256', timestamp, scope, hash(canonical)].join('\n');
  const key = hmac(hmac(hmac('TC3' + credentials.secretKey, date), 'ocr'), 'tc3_request');
  const out = { 'Content-Type': 'application/json; charset=utf-8', Host: HOST,
    'X-TC-Action': 'GeneralBasicOCR', 'X-TC-Version': '2018-11-19', 'X-TC-Timestamp': String(timestamp),
    Authorization: 'TC3-HMAC-SHA256 Credential=' + credentials.secretId + '/' + scope +
      ', SignedHeaders=' + names + ', Signature=' + hmac(key, stringToSign, 'hex') };
  if (credentials.token) out['X-TC-Token'] = credentials.token;
  return out;
}

function createOcrProvider(options) {
  const opts = options || {}, env = opts.env || process.env;
  const credentials = { secretId: String(env.OCR_SECRET_ID || '').trim(),
    secretKey: String(env.OCR_SECRET_KEY || '').trim(), token: String(env.OCR_SESSION_TOKEN || '').trim() };
  return { async recognize(image, now) {
    if (!credentials.secretId || !credentials.secretKey) throw fail(CODES.OCR_NOT_CONFIGURED,
      '图片识别尚未配置，请配置 OCR_SECRET_ID / OCR_SECRET_KEY 并开通腾讯云通用印刷体识别；仍可手动选点。');
    const body = JSON.stringify({ ImageBase64: image.toString('base64'), LanguageType: 'zh', IsPdf: false });
    let response;
    try {
      response = await (opts.http || defaultTransport)('https://' + HOST + '/', { method: 'POST', body,
        headers: signedHeaders(body, credentials, Math.floor(new Date(now || Date.now()).getTime() / 1000)),
        timeoutMs: 12000, maxBytes: 512 * 1024, errorCode: CODES.UPSTREAM_OCR_FAILED });
    } catch (_) {
      throw fail(CODES.UPSTREAM_OCR_FAILED, '图片识别连接失败或超时，请稍后重试或手动输入地点。');
    }
    const result = response && response.json && response.json.Response;
    if (result && result.Error) {
      const code = String(result.Error.Code || '').replace(/[^\w.]/g, '').slice(0, 100);
      const hint = /AuthFailure|UnauthorizedOperation/.test(code)
        ? '请检查云端 OCR 凭据及 GeneralBasicOCR 权限。'
        : /LimitExceeded|ResourceUnavailable/.test(code) ? '请检查 OCR 服务额度或稍后重试。'
          : '请换一张清晰的站牌、门牌或入口牌照片重试。';
      throw fail(CODES.UPSTREAM_OCR_FAILED, '图片识别失败。' + hint, { serviceCode: code });
    }
    if (!result || !Array.isArray(result.TextDetections)) throw fail(CODES.UPSTREAM_OCR_FAILED, '图片识别返回异常，请稍后重试。');
    return { provider: 'tencent-ocr', lines: result.TextDetections.slice(0, 100).map(row => ({
      text: row && typeof row.DetectedText === 'string' ? row.DetectedText.replace(/\s+/g, ' ').trim().slice(0, 100) : '',
      confidence: row && Number.isFinite(row.Confidence) ? Math.max(0, Math.min(100, row.Confidence)) : null,
    })).filter(row => row.text) };
  } };
}

module.exports = { createOcrProvider, signedHeaders, MAX_IMAGE_BYTES };

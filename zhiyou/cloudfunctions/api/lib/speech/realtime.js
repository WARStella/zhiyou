'use strict';

const crypto = require('crypto');
const { fail, CODES } = require('../errors');
const MODELS = ['16k_zh', '16k_zh_en', 'Hy-ASR-3.0-preview'];

function realtimeConfigured(env) {
  return Boolean(String(env.ASR_SECRET_ID || '').trim() && String(env.ASR_SECRET_KEY || '').trim() &&
    /^[1-9]\d{4,19}$/.test(String(env.ASR_APP_ID || '').trim()) &&
    MODELS.includes(env.ASR_ENGINE_MODEL || '16k_zh') && !String(env.ASR_SESSION_TOKEN || '').trim());
}

// 仅在云端生成短期签名；URL 本身也是临时访问凭据，不得持久化或写日志。
function createRealtimeSession(env, now) {
  if (!realtimeConfigured(env)) throw fail(CODES.ASR_NOT_CONFIGURED,
    '实时语音需配置 ASR_APP_ID（腾讯云数字 APPID）、ASR_SECRET_ID、ASR_SECRET_KEY；' +
    'ASR_ENGINE_MODEL 可留空。当前实时签名仅支持长期 API 密钥，ASR_SESSION_TOKEN 须留空。');
  const timestamp = Math.floor(new Date(now || Date.now()).getTime() / 1000);
  const voiceId = crypto.randomBytes(16).toString('hex');
  const params = { engine_model_type: env.ASR_ENGINE_MODEL || '16k_zh', expired: timestamp + 90,
    filter_dirty: 0, filter_modal: 0, filter_punc: 0, needvad: 1,
    nonce: crypto.randomBytes(4).readUInt32BE(0) || 1, secretid: String(env.ASR_SECRET_ID).trim(),
    timestamp, voice_format: 1, voice_id: voiceId };
  const path = 'asr.cloud.tencent.com/asr/v2/' + String(env.ASR_APP_ID).trim();
  const keys = Object.keys(params).sort();
  const original = path + '?' + keys.map(k => k + '=' + params[k]).join('&');
  const signature = crypto.createHmac('sha1', String(env.ASR_SECRET_KEY).trim()).update(original).digest('base64');
  const url = 'wss://' + path + '?' + keys.map(k => k + '=' + encodeURIComponent(params[k])).join('&') +
    '&signature=' + encodeURIComponent(signature);
  return { url, voiceId, expiresAt: params.expired, provider: 'tencent-asr-realtime',
    model: params.engine_model_type, maxDurationMs: 60000 };
}

module.exports = { createRealtimeSession, realtimeConfigured };

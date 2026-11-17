'use strict';

// Public catalog contains identifiers only. Credentials and upstream hosts never come from clients.
const { credential } = require('./credentials');
function catalog(env = process.env) {
  const configured = id => Boolean(credential(env, id).key);
  return [
    { id: 'deepseek', kind: 'text', label: 'DeepSeek V4.1 Flash', model: 'deepseek-flash', configured: !!(env.GUIDE_DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || env.AI_API_KEY) },
    { id: 'aliyun-text', kind: 'text', label: '阿里云 · 千问', model: env.MEDIA_ALI_TEXT_MODEL || 'qwen-plus', configured: configured('aliyun-text') },
    { id: 'doubao-text', kind: 'text', label: '豆包', model: env.ARK_TEXT_MODEL || 'doubao-seed-2-0-mini-260428', configured: configured('doubao-text') },
    { id: 'zhipu-text', kind: 'text', label: '4.7flash', model: 'glm-4.7-flash', configured: configured('zhipu-text') },
    { id: 'aliyun-image', kind: 'image', label: '阿里云 · 千问生图', model: env.MEDIA_ALI_IMAGE_MODEL || 'qwen-image-2.0', configured: configured('aliyun-image') },
    { id: 'aliyun-video', kind: 'video', label: '阿里云 · 万相', model: env.MEDIA_ALI_VIDEO_MODEL || 'wan2.7-t2v', configured: configured('aliyun-video') },
    { id: 'aliyun-tts', kind: 'tts', label: '阿里云 · 千问语音', model: env.MEDIA_ALI_TTS_MODEL || 'qwen3-tts-flash', voice: env.TTS_ALI_VOICE || 'Cherry', configured: configured('aliyun-tts') },
    { id: 'tencent-tts', kind: 'tts', label: '腾讯云 · 语音播报', model: 'TextToVoice', voice: env.TTS_TENCENT_VOICE || '101001', configured: require('./tencent-tts').configured(env) },
    { id: 'doubao-tts', kind: 'tts', label: '豆包语音播报', model: 'seed-tts-2.0', voice: env.TTS_DOUBAO_VOICE || require('./doubao-tts').DEFAULT_VOICE, configured: configured('doubao-tts') },
    { id: 'zhipu-image', kind: 'image', label: 'CogView-3-Flash', model: 'cogview-3-flash', configured: configured('zhipu-image') },
    { id: 'doubao-image', kind: 'image', label: 'Seedream 5.0 Flash', model: 'doubao-seedream-5-0-flash-260915', configured: configured('doubao-image') },
    { id: 'zhipu-video', kind: 'video', label: 'CogVideoX-Flash', model: 'cogvideox-flash', configured: configured('zhipu-video') },
    { id: 'doubao-video', kind: 'video', label: 'Seedance 1.0 Pro Fast', model: 'doubao-seedance-1-0-pro-fast-251015', configured: configured('doubao-video') },
    { id: 'zhipu-tts', kind: 'tts', label: 'GLM-TTS', model: 'glm-tts', voice: env.TTS_ZHIPU_VOICE || 'tongtong', configured: configured('zhipu-tts') },
    { id: 'tencent-asr', kind: 'asr', label: '腾讯云实时识别', model: '16k_zh', configured: Boolean(String(env.ASR_SECRET_ID || '').trim() && String(env.ASR_SECRET_KEY || '').trim()) },
    { id: 'zhipu-asr', kind: 'asr', label: 'GLM-ASR-2512', model: 'glm-asr-2512', configured: configured('zhipu-asr') },
    { id: 'doubao-asr', kind: 'asr', label: '豆包录音识别', model: 'volc.bigasr.auc_turbo', configured: configured('doubao-asr') },
  ].map(row => ({ ...row, status: row.configured ? '凭据已填写，开通状态、权限及额度待验证' : '未配置' }));
}
module.exports = { catalog };

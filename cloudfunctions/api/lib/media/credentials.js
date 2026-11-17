'use strict';

// Different APIs may share a platform credential, but they must also support independent permissions.
const KEYS = {
  'doubao-text': ['ARK_API_KEY'],
  'zhipu-text': ['ZHIPU_API_KEY'],
  'doubao-tts': ['DOUBAO_TTS_API_KEY'],
  'doubao-image': ['ARK_IMAGE_API_KEY', 'ARK_API_KEY'],
  'doubao-video': ['ARK_VIDEO_API_KEY', 'ARK_API_KEY'],
  'doubao-asr': ['DOUBAO_ASR_API_KEY'],
  'zhipu-image': ['ZHIPU_IMAGE_API_KEY', 'ZHIPU_API_KEY'],
  'zhipu-video': ['ZHIPU_VIDEO_API_KEY', 'ZHIPU_API_KEY'],
  'zhipu-asr': ['ZHIPU_ASR_API_KEY', 'ZHIPU_API_KEY'],
  'zhipu-tts': ['ZHIPU_TTS_API_KEY', 'ZHIPU_API_KEY'],
  'aliyun-text': ['ALI_TEXT_API_KEY', 'DASHSCOPE_API_KEY'],
  'aliyun-image': ['ALI_IMAGE_API_KEY', 'DASHSCOPE_API_KEY'],
  'aliyun-video': ['ALI_VIDEO_API_KEY', 'DASHSCOPE_API_KEY'],
  'aliyun-tts': ['ALI_TTS_API_KEY', 'DASHSCOPE_API_KEY'],
};
function credential(env, id) {
  const names = KEYS[id] || [];
  // An explicitly empty capability key disables this capability even if a shared key exists.
  const name = names.find(n => Object.prototype.hasOwnProperty.call(env, n));
  return { key: name ? String(env[name] || '').trim() : '', variable: name || names[0] || '' };
}
module.exports = { credential };

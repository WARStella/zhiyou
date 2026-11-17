const DEFAULTS = { image: 'aliyun-image', video: 'aliyun-video', tts: 'aliyun-tts', text: 'deepseek', asr: 'tencent-asr', autoSpeak: false }
const KEY = 'zhiyou-ai-settings-v1'
function readSettings(api) {
  let settings
  try { settings = Object.assign({}, DEFAULTS, (api || wx).getStorageSync(KEY) || {}) } catch (_) { settings = Object.assign({}, DEFAULTS) }
  const choices = { text: ['deepseek', 'aliyun-text', 'doubao-text', 'zhipu-text'], image: ['aliyun-image', 'zhipu-image', 'doubao-image'], video: ['aliyun-video', 'zhipu-video', 'doubao-video'], tts: ['aliyun-tts', 'tencent-tts', 'doubao-tts', 'zhipu-tts'], asr: ['tencent-asr', 'zhipu-asr', 'doubao-asr'] }
  for (const kind of Object.keys(choices)) if (!choices[kind].includes(settings[kind])) settings[kind] = DEFAULTS[kind]
  return settings
}
function saveSettings(value) { wx.setStorageSync(KEY, Object.assign({}, readSettings(), value)) }
module.exports = { readSettings, saveSettings }

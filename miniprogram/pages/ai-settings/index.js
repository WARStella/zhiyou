const api = require('../../utils/api')
const { readSettings, saveSettings } = require('../../utils/ai-settings')
const DESCRIPTIONS = { asr: '选择语音输入的识别服务', text: '选择怎样回答你的问题', image: '为景点讲解生成辅助画面', video: '把景点故事变成简短画面', tts: '听更新后的路线与下一步安排' }
const ICONS = { asr: 'mic', text: 'text', image: 'image', video: 'film', tts: 'mic' }
const FRIENDLY_NAMES = { 'zhipu-image': 'CogView-3-Flash', 'doubao-image': 'Seedream 5.0 Flash', 'zhipu-video': 'CogVideoX-Flash', 'doubao-video': 'Seedance 1.0 Pro Fast', 'zhipu-tts': 'GLM-TTS', 'tencent-asr': '腾讯云实时识别', 'zhipu-asr': 'GLM-ASR-2512', 'doubao-asr': '豆包录音识别', 'zhipu-text': '4.7flash', 'doubao-tts': '豆包语音播报', 'doubao-text': '豆包', 'aliyun-image': '千问生图', 'aliyun-video': '万相', 'aliyun-tts': '千问语音', 'tencent-tts': '腾讯云播报', 'aliyun-text': '千问', deepseek: 'DeepSeek V4.1 Flash' }
Page({
  data: { rows: [], error: '', loading: true, autoSpeak: false, detailsOpen: false, saveNote: '选择会自动保存，仅在本机生效' },
  onShow() { this.load() },
  onUnload() { this.loadToken = (this.loadToken || 0) + 1 },
  async load() {
    const token = this.loadToken = (this.loadToken || 0) + 1
    this.setData({ loading: true, error: '' })
    try {
      const data = await api.callApiStrict('media.catalog', {})
      if (token !== this.loadToken) return
      this.options = data.options || []
      this.render()
    } catch (e) { if (token === this.loadToken) this.setData({ error: '暂时无法读取服务列表，请稍后重新加载。', loading: false }) }
  },
  render() {
    const settings = readSettings(), labels = { text: '文字回答', image: '讲解配图', video: '讲解短片', tts: '路线语音播报', asr: '语音识别' }
    const rows = Object.keys(labels).map(kind => {
      const options = (this.options || []).filter(o => o.kind === kind && o.id !== 'compatible-text').map(o => ({ ...o,
        display: o.label + ' · ' + o.model + (o.configured ? '' : '（待启用）') }))
      const index = options.findIndex(o => o.id === settings[kind]), selected = options[index]
      return { kind, label: labels[kind], icon: ICONS[kind], description: DESCRIPTIONS[kind], options,
        index: Math.max(0, index), value: selected ? selected.display : '请选择模型',
        name: selected ? FRIENDLY_NAMES[selected.id] || selected.label : '请选择模型', model: selected ? selected.model : '',
        voice: selected ? selected.voice || '' : '', configured: Boolean(selected && selected.configured),
        status: selected && selected.configured ? '凭据已填写 · 待实际使用验证' : '尚未启用',
        optionNote: kind === 'asr' ? selected && selected.id === 'tencent-asr' ? '实时转文字' : selected && selected.id === 'zhipu-asr' ? '录完后转文字，每段最多30秒' : '录完后转文字，每段最多60秒' : '可选 ' + options.length + ' 个模型', empty: options.length === 0 }
    })
    this.setData({ rows, autoSpeak: settings.autoSpeak, loading: false, error: '' })
  },
  change(e) {
    const kind = e.currentTarget.dataset.kind, row = this.data.rows.find(r => r.kind === kind)
    const option = row && row.options[Number(e.detail.value)]
    if (!option) return
    try {
      saveSettings({ [kind]: option.id }); this.render()
      this.setData({ saveNote: '已保存，下次使用' + row.label + '时生效' })
    } catch (_) { this.setData({ error: '未能保存选择，请重新尝试。' }) }
  },
  toggleAuto(e) {
    try { saveSettings({ autoSpeak: e.detail.value }); this.render(); this.setData({ saveNote: e.detail.value ? '已开启：路线修改确认后自动播报' : '已关闭自动播报，仍可手动播放' }) }
    catch (_) { this.setData({ error: '未能保存偏好，请重新尝试。' }) }
  },
  toggleDetails() { this.setData({ detailsOpen: !this.data.detailsOpen }) },
})

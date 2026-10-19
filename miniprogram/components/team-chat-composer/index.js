const api = require('../../utils/api')
const { createSpeechInput, appendSpeech } = require('../../utils/speech-input')

Component({
  properties: { crewId: { type: String, value: '' } },
  data: { text: '', inputFocused: false, sending: false, uncertain: false, blocked: false, error: '', speechDraft: false,
    voiceActive: false, voiceCanStop: false, voiceStatus: 'idle', preview: '', voiceError: '', permissionDenied: false },
  observers: { crewId() { this.resetCrew() } },
  lifetimes: {
    attached() { this.alive = true; this.visible = true; this.resetCrew() },
    detached() { this.dispose() },
  },
  pageLifetimes: { show() { this.activate() }, hide() { this.suspend() } },
  methods: {
    resetCrew(force) {
      if (!force && this.boundCrew === this.properties.crewId) return
      this.boundCrew = this.properties.crewId
      this.generation = (this.generation || 0) + 1
      if (this.speech) this.speech.cancel()
      this.pending = null
      this.setData({ text: '', inputFocused: false, sending: false, uncertain: false, blocked: false, error: '', speechDraft: false,
        voiceActive: false, voiceCanStop: false, voiceStatus: 'idle', preview: '', voiceError: '', permissionDenied: false })
    },
    activate() {
      this.visible = true
      this.generation = (this.generation || 0) + 1
      this.setData({ sending: false, uncertain: Boolean(this.pending) })
    },
    suspend() {
      this.visible = false
      this.generation = (this.generation || 0) + 1
      if (this.speech) this.speech.cancel()
      this.setData({ inputFocused: false, sending: false, uncertain: Boolean(this.pending), voiceActive: false,
        voiceCanStop: false, voiceStatus: 'idle', preview: '', voiceError: '', permissionDenied: false })
    },
    dispose() {
      this.alive = false; this.visible = false; this.generation = (this.generation || 0) + 1
      if (this.speech) this.speech.dispose()
      this.pending = null
    },
    live(generation) {
      if (!this.alive || !this.visible || this.generation !== generation || this.data.blocked || !this.properties.crewId) return false
      if (wx.getStorageSync('zhiyou-active-crew') !== this.properties.crewId) {
        this.block('队伍已变化，请返回当前队伍后再发送。')
        return false
      }
      return true
    },
    block(message) {
      this.resetCrew(true)
      this.setData({ blocked: true, error: message })
      this.triggerEvent('accessdenied', { message })
    },
    onText(e) {
      if (this.live(this.generation) && !this.data.sending && !this.data.uncertain) this.setData({ text: e.detail.value })
    },
    focusText() {
      if (!this.live(this.generation) || this.data.sending || this.data.uncertain) return
      if (this.data.voiceActive && this.data.voiceStatus !== 'canceling' && this.speech) this.speech.cancel()
      this.setData({ inputFocused: true })
    },
    blurText() { this.setData({ inputFocused: false }) },
    onVoiceResult(text) {
      if (!this.live(this.recordGeneration) || this.recordCrew !== this.properties.crewId || this.data.sending || this.data.uncertain) return
      const merged = appendSpeech(this.data.text, text, 1000)
      if (merged === null) { this.setData({ error: '转写后超过 1000 字，请分次发送；原文字已保留。' }); return }
      this.setData({ text: merged, speechDraft: true, error: '' })
    },
    tapVoice() {
      if (!this.live(this.generation) || this.data.sending || this.data.uncertain) return
      this.setData({ inputFocused: false })
      if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard({})
      if (!this.speech) this.speech = createSpeechInput({ wx,
        onState: state => {
          if (!this.live(this.recordGeneration) || this.recordCrew !== this.properties.crewId) return
          this.setData({ voiceStatus: state.status, preview: state.preview || '', voiceError: state.error || '',
            permissionDenied: Boolean(state.permissionDenied),
            voiceActive: ['authorizing', 'starting', 'recording', 'recognizing', 'canceling'].includes(state.status),
            voiceCanStop: ['starting', 'recording'].includes(state.status) })
        },
        onResult: text => this.onVoiceResult(text),
      })
      if (this.data.voiceCanStop) this.speech.stop()
      else if (!this.data.voiceActive) {
        this.recordGeneration = this.generation; this.recordCrew = this.properties.crewId; this.speech.start()
      }
    },
    cancelVoice() { if (this.speech) this.speech.cancel() },
    openRecordSettings() {
      if (!this.data.voiceActive && typeof wx.openSetting === 'function') wx.openSetting({})
    },
    async sendMessage() {
      if (!this.live(this.generation) || this.data.sending || this.data.voiceActive) return
      if (!this.pending) {
        const text = this.data.text.trim()
        if (!text || text.length > 1000) { this.setData({ error: '请输入 1—1000 字的消息' }); return }
        this.pending = { crewId: this.properties.crewId, clientMessageId: api.newRequestId(), text,
          source: this.data.speechDraft ? 'speech' : 'text' }
        this.setData({ text })
      }
      const pending = this.pending, generation = this.generation
      this.setData({ sending: true, uncertain: false, error: '' })
      try {
        // 已知离线时不把写请求交给 SDK 等待网络恢复；恢复后由用户手动重试。
        if (typeof wx.getNetworkType === 'function') {
          const network = await new Promise(resolve => wx.getNetworkType({
            success: resolve, fail: () => resolve({ networkType: 'unknown' }),
          }))
          if (!this.live(generation) || this.pending !== pending) return
          if (!network || ['none', 'unknown'].includes(network.networkType)) {
            this.setData({ uncertain: true, error: network && network.networkType === 'none'
              ? '当前无网络，消息尚未发送。恢复网络后请手动点击重试。'
              : '暂时无法确认网络，消息尚未发送，请检查网络后手动重试。' })
            return
          }
        }
        const result = await api.callApi('chat.send', pending)
        if (!this.live(generation) || this.pending !== pending) return
        if (!result || !result.ok) {
          const error = result && result.error || { code: 'CLOUD_CALL_FAILED', message: '暂时无法发送' }
          if (['FORBIDDEN_NOT_MEMBER', 'AUTH_REQUIRED'].includes(error.code)) { this.block(error.message); return }
          const uncertain = !error.code || ['CLOUD_CALL_FAILED', 'INTERNAL'].includes(error.code)
          if (!uncertain) this.pending = null
          this.setData({ uncertain, error: uncertain ? '发送结果待确认，点击重试不会重复发送。' : error.message })
          return
        }
        this.pending = null
        this.setData({ text: '', speechDraft: false, uncertain: false, error: '' })
        this.triggerEvent('sent', { message: result.data.message, serverTime: result.meta && result.meta.serverTime })
      } catch (_) {
        if (this.live(generation) && this.pending === pending) this.setData({ uncertain: true, error: '发送结果待确认，请重试。' })
      } finally {
        if (this.live(generation) && (!this.pending || this.pending === pending)) this.setData({ sending: false })
      }
    },
  },
})

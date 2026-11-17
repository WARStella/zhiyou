const { createSpeechInput } = require('../../utils/speech-input')

Component({
  properties: { disabled: { type: Boolean, value: false }, contextKey: { type: String, value: '' },
    hint: { type: String, value: '录音按偏好中选择的服务转文字；结束后追加到输入框，检查后再提交。' } },
  data: { status: 'idle', preview: '', error: '', permissionDenied: false, active: false,
    canStop: false, buttonLabel: '语音输入', message: '' },
  observers: {
    disabled(value) { if (value && this.speech) this.speech.cancel() },
    contextKey() { if (this.speech) this.speech.cancel() },
  },
  lifetimes: {
    detached() { if (this.speech) this.speech.dispose() },
  },
  pageLifetimes: {
    hide() { if (this.speech) this.speech.cancel() },
  },
  methods: {
    tapVoice() {
      if (this.properties.disabled) return
      if (!this.speech) this.speech = createSpeechInput({ wx,
        onState: state => {
          const status = state.status
          const active = ['authorizing', 'starting', 'recording', 'recognizing', 'canceling'].includes(status)
          const canStop = status === 'recording' || status === 'starting'
          this.triggerEvent('state', { active })
          this.setData(Object.assign({}, state, { active, canStop,
            buttonLabel: canStop ? '结束录音' : status === 'recognizing' ? '等待最终文字…'
              : status === 'canceling' ? '正在取消…' : status === 'authorizing' ? '等待授权…' : '语音输入',
            message: status === 'recording' ? '正在录音，说完点“结束录音”。智谱每段最多30秒，其他服务最多60秒。'
              : status === 'done' ? '已识别，请检查输入框，修改后再提交。' : '',
          }))
        },
        onResult: text => {
          if (!this.properties.disabled && this.recordContext === this.properties.contextKey) {
            this.triggerEvent('result', { text, contextKey: this.recordContext })
          }
        },
      })
      if (this.data.canStop) this.speech.stop()
      else if (!this.data.active) { this.recordContext = this.properties.contextKey; this.speech.start() }
    },
    cancelVoice() { if (this.speech) this.speech.cancel() },
    openRecordSettings() {
      if (!this.data.active && typeof wx.openSetting === 'function') wx.openSetting({})
    },
  },
})

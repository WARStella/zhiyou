const api = require('../../utils/api')
const { readSettings } = require('../../utils/ai-settings')
const voiceLabel = () => ({ 'aliyun-tts': '千问语音', 'tencent-tts': '腾讯云播报', 'doubao-tts': '豆包语音播报', 'zhipu-tts': 'GLM-TTS' })[readSettings().tts] || '千问语音'
Component({
  properties: { tripId: String, version: Number },
  data: { busy: false, playing: false, error: '', summary: '', canSpeak: false, hasPlayed: false, summaryOpen: false, providerLabel: '', statusText: '修改已生效' },
  observers: { 'tripId, version': function () { if (this.voiceReady) this.changed() } },
  lifetimes: {
    attached() { this.voiceReady = true; this.visible = true; this.token = 0; this.changed() },
    detached() { this.visible = false; this.stop() },
  },
  pageLifetimes: { hide() { this.visible = false; this.stop() }, show() { this.visible = true; this.setData({ providerLabel: voiceLabel() }) } },
  methods: {
    stop() {
      this.token = (this.token || 0) + 1
      if (this.audio) { this.audio.stop(); this.audio.destroy(); this.audio = null }
      if (this.path) { try { wx.getFileSystemManager().unlink({ filePath: this.path, fail() {} }) } catch (_) {} this.path = '' }
      this.setData({ busy: false, playing: false, statusText: this.data.hasPlayed ? '播报已停止' : '修改已生效' })
    },
    changed() {
      this.stop(); this.setData({ summary: '', error: '', summaryOpen: false, hasPlayed: false, statusText: '修改已生效',
        providerLabel: voiceLabel(), canSpeak: Boolean(this.data.tripId && this.data.version > 1) })
      if (this.visible && this.data.tripId && this.data.version > 1 && readSettings().autoSpeak) this.play()
    },
    toggleSummary() { this.setData({ summaryOpen: !this.data.summaryOpen }) },
    settings() { wx.navigateTo({ url: '/pages/ai-settings/index' }) },
    async play() {
      if (this.data.busy || !this.visible) return
      this.stop()
      const token = this.token, tripId = this.data.tripId, version = this.data.version
      const current = () => this.visible && token === this.token && this.data.tripId === tripId && this.data.version === version
      this.setData({ busy: true, error: '', providerLabel: voiceLabel(), statusText: '正在准备语音…' })
      try {
        const task = await api.callApiStrict('media.speakTrip', { tripId, version, optionId: readSettings().tts })
        if (!current()) return
        if (task.status !== 'succeeded') throw Object.assign(new Error(task.message || '语音尚未生成'), { code: task.status === 'unknown' ? 'MEDIA_RESULT_UNKNOWN' : 'MEDIA_UPSTREAM_FAILED' })
        const latest = await api.callApiStrict('media.get', { taskId: task.taskId })
        if (!current()) return
        if (latest.status !== 'succeeded') throw new Error('语音已过期，请刷新后重试')
        let src = latest.url
        if (latest.audioBase64) {
          if (!['mp3', 'wav'].includes(latest.format)) throw new Error('语音音频格式不支持')
          const path = wx.env.USER_DATA_PATH + '/route-voice-' + Date.now() + '-' + token + '.' + latest.format
          await new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath: path, data: latest.audioBase64, encoding: 'base64', success: resolve, fail: reject }))
          if (!current()) { wx.getFileSystemManager().unlink({ filePath: path, fail() {} }); return }
          this.path = path; src = path
        }
        if (!src) throw new Error('语音未返回可播放结果')
        const audio = wx.createInnerAudioContext(); this.audio = audio; audio.src = src
        audio.onEnded(() => { if (current()) { this.stop(); this.setData({ statusText: '播报已完成' }) } })
        audio.onError(() => { if (current()) { this.stop(); this.setData({ error: '播放暂时中断，请检查网络后重播。', statusText: '播放已中断' }) } })
        this.setData({ busy: false, playing: true, hasPlayed: true, summary: latest.text, statusText: '正在播报新安排' }); audio.play()
      } catch (e) {
        if (current()) {
          const message = e.code === 'MEDIA_NOT_CONFIGURED' ? '所选语音服务尚未启用，可在偏好里选择其他服务。'
            : e.code === 'VERSION_CONFLICT' ? '行程已更新，请刷新安排后播放最新版本。'
              : e.code === 'MEDIA_RESULT_UNKNOWN' ? '语音请求结果待确认，请稍后查看，避免重复生成。'
                : '语音暂时不可用，行程修改已生效。可稍后重播或更换语音服务。'
          this.setData({ busy: false, error: message, statusText: '暂未播放' })
        }
      }
    },
  },
})

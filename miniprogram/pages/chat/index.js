const api = require('../../utils/api')
const { appendSpeech } = require('../../utils/speech-input')
const CREW_KEY = 'zhiyou-active-crew'
const unavailable = e => e && ['FORBIDDEN_NOT_MEMBER', 'AUTH_REQUIRED'].includes(e.code)
const timeLabel = value => {
  const d = new Date(value)
  return [d.getMonth() + 1, d.getDate()].join('/') + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

Page({
  data: { crewId: '', messages: [], text: '', speechDraft: false, sending: false, uncertain: false,
    loading: false, loadingHistory: false, hasHistory: false, locked: false, error: '', syncError: '',
    newCount: 0, scrollTo: '', voiceContext: '', initialized: false },
  onLoad(options) {
    this.setData({ crewId: options && options.crewId || wx.getStorageSync(CREW_KEY) || '' })
    this.generation = 0
    this.cursor = 0
  },
  onShow() {
    this.visible = true
    this.generation = (this.generation || 0) + 1
    this.refreshing = false
    this.setData({ loadingHistory: false })
    if (!this.data.crewId || wx.getStorageSync(CREW_KEY) !== this.data.crewId) {
      this.lock('当前队伍已变化，请返回队伍页重新进入聊天。')
      return
    }
    this.setData({ voiceContext: this.data.crewId + ':' + this.generation })
    return this.refreshMessages()
  },
  onHide() { this.stop() },
  onUnload() { this.stop(); this.pending = null },
  stop() {
    this.visible = false
    this.generation = (this.generation || 0) + 1
    clearTimeout(this.pollTimer)
    this.pollTimer = null
    this.setData({ voiceContext: '', loading: false, loadingHistory: false, sending: false,
      uncertain: Boolean(this.pending) })
  },
  live(generation) {
    if (!this.visible || this.generation !== generation || this.data.locked) return false
    if (wx.getStorageSync(CREW_KEY) !== this.data.crewId) {
      this.lock('当前队伍已变化，请返回队伍页重新进入聊天。')
      return false
    }
    return true
  },
  lock(message) {
    this.stop()
    this.pending = null
    this.setData({ locked: true, messages: [], text: '', speechDraft: false, sending: false,
      uncertain: false, newCount: 0, syncError: '', error: message })
  },
  async call(action, payload) {
    const r = await api.callApi(action, payload)
    if (!r || !r.ok) throw api.toError ? api.toError(r) : Object.assign(new Error(r && r.error && r.error.message || '请求失败'),
      { code: r && r.error && r.error.code })
    return r.data
  },
  merge(messages) {
    const rows = new Map(this.data.messages.map(m => [m.messageId, m]))
    for (const row of messages) rows.set(row.messageId, Object.assign({}, row, { timeLabel: timeLabel(row.sentAt) }))
    this.setData({ messages: Array.from(rows.values()).sort((a, b) => a.seq - b.seq) })
    // 超时后轮询发现自己的消息也视为送达，不要求再点一次发送。
    if (this.pending && messages.some(m => m.isMine && m.clientMessageId === this.pending.clientMessageId)) this.acknowledge()
  },
  acknowledge() {
    const sent = this.pending
    this.pending = null
    this.setData({ sending: false, uncertain: false, error: '',
      text: sent && this.data.text === sent.text ? '' : this.data.text,
      speechDraft: sent && this.data.text === sent.text ? false : this.data.speechDraft })
  },
  async refreshMessages() {
    if (!this.visible || this.data.locked || this.refreshing) return
    const generation = this.generation, initial = !this.data.initialized
    if (!this.live(generation)) return
    clearTimeout(this.pollTimer)
    this.refreshing = true
    if (initial) this.setData({ loading: true })
    let nextDelay = 3000
    try {
      const p = { crewId: this.data.crewId, limit: 30 }
      if (!initial) p.afterSeq = this.cursor
      const data = await this.call('chat.list', p)
      if (!this.live(generation)) return
      const added = data.messages.filter(m => !this.data.messages.some(old => old.messageId === m.messageId)).length
      this.merge(data.messages)
      this.cursor = data.latestSeq
      this.failures = 0
      this.setData({ initialized: true, syncError: '', loading: false,
        hasHistory: initial ? data.hasMore : this.data.hasHistory,
        newCount: initial ? 0 : this.data.newCount + added })
      if (initial) this.jumpLatest()
      if (!initial && data.hasMore) nextDelay = 100
    } catch (e) {
      if (!this.live(generation)) return
      if (unavailable(e)) { this.lock(e.message); return }
      this.failures = (this.failures || 0) + 1
      nextDelay = Math.min(15000, 3000 * Math.pow(2, this.failures))
      this.setData({ syncError: e.message || '消息暂时无法更新，请重试', loading: false })
    } finally {
      if (this.live(generation)) {
        this.refreshing = false
        this.pollTimer = setTimeout(() => this.refreshMessages(), nextDelay)
      }
    }
  },
  async loadHistory() {
    if (!this.live(this.generation)) return
    if (!this.data.hasHistory || this.data.loadingHistory || !this.data.messages.length) return
    const generation = this.generation, first = this.data.messages[0]
    this.setData({ loadingHistory: true })
    try {
      const data = await this.call('chat.list', { crewId: this.data.crewId, beforeSeq: first.seq, limit: 30 })
      if (!this.live(generation)) return
      this.merge(data.messages)
      this.setData({ hasHistory: data.hasMore, scrollTo: 'message-' + first.messageId, syncError: '' })
    } catch (e) {
      if (!this.live(generation)) return
      if (unavailable(e)) this.lock(e.message)
      else this.setData({ syncError: e.message })
    } finally {
      if (this.live(generation)) this.setData({ loadingHistory: false })
    }
  },
  jumpLatest() {
    const last = this.data.messages[this.data.messages.length - 1]
    this.setData({ scrollTo: '', newCount: 0 })
    if (last) this.setData({ scrollTo: 'message-' + last.messageId })
  },
  onText(e) {
    if (!this.data.locked && !this.data.sending && !this.data.uncertain) this.setData({ text: e.detail.value })
  },
  onVoice(e) {
    if (!this.visible || this.data.locked || this.data.sending || this.data.uncertain ||
      e.detail.contextKey !== this.data.voiceContext || !this.live(this.generation)) return
    const text = appendSpeech(this.data.text, e.detail.text, 1000)
    if (text === null) { this.setData({ error: '合并后超过 1000 字，请分次发送；原文字已保留。' }); return }
    this.setData({ text, speechDraft: true, error: '' })
  },
  async sendMessage() {
    if (this.data.sending || !this.live(this.generation)) return
    const text = this.data.text.trim()
    if (!this.pending) {
      if (!text || text.length > 1000) { this.setData({ error: '请输入 1—1000 字的消息' }); return }
      this.pending = { crewId: this.data.crewId, clientMessageId: api.newRequestId(), text,
        source: this.data.speechDraft ? 'speech' : 'text' }
      // 固定本次待发送内容；网络不确定时，重试始终沿用同一个消息编号和正文。
      this.setData({ text })
    }
    const generation = this.generation, pending = this.pending
    this.setData({ sending: true, uncertain: false, error: '' })
    try {
      const data = await this.call('chat.send', pending)
      if (!this.live(generation)) return
      this.merge([data.message])
      this.jumpLatest()
      // 不能用刚发送消息的序号推进拉取游标，否则会漏掉同时到来的队友消息。
      this.refreshMessages()
    } catch (e) {
      if (!this.live(generation) || this.pending !== pending) return
      if (unavailable(e)) { this.lock(e.message); return }
      const uncertain = !e.code || ['CLOUD_CALL_FAILED', 'INTERNAL'].includes(e.code)
      if (!uncertain) this.pending = null
      this.setData({ uncertain, sending: false, error: uncertain
        ? '发送结果尚未确认，请重试；同一条消息不会重复发送。' : e.message })
    } finally {
      if (this.live(generation) && (!this.pending || this.pending === pending)) this.setData({ sending: false })
    }
  },
})

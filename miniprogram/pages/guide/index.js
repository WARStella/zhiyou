const api = require('../../utils/api')
const { createGuideAssistant, initialGuideState } = require('../../utils/guide-assistant')
const { appendSpeech } = require('../../utils/speech-input')
const { choiceIndex, clarificationValue, replyText, searchTimeLabel } = require('../../utils/guide-conversation')
const { readSettings } = require('../../utils/ai-settings')
Page({
  data: { ...initialGuideState(), messages: [], activeReplyId: '', scrollTarget: '', voiceActive: false,
    voiceOpen: false, voiceContext: 'guide-0', moreActionsOpen: false, chatHeight: 667, keyboardHeight: 0, sending: false, textModelLabel: 'DeepSeek V4.1 Flash' },
  onLoad(query) {
    this.guideVisible = true; this.chatGeneration = 0; this.messageSequence = 0; this.guideVoiceGeneration = 0
    this.measureWindow()
    const personalTrip = wx.getStorageSync('zhiyou-active-trip')
    const scope = personalTrip && personalTrip.tripId ? 'trip' : query && query.scope === 'team' ? 'team' : 'trip'
    this.setData({ scopeLabel: scope === 'team' ? '队伍共同路线' : '当前个人行程', mediaCrewId: wx.getStorageSync('zhiyou-active-crew') || '' })
    this.guide = createGuideAssistant({ wx, callApi: api.callApi, newRequestId: api.newRequestId, scope,
      getCrewId: () => wx.getStorageSync('zhiyou-active-crew') || null,
      getTripId: () => { const saved = wx.getStorageSync('zhiyou-active-trip'); return scope === 'team' ? null : saved && saved.tripId || null },
      onState: patch => {
        if (Object.prototype.hasOwnProperty.call(patch, 'result')) {
          patch = { ...patch, mediaAvailable: Boolean(patch.result && patch.result.place && patch.result.evidence && patch.result.evidence.length && patch.result.sources && patch.result.sources.length), mediaCrewId: wx.getStorageSync('zhiyou-active-crew') || '' }
          patch = { ...patch, voiceContext: 'guide-' + (++this.guideVoiceGeneration) }
          // Full reset: do not retain another crew's local conversation.
          if (patch.result === null && Object.prototype.hasOwnProperty.call(patch, 'center')) {
            this.chatGeneration++
            patch = { ...patch, messages: [], activeReplyId: '', sending: false }
          }
        }
        this.setData(patch)
      } })
  },
  measureWindow(size) {
    let info = size || {}
    if (!size) try { info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync() } catch (_) {}
    this.windowHeight = info.windowHeight || 667
    this.setData({ chatHeight: Math.max(220, this.windowHeight - this.data.keyboardHeight) })
  },
  onResize(e) { this.measureWindow(e.size) },
  onKeyboardHeight(e) {
    const height = Math.max(0, Number(e.detail.height) || 0)
    this.setData({ keyboardHeight: height, chatHeight: Math.max(220, this.windowHeight - height) }); this.scrollLatest()
  },
  onShow() { this.guideVisible = true; this.refreshModelLabel(); if (this.guide) this.guide.show() },
  refreshModelLabel() { const id = readSettings().text; this.setData({ textModelLabel: id === 'zhipu-text' ? '4.7flash' : id === 'doubao-text' ? '豆包' : id === 'aliyun-text' ? '千问' : 'DeepSeek V4.1 Flash' }) },
  openPreferences() { if (!this.data.busy && !this.data.sending && !this.data.voiceActive) wx.navigateTo({ url: '/pages/ai-settings/index' }) },
  onMediaLayout(e) { if (!e || !e.currentTarget || e.currentTarget.dataset.reply === this.data.activeReplyId) this.scrollLatest() },
  onHide() {
    this.guideVisible = false; this.chatGeneration++
    this.setData({ voiceActive: false, keyboardHeight: 0, chatHeight: this.windowHeight || 667, sending: false,
      messages: this.data.messages.map(m => m.pending ? { ...m, pending: false, failed: true, text: '本次回答已中断，请重新发送。' } : m) })
    if (this.guide) this.guide.hide()
  },
  onUnload() { this.chatGeneration++; if (this.guide) this.guide.dispose() },
  scrollLatest() {
    const last = this.data.messages[this.data.messages.length - 1]
    if (!last) return
    this.setData({ scrollTarget: '' })
    const update = () => { if (this.guideVisible) this.setData({ scrollTarget: last.id }) }
    if (wx.nextTick) wx.nextTick(update); else update()
  },
  async converse(text, task, options = {}) {
    if (!this.guideVisible || this.data.busy || this.data.sending || this.data.voiceActive) return
    const generation = ++this.chatGeneration
    const userId = 'message-' + (++this.messageSequence), replyId = 'message-' + (++this.messageSequence)
    const previousResult = this.data.result, previousCrowd = this.data.crowdResult
    this.setData({ sending: true, moreActionsOpen: false, activeReplyId: '', error: '',
      messages: this.data.messages.concat([
        { id: userId, role: 'user', text, imagePath: options.imagePath || '' },
        { id: replyId, role: 'assistant', text: '', pending: true, pendingLabel: options.pendingLabel || '正在整理回答…' },
      ]) })
    this.scrollLatest()
    let localAnswer
    try { localAnswer = await task() } catch (_) { if (generation === this.chatGeneration) this.setData({ error: '本次请求未完成，请重试。' }) }
    if (!this.guideVisible || generation !== this.chatGeneration) return
    const result = this.data.result, crowd = this.data.crowdResult
    const changedResult = result && result !== previousResult, changedCrowd = crowd && crowd !== previousCrowd
    const failed = Boolean(this.data.error)
    const reply = { id: replyId, role: 'assistant', pending: false, failed, sourcesOpen: false,
      text: failed ? this.data.error : options.answer || (typeof localAnswer === 'string' ? localAnswer : '') ||
        (changedCrowd ? '照片中检测到约 ' + crowd.count + ' 人。' : changedResult ? replyText(result) : options.fallback || '已处理，可以继续提问。'),
      knowledgeOrigin: !failed && changedResult ? result.knowledgeOrigin || '' : '',
      searchTimeLabel: !failed && changedResult && result.knowledgeOrigin === 'web' ? searchTimeLabel(result.searchedAt) : '',
      sources: !failed && changedResult ? result.sources || [] : [], notices: !failed && changedResult ? result.notices || [] : [],
      merchants: !failed && changedResult ? (result.merchants || []).map(row => ({ ...row, distanceLabel: row.distanceMeters < 1000 ? Math.round(row.distanceMeters) + ' 米' : (row.distanceMeters / 1000).toFixed(1) + ' 公里', ratingLabel: row.rating ? row.rating.value + ' 分' : '暂无评分', costLabel: row.averageCost !== null ? '人均约 ¥' + row.averageCost : '暂无人均消费' })) : [],
      rankingNote: !failed && changedResult ? result.rankingNote || '' : '',
      candidates: !failed && changedResult ? result.candidates || [] : [],
      mediaAvailable: Boolean(!failed && changedResult && result.place && result.evidence && result.evidence.length && result.sources && result.sources.length),
      mediaPreferredKind: !failed && changedResult ? result.requestedMediaKind || '' : '',
      mediaSessionId: !failed && changedResult ? result.sessionId || '' : '', mediaVersion: !failed && changedResult ? result.version : 0,
      mediaCrewId: this.data.mediaCrewId || '', appliedTrip: !failed && changedResult ? result.appliedTrip || null : null,
      questions: !failed && this.data.tripChange && this.data.tripChange.needsClarification ? this.data.changeQuestions.map(q => q.prompt) : [],
      crowd: !failed && changedCrowd ? crowd : null, crowdImagePath: changedCrowd ? this.data.crowdImagePath : '',
      crowdBoxes: changedCrowd ? this.data.crowdBoxes : [] }
    this.setData({ sending: false, messages: this.data.messages.map(m => m.id === replyId ? reply : m),
      activeReplyId: !changedCrowd && result ? replyId : '' })
    if (!failed) { this.guide.setText(''); if (changedCrowd) this.guide.removeImage() }
    this.scrollLatest()
  },
  onText(e) { this.guide.setText(e.detail.value) },
  toggleMoreActions() { if (!this.data.voiceActive) this.setData({ moreActionsOpen: !this.data.moreActionsOpen }) },
  toggleVoice() { if (!this.data.voiceActive && !this.data.busy) this.setData({ voiceOpen: !this.data.voiceOpen }) },
  toggleSources(e) { const id = e.currentTarget.dataset.message; this.setData({ messages: this.data.messages.map(m => m.id === id ? { ...m, sourcesOpen: !m.sourcesOpen } : m) }) },
  onVoice(e) {
    if (!this.guideVisible) return
    const merged = appendSpeech(this.data.text, e.detail.text, 1000)
    if (merged === null) this.setData({ error: '追加后超过1000字，请分次提问' }); else this.guide.setText(merged)
  },
  onVoiceState(e) { if (this.guideVisible) this.setData({ voiceActive: Boolean(e.detail.active) }) },
  ask() {
    if (this.data.voiceActive) { this.setData({ error: '请先结束语音识别，检查文字后再提问' }); return }
    if (this.data.busy || this.data.sending) return
    const text = this.data.text.trim(), photo = this.data.imagePath, result = this.data.result
    if (!text && !photo) return this.guide.ask()
    if (!photo && result && result.candidates && result.candidates.length) {
      const index = choiceIndex(text, result.candidates)
      if (index !== -1) return this.confirmPlace({ currentTarget: { dataset: { id: result.candidates[index].id } } }, text)
    }
    const change = this.data.tripChange
    if (!photo && change && !change.needsClarification) {
      if (/^(?:放弃|取消)(?:这次|本次)?修改[。！!]*$|^保持原计划[。！!]*$/.test(text)) return this.discardChange()
      const index = choiceIndex(text.replace(/方案/g, ''), this.data.changeCandidates)
      const explicit = /^(?:确认|采用|应用)(?:修改|方案)?[。！!]*$/.test(text)
      const candidates = this.data.changeCandidates
      const selected = index !== -1 ? candidates[index] : explicit && candidates.length === 1 ? candidates[0] : null
      if (selected && selected.feasible) return this.confirmChange({ currentTarget: { dataset: { id: selected.candidateId } } })
    }
    if (!photo && change && change.needsClarification) {
      const question = this.data.changeQuestions.find(q => !Object.prototype.hasOwnProperty.call(this.data.changeAnswers, q.key))
      const value = question ? clarificationValue(question, text) : null
      if (value !== null) return this.converse(text, async () => {
        this.guide.answerChange(question.key, value)
        const next = this.data.changeQuestions.find(q => !Object.prototype.hasOwnProperty.call(this.data.changeAnswers, q.key))
        if (!next) await this.guide.continueChange()
        else return '已记录。' + next.prompt
      }, { fallback: '已记录，请继续补充下面的问题。' })
    }
    if (!photo && /^(你好|您好|嗨|你能做什么|怎么用)[？?！!。]*$/.test(text))
      return this.converse(text, async () => '你好，我是你的随行助手。可以问我下一站安排、集合进度、景点历史，也可以直接说要怎样修改行程。发来地标照片可以找地点，问“照片里有多少人”可以统计人数。涉及行程修改时，我会先给出方案，再请你确认。')
    return this.converse(text || '帮我认一下这张照片里的地点', async () => {
        if (!photo && /附近|周边|这周围/.test(text) && /好吃|吃点|吃饭|美食|餐厅|饭店|饭馆|餐馆|咖啡|奶茶|饮品|甜品|蛋糕|火锅|烧烤|超市|便利店|药店|商场|购物|酒店|宾馆/.test(text)) {
          await this.guide.locate(); if (this.data.error || !this.data.center) return
        }
        return this.guide.ask()
      },
      { imagePath: photo, pendingLabel: photo ? '正在识别照片并核对结果…' : '正在查询并整理回答…' })
  },
  confirmPlace(e, text) {
    if (e.currentTarget.dataset.reply && e.currentTarget.dataset.reply !== this.data.activeReplyId) return
    const id = e.currentTarget.dataset.id, row = ((this.data.result || {}).candidates || []).find(r => r.id === id)
    if (row) return this.converse(text || '我选“' + row.name + '”', () => this.guide.ask(id), { pendingLabel: '正在核对地点与资料…' })
  },
  choosePhoto() { return this.guide.choose() },
  removePhoto() { if (!this.data.sending && !this.data.busy) this.guide.removeImage() },
  locate() { return this.guide.locate() },
  chooseStart() { return this.guide.chooseStart() },
  setPlanStay(e) { this.guide.setPlanStay(e.detail.value) },
  setPlanMode(e) { this.guide.setPlanMode(e.detail.value) },
  confirmPlan() { return this.converse('确认生成这份行程', () => this.guide.confirmPlan(), { fallback: '本次未生成新行程。' }) },
  useMeeting() { return this.converse('用这个地点集合', () => this.guide.useMeeting(), { fallback: '本次未变更集合点。' }) },
  answerChange(e) { if (e.currentTarget.dataset.reply && e.currentTarget.dataset.reply !== this.data.activeReplyId) return; if (!this.data.sending && !this.data.voiceActive) this.guide.answerChange(e.currentTarget.dataset.key, e.currentTarget.dataset.value === undefined ? e.detail.value : e.currentTarget.dataset.value) },
  continueChange() { return this.converse('补充完成，生成方案', () => this.guide.continueChange()) },
  confirmChange(e) { if (e.currentTarget.dataset.reply && e.currentTarget.dataset.reply !== this.data.activeReplyId) return; return this.converse('确认采用这个修改方案', () => this.guide.confirmChange(e.currentTarget.dataset.id), { fallback: '未确认修改，原行程未改变。' }) },
  discardChange() { return this.converse('放弃这次修改', async () => this.guide.discardChange()) },
  navigate(e) { if (!this.data.voiceActive && !this.data.sending) return this.guide.navigate(e.currentTarget.dataset.target) },
  countPeople() { return this.converse('这张照片里有多少人？', () => this.guide.countPeople(), { imagePath: this.data.imagePath, pendingLabel: '正在检测照片中的人数…' }) },
  async askCrowd() { if (!this.data.imagePath) await this.choosePhoto(); if (this.data.imagePath) return this.countPeople() },
  clear() { if (!this.data.busy && !this.data.sending && !this.data.voiceActive) { this.setData({ moreActionsOpen: false }); return this.guide.clear() } },
  example(e) { if (!this.data.voiceActive && !this.data.sending) this.guide.setText(e.currentTarget.dataset.text) },
  copySource(e) { wx.setClipboardData({ data: e.currentTarget.dataset.url }) },
  previewPhoto(e) { if (wx.previewImage) wx.previewImage({ current: e.currentTarget.dataset.path, urls: [e.currentTarget.dataset.path] }) },
  openMerchant(e) {
    const { message: id, merchant } = e.currentTarget.dataset
    const message = this.data.messages.find(row => row.id === id)
    const row = message && (message.merchants || []).find(row => row.id === merchant)
    if (!row || !row.location) return
    wx.openLocation({ latitude: row.location.latitude, longitude: row.location.longitude, name: row.name, address: row.address || '',
      fail: () => wx.showToast({ title: '地图暂时无法打开，请稍后重试', icon: 'none' }) })
  },
  previewPlace(e) {
    const row = ((this.data.result || {}).candidates || []).find(item => item.id === e.currentTarget.dataset.id)
    if (row) wx.openLocation({ latitude: row.point.latitude, longitude: row.point.longitude, name: row.name, address: row.address,
      fail: () => this.setData({ error: '位置预览暂不可用，请核对地址后确认' }) })
  },
})


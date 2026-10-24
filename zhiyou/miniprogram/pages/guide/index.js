const api = require('../../utils/api')
const { createGuideAssistant, initialGuideState } = require('../../utils/guide-assistant')
const { appendSpeech } = require('../../utils/speech-input')

Page({
  data: { ...initialGuideState(), voiceActive: false, voiceContext: 'guide-0',
    moreActionsOpen: false, examplesOpen: false, sourcesOpen: false, traceOpen: false },
  onLoad(query) {
    this.guideVisible = true
    this.guideVoiceGeneration = 0
    const scope = query && query.scope === 'team' ? 'team' : 'trip'
    this.setData({ scopeLabel: scope === 'team' ? '队伍共同路线' : '行程页当前路线' })
    this.guide = createGuideAssistant({ wx, callApi: api.callApi, newRequestId: api.newRequestId, scope,
      getCrewId: () => wx.getStorageSync('zhiyou-active-crew') || null,
      getTripId: () => { const saved = wx.getStorageSync('zhiyou-active-trip'); return scope === 'team' ? null : saved && saved.tripId || null },
      onState: patch => {
        if (Object.prototype.hasOwnProperty.call(patch, 'result')) {
          this.guideVoiceGeneration++
          patch = { ...patch, voiceContext: 'guide-' + this.guideVoiceGeneration, sourcesOpen: false, traceOpen: false }
        }
        this.setData(patch)
        /**
         * 「数人数」快捷入口（2026-10-20）。
         *
         * 从 `askCrowd()` 进来时先弹选图；选完照片（`imagePath` 落地）就自动开始识别，
         * 用户不用再找「统计照片人数」那一步。取消选图则清掉标记，
         * 避免下一次随便拍张照片就被自动识别、白烧一次配额。
         */
        if (this.pendingCrowd && !patch.busy) {
          if (patch.imagePath) {
            this.pendingCrowd = false
            this.guide.countPeople()
          } else if (patch.choosing === false) {
            this.pendingCrowd = false
          }
        }
      } })
  },
  onShow() { this.guideVisible = true; if (this.guide) this.guide.show() },
  onHide() { this.guideVisible = false; this.setData({ voiceActive: false }); if (this.guide) this.guide.hide() },
  onUnload() { if (this.guide) this.guide.dispose() },
  onText(e) { this.guide.setText(e.detail.value) },
  toggleMoreActions() { this.setData({ moreActionsOpen: !this.data.moreActionsOpen }) },
  toggleExamples() { this.setData({ examplesOpen: !this.data.examplesOpen }) },
  toggleSources() { this.setData({ sourcesOpen: !this.data.sourcesOpen }) },
  toggleTrace() { this.setData({ traceOpen: !this.data.traceOpen }) },
  onVoice(e) {
    if (!this.guideVisible) return
    const merged = appendSpeech(this.data.text, e.detail.text, 1000)
    if (merged === null) this.setData({ error: '追加后超过 1000 字，请分次提问' })
    else this.guide.setText(merged)
  },
  onVoiceState(e) { if (this.guideVisible) this.setData({ voiceActive: Boolean(e.detail.active) }) },
  ask() {
    if (this.data.voiceActive) { this.setData({ error: '请先结束语音识别，检查文字后再提问' }); return }
    return this.guide.ask()
  },
  confirmPlace(e) { return this.guide.ask(e.currentTarget.dataset.id) },
  choosePhoto() { return this.guide.choose() },
  removePhoto() { this.guide.removeImage() },
  locate() { return this.guide.locate() },
  chooseStart() { return this.guide.chooseStart() },
  setPlanStay(e) { this.guide.setPlanStay(e.detail.value) },
  setPlanMode(e) { this.guide.setPlanMode(e.detail.value) },
  confirmPlan() { if (!this.data.voiceActive) return this.guide.confirmPlan() },
  useMeeting() { return this.guide.useMeeting() },
  answerChange(e) { this.guide.answerChange(e.currentTarget.dataset.key, e.currentTarget.dataset.value === undefined ? e.detail.value : e.currentTarget.dataset.value) },
  continueChange() { if (!this.data.voiceActive) return this.guide.continueChange() },
  confirmChange(e) { if (!this.data.voiceActive) return this.guide.confirmChange(e.currentTarget.dataset.id) },
  discardChange() { this.guide.discardChange() },
  navigate(e) { if (!this.data.voiceActive) return this.guide.navigate(e.currentTarget.dataset.target) },
  countPeople() { if (!this.data.voiceActive) return this.guide.countPeople() },
  /**
   * YOLO 人数识别的快捷入口（2026-10-20）。
   *
   * 为什么要单独一个入口：人数识别的按钮只在**选了照片之后**才出现
   * （`wx:if="{{imagePath}}"`），所以"能数人数"这件事在空页面上完全看不到。
   * 这个入口把两步并成一步：没照片就先去拍/选，选完自动开始识别；
   * 已经有照片就直接识别。
   */
  askCrowd() {
    if (this.data.voiceActive) { this.setData({ error: '请先结束语音识别，再试人数识别' }); return }
    if (this.data.busy) return
    if (this.data.imagePath) return this.guide.countPeople()
    this.pendingCrowd = true
    return this.guide.choose()
  },
  clear() { return this.guide.clear() },
  example(e) { if (!this.data.voiceActive) this.guide.setText(e.currentTarget.dataset.text) },
  copySource(e) { wx.setClipboardData({ data: e.currentTarget.dataset.url }) },
  previewPlace(e) {
    const row = (this.data.result && this.data.result.candidates || []).find(item => item.id === e.currentTarget.dataset.id)
    if (row) wx.openLocation({ latitude: row.point.latitude, longitude: row.point.longitude, name: row.name, address: row.address,
      fail: () => this.setData({ error: '位置预览暂不可用，请核对地址后确认' }) })
  },
})

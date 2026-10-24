const { createGuideEntry } = require('../../utils/guide-entry')

/** 首次进入的提示只出现一次；存储键单独一个，避免和拖动位置混在一起。 */
const HINT_KEY = 'zhiyou-guide-entry-hinted'

Component({
  properties: { scope: { type: String, value: 'trip' } },
  data: { visible: false, left: 0, top: 0, dragging: false, hint: false },
  lifetimes: {
    attached() {
      this.entry = createGuideEntry({ wx, scope: this.properties.scope, onState: state => this.setData(state) })
      this.onEntryKeyboard = event => this.entry.setKeyboardHeight(event.height)
      if (typeof wx.onKeyboardHeightChange === 'function') wx.onKeyboardHeightChange(this.onEntryKeyboard)
      this.showEntry()
      this.showHintOnce()
    },
    detached() {
      if (typeof wx.offKeyboardHeightChange === 'function') wx.offKeyboardHeightChange(this.onEntryKeyboard)
      if (this.hintTimer) clearTimeout(this.hintTimer)
      if (this.entry) this.entry.dispose()
    },
  },
  pageLifetimes: {
    show() { this.showEntry() },
    hide() { this.hideEntry() },
    resize(event) { this.resizeEntry(event.size) },
  },
  methods: {
    showEntry() { if (this.entry) this.entry.show() },
    hideEntry() { if (this.entry) this.entry.hide() },
    resizeEntry(size) { if (this.entry) this.entry.resize(size) },
    touchStart(event) { this.entry.touchStart(event) },
    touchMove(event) { this.entry.touchMove(event) },
    touchEnd(event) { this.entry.touchEnd(event) },
    touchCancel() { this.entry.touchCancel() },
    openGuide(event) { this.entry.tap(event) },

    /**
     * 去掉「游览助手」四个字之后，第一次见到这个星芒的人不知道它是干什么的。
     * 首次进入时在球的上方冒 2 秒气泡，之后不再打扰（标记写进 storage）。
     * 读存储包在 try 里：storage 异常不该阻止入口显示。
     */
    showHintOnce() {
      let hinted = false
      try { hinted = Boolean(wx.getStorageSync(HINT_KEY)) } catch (err) { hinted = false }
      if (hinted) return
      this.setData({ hint: true })
      this.hintTimer = setTimeout(() => {
        this.setData({ hint: false })
        try { wx.setStorageSync(HINT_KEY, 1) } catch (err) { /* 忽略 */ }
      }, 2200)
    },
  },
})

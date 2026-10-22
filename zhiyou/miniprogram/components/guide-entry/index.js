const { createGuideEntry } = require('../../utils/guide-entry')

Component({
  properties: { scope: { type: String, value: 'trip' } },
  data: { visible: false, left: 0, top: 0, dragging: false },
  lifetimes: {
    attached() {
      this.entry = createGuideEntry({ wx, scope: this.properties.scope, onState: state => this.setData(state) })
      this.onEntryKeyboard = event => this.entry.setKeyboardHeight(event.height)
      if (typeof wx.onKeyboardHeightChange === 'function') wx.onKeyboardHeightChange(this.onEntryKeyboard)
      this.showEntry()
    },
    detached() {
      if (typeof wx.offKeyboardHeightChange === 'function') wx.offKeyboardHeightChange(this.onEntryKeyboard)
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
  },
})

const POSITION_KEY = 'zhiyou-guide-entry-position'
const SIZE = 64
const GAP = 12
const DRAG_THRESHOLD = 8
const MAX_TAP_DURATION = 600
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback

function boundsFor(info) {
  const width = positive(info.windowWidth, 375), height = positive(info.windowHeight, 667)
  const safe = info.safeArea || {}
  const bottomInset = Number.isFinite(info.screenHeight) && Number.isFinite(safe.bottom)
    ? Math.max(0, info.screenHeight - safe.bottom) : 0
  const minX = Math.min(GAP, Math.max(0, (width - SIZE) / 2))
  const minY = Math.min(GAP, Math.max(0, (height - SIZE) / 2))
  return { minX, maxX: Math.max(minX, width - SIZE - GAP), minY,
    maxY: Math.max(minY, height - SIZE - 24 - bottomInset) }
}
function savedAnchor(value) {
  return value && (value.side === 'left' || value.side === 'right') && Number.isFinite(value.ratio)
    ? { side: value.side, ratio: clamp(value.ratio, 0, 1) } : { side: 'right', ratio: 1 }
}
function positionFor(anchor, bounds) {
  return { left: anchor.side === 'left' ? bounds.minX : bounds.maxX,
    top: Math.round(bounds.minY + anchor.ratio * (bounds.maxY - bounds.minY)) }
}
function point(touches, identifier) {
  if (!touches || touches.length !== 1) return null
  const touch = touches[0]
  if (!touch || (identifier !== undefined && touch.identifier !== undefined && touch.identifier !== identifier)) return null
  for (const [xKey, yKey] of [['clientX', 'clientY'], ['pageX', 'pageY'], ['x', 'y']]) {
    if (Number.isFinite(touch[xKey]) && Number.isFinite(touch[yKey])) {
      return { x: touch[xKey], y: touch[yKey], identifier: touch.identifier }
    }
  }
  return null
}

function createGuideEntry(options) {
  const wx = options.wx, now = options.now || Date.now
  let alive = true, shown = false, keyboardHeight = 0, gesture = null, opening = false
  let ignoreTapUntil = 0, lastNavigation = -Infinity, anchor = savedAnchor(null), bounds = boundsFor({})
  let state = { visible: false, left: 0, top: 0, dragging: false }
  const publish = patch => { state = Object.assign({}, state, patch); if (alive) options.onState(patch) }
  function measure(size) {
    let info = {}
    try { info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync() } catch (_) {}
    bounds = boundsFor(Object.assign({}, info, size || {}))
  }
  function load() {
    try { anchor = savedAnchor(wx.getStorageSync(POSITION_KEY)) } catch (_) { anchor = savedAnchor(null) }
  }
  function cancel() {
    ignoreTapUntil = now() + 400
    gesture = null
    if (alive) publish(Object.assign({ dragging: false }, positionFor(anchor, bounds)))
  }
  function moveTo(touch) {
    const dx = touch.x - gesture.start.x, dy = touch.y - gesture.start.y
    if (Math.hypot(dx, dy) > DRAG_THRESHOLD) gesture.moved = true
    if (gesture.moved) publish({ dragging: true,
      left: clamp(gesture.origin.left + dx, bounds.minX, bounds.maxX),
      top: clamp(gesture.origin.top + dy, bounds.minY, bounds.maxY) })
  }
  function finish() {
    const moved = gesture.moved
    const held = now() - gesture.startedAt > MAX_TAP_DURATION
    if (moved) {
      anchor = { side: state.left <= (bounds.minX + bounds.maxX) / 2 ? 'left' : 'right',
        ratio: bounds.maxY === bounds.minY ? 0 : (state.top - bounds.minY) / (bounds.maxY - bounds.minY) }
      try { wx.setStorageSync(POSITION_KEY, anchor) } catch (_) {}
    }
    if (moved || held) ignoreTapUntil = now() + 400
    gesture = null
    publish(Object.assign({ dragging: false }, positionFor(anchor, bounds)))
    return moved || held
  }
  function openGuide() {
    if (!alive || !shown || !state.visible || opening || now() < ignoreTapUntil || now() - lastNavigation < 600) return
    opening = true; lastNavigation = now()
    const fail = () => { if (alive && shown) wx.showToast({ title: '助手暂时无法打开，请重试', icon: 'none' }) }
    const url = '/pages/guide/index' + (options.scope === 'team' ? '?scope=team' : '')
    try { wx.navigateTo({ url, fail, complete: () => { opening = false } }) }
    catch (_) { opening = false; fail() }
  }
  function show() {
    if (!alive) return
    shown = true; gesture = null; opening = false; load()
    if (!keyboardHeight) measure()
    publish(Object.assign({ visible: !keyboardHeight, dragging: false }, positionFor(anchor, bounds)))
  }
  function hide() {
    shown = false; cancel(); opening = false; publish({ visible: false })
  }
  return {
    show, hide,
    resize(size) {
      if (!alive || !shown || keyboardHeight) return
      cancel(); measure(size); publish(positionFor(anchor, bounds))
    },
    setKeyboardHeight(height) {
      keyboardHeight = Math.max(0, Number(height) || 0)
      if (!alive || !shown) return
      if (keyboardHeight) { cancel(); publish({ visible: false }) } else show()
    },
    touchStart(event) {
      if (!alive || !shown || !state.visible || opening) return
      const start = point(event.touches)
      if (!start) { cancel(); return }
      ignoreTapUntil = 0
      gesture = { start, startedAt: now(), origin: { left: state.left, top: state.top }, moved: false }
    },
    touchMove(event) {
      if (!gesture || !alive || !shown) return
      const touch = point(event.touches, gesture.start.identifier)
      if (!touch) { cancel(); return }
      moveTo(touch)
    },
    touchEnd(event) {
      if (!gesture || !alive || !shown) return
      if (event.touches && event.touches.length) { cancel(); return }
      const last = point(event.changedTouches, gesture.start.identifier)
      if (event.changedTouches && event.changedTouches.length && !last) { cancel(); return }
      if (last) moveTo(last)
      // Drag handlers may receive touchend without a subsequent tap event.
      if (!finish()) openGuide()
    },
    touchCancel() { cancel() },
    tap(event) {
      if (!alive || !shown || !state.visible || opening) return
      // A native tap can arrive without touchend. Only an unmoved gesture may open the page.
      if (gesture) {
        if (!event || event.type !== 'tap') return
        if (finish()) return
      }
      openGuide()
    },
    dispose() { gesture = null; shown = false; alive = false },
  }
}
module.exports = { createGuideEntry, boundsFor, positionFor, savedAnchor, POSITION_KEY, SIZE }

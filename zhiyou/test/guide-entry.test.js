const test = require('node:test')
const assert = require('node:assert/strict')
const { createGuideEntry, boundsFor, POSITION_KEY, SIZE } = require('../miniprogram/utils/guide-entry')
const { loadComponent } = require('./page-harness')
const touch = (x, y, id = 0) => ({ clientX: x, clientY: y, identifier: id })
function environment(options = {}) {
  const state = {}, storage = options.storage || {}, navigations = [], toasts = []
  const info = options.info || { windowWidth: 375, windowHeight: 667, screenHeight: 812, safeArea: { bottom: 778 } }
  let clock = 1000
  const wx = { getWindowInfo: () => info, getStorageSync: key => storage[key],
    setStorageSync: (key, value) => { storage[key] = value },
    navigateTo: args => { navigations.push(args); args.complete() }, showToast: args => toasts.push(args), ...options.wx }
  const entry = createGuideEntry({ wx, now: () => clock, onState: patch => Object.assign(state, patch) })
  entry.show()
  return { entry, state, storage, navigations, toasts, info, advance: ms => { clock += ms } }
}
function start(e) {
  const p = touch(e.state.left + SIZE / 2, e.state.top + SIZE / 2)
  e.entry.touchStart({ touches: [p] }); return p
}
function drag(e, x, y) {
  start(e); e.entry.touchMove({ touches: [touch(x, y)] })
  e.entry.touchEnd({ touches: [], changedTouches: [touch(x, y)] })
}

test('轻点及手抖只打开一次助手，页面跳转失败可反馈并重试', () => {
  const e = environment(), p = start(e)
  e.entry.touchMove({ touches: [touch(p.clientX + 3, p.clientY + 2)] })
  e.entry.touchEnd({ touches: [], changedTouches: [p] }); e.entry.tap(); e.entry.tap()
  assert.equal(e.navigations.length, 1); assert.equal(e.navigations[0].url, '/pages/guide/index')
  assert.equal(e.storage[POSITION_KEY], undefined)
  const failed = environment({ wx: { navigateTo: args => { args.fail(); args.complete() } } })
  failed.entry.tap(); assert.equal(failed.toasts.length, 1)
  failed.advance(700); failed.entry.tap(); assert.equal(failed.toasts.length, 2)
})

test('只有按下和松手、没有 tap 回调时也能打开已注册的助手页面，补发 tap 不重复跳转', () => {
  const e = environment(), p = start(e)
  e.advance(120)
  e.entry.touchEnd({ touches: [], changedTouches: [p] })
  assert.equal(e.navigations.length, 1)
  const route = e.navigations[0].url.slice(1)
  const app = require('../miniprogram/app.json')
  assert.ok(app.pages.includes(route)); assert.ok(!app.tabBar.list.some(item => item.pagePath === route))
  e.entry.tap({ type: 'tap' }); assert.equal(e.navigations.length, 1)
})

test('轻点松手跳转期间即使没有 complete 回调，重复事件也不再打开；取消和长按不触发跳转', () => {
  const navigations = []
  const e = environment({ wx: { navigateTo: args => { navigations.push(args) } } }), p = start(e)
  e.entry.touchEnd({ touches: [], changedTouches: [p] })
  e.entry.tap({ type: 'tap' }); e.advance(700); e.entry.tap({ type: 'tap' })
  assert.equal(navigations.length, 1)
  const cancelled = environment()
  start(cancelled); cancelled.entry.touchCancel(); cancelled.entry.touchEnd({ touches: [], changedTouches: [] })
  cancelled.entry.tap({ type: 'tap' }); assert.equal(cancelled.navigations.length, 0)
  const held = environment(), h = start(held)
  held.advance(800); held.entry.touchEnd({ touches: [], changedTouches: [h] }); held.entry.tap({ type: 'tap' })
  assert.equal(held.navigations.length, 0)
})

test('拖动限制在屏幕内、松手吸边，抬手后的 tap 不打开，下一次轻点可进入', () => {
  const e = environment(), b = boundsFor(e.info)
  drag(e, -1000, -1000)
  assert.equal(e.state.left, b.minX); assert.equal(e.state.top, b.minY)
  assert.deepEqual(e.storage[POSITION_KEY], { side: 'left', ratio: 0 })
  e.entry.tap(); assert.equal(e.navigations.length, 0)
  drag(e, 5000, 5000)
  assert.equal(e.state.left, b.maxX); assert.equal(e.state.top, b.maxY)
  assert.deepEqual(e.storage[POSITION_KEY], { side: 'right', ratio: 1 })
  e.entry.tap(); assert.equal(e.navigations.length, 0)
  const p = start(e); e.entry.touchEnd({ touches: [], changedTouches: [p] }); e.entry.tap()
  assert.equal(e.navigations.length, 1)
})

test('行程和队伍两实例共享吸边及高度比例，换屏幕/横屏后仍保持可见', () => {
  const storage = {}, trip = environment({ storage })
  drag(trip, 30, 220); trip.entry.hide()
  const saved = { ...storage[POSITION_KEY] }
  const crew = environment({ storage, info: { windowWidth: 430, windowHeight: 800 } })
  const b = boundsFor(crew.info)
  assert.equal(crew.state.left, b.minX)
  assert.equal(crew.state.top, Math.round(b.minY + saved.ratio * (b.maxY - b.minY)))
  crew.entry.resize({ windowWidth: 800, windowHeight: 320 })
  assert.ok(crew.state.top + SIZE <= 320); assert.ok(crew.state.left + SIZE <= 800)
  drag(crew, 790, 100); trip.entry.show()
  assert.equal(trip.state.left, boundsFor(trip.info).maxX)
  assert.equal(trip.storage[POSITION_KEY].side, 'right')
})

test('拖回起点仍按拖动处理；多指、触摸取消、切页和销毁不误打开或覆盖已保存位置', () => {
  const e = environment(), before = { left: e.state.left, top: e.state.top }, p = start(e)
  e.entry.touchMove({ touches: [touch(p.clientX - 40, p.clientY - 40)] })
  e.entry.touchEnd({ touches: [], changedTouches: [p] }); e.entry.tap()
  assert.equal(e.navigations.length, 0)
  const saved = JSON.stringify(e.storage[POSITION_KEY])
  start(e); e.entry.touchMove({ touches: [touch(50, 50)] }); e.entry.touchCancel(); e.entry.tap()
  assert.equal(JSON.stringify(e.storage[POSITION_KEY]), saved)
  assert.equal(e.state.left, before.left); assert.equal(e.state.top, before.top)
  start(e); e.entry.touchMove({ touches: [touch(50, 50), touch(80, 80, 1)] }); e.entry.tap()
  assert.equal(e.navigations.length, 0)
  start(e); e.entry.hide(); e.entry.touchEnd({ changedTouches: [p] }); e.entry.tap()
  assert.equal(e.state.visible, false); assert.equal(e.navigations.length, 0)
  e.entry.show(); e.entry.dispose(); e.entry.touchStart({ touches: [p] }); e.entry.tap()
  assert.equal(e.navigations.length, 0)
})

test('键盘弹出时隐藏，关闭后恢复原位；位置偏好存储异常时仍可拖动和进入', () => {
  const e = environment(), before = { left: e.state.left, top: e.state.top }
  start(e); e.entry.touchMove({ touches: [touch(40, 100)] }); e.entry.setKeyboardHeight(300)
  e.entry.tap(); assert.equal(e.state.visible, false); assert.equal(e.navigations.length, 0)
  e.entry.resize({ windowHeight: 250 }); e.entry.setKeyboardHeight(0)
  assert.equal(e.state.visible, true); assert.equal(e.state.left, before.left); assert.equal(e.state.top, before.top)
  const broken = environment({ wx: { getStorageSync() { throw new Error('unavailable') }, setStorageSync() { throw new Error('full') } } })
  drag(broken, 20, 200)
  assert.equal(broken.state.left, 12)
  const p = start(broken); broken.entry.touchEnd({ touches: [], changedTouches: [p] }); broken.entry.tap()
  assert.equal(broken.navigations.length, 1)
})

test('兼容 x/y 与 pageX/pageY 坐标，抬手缺少 identifier 时仍能完成拖动并再次轻点进入', () => {
  for (const fields of [['x', 'y'], ['pageX', 'pageY']]) {
    const e = environment()
    const p = (x, y, id) => ({ [fields[0]]: x, [fields[1]]: y, ...(id === undefined ? {} : { identifier: id }) })
    e.entry.touchStart({ touches: [p(e.state.left + 32, e.state.top + 32, 7)] })
    e.entry.touchMove({ touches: [p(30, 200, 7)] })
    assert.equal(e.state.dragging, true)
    e.entry.touchEnd({ touches: [], changedTouches: [p(30, 200)] })
    assert.equal(e.state.left, 12); assert.equal(e.storage[POSITION_KEY].side, 'left')
    e.entry.tap({ type: 'tap' }); assert.equal(e.navigations.length, 0)
    e.entry.touchStart({ touches: [p(30, 200, 8)] })
    e.entry.touchEnd({ touches: [], changedTouches: [p(30, 200)] })
    e.entry.tap({ type: 'tap' }); assert.equal(e.navigations.length, 1)
  }
})

test('抬手事件没有结束坐标时沿用已记录手势，轻点可打开、拖动不误开', () => {
  const e = environment()
  start(e); e.entry.touchEnd({ touches: [], changedTouches: [] }); e.entry.tap({ type: 'tap' })
  assert.equal(e.navigations.length, 1)
  e.advance(700)
  start(e); e.entry.touchMove({ touches: [touch(30, 200)] })
  e.entry.touchEnd({ touches: [], changedTouches: [] }); e.entry.tap({ type: 'tap' })
  assert.equal(e.navigations.length, 1); assert.equal(e.storage[POSITION_KEY].side, 'left')
})

test('真实 tap 可结束遗漏 touchend 的轻点，但不能把已拖动或取消的手势当成轻点', () => {
  const e = environment()
  start(e); e.entry.tap(); assert.equal(e.navigations.length, 0)
  e.entry.tap({ type: 'tap' }); assert.equal(e.navigations.length, 1)
  e.advance(700)
  start(e); e.entry.touchMove({ touches: [touch(30, 200)] }); e.entry.tap({ type: 'tap' })
  assert.equal(e.navigations.length, 1); assert.equal(e.state.dragging, false)
  assert.equal(e.storage[POSITION_KEY].side, 'left')
  start(e); e.entry.touchCancel(); e.entry.tap({ type: 'tap' })
  assert.equal(e.navigations.length, 1)
  start(e); e.entry.touchEnd({ touches: [], changedTouches: [touch(30, 200, 99)] })
  e.entry.tap({ type: 'tap' }); assert.equal(e.navigations.length, 1)
})

test('实际悬浮组件接收触摸和页面生命周期，键盘监听在销毁时解绑', () => {
  let keyboard, removed, navigations = 0
  const c = loadComponent('miniprogram/components/guide-entry/index.js', { wx: {
    getWindowInfo: () => ({ windowWidth: 375, windowHeight: 667 }),
    onKeyboardHeightChange: callback => { keyboard = callback },
    offKeyboardHeightChange: callback => { removed = callback },
    navigateTo: args => { navigations++; args.complete() },
  } })
  try {
    c.__attached(); assert.equal(c.data.visible, true)
    const p = touch(c.data.left + 32, c.data.top + 32)
    c.touchStart({ touches: [p] }); c.touchMove({ touches: [touch(20, 200)] })
    c.touchEnd({ touches: [], changedTouches: [touch(20, 200)] }); c.openGuide()
    assert.equal(navigations, 0); assert.equal(c.__storage[POSITION_KEY].side, 'left')
    keyboard({ height: 300 }); assert.equal(c.data.visible, false)
    keyboard({ height: 0 }); c.__pageHide(); assert.equal(c.data.visible, false)
    c.__pageShow(); c.__pageResize({ size: { windowWidth: 320, windowHeight: 480 } })
    c.touchStart({ touches: [touch(20, 200)] })
    c.touchEnd({ touches: [], changedTouches: [touch(20, 200)] })
    assert.equal(navigations, 1)
    c.openGuide({ type: 'tap' }); assert.equal(navigations, 1)
    c.__detached(); assert.equal(removed, keyboard)
    keyboard({ height: 200 }); assert.equal(c.data.visible, true)
  } finally { c.entry.dispose(); c.__restoreGlobals() }
})

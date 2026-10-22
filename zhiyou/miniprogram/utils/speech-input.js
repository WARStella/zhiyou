const { createRealtimeSpeechManager } = require('./realtime-speech')
const apiClient = require('./api')
// 两个输入框互斥；api 只生成短期签名，音频直达腾讯云实时识别。
let microphoneOwner = null
const MAX_DURATION_MS = 60000

function appendSpeech(current, spoken, limit) {
  const text = String(spoken || '').trim()
  if (!text) return null
  const before = String(current || '')
  const value = before + (before && !/[\s，,。；;！!？?]$/.test(before) ? '，' : '') + text
  return value.length <= (limit || 1000) ? value : null
}

function createSpeechInput(options) {
  const api = options.wx
  const later = options.setTimeout || setTimeout
  const clear = options.clearTimeout || clearTimeout
  const loadManager = options.getManager || (() => createRealtimeSpeechManager(api, options.callApi || apiClient.callApi))
  let onState = options.onState || (() => {})
  let onResult = options.onResult || (() => {})
  let session = null, disposed = false
  const publish = (status, extra) => {
    if (!disposed) onState(Object.assign({ status, error: '', permissionDenied: false, diagnostic: null }, extra || {}))
  }
  const live = s => session === s && !s.finished
  function finish(s, status, extra) {
    if (!live(s)) return
    s.finished = true
    clear(s.timer)
    session = null
    if (microphoneOwner === s) microphoneOwner = null
    publish(status, extra)
  }
  function failed(s, message, permissionDenied, diagnostic) {
    finish(s, s.cancelled ? 'idle' : 'error', { error: s.cancelled ? '' : message,
      preview: '', permissionDenied: Boolean(permissionDenied), diagnostic: s.cancelled ? null : diagnostic || null })
  }
  function armStop(s) {
    clear(s.timer)
    s.timer = later(() => {
      if (!live(s)) return
      // 不能在旧会话尚未结束时接收新会话的回调，保留占用直至终止事件。
      s.cancelled = true
      const message = '语音服务响应超时，已请求停止录音。可继续文字输入；若一直未结束，请重新打开小程序。'
      try { if (s.manager.cancel) s.manager.cancel(); else s.manager.stop() } catch (_) {}
      publish(live(s) ? 'canceling' : 'error', { preview: '', error: message })
    }, 30000)
  }
  function stopManager(s) {
    armStop(s)
    try { s.manager.stop() } catch (_) {
      // 启动尚未回调时 stop 可能失败；onStart 会再次停止，不能丢掉会话。
      publish('canceling', { preview: '', error: '正在结束语音，请稍候；文字输入仍可使用。' })
    }
  }
  function begin(s) {
    if (!live(s) || s.cancelled || disposed) return
    const manager = s.manager
    manager.onStart = () => {
      if (!live(s)) return
      if (s.cancelled || s.stopping) { stopManager(s); return }
      publish('recording', { preview: '' })
    }
    manager.onRecognize = result => {
      if (live(s) && !s.cancelled && !s.stopping && !disposed) {
        publish('recording', { preview: typeof (result || {}).result === 'string' ? result.result : '' })
      }
    }
    manager.onProcessing = () => {
      if (live(s) && !s.cancelled) { s.stopping = true; publish('recognizing'); armStop(s) }
    }
    manager.onInterrupt = () => {
      if (live(s)) { publish('canceling', { preview: '', error: '录音被通话或系统中断，请重新录音。' }); armStop(s) }
    }
    manager.onStop = result => {
      if (!live(s)) return
      if (s.cancelled || disposed) { finish(s, 'idle', { preview: '' }); return }
      const raw = result && (result.result || result.Result)
      const text = typeof raw === 'string' ? raw.trim() : ''
      if (!text) { failed(s, '没有识别到清晰语音，请靠近手机重试，也可以直接输入文字。'); return }
      finish(s, 'done', { preview: text })
      if (!disposed) onResult(text)
    }
    manager.onError = error => failed(s, error && error.userMessage || '语音识别失败，请检查网络与麦克风权限后重试，也可以直接输入文字。',
      false, error && error.diagnostic)
    s.started = true
    clear(s.timer)
    s.timer = later(() => {
      if (!live(s)) return
      s.stopping = true
      publish('recognizing')
      stopManager(s)
    }, MAX_DURATION_MS + 5000)
    publish('starting', { preview: '' })
    try { manager.start({ duration: MAX_DURATION_MS, lang: 'zh_CN' }) }
    catch (_) { failed(s, '无法启动录音，请检查麦克风权限，或直接输入文字。') }
  }
  function authorize(s) {
    if (!live(s) || disposed) return
    const request = () => {
      if (!live(s) || disposed) return
      if (typeof api.authorize !== 'function') { failed(s, '当前微信版本不支持录音授权，请升级微信或直接输入文字。'); return }
      api.authorize({ scope: 'scope.record', success: () => begin(s),
        fail: () => failed(s, '未开启麦克风权限。可点“录音设置”开启，或直接输入文字。', true) })
    }
    api.getSetting({ success: result => {
      if (!live(s) || disposed) return
      const granted = (result.authSetting || {})['scope.record']
      if (granted === true) begin(s)
      else if (granted === false) failed(s, '麦克风权限已关闭。可点“录音设置”开启，或直接输入文字。', true)
      else request()
    }, fail: () => failed(s, '无法读取麦克风权限，请稍后重试或直接输入文字。') })
  }
  function cancel() {
    const s = session
    if (!s) return
    s.cancelled = true
    if (!s.started) { finish(s, 'idle', { preview: '' }); return }
    publish('canceling', { preview: '' })
    armStop(s)
    try { if (s.manager.cancel) s.manager.cancel(); else s.manager.stop() } catch (_) {}
  }
  return {
    start() {
      if (disposed || session) return false
      if (microphoneOwner) {
        publish('error', { preview: '', error: '另一个语音输入尚未结束，请先结束或取消。' }); return false
      }
      let manager
      try {
        manager = loadManager()
        if (!manager || typeof manager.start !== 'function' || typeof manager.stop !== 'function') throw new Error('unavailable')
      } catch (_) {
        publish('error', { preview: '', error: '当前微信无法使用原生录音，请升级微信或直接输入文字。' }); return false
      }
      const s = { manager, started: false, cancelled: false, finished: false }
      session = s; microphoneOwner = s
      publish('authorizing', { preview: '' })
      s.timer = later(() => failed(s, '录音授权等待超时，请重新点击语音输入。'), 30000)
      try {
        if (typeof api.requirePrivacyAuthorize === 'function') api.requirePrivacyAuthorize({
          success: () => authorize(s), fail: () => failed(s, '未完成隐私授权，无法使用语音；仍可直接输入文字。') })
        else authorize(s)
      } catch (_) { failed(s, '无法申请录音权限，请直接输入文字，或升级微信后重试。') }
      return true
    },
    stop() {
      const s = session
      if (!s || s.cancelled || !s.started || s.stopping) return
      s.stopping = true
      publish('recognizing')
      stopManager(s)
    },
    cancel,
    dispose() {
      cancel(); disposed = true
      onState = () => {}; onResult = () => {}
    },
  }
}

module.exports = { createSpeechInput, appendSpeech, MAX_DURATION_MS }

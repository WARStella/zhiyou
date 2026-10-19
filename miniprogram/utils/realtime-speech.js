// 原生 PCM 分片 → 云端短期签名 → 官方 asr.js。SecretKey 不进入小程序。
const createTencentAsr = require('../vendor/tencent-asr/asr')
const brokers = new WeakMap()
const CHUNK_BYTES = 6400 // 16kHz / 16bits / mono 的 200ms
const MAX_TEXT = 1000
const bufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get

function audioFrameBytes(data) {
  try {
    // 原生桥接/独立 JS 环境的 ArrayBuffer 不一定 instanceof 本环境的构造函数。
    // 用原生 getter 校验真实二进制对象；不能仅信任 byteLength 或 toStringTag。
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    return new Uint8Array(data, 0, bufferByteLength.call(data))
  } catch (_) { return null }
}

// 只提取枚举和数字；原始事件可能含带签名 URL，不可直接展示或打印。
function connectionFailure(session, event, source) {
  const e = event || {}
  const raw = [e.errMsg, e.reason, e.message].filter(v => typeof v === 'string').join(' ')
  const phase = session.ready ? (session.audioStopped ? 'finalizing' : 'recording')
    : session.socketOpened ? 'authenticating' : 'connecting'
  const names = { connecting: '建立连接', authenticating: '服务鉴权', recording: '录音识别', finalizing: '等待最终文字' }
  const diagnostic = { phase, source }
  const match = raw.match(/(?:response\s+code|status(?:\s*code)?|http)[\s:=]+([1-5]\d{2})\b/i)
  const status = Number(e.statusCode || (match && match[1]))
  if (Number.isInteger(status) && status >= 100 && status <= 599) diagnostic.httpStatus = status
  if (Number.isInteger(e.errno) && Math.abs(e.errno) <= 1000000000) diagnostic.errno = e.errno
  if (source === 'close' && Number.isInteger(e.code) && e.code >= 1000 && e.code <= 4999) diagnostic.closeCode = e.code
  if (/not\s+in\s+(?:the\s+)?(?:domain|url)|domain\s+(?:list|not)|合法域名/i.test(raw)) diagnostic.category = 'domain'
  else if (/\b(?:tls|ssl|certificate)\b|证书/i.test(raw)) diagnostic.category = 'tls'
  else if (/\bdns\b|name_not_resolved|resolve\s+host|域名解析/i.test(raw)) diagnostic.category = 'dns'
  else diagnostic.category = 'unknown'
  const codes = [names[phase]]
  if (diagnostic.httpStatus) codes.push('HTTP ' + diagnostic.httpStatus)
  if (diagnostic.errno !== undefined) codes.push('errno ' + diagnostic.errno)
  if (diagnostic.closeCode) codes.push('关闭码 ' + diagnostic.closeCode)
  let message
  if (diagnostic.category === 'domain') message = '微信未允许语音连接，请检查当前小程序的 socket 合法域名是否已生效。'
  else if (diagnostic.category === 'tls') message = '语音安全连接失败，请切换手机网络后重试。'
  else if (diagnostic.category === 'dns') message = '手机无法解析语音服务域名，请检查网络后重试。'
  else if ([401, 403].includes(diagnostic.httpStatus)) message = '语音服务拒绝连接，请核对腾讯云实时识别服务、账号凭据和权限。'
  else if (!session.ready) message = session.socketOpened
    ? '语音连接已打开，但未通过服务鉴权便断开；请核对实时识别服务和云端凭据。'
    : '尚未建立实时语音连接；请核对 socket 合法域名，并切换手机网络重试。'
  else message = source === 'send' ? '实时语音发送失败，请重新录音或直接输入文字。'
    : '实时语音连接中断，请重新录音或直接输入文字。'
  return { message: message + '（' + codes.join('，') + '）', diagnostic }
}

function recorderBroker(api) {
  const native = api.getRecorderManager()
  if (brokers.has(native)) return brokers.get(native)
  if (typeof native.onFrameRecorded !== 'function') throw new Error('streaming unavailable')
  const broker = { native, owner: null }
  native.onStart(() => { if (broker.owner) broker.owner.started() })
  native.onFrameRecorded(frame => { if (broker.owner) broker.owner.frame(frame) })
  native.onStop(file => {
    const owner = broker.owner
    broker.owner = null
    if (file && file.tempFilePath) {
      try { api.getFileSystemManager().unlink({ filePath: file.tempFilePath, fail: () => {} }) } catch (_) {}
    }
    if (owner) owner.stopped(file)
  })
  native.onError(() => {
    const owner = broker.owner
    broker.owner = null
    if (owner) owner.failed()
  })
  if (typeof native.onInterruptionBegin === 'function') native.onInterruptionBegin(() => {
    if (broker.owner) broker.owner.interrupted()
  })
  brokers.set(native, broker)
  return broker
}

function createRealtimeSpeechManager(api, callApi, options) {
  const opts = options || {}
  const later = opts.setTimeout || setTimeout
  const clear = opts.clearTimeout || clearTimeout
  const broker = recorderBroker(api)
  if (typeof api.connectSocket !== 'function') throw new Error('socket unavailable')
  let current = null
  const manager = {}
  const emit = (event, value) => { if (typeof manager[event] === 'function') manager[event](value) }
  const live = s => current === s && !s.finished
  function timer(s, fn, ms) {
    const id = later(() => { s.timers.delete(id); if (live(s)) fn() }, ms)
    s.timers.add(id)
    return id
  }
  function untimer(s, id) { clear(id); s.timers.delete(id) }
  function stopNative(s) {
    if (s.nativeRequested && !s.audioStopped && broker.owner === s.owner) {
      try { broker.native.stop() } catch (_) {} // onStart 会再次处理启动阶段的停止
    }
  }
  function closeSocket(s) {
    if (!s.socket || s.closeRequested) return
    s.closeRequested = true
    try { s.socket.close({ code: 1000 }) } catch (_) {}
  }
  function finish(s, error, text, diagnostic) {
    if (!live(s)) return
    s.finished = true; current = null
    for (const id of s.timers) clear(id)
    s.timers.clear(); s.bytes = new Uint8Array(0); s.segments.clear(); s.sendDone = null
    stopNative(s)
    closeSocket(s)
    if (error) emit('onError', { userMessage: error, diagnostic: diagnostic || null })
    else emit('onStop', { result: text || '' })
  }
  function socketFailed(s, event, source) {
    if (!live(s)) return
    const failure = connectionFailure(s, event, source)
    finish(s, failure.message, null, failure.diagnostic)
  }
  function send(s, data, done) {
    try {
      if (!s.recognizer.socket || s.recognizer.socket.readyState !== 1) {
        socketFailed(s, {}, 'send'); return
      }
      s.sendDone = done
      if (typeof data === 'string') s.recognizer.stop()
      else s.recognizer.write(data)
    } catch (event) { socketFailed(s, event, 'send') }
  }
  function pump(s) {
    if (!live(s) || s.ended) return
    if (s.audioStopped && s.tailReady && s.bytes.length % 2) {
      finish(s, '录音末尾数据不完整，请重新录音或直接输入文字。', null,
        { phase: 'finalizing', source: 'recorder', category: 'incomplete_sample', byteLength: s.bytes.length })
      return
    }
    if (s.bytes.length >= CHUNK_BYTES || (s.audioStopped && s.tailReady && s.bytes.length)) {
      const size = Math.min(CHUNK_BYTES, s.bytes.length)
      const packet = s.bytes.slice(0, size)
      s.bytes = s.bytes.slice(size)
      s.sentBytes += size
      send(s, packet.buffer, () => timer(s, () => pump(s), 200))
    } else if (s.audioStopped && s.tailReady) {
      if (s.sentBytes < 9600) { finish(s, '录音过短或没有收到音频，请说话后重试。'); return }
      s.ended = true
      // 所有音频分片发送完成后才发 end，不能拿尚未稳定的预览充当最终结果。
      send(s, JSON.stringify({ type: 'end' }), () => {
        timer(s, () => finish(s, '等待最终语音结果超时，请重新录音或直接输入文字。'), 10000)
      })
    } else timer(s, () => pump(s), 200)
  }
  function beginRecording(s) {
    if (!live(s) || s.ready) return
    s.ready = true
    untimer(s, s.connectionTimer)
    if (broker.owner) { finish(s, '麦克风正在结束上一段录音，请稍后重试。'); return }
    s.owner = {
      started() {
        if (!live(s) || s.stopRequested) { stopNative(s); return }
        emit('onStart')
      },
      frame(event) {
        if (!live(s) || s.ended) return
        const raw = event && event.frameBuffer
        const data = audioFrameBytes(raw)
        if (!data) {
          const frameType = raw === null ? 'null' : typeof raw
          finish(s, '录音分片读取失败，请重新录音或直接输入文字。（分片类型 ' + frameType + '）', null,
            { phase: 'recording', source: 'recorder', category: 'invalid_frame', frameType })
          return
        }
        if (!data.byteLength) return
        s.receivedBytes += data.byteLength
        if (s.receivedBytes > 1920000 + CHUNK_BYTES || s.bytes.length + data.byteLength > 96000) {
          finish(s, '实时音频积压或超过60秒，请检查网络后分段重录。'); return
        }
        const combined = new Uint8Array(s.bytes.length + data.byteLength)
        // 回调边界可能拆开一个 16bit 采样，保留全部字节，发送时按完整采样对齐。
        combined.set(s.bytes); combined.set(data, s.bytes.length)
        s.bytes = combined
        untimer(s, s.audioTimer)
        s.audioTimer = timer(s, () => finish(s, '没有收到连续录音分片，请升级微信或直接输入文字。'), 5000)
      },
      stopped() {
        s.audioStopped = true
        if (!live(s)) return
        untimer(s, s.audioTimer); untimer(s, s.durationTimer)
        emit('onProcessing')
        // 给发送队列留出一个分片周期，再发送 end。
        timer(s, () => { s.tailReady = true }, 200)
      },
      failed() { s.audioStopped = true; finish(s, '录音失败，请检查麦克风权限后重试。') },
      interrupted() { emit('onInterrupt'); finish(s, '录音被通话或系统中断，请重新录音。') },
    }
    broker.owner = s.owner
    s.nativeRequested = true
    s.audioTimer = timer(s, () => finish(s, '当前设备未返回录音分片，请升级微信或直接输入文字。'), 5000)
    s.durationTimer = timer(s, () => manager.stop(), 60000)
    try {
      broker.native.start({ duration: 60000, sampleRate: 16000, numberOfChannels: 1,
        format: 'PCM', frameSize: 4 })
      timer(s, () => pump(s), 200)
    } catch (_) {
      broker.owner = null; s.audioStopped = true
      finish(s, '无法启动实时录音，请升级微信或直接输入文字。')
    }
  }
  // SDK 内部会直接 JSON.parse；在交给 SDK 前检查格式及会话，避免异步异常逃逸。
  function validMessage(s, event) {
    if (!live(s)) return
    let message
    try {
      if (typeof event.data !== 'string' || event.data.length > 100000) throw new Error('invalid message')
      message = JSON.parse(event.data)
      if (!message || typeof message !== 'object' || !Number.isInteger(message.code)) throw new Error('invalid message')
      // 鉴权失败时可能没有 voice_id；成功消息仍须严格匹配本次会话。
      if (message.code === 0 ? message.voice_id !== s.voiceId
        : message.voice_id && message.voice_id !== s.voiceId) throw new Error('invalid message')
    } catch (_) { finish(s, '实时语音服务返回异常，请检查服务配置、额度或稍后重试。'); return false }
    return true
  }
  function receive(s, message) {
    if (!live(s)) return
    if (message.code !== 0) {
      const hints = { 4002: '实时语音鉴权失败，请核对云端 APPID 与密钥及服务权限。',
        4003: '腾讯云实时语音识别尚未开通，请在控制台开通服务。',
        4004: '实时语音资源包已耗尽，请检查账号额度。', 4005: '腾讯云账号欠费，请检查账号状态。',
        4006: '实时语音并发已满，请稍后重试。', 4007: '录音格式无法识别，请检查微信版本。' }
      const code = message.code >= 1000 && message.code <= 9999 ? message.code : null
      finish(s, (hints[message.code] || '实时语音识别未成功，请检查网络后重录。') +
        (code ? '（服务码 ' + code + '）' : ''), null,
        { phase: s.ready ? 'recording' : 'authenticating', source: 'provider', providerCode: code }); return
    }
    if (!s.ready) {
      // TCP/WebSocket 打开不等于语音鉴权成功，收到服务确认后才启动麦克风。
      beginRecording(s)
    }
    if (!live(s)) return
    if (message.result) {
      const r = message.result
      if (!Number.isInteger(r.index) || r.index < 0 || r.index > 1000 || ![0, 1, 2].includes(r.slice_type) ||
          typeof r.voice_text_str !== 'string' || r.voice_text_str.length > MAX_TEXT) {
        finish(s, '识别文字异常或过长，请分段重录。'); return
      }
      const old = s.segments.get(r.index)
      if (!old || !old.stable) s.segments.set(r.index, { text: r.voice_text_str, stable: r.slice_type === 2 })
      const text = Array.from(s.segments.keys()).sort((a, b) => a - b).map(k => s.segments.get(k).text).join('')
      if (text.length > MAX_TEXT) { finish(s, '识别文字超过1000字，请分段重录。'); return }
      emit('onRecognize', { result: text })
    }
    if (message.final === 1) {
      const indexes = Array.from(s.segments.keys()).sort((a, b) => a - b)
      if (!s.ended || indexes.some((value, i) => value !== i) || Array.from(s.segments.values()).some(part => !part.stable)) {
        finish(s, '未收到完整的最终识别结果，请重新录音。'); return
      }
      const text = Array.from(s.segments.keys()).sort((a, b) => a - b).map(k => s.segments.get(k).text).join('')
      finish(s, null, text)
    }
  }
  manager.start = () => {
    if (current || broker.owner) throw new Error('recorder busy')
    const s = { timers: new Set(), segments: new Map(), bytes: new Uint8Array(0), sentBytes: 0, receivedBytes: 0 }
    current = s
    s.connectionTimer = timer(s, () => finish(s, '实时语音连接超时，请检查网络后重试。'), 15000)
    Promise.resolve().then(() => live(s) ? callApi('speech.session', {}) : null).then(response => {
      if (!live(s)) return
      if (!response || !response.ok) {
        const code = response && response.error && response.error.code
        finish(s, code === 'ASR_NOT_CONFIGURED' ? '实时语音服务尚未配置，请先使用文字输入。'
          : code === 'RATE_LIMITED' ? '语音请求过于频繁，请稍后再试。' : '无法申请实时语音连接，请稍后重试。')
        return
      }
      const data = response.data || {}
      // 只连接既定语音服务，URL 不写日志、不缓存，不跟随任意云端域名。
      if (!/^wss:\/\/asr\.cloud\.tencent\.com\/asr\/v2\/[1-9]\d{4,19}\?/.test(data.url || '') ||
          !/^[a-f0-9]{32}$/.test(data.voiceId || '')) {
        finish(s, '实时语音连接配置异常，请先使用文字输入。'); return
      }
      s.voiceId = data.voiceId
      // 官方识别类负责连接、发送音频/end 和识别事件；外层保留录音生命周期及失败兜底。
      const sdk = createTencentAsr({
        getRecorderManager: () => broker.native,
        connectSocket(config) {
          // SDK.start 内部有 await；取消可能发生在获取签名和实际连接之间。
          if (!live(s)) throw new Error('session canceled')
          const socket = api.connectSocket({ ...config, fail: event => socketFailed(s, event, 'connect') })
          s.socket = socket
          socket.onOpen(() => {
            s.socketOpened = true
            // 微信 CONNECTING 阶段 close 可能无效，迟到的 open 仍须再关闭。
            if (!live(s)) { s.closeRequested = false; closeSocket(s) }
          })
          if (!live(s)) closeSocket(s)
          return {
            get readyState() {
              return typeof socket.readyState === 'number' ? socket.readyState : (s.socketOpened || s.ready ? 1 : 0)
            },
            send(config) {
              const done = s.sendDone
              s.sendDone = null
              socket.send({ ...config,
                success(event) {
                  if (config.success) config.success(event)
                  if (live(s) && done) done()
                },
                fail(event) {
                  socketFailed(s, event, 'send')
                  if (config.fail) config.fail(event)
                },
              })
            },
            close() { closeSocket(s) },
            onMessage(callback) {
              socket.onMessage(event => {
                if (!validMessage(s, event)) return
                try { callback(event) } catch (_) { finish(s, '实时语音服务返回异常，请稍后重试。') }
              })
            },
            onError(callback) {
              socket.onError(event => { socketFailed(s, event, 'error'); callback(event) })
            },
            onClose(callback) {
              socket.onClose(event => { socketFailed(s, event, 'close'); callback(event) })
            },
          }
        },
      })
      const recognizer = new sdk.SpeechRecognizer(false)
      s.recognizer = recognizer
      // SDK 需要不带 wss:// 的完整签名地址。只消费云端签名，禁用默认本地签名/取时。
      recognizer.getUrl = async () => data.url.slice('wss://'.length)
      recognizer.OnRecognitionStart = () => beginRecording(s)
      // SDK 的稳定句事件可能先补发 OnSentenceBegin；只在实际对应事件消费一次。
      recognizer.OnSentenceBegin = message => { if (message.result.slice_type === 0) receive(s, message) }
      recognizer.OnRecognitionResultChange = message => receive(s, message)
      recognizer.OnSentenceEnd = message => receive(s, message)
      recognizer.OnRecognitionComplete = message => receive(s, message)
      recognizer.OnError = message => {
        if (message.code === 6000) socketFailed(s, message.message, 'error')
        else receive(s, message)
      }
      return recognizer.start({}, s.voiceId)
    }).catch(() => finish(s, '无法建立实时语音连接，请检查网络和服务配置。'))
  }
  manager.stop = () => {
    const s = current
    if (!s || s.stopRequested) return
    s.stopRequested = true
    if (!s.nativeRequested) { finish(s, null, ''); return }
    stopNative(s)
    timer(s, () => finish(s, '录音停止超时，请重新打开小程序或使用文字输入。'), 12000)
  }
  manager.cancel = () => { if (current) finish(current, null, '') }
  return manager
}

module.exports = { createRealtimeSpeechManager, connectionFailure }

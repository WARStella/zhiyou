// 原生录音只注册一组监听，按会话路由；无需第三方小程序插件。
const brokers = new WeakMap()
const MAX_AUDIO_BYTES = 512 * 1024

function brokerFor(api) {
  const native = api.getRecorderManager()
  if (brokers.has(native)) return brokers.get(native)
  const broker = { native, owner: null }
  native.onStart(() => { if (broker.owner) broker.owner.started() })
  native.onStop(file => {
    const owner = broker.owner
    broker.owner = null
    if (owner) owner.stopped(file)
  })
  native.onError(() => {
    const owner = broker.owner
    broker.owner = null
    if (owner) owner.failed('录音失败，请检查麦克风权限后重试。')
  })
  if (typeof native.onInterruptionBegin === 'function') native.onInterruptionBegin(() => {
    if (broker.owner) broker.owner.interrupted()
  })
  brokers.set(native, broker)
  return broker
}

function createNativeSpeechManager(api, callApi) {
  const broker = brokerFor(api)
  let current = null
  const manager = {}
  const emit = (name, value) => { if (typeof manager[name] === 'function') manager[name](value) }
  const live = s => current === s && !s.finished
  function cleanup(s) {
    if (!s.path || s.cleaned) return
    s.cleaned = true
    try { api.getFileSystemManager().unlink({ filePath: s.path, fail: () => {} }) } catch (_) {}
  }
  function finish(s, error, text) {
    if (!live(s)) return
    s.finished = true; current = null
    cleanup(s)
    if (error) emit('onError', { userMessage: error })
    else emit('onStop', { result: text || '' })
  }
  const owner = {
    started() { if (current) emit('onStart') },
    failed(message) { if (current) finish(current, message) },
    interrupted() {
      if (!current) return
      current.cancelled = true; current.interruption = true
      emit('onInterrupt')
      try { broker.native.stop() } catch (_) {}
    },
    stopped(file) {
      const s = current
      if (!s) return
      s.stopped = true; s.path = file && file.tempFilePath
      if (s.cancelled) { finish(s, s.interruption ? '录音被通话或系统中断，请重新录音。' : null, ''); return }
      if (!file || !s.path || !Number.isFinite(file.duration) || file.duration < 300 || file.duration > 60000 || file.fileSize > MAX_AUDIO_BYTES) {
        finish(s, '录音过短、超过60秒或文件过大，请分段重录。'); return
      }
      emit('onProcessing')
      try {
        api.getFileSystemManager().readFile({ filePath: s.path, encoding: 'base64',
          success: async data => {
            if (!live(s) || s.cancelled) { cleanup(s); return }
            const audio = data && data.data
            if (typeof audio !== 'string' || !audio || audio.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4) {
              finish(s, '录音读取失败或超过512KB，请分段重录。'); return
            }
            try {
              const response = await callApi('speech.recognize', { audioBase64: audio, format: 'mp3', durationMs: file.duration })
              if (!live(s) || s.cancelled) return
              if (!response || !response.ok) {
                const code = response && response.error && response.error.code
                finish(s, code === 'ASR_NOT_CONFIGURED' ? '语音服务尚未启用，请先使用文字输入。'
                  : code === 'RATE_LIMITED' ? '语音请求过于频繁，请稍后再试。' : '语音识别暂不可用，请稍后重录或直接输入文字。')
              } else finish(s, null, response.data && response.data.text)
            } catch (_) {
              if (live(s)) finish(s, '语音识别网络请求失败，请稍后重录或直接输入文字。')
            }
          },
          fail: () => { if (live(s)) finish(s, '无法读取录音，请重录或直接输入文字。') },
        })
      } catch (_) { finish(s, '当前微信无法读取录音，请升级后重试或直接输入文字。') }
    },
  }
  manager.start = () => {
    if (broker.owner || current) throw new Error('recorder busy')
    current = { cancelled: false, stopped: false, finished: false }
    broker.owner = owner
    try {
      broker.native.start({ duration: 60000, sampleRate: 16000, numberOfChannels: 1, encodeBitRate: 24000, format: 'mp3' })
    } catch (error) {
      broker.owner = null; current = null; throw error
    }
  }
  manager.stop = () => { if (broker.owner === owner) broker.native.stop() }
  manager.cancel = () => {
    if (!current) return
    current.cancelled = true
    if (current.stopped) finish(current, null, '')
    else manager.stop()
  }
  return manager
}

module.exports = { createNativeSpeechManager, MAX_AUDIO_BYTES }

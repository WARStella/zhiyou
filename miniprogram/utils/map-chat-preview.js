const nameOf = row => (row.nickname || '未命名队友') + (row.isMine ? '（我）' : '')
const excerpt = text => {
  const chars = Array.from(String(text || '').replace(/\s+/g, ' ').trim())
  return chars.slice(0, 42).join('') + (chars.length > 42 ? '…' : '')
}

// 地图只保留最近两条；页面隐藏、切队或撤权后，异步头像和消息都不能回填。
function createMapChatPreview(options) {
  const later = options.setTimeout || setTimeout, clear = options.clearTimeout || clearTimeout
  const clock = options.now || Date.now
  let active = false, crewId = '', generation = 0, timer = null, failures = 0
  let rows = [], recentMessages = [], cursor = null, busy = false, refreshPending = false
  let finishAvatarRequest = null
  const avatars = new Map()
  const current = gen => active && gen === generation && options.getCrewId() === crewId
  const reset = () => options.onState({ chatPreview: [], chatPreviewReady: false,
    chatPreviewAvailable: true, chatPreviewNote: '', chatPreviewLatestSeq: 0 })
  function stop() {
    active = false; generation++; clear(timer); timer = null
    if (finishAvatarRequest) finishAvatarRequest([])
    rows = []; recentMessages = []; cursor = null; busy = false; refreshPending = false; avatars.clear(); reset()
  }
  async function resolveAvatars(messages, gen) {
    const ids = [...new Set(messages.map(row => row.avatarFileId).filter(id =>
      typeof id === 'string' && /^cloud:\/\/[^\s]+$/.test(id) && id.length <= 2048))]
    const missing = ids.filter(id => !avatars.has(id) || avatars.get(id).until <= clock())
    if (missing.length && options.wx.cloud && typeof options.wx.cloud.getTempFileURL === 'function') {
      const found = await new Promise(resolve => {
        let done = false, timeout
        const finish = files => {
          if (done) return
          done = true; clear(timeout); finishAvatarRequest = null; resolve(files)
        }
        finishAvatarRequest = finish
        timeout = later(() => finish([]), 3000)
        try {
          options.wx.cloud.getTempFileURL({ fileList: missing,
            success: result => finish(result && result.fileList || []), fail: () => finish([]) })
        } catch (_) { finish([]) }
      })
      if (!current(gen)) return
      for (const id of missing) {
        const match = found.find(file => file.fileID === id && /^https:\/\//.test(file.tempFileURL || '') &&
          (file.status === undefined || file.status === 0))
        avatars.set(id, { url: match ? match.tempFileURL : '', until: clock() + 60000 })
      }
    }
    return messages.map(row => ({ messageId: row.messageId, name: nameOf(row),
      initial: Array.from(row.nickname || (row.isMine ? '我' : '未'))[0],
      text: excerpt(row.text), avatarFileId: row.avatarFileId || '',
      avatarUrl: (avatars.get(row.avatarFileId) || {}).url || '' }))
  }
  async function poll(gen) {
    if (!current(gen)) return
    if (busy) { refreshPending = true; return }
    busy = true
    clear(timer); timer = null
    let delay = 3000
    try {
      const payload = { crewId, limit: cursor === null ? 2 : 50 }
      if (cursor !== null) payload.afterSeq = cursor
      const result = await options.callApi('chat.list', payload)
      if (!current(gen)) return
      if (!result || !result.ok) {
        if (result && result.error && ['FORBIDDEN_NOT_MEMBER', 'AUTH_REQUIRED'].includes(result.error.code)) {
          stop(); options.onState({ chatPreviewAvailable: false }); return
        }
        throw new Error('chat unavailable')
      }
      const incoming = result.data.messages || []
      if (options.onMessages) options.onMessages(incoming, result.meta && result.meta.serverTime)
      const merged = new Map(recentMessages.map(row => [row.messageId, row]))
      for (const row of incoming) merged.set(row.messageId, row)
      recentMessages = Array.from(merged.values()).sort((a, b) => a.seq - b.seq).slice(-2)
      cursor = Math.max(cursor || 0, result.data.latestSeq || 0, ...incoming.map(row => row.seq || 0))
      const messages = recentMessages
      if (result.data.hasMore && payload.afterSeq !== undefined) delay = 100
      // 先显示文字与首字，头像慢加载不能阻塞聊天提示。
      rows = messages.map(row => ({ messageId: row.messageId, name: nameOf(row), text: excerpt(row.text),
        initial: Array.from(row.nickname || (row.isMine ? '我' : '未'))[0], avatarFileId: row.avatarFileId || '',
        avatarUrl: (avatars.get(row.avatarFileId) || {}).url || '' }))
      options.onState({ chatPreview: rows, chatPreviewReady: true, chatPreviewAvailable: true, chatPreviewNote: '',
        /**
         * **已经显示出来的**最新消息序号。
         *
         * 页面拿它推进"本人已读游标"，语义是"用户真的在屏幕上看到了这一批"。
         * 注意它与 `cursor`（拉取游标）是两件事：`cursor` 只表示请求到哪儿了，
         * 拉取成功不代表用户看见 —— 交接文档点名的缺口正是把两者混为一谈。
         */
        chatPreviewLatestSeq: messages.length ? messages[messages.length - 1].seq : 0 })
      const withAvatars = await resolveAvatars(messages, gen)
      if (!current(gen)) return
      rows = withAvatars
      options.onState({ chatPreview: rows })
      failures = 0
    } catch (_) {
      if (!current(gen)) return
      failures++
      delay = Math.min(15000, 3000 * Math.pow(2, failures))
      options.onState({ chatPreviewNote: '消息暂未更新，正在重试' })
    } finally {
      if (current(gen)) {
        busy = false
        timer = later(() => { refreshPending = false; return poll(gen) }, refreshPending ? 1 : delay)
        if (timer && timer.unref) timer.unref()
      }
    }
  }
  function start(id) {
    if (active && crewId === id) return
    stop(); crewId = id
    if (!id) return
    active = true; failures = 0
    return poll(generation)
  }
  function imageError(messageId) {
    const row = rows.find(row => row.messageId === messageId)
    if (!row) return
    avatars.set(row.avatarFileId, { url: '', until: clock() + 60000 })
    rows = rows.map(item => item.messageId === messageId ? Object.assign({}, item, { avatarUrl: '' }) : item)
    options.onState({ chatPreview: rows })
  }
  return { start, stop, imageError, refresh: () => current(generation) ? poll(generation) : undefined }
}

module.exports = { createMapChatPreview }

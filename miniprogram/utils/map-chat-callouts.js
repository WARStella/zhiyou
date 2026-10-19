const DISPLAY_MS = 8000
// 仅来自服务端 isMine 的本人消息使用本地槽位，不依赖 loc.list 的返回顺序。
const OWN_MESSAGE = '@self'

function messageText(text) {
  const all = Array.from(String(text || '').replace(/\s+/g, ' ').trim())
  const chars = all.slice(0, 54)
  if (all.length > 54) chars[53] = '…'
  const lines = []
  for (let i = 0; i < chars.length; i += 18) lines.push(chars.slice(i, i + 18).join(''))
  return lines.join('\n')
}

function createMapChatCallouts(options) {
  const now = options.now || Date.now, later = options.setTimeout || setTimeout, clear = options.clearTimeout || clearTimeout
  const active = new Map(), latest = new Map()
  let timer = null
  function schedule() {
    clear(timer); timer = null
    if (!active.size) return
    const expiresAt = Math.min(...Array.from(active.values()).map(row => row.expiresAt))
    timer = later(() => {
      timer = null
      for (const [key, row] of active) if (row.expiresAt <= now()) active.delete(key)
      options.onChange(); schedule()
    }, Math.max(1, expiresAt - now()))
    if (timer && timer.unref) timer.unref()
  }
  function receive(messages, serverTime) {
    const parsedTime = new Date(serverTime).getTime()
    const serverNow = Number.isFinite(parsedTime) ? parsedTime : now()
    let changed = false
    for (const message of messages || []) {
      const key = message.isMine === true ? OWN_MESSAGE : message.senderKey
      const sentAt = new Date(message.sentAt).getTime(), age = serverNow - sentAt
      if (!key || !Number.isSafeInteger(message.seq) || message.seq <= 0 ||
        !Number.isFinite(sentAt) || age < -1000 || age >= DISPLAY_MS || !message.text ||
        message.seq <= (latest.get(key) || 0)) continue
      latest.set(key, message.seq)
      active.set(key, { text: messageText(message.text), messageId: message.messageId,
        expiresAt: now() + DISPLAY_MS - Math.max(0, age) })
      changed = true
    }
    if (changed) { options.onChange(); schedule() }
  }
  return { receive,
    get(key) { const row = active.get(key); return row && row.expiresAt > now() ? row : null },
    getOwn() { const row = active.get(OWN_MESSAGE); return row && row.expiresAt > now() ? row : null },
    clear() { clear(timer); timer = null; active.clear(); latest.clear(); options.onChange() },
  }
}

module.exports = { createMapChatCallouts, DISPLAY_MS }

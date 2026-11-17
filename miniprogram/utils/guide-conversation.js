// Conversation presentation stays local. Business writes still use the existing
// authenticated proposal/confirmation controller and its version checks.
function choiceIndex(text, options) {
  const value = String(text || '').trim().replace(/[。！!，,？?\s]/g, '')
  const exact = (options || []).map((o, index) => ({ o, index })).filter(({ o }) => value === o.name || value === o.label || value === '选' + (o.name || o.label))
  if (exact.length === 1) return exact[0].index
  if (exact.length) return -1 // Same-name campuses/entrances still need an explicit choice.
  const match = value.match(/^(?:选|选择|确认)?(?:第)?([1-9一二三四五六七八九])(?:个|项|个地点|个方案)?$/)
  if (!match) return -1
  const n = /\d/.test(match[1]) ? Number(match[1]) : '一二三四五六七八九'.indexOf(match[1]) + 1
  return n <= (options || []).length ? n - 1 : -1
}
function clarificationValue(question, text) {
  const value = String(text || '').trim()
  if (question.kind === 'node' || question.kind === 'place') {
    const index = choiceIndex(value, question.options)
    return index === -1 ? null : question.options[index].value
  }
  if (question.kind === 'minutes') {
    if (/^(?:半个?小时)$/.test(value)) return 30
    const match = value.match(/^([0-9一二两三四五六七八九十百]+)\s*(?:分钟|分)?$/)
    if (!match) return null
    const word = match[1], digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
    let number = /^\d+$/.test(word) ? Number(word) : 0
    if (!/^\d+$/.test(word)) {
      let digit = 0
      for (const ch of word) {
        if (digits[ch]) digit = digits[ch]
        else { number += (digit || 1) * (ch === '百' ? 100 : 10); digit = 0 }
      }
      number += digit
    }
    return Number.isInteger(number) && number > 0 && number <= 1440 ? number : null
  }
  if (question.kind === 'clock') {
    const match = value.match(/^(?:下午|晚上|上午|早上)?(\d{1,2})[:：点](\d{1,2}|半)?(?:分)?$/)
    if (!match) return null
    let hour = Number(match[1]), minute = match[2] === '半' ? 30 : Number(match[2] || 0)
    if (!/[:：]|下午|晚上|上午|早上/.test(value) && hour <= 12) return null
    if (/下午|晚上/.test(value) && hour < 12) hour += 12
    if (/上午|早上/.test(value) && hour === 12) hour = 0
    return hour <= 23 && minute <= 59 ? String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') : null
  }
  return null
}
function replyText(result) {
  const answer = result && result.answer || ''
  const evidence = result && result.evidence || []
  if (!evidence.length) return answer || '已处理，可以继续提问。'
  const intro = /下面是.*讲解片段/.test(answer) ? '' : answer
  return [intro, ...evidence.map(e => e.text + (e.sourceNumbers && e.sourceNumbers.length ? ' [' + e.sourceNumbers.join(', ') + ']' : e.sourceNumber ? ' [' + e.sourceNumber + ']' : ''))].filter(Boolean).join('\n\n')
}
function searchTimeLabel(value) {
  const time = value ? new Date(value).getTime() : NaN
  return Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + ' 北京时间' : ''
}
module.exports = { choiceIndex, clarificationValue, replyText, searchTimeLabel }

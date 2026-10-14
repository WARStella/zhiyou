function parseMinutes(content) {
  const text = String(content == null ? '' : content).trim()
  if (!/^\d+$/.test(text)) throw new Error('请输入 1–1440 之间的整数分钟数')
  const minutes = Number(text)
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error('请输入 1–1440 之间的整数分钟数')
  }
  return minutes
}

function requestMinutes(shorten) {
  return new Promise((resolve, reject) => {
    wx.showModal({
      title: shorten ? '少停留多久？' : '多停留多久？',
      editable: true,
      placeholderText: '请输入分钟数，如 15（1–1440）',
      confirmText: '确认调整',
      success(res) {
        if (!res.confirm) { resolve(null); return }
        try { resolve(parseMinutes(res.content)) } catch (e) { reject(e) }
      },
      fail() { reject(new Error('输入窗口打开失败，请重试')) },
    })
  })
}
module.exports = { requestMinutes, parseMinutes }

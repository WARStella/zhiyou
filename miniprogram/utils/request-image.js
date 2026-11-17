const { IMAGE_REQUEST_BUDGET_BYTES, imageRequestBytes } = require('./cloud-request-size')

const COMPRESSION_STEPS = [
  { edge: 1600, quality: 70 }, { edge: 1400, quality: 60 }, { edge: 1200, quality: 50 },
  { edge: 960, quality: 45 }, { edge: 720, quality: 40 }, { edge: 540, quality: 35 },
]
const call = (target, method, args) => new Promise((resolve, reject) => {
  if (typeof target[method] !== 'function') return reject(new Error('当前微信不支持图片处理，请更新微信或使用文字输入'))
  target[method]({ ...args, success: resolve, fail: reject })
})

async function readImageForRequest(wx, original, options = {}) {
  const action = options.action || 'guide.ask', payload = options.payload || {}
  const requestOptions = options.requestOptions || {}, copies = new Set()
  const fs = wx.getFileSystemManager()
  const checkCurrent = () => {
    if (options.current && !options.current()) throw new Error('本次图片处理已取消')
  }
  let info = null
  if (typeof wx.getImageInfo === 'function') {
    try { info = await call(wx, 'getImageInfo', { src: original }) } catch (_) {}
  }
  try {
    for (const step of COMPRESSION_STEPS) {
      checkCurrent()
      let dimensions = { compressedWidth: step.edge }
      if (info && Number.isFinite(info.width) && info.width > 0 && Number.isFinite(info.height) && info.height > 0) {
        const ratio = Math.min(1, step.edge / Math.max(info.width, info.height))
        dimensions = { compressedWidth: Math.max(1, Math.round(info.width * ratio)),
          compressedHeight: Math.max(1, Math.round(info.height * ratio)) }
      }
      const compressed = await call(wx, 'compressImage', { src: original, quality: step.quality, ...dimensions })
      const path = compressed.tempFilePath
      if (!path) throw new Error('图片压缩失败，请重新拍摄或选择图片')
      if (path !== original) copies.add(path)
      checkCurrent()
      const stat = await call(fs, 'stat', { path })
      const size = stat.stats && stat.stats.size
      if (!Number.isFinite(size) || size <= 0) throw new Error('无法读取图片大小，请重新选择图片')
      // 先按文件字节数估算 Base64 长度，大图不必先整个读入 JS 内存。
      const base64Length = Math.ceil(size / 3) * 4
      const overhead = imageRequestBytes(action, { ...payload, imageBase64: '' }, requestOptions)
      if (base64Length + overhead > IMAGE_REQUEST_BUDGET_BYTES) continue
      checkCurrent()
      const file = await call(fs, 'readFile', { filePath: path, encoding: 'base64' })
      if (typeof file.data !== 'string' || !file.data) throw new Error('图片读取失败，请重新选择图片')
      checkCurrent()
      // 最终按真正发送的 UTF-8 JSON 复核，包含问题、地点、版本号与请求元数据。
      if (imageRequestBytes(action, { ...payload, imageBase64: file.data }, requestOptions) <= IMAGE_REQUEST_BUDGET_BYTES) return file.data
    }
    throw new Error('图片压缩后仍超出发送大小限制，请裁剪到需要识别的区域后重选，或改用文字输入')
  } finally {
    // 原图用于预览/重试，只清理本次生成的所有压缩副本。
    for (const path of copies) {
      try { fs.unlink({ filePath: path, success() {}, fail() {} }) } catch (_) {}
    }
  }
}

module.exports = { readImageForRequest }

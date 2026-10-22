// 应用主动采用保守预算，给微信 SDK 的传输封装留出余量。
const IMAGE_REQUEST_BUDGET_BYTES = 512 * 1024

function utf8Bytes(text) {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes++
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++ }
    else bytes += 3
  }
  return bytes
}

const cloudRequestBytes = data => utf8Bytes(JSON.stringify({ name: 'api', data }))

function imageRequestBytes(action, payload, options = {}) {
  const data = { action, requestId: options.requestId || 'x'.repeat(128), payload }
  if (options.expectedVersion !== undefined && options.expectedVersion !== null) data.expectedVersion = options.expectedVersion
  return cloudRequestBytes(data)
}

function isDataSizeError(message) {
  return /data exceed(?:s)? max size|payload too large|request entity too large/i.test(String(message || ''))
}

module.exports = { IMAGE_REQUEST_BUDGET_BYTES, utf8Bytes, cloudRequestBytes, imageRequestBytes, isDataSizeError }

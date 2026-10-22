'use strict';
const { defaultTransport } = require('../http');
const { assert, CODES } = require('../errors');
function crowdConfig(env = process.env) {
  const base = String(env.YOLO_BASE_URL || '').trim().replace(/\/+$/, ''), key = String(env.YOLO_API_KEY || '').trim();
  let valid = false;
  try { const u = new URL(base); valid = u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && (!u.port || u.port === '443'); } catch (_) {}
  return { base, key, available: Boolean(valid && key) };
}
function createCrowdProvider(options = {}) {
  const config = crowdConfig(options.env);
  return { available: config.available, async countPeople(imageBase64) {
    assert(config.available, CODES.NOT_IMPLEMENTED, 'YOLO 人群计数服务尚未部署，请配置 YOLO_BASE_URL 和 YOLO_API_KEY');
    let data;
    try {
      const result = await (options.http || defaultTransport)(config.base + '/count', { method: 'POST', timeoutMs: 25000,
        maxBytes: 256 * 1024, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.key },
        body: JSON.stringify({ imageBase64 }) });
      data = result && result.json;
    } catch (_) { assert(false, CODES.INSUFFICIENT_DATA, 'YOLO 计数暂不可用，请稍后重试；未使用语言模型猜测人数'); }
    assert(data && data.estimated === true && Number.isSafeInteger(data.count) && data.count >= 0 && data.count <= 1000 &&
      Array.isArray(data.boxes) && data.boxes.length === data.count && /^yolo[\w.-]{1,60}$/i.test(data.model || '') &&
      Number.isFinite(data.confidenceThreshold) && data.confidenceThreshold > 0 && data.confidenceThreshold < 1 &&
      data.boxes.every(b => b && [b.x, b.y, b.width, b.height, b.confidence].every(Number.isFinite) &&
        b.x >= 0 && b.y >= 0 && b.width > 0 && b.height > 0 && b.x + b.width <= 1.00001 && b.y + b.height <= 1.00001 &&
        b.confidence >= data.confidenceThreshold && b.confidence <= 1), CODES.INSUFFICIENT_DATA, 'YOLO 返回结果异常，请重新检测');
    return { count: data.count, model: data.model, confidenceThreshold: data.confidenceThreshold, estimated: true,
      truncated: Boolean(data.truncated), boxes: data.boxes.map(({ x, y, width, height, confidence }) => ({ x, y, width, height, confidence })),
      notice: '仅统计照片中检测到的人体，遮挡、远处小目标可能漏检，结果为估计值，不代表现场实时人数。' + (data.truncated ? '已达到检测数量上限，实际人数可能更多。' : '') };
  } };
}
module.exports = { crowdConfig, createCrowdProvider };

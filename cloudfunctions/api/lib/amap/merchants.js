'use strict';
const { resolveKey } = require('./key');
const { coord } = require('../geo');
function value(raw) { return typeof raw === 'string' && raw.trim() ? raw.trim() : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : null; }
function createMerchantSearch(options = {}) {
  const { key } = resolveKey(options), http = options.http || require('../http').defaultTransport;
  return { async search(point, query = {}) {
    if (!key) return { ok: false, code: 'AMAP_KEY_NOT_CONFIGURED', message: '云函数未配置AMAP_KEY', mapApiCalls: 0 };
    if (!coord(point)) return { ok: false, code: 'INVALID_POINT', message: '检索位置无效', mapApiCalls: 0 };
    const url = new URL('https://restapi.amap.com/v3/place/around');
    for (const [name, val] of Object.entries({ key, location: point.longitude + ',' + point.latitude, types: ['050000','060000','090000','100000'].includes(query.types) ? query.types : '050000', keywords: String(query.keyword || '').slice(0, 40), radius: '3000', offset: '10', page: '1', extensions: 'all', sortrule: 'distance', output: 'json' })) url.searchParams.set(name, val);
    let result;
    try { result = await http(url.toString(), { timeoutMs: 8000, maxBytes: 256 * 1024 }); }
    catch (_) { return { ok: false, code: 'AMAP_REQUEST_FAILED', message: '高德请求未完成，请检查网络后重试', mapApiCalls: 1 }; }
    const body = result && result.json || {};
    if (String(body.status) !== '1') {
      const code = String(body.infocode || 'UNKNOWN');
      const messages = { '10001': 'AMAP_KEY无效或已过期', '10002': 'Key未开通对应服务', '10003': '调用频率超限', '10004': '调用配额不足', '10009': 'Key类型不匹配，需要Web服务Key', '10012': '缺少接口权限' };
      return { ok: false, code, message: messages[code] || '高德拒绝了请求，请核对权限与配额', mapApiCalls: 1 };
    }
    const items = (Array.isArray(body.pois) ? body.pois : []).map(p => {
      const parts = String(p.location || '').split(',').map(Number), location = coord({ longitude: parts[0], latitude: parts[1] });
      const biz = p.biz_ext && !Array.isArray(p.biz_ext) ? p.biz_ext : {};
      return { id: String(p.id || ''), name: value(p.name), address: value(p.address), location,
        distanceMeters: value(p.distance), rating: value(biz.rating), averageCost: value(biz.cost), category: value(p.type) };
    }).filter(p => p.id && p.name && p.location);
    return { ok: true, items, mapApiCalls: 1, ratingCount: items.filter(p => p.rating !== null && Number(p.rating) > 0).length,
      costCount: items.filter(p => p.averageCost !== null && Number(p.averageCost) > 0).length,
      note: '评分和人均消费按高德原字段返回；空值或0不证明存在有效评分。该接口未提供用于本项目排序的人气字段。' };
  } };
}
module.exports = { createMerchantSearch };

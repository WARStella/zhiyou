'use strict';

const { createMapProvider } = require('./map');
const geo = require('./geo');
const { requestCount } = require('./map/usage');
const { MEET_SEARCH_RADIUS_METERS } = require('../domain/meet');

const KEYWORDS = ['地铁站', '商场', '公园', '广场'];

/** 搜索所有类别再统一比较，不能因先找到几座地铁站而漏掉更靠近中心的商场。 */
async function searchMeetingPlaces(ctx, center) {
  let provider;
  try {
    provider = (ctx.createMapProvider || createMapProvider)(process.env.MAP_PROVIDER,
      { timeoutMs: process.env.MAP_TIMEOUT_MS ? Number(process.env.MAP_TIMEOUT_MS) : undefined });
  } catch (e) {
    return { places: [], search: { radiusMeters: MEET_SEARCH_RADIUS_METERS, keywords: [],
      mapApiCalls: 0, status: 'failed', failures: [{ reason: 'MAP_PROVIDER_UNAVAILABLE',
        message: (e && e.message) || '地图服务初始化失败' }] } };
  }
  const results = await Promise.all(KEYWORDS.map(async keyword => {
    try {
      return await provider.searchPlaces({ keyword, center, radius: MEET_SEARCH_RADIUS_METERS,
        autoExtend: false, orderBy: 'distance', pageSize: 20, pageIndex: 1 });
    } catch (e) {
      return { ok: false, requestCount: 0, reason: 'UPSTREAM_FAILED',
        message: (e && e.message) || '地点检索失败' };
    }
  }));
  const places = [];
  const failures = [];
  const seen = new Set();
  let calls = 0;
  results.forEach((result, i) => {
    calls += requestCount(result || { requestCount: 0 });
    if (!result || !result.ok) {
      failures.push({ keyword: KEYWORDS[i], reason: (result && result.reason) || 'UPSTREAM_FAILED',
        message: (result && result.message) || '地点检索失败' });
      return;
    }
    for (const item of result.items || []) {
      const point = geo.coord(item && item.location);
      const name = item && typeof item.title === 'string' ? item.title.trim() : '';
      if (!point || !name) continue;
      const id = 'poi_' + (item.poiId || `${name}@${point.latitude},${point.longitude}`);
      if (seen.has(id)) continue;
      seen.add(id);
      places.push({ _id: id, name, location: point, category: 'meeting',
        confidence: 'normal', address: item.address || null, candidateSource: 'poi-search' });
    }
  });
  return { places, search: { radiusMeters: MEET_SEARCH_RADIUS_METERS, keywords: KEYWORDS,
    mapApiCalls: calls, failures, status: failures.length === KEYWORDS.length ? 'failed' : failures.length ? 'partial' : 'ok' } };
}

module.exports = { searchMeetingPlaces };

'use strict';

// The platform adapter must preserve units, score scales and popularity definitions.
// This module never treats missing measurements as zero or mixes different heat metrics.
function measurement(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
function normalize(row) {
  const distanceMeters = measurement(row.distanceMeters);
  const rating = row.rating && measurement(row.rating.value) !== null && measurement(row.rating.scale) > 0 && row.rating.value <= row.rating.scale
    ? { value: row.rating.value, scale: row.rating.scale } : null;
  const popularity = row.popularity && measurement(row.popularity.value) !== null && typeof row.popularity.metric === 'string' && row.popularity.metric.trim()
    ? { value: row.popularity.value, metric: row.popularity.metric.slice(0, 40), period: String(row.popularity.period || '').slice(0, 40) } : null;
  return { id: String(row.id || '').slice(0, 100), name: String(row.name || '').slice(0, 80), distanceMeters, rating, popularity, category: String(row.category || '').slice(0, 100), averageCost: measurement(row.averageCost) };
}
function factorText(row, factor) {
  if (factor === 'distance' && row.distanceMeters !== null) return '直线距离 ' + (row.distanceMeters < 1000 ? Math.round(row.distanceMeters) + ' 米' : (row.distanceMeters / 1000).toFixed(1) + ' km');
  if (factor === 'cost' && row.averageCost !== null) return '参考人均 ¥' + row.averageCost;
  if (factor === 'rating' && row.rating) return '评分 ' + row.rating.value + '/' + row.rating.scale;
  if (factor === 'popularity' && row.popularity) return (row.popularity.period ? row.popularity.period + ' ' : '') + row.popularity.metric + ' ' + row.popularity.value;
  return null;
}
async function rankMerchants(rows, preferences, provider) {
  const source = (rows || []).slice(0, 20), normalized = source.map(normalize);
  const ids = normalized.map(row => row.id);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('商户标识缺失或重复');
  const byId = new Map(source.map((row, i) => [normalized[i].id, row]));
  let ranking;
  if (provider && typeof provider.rankMerchants === 'function' && source.length) {
    try {
      const response = await provider.rankMerchants({ preferences: String(preferences || '').slice(0, 1000), merchants: normalized });
      const proposed = response && response.ok && response.data && response.data.ranking;
      if (Array.isArray(proposed) && proposed.length === ids.length && new Set(proposed.map(r => r.id)).size === ids.length && proposed.every(r => byId.has(r.id) && Array.isArray(r.factors) && r.factors.every(f => factorText(normalized.find(row => row.id === r.id), f)))) ranking = proposed;
    } catch (_) { /* Explicit distance fallback; never label it AI ranking. */ }
  }
  const aiRanked = Boolean(ranking);
  if (!ranking) ranking = normalized.map((row, index) => ({ ...row, index })).sort((a,b) => (a.distanceMeters === null ? Infinity : a.distanceMeters) - (b.distanceMeters === null ? Infinity : b.distanceMeters) || a.index - b.index).map(row => ({ id: row.id, factors: row.distanceMeters === null ? [] : ['distance'] }));
  return { rankingMode: aiRanked ? 'ai' : 'distance', rankingNote: aiRanked ? 'AI结合距离、评分、人均消费和你的需求排序；缺失指标不参与比较' : 'AI排序暂不可用，按距离排序；缺少距离的商户保留原顺序置后',
    items: ranking.map((row, index) => ({ ...byId.get(row.id), rank: index + 1, reasons: [...new Set(row.factors)].map(f => factorText(normalized.find(item => item.id === row.id), f)) })) };
}
module.exports = { rankMerchants, normalize };

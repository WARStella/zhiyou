'use strict';
function safeUrl(value) {
  try {
    const u = new URL(value), h = u.hostname.toLowerCase();
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || (u.port && !['80','443'].includes(u.port)) || !h.includes('.') || /^(?:[\d.]+|\[.*\])$/.test(h) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(h)) return null;
    return u.href;
  } catch (_) { return null; }
}
// Search returns real URLs and page excerpts; model output cannot introduce sources.
function parseSearch(body, now) {
  if (!Array.isArray(body && body.results)) return { ok: false, reason: 'invalid_output' };
  const chunks = [], seen = new Set(), retrievedAt = new Date(now || Date.now()).toISOString();
  for (const result of body.results.slice(0, 10)) {
    if (!result || typeof result !== 'object') continue;
    const url = safeUrl(result.url);
    const text = [result.content, result.summary, result.snippet].find(value => typeof value === 'string' && value.trim().length >= 8);
    if (!url || !text || seen.has(url)) continue;
    seen.add(url);
    const id = 'web-' + (chunks.length + 1);
    chunks.push({ chunkId: id, text: text.trim().slice(0, 3000), source: {
      id, title: String(result.title || new URL(url).hostname).slice(0, 160),
      publisher: String(result.site_name || new URL(url).hostname).slice(0, 80),
      url, origin: 'web', retrievedAt,
    } });
    if (chunks.length === 5) break;
  }
  return chunks.length ? { ok: true, chunks, searchedAt: retrievedAt } : { ok: false, reason: 'no_search_results' };
}
function createWebKnowledge(options = {}) {
  const env = options.env || process.env, http = options.http || require('../http').defaultTransport;
  // Search and summarization both use the official DeepSeek credential, never an Aliyun key.
  const key = String(env.GUIDE_DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || env.AI_API_KEY || '').trim();
  const fail = (reason, httpStatus) => {
    console.warn('[guide.web-search]', JSON.stringify({ provider: 'deepseek', reason, httpStatus: Number.isInteger(httpStatus) ? httpStatus : null }));
    return { ok: false, reason };
  };
  return { async search(place, question, now) {
    if (!key || env.GUIDE_WEB_SEARCH_ENABLED === 'false') return fail('not_configured');
    try {
      const response = await http('https://api.deepseek.com/v1/tools/search', {
        method: 'POST', timeoutMs: 18000, maxBytes: 512 * 1024,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ query: [place.name, place.address || '', '历史 建筑 介绍'].join(' ').slice(0, 128),
          ori_question: String(question || place.name).slice(0, 128), count: 5, need_content: true }),
      });
      const found = parseSearch(response && response.json, now);
      if (!found.ok) return fail(found.reason, response && response.httpStatus);
      if (typeof options.selectEvidence !== 'function') return fail('summary_unavailable');
      const selected = await options.selectEvidence({ question, place: { name: place.name, address: place.address || '' },
        chunks: found.chunks.map(({ chunkId, text }) => ({ chunkId, text })) });
      const chunks = selected && selected.ok && Array.isArray(selected.data && selected.data.segments)
        ? selected.data.segments.slice(0, 3).map(segment => {
          const chunk = segment && found.chunks.find(row => row.chunkId === segment.chunkId);
          return chunk && typeof segment.quote === 'string' && segment.quote.trim().length >= 8 && chunk.text.includes(segment.quote)
            ? { ...chunk, text: segment.quote.slice(0, 1600) } : null;
        }).filter(Boolean) : [];
      if (!chunks.length) return fail('no_valid_citations');
      return { ok: true, chunks, searchedAt: found.searchedAt };
    } catch (error) {
      const status = error && error.details && error.details.httpStatus;
      fail(error && error.details && error.details.timeoutMs ? 'timeout' : 'request_failed', status);
      return { ok: false, reason: 'unavailable' };
    }
  } };
}
module.exports = { createWebKnowledge, parseSearch, safeUrl };

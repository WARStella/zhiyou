'use strict';

const C = require('../repo/collections');
const { coord } = require('../geo');
const { safeUrl } = require('./web-knowledge');
const aliases = require('./place-aliases');
const normalize = text => String(text || '').replace(/[\s·•（）()]/g, '');
function nameKeys(name) {
  const key = normalize(name);
  const group = aliases.find(doc => doc.names.some(alias => normalize(alias) === key));
  return [...new Set([key, ...(group ? group.names.map(normalize) : [])])];
}
function tokens(text) {
  const chars = Array.from(normalize(text));
  return [...new Set(chars.slice(0, -1).map((char, i) => char + chars[i + 1]))];
}
function selectChunks(documents, place, question) {
  const point = coord(place && place.point);
  if (!point) return [];
  const names = nameKeys(place.name), terms = tokens(question);
  return documents.filter(doc => {
    if (!doc || typeof doc !== 'object' || typeof doc._id !== 'string') return false;
    const b = doc.bounds;
    return doc.status === 'published' && doc.version && doc.reviewedAt && doc.title && doc.publisher && safeUrl(doc.url) &&
      Array.isArray(doc.names) && doc.names.some(alias => names.includes(normalize(alias))) &&
      b && ['south', 'north', 'west', 'east'].every(k => Number.isFinite(b[k])) &&
      b.south <= point.latitude && point.latitude <= b.north && b.west <= point.longitude && point.longitude <= b.east;
  }).flatMap(doc => (Array.isArray(doc.chunks) ? doc.chunks : []).slice(0, 30).map((chunk, i) => ({
    chunkId: doc._id + ':' + i, text: typeof chunk?.text === 'string' ? chunk.text.slice(0, 1600) : '', topic: String(chunk?.topic || '').slice(0, 100),
    source: { id: doc._id, title: String(doc.title).slice(0, 160), publisher: String(doc.publisher).slice(0, 80), url: safeUrl(doc.url),
      publishedAt: doc.publishedAt || null, reviewedAt: doc.reviewedAt, origin: 'cloud', version: String(doc.version).slice(0, 100) },
    score: terms.filter(term => String(chunk?.text || '').includes(term) || String(chunk?.topic || '').includes(term)).length,
  }))).filter(chunk => chunk.text.trim().length >= 8).sort((a, b) => b.score - a.score).slice(0, 3);
}
async function retrieve(repo, place, question) {
  if (!coord(place && place.point) || !normalize(place.name)) return { ok: true, chunks: [] };
  try {
    const documents = await repo.find(C.GUIDE_KNOWLEDGE, { status: 'published', nameKeys: { __op: 'in', value: nameKeys(place.name) } }, { limit: 20 });
    return { ok: true, chunks: selectChunks(documents, place, question) };
  } catch (_) { return { ok: false, reason: 'unavailable', chunks: [] }; }
}
module.exports = { retrieve, selectChunks, normalize };

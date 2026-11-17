'use strict';

function allowedBase(base) {
  try {
    const u = new URL(base);
    const removed = /(^|\.)(volces\.com|volcengine\.com|byteplus\.com)$/.test(u.hostname) || u.hostname === 'openspeech.bytedance.com';
    return !removed && u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && (!u.port || u.port === '443');
  } catch (_) { return false; }
}
function compatibleText(env) {
  // Selecting another provider must never forward the default DeepSeek credential to it.
  const key = String(env.GUIDE_AI_API_KEY || '').trim();
  const base = String(env.GUIDE_AI_BASE_URL || env.AI_BASE_URL || '').trim().replace(/\/+$/, '');
  const model = String(env.GUIDE_AI_MODEL || env.AI_MODEL || '').trim();
  return { provider: 'compatible', key, base, model, available: Boolean(key && model && allowedBase(base)) };
}
module.exports = { allowedBase, compatibleText };

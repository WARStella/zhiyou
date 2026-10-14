'use strict';

/**
 * 高德 Key 的读取与归一化 —— **单一事实来源**。
 *
 * 照片 provider 与公交 provider 都要用它。各写一份必然漂移，
 * 而这里的漂移后果很具体：一处去了空白、另一处没去，
 * 于是"照片能用、公交报 10001 Key 不正确" —— 排查方向直接跑偏。
 *
 * ── 为什么要去空白（不是洁癖）──────────────────────────────
 *
 * 腾讯那边已经踩过一次（见 `actions/map.js` 的说明：
 * 「检测到 MAP_KEY 前后有多余空白（常见于从控制台表格复制）」）。
 * 从控制台表格里复制 Key 时很容易连一个空格或换行一起带走，
 * 后果是上游返回 `10001 Key 不正确` —— **一个把人引向"Key 本身错了"
 * 的错误诊断**，实际只是多了个空格。
 *
 * 所以这里在去空白的同时，把"是否去过空白"也记下来，好在报错时说清是哪种。
 *
 * ⚠️ Key 只从**云函数环境变量** `AMAP_KEY` 读取，绝不写入代码或仓库。
 */

const DEFAULT_KEY_ENV = 'AMAP_KEY';

/** 去空白并记录是否去过 —— `{ key, trimmed, hadValue }` */
function normalizeKey(raw) {
  if (raw == null) return { key: '', trimmed: false, hadValue: false };
  const s = String(raw);
  const t = s.trim();
  return { key: t, trimmed: t !== s, hadValue: s.length > 0 };
}

/** 从参数或环境变量取 Key 并归一化 */
function resolveKey(opts, envName) {
  opts = opts || {};
  const raw = opts.key !== undefined ? opts.key : process.env[envName || DEFAULT_KEY_ENV];
  return normalizeKey(raw);
}

module.exports = { normalizeKey, resolveKey, DEFAULT_KEY_ENV };

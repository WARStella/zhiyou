'use strict';

/**
 * 输出侧的安全处理 —— 把 `guide.ask` 的返回**逐字段**过一遍闸门。
 *
 * ── 为什么必须按策略表里的字段集合处理，而不是"把整个 JSON 字符串丢给检测" ──
 *
 * ① 序列化后的 JSON 会把 `sessionId`、`version`、`chunkId` 这些**内部标识**
 *    一起送检。它们一旦被判定命中（例如某个 chunkId 恰好含数字串），
 *    整条回答就会被误杀，而用户看到的只是"回答被省略了" —— 无从排查。
 * ② 送检的每一次都是配额。字段集合写清楚，配额才花在真正会显示给用户看的
 *    那几个字上。
 * ③ 检测结果要能**回写到正确的字段**（脱敏后的 `evidence[].text` 不能再是原文），
 *    否则下一轮又把未脱敏的旧文本显示出来。
 */

const policy = require('./policy');

const FALLBACK = '这条回答未通过内容安全检查，已省略。可以换个问法再试。';

/**
 * @param {object} result  `runAgent` 的返回（会被浅拷贝，不改原对象）
 * @param {object} args
 *   · `gate`   安全闸门（`ctx.safety`）
 *   · `action` 动作名（决定用哪条输出策略）
 * @returns {Promise<{result:object, applied:boolean, changed:boolean, replaced:boolean, labels:string[]}>}
 */
async function sanitizeResult(result, args) {
  const opts = args || {};
  const gate = opts.gate;
  const action = opts.action || 'guide.ask';
  const entry = policy.outputEntry(action);
  if (!result || !gate || !entry) return { result, applied: false, changed: false, replaced: false, labels: [] };

  const next = Object.assign({}, result);
  const labels = new Set();
  let applied = false;
  let changed = false;
  let replaced = false;
  const extraNotices = [];

  const absorb = (verdict) => {
    if (!verdict || !verdict.applied) return verdict;
    applied = true;
    for (const label of verdict.labels || []) labels.add(label);
    return verdict;
  };

  // ① 模型生成的主文案：本地 + 云；不可信时整条替换
  for (const field of entry.modelFields || []) {
    const value = result[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    const verdict = absorb(await gate.checkOutput({ action, text: value }));
    if (!verdict || !verdict.applied) continue;
    if (verdict.ok) {
      if (verdict.text !== value) { next[field] = verdict.text; changed = true; }
    } else {
      next[field] = FALLBACK;
      replaced = true;
      changed = true;
      extraNotices.push(verdict.notice || FALLBACK);
    }
  }

  // ② 自己拼的提示与线索：只做本地脱敏，不花云配额
  for (const field of entry.localFields || []) {
    const value = result[field];
    if (typeof value === 'string') {
      const verdict = absorb(await gate.checkOutput({ action, text: value, useCloud: false }));
      if (verdict && verdict.applied) {
        // 单条字段被判不可信（severe）时清空，而不是把原文留下
        if (!verdict.ok) { next[field] = ''; changed = true; }
        else if (verdict.text !== value) { next[field] = verdict.text; changed = true; }
      }
      continue;
    }
    if (!Array.isArray(value)) continue;
    const rows = [];
    for (const item of value) {
      if (typeof item !== 'string') { rows.push(item); continue; }
      const verdict = absorb(await gate.checkOutput({ action, text: item, useCloud: false }));
      if (verdict && verdict.applied && !verdict.ok) continue; // 单条不可信就丢掉这一条
      if (verdict && verdict.applied && verdict.text !== item) { rows.push(verdict.text); changed = true; } else rows.push(item);
    }
    next[field] = rows;
  }

  // ③ 已审核知识库原文只做本地脱敏；联网生成的讲解正文仍按模型输出送检。
  for (const spec of entry.nested || []) {
    const rows = next[spec.field];
    if (!Array.isArray(rows)) continue;
    const out = [];
    for (const row of rows) {
      const text = row && row[spec.key];
      if (typeof text !== 'string') { out.push(row); continue; }
      const verdict = absorb(await gate.checkOutput({ action, text, useCloud: spec.field === 'evidence' && result.knowledgeOrigin === 'web' }));
      if (verdict && verdict.applied && !verdict.ok) continue;
      if (verdict && verdict.applied && verdict.text !== text) {
        out.push(Object.assign({}, row, { [spec.key]: verdict.text }));
        changed = true;
      } else out.push(row);
    }
    next[spec.field] = out;
  }

  if (extraNotices.length) {
    const merged = (Array.isArray(next.notices) ? next.notices : []).concat(extraNotices);
    next.notices = [...new Set(merged)];
    changed = true;
  }

  return { result: next, applied, changed, replaced, labels: [...labels] };
}

module.exports = { sanitizeResult, FALLBACK };

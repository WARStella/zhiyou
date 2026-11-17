'use strict';

/**
 * 模型输出的 JSON 容错解析。
 *
 * ── 为什么必须有它（DeepSeek 实测相关）──────────────────────
 *
 * 模型经常把 JSON 包在 markdown 代码块里，或在前后加一句解释：
 *
 *     ```json
 *     {"anchorText": "中央大街", ...}
 *     ```
 *
 * 或者「好的，我来解析：{...}」。
 *
 * 这是**已知的常见行为**，不该被当成"模型坏了"而整体失败 ——
 * 尤其 `response_format: {type:'json_object'}` 并非所有模型都可靠支持，
 * 有些会忽略它。**不依赖它，也不因为它的缺失而失败。**
 *
 * ⚠️ 但只做这一层容错：**不做"猜它想说什么"**。
 * 补全缺失字段、把中文描述翻译成枚举值 —— 那超出"解析"的范围，
 * 会把模型的问题掩盖成系统的问题。解析不出来就如实失败，让调用方降级。
 */

/** 取第一个 `{` 到最后一个 `}` 之间的片段（前后有解释文字时用） */
function betweenBraces(s) {
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  return first >= 0 && last > first ? s.slice(first, last + 1) : null;
}

/** 取 markdown 代码块里的内容 */
function insideFence(s) {
  const m = String(s).match(/```(?:json)?\s*([\s\S]*?)```/i);
  return m && m[1] ? m[1].trim() : null;
}

/**
 * @param {string} raw 模型的原始输出
 * @returns {object|null} 解析出的对象；失败返回 null（**不抛异常**）
 */
function parseJsonLoose(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;

  // 依次尝试，从"最不加工"到"最加工" —— 先试原样，避免过度清洗改变语义
  const candidates = [];
  const push = (v) => {
    if (v && candidates.indexOf(v) < 0) candidates.push(v);
  };

  push(s);
  push(insideFence(s));
  push(betweenBraces(s));

  const fenced = insideFence(s);
  if (fenced) push(betweenBraces(fenced));

  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      // 只接受对象：数组或标量都不是我们要的解析结果
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch (e) {
      /* 试下一个候选 */
    }
  }
  return null;
}

module.exports = { parseJsonLoose, insideFence, betweenBraces };

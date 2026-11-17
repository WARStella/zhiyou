'use strict';

/**
 * 仓储查询的**共享约束** —— 两个实现都必须遵守，否则又会出现"本地对、线上错"。
 *
 * 背景（2026-10-13 实际踩到）：
 *   内存仓储支持函数谓词 `(doc) => ...`，云数据库不支持。
 *   当初在 ops.health 里写了谓词统计"已核验地点"，
 *   本地 48 项测试全过，线上直接算出错误结果 —— 而且**不报错**。
 *
 * 因此把约束抽到这里，由云实现主动校验，并纳入测试。
 */

/** 两个实现都支持的操作符。新增操作符必须同时改 memory.js 与 cloud.js。 */
const OP_NAMES = ['gte', 'gt', 'lte', 'lt', 'neq', 'in', 'exists'];

/**
 * 校验查询是**结构化**的。
 * @param {object|Function|null} query
 * @throws {Error} 使用函数谓词或未知操作符时抛出
 */
function assertStructuredQuery(query) {
  if (!query) return;

  if (typeof query === 'function') {
    throw new Error(
      '仓储查询不支持函数谓词（云数据库无法表达，会导致本地对、线上错且不报错）。' +
        '请改用结构化操作符，例如 { verifiedAt: { __op: "neq", value: null } }。'
    );
  }

  for (const [key, v] of Object.entries(query)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && v.__op) {
      if (!OP_NAMES.includes(v.__op)) {
        throw new Error(
          `不支持的查询操作符：${v.__op}（字段 ${key}）。支持：${OP_NAMES.join(', ')}`
        );
      }
    }
  }
}

module.exports = { assertStructuredQuery, OP_NAMES };

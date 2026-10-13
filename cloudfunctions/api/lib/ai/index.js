'use strict';

/**
 * 需求解析 —— provider 工厂与降级链。
 *
 * 计划书 §6.5 最后一句是这里全部设计的依据：
 *   > **模型不可用时，保留手动修改与确定性可行性检查。**
 *
 * 所以解析不是"要么用模型、要么没有"，而是一条**必然有结果**的链：
 *
 *   模型（配了 Key）──失败──▶ 规则解析 ──▶ 一定有结果
 *                     │
 *                     └─ 降级原因如实带回（attempts），不藏
 *
 * 「降级」不是妥协，是产品要求：答辩现场网络不好、模型欠费限流，
 * 系统都必须还能用 —— 而且**必须让人知道现在是谁在解析**。
 */

const { createHttpParser, PROMPT_VERSION } = require('./http');
const rulebased = require('./rulebased');

const RULE_PROMPT_VERSION = 'rulebased-v1';

/** 规则解析器包装成统一接口。 */
function createRuleParser() {
  return {
    name: 'rulebased',
    promptVersion: RULE_PROMPT_VERSION,
    model: null,
    available: true,
    async parse(text, opts) {
      return { ok: true, parsed: rulebased.parse(text, opts), timingMs: 0 };
    },
  };
}

/** 测试用：把预先准备好的结果当解析输出，避免在单测里调模型。 */
function createFakeParser(opts) {
  opts = opts || {};
  const canned = opts.canned || {};
  return {
    name: 'fake',
    promptVersion: 'fake-v1',
    model: 'fake',
    available: true,
    async parse(text, o) {
      if (opts.failWith) {
        return { ok: false, reason: opts.failWith.reason || 'AI_UPSTREAM_FAILED', message: opts.failWith.message || '假解析器故障' };
      }
      const hit = canned[text];
      if (hit) return { ok: true, parsed: Object.assign({ rawText: text, parser: 'fake' }, hit), timingMs: 1 };
      return { ok: true, parsed: rulebased.parse(text, o), timingMs: 1 };
    },
  };
}

function createIntentParser(name, opts) {
  switch (name) {
    case 'rulebased':
      return createRuleParser();
    case 'http':
      return createHttpParser(opts);
    case 'fake':
      return createFakeParser(opts);
    default:
      throw new Error(`未知的需求解析器：${name}`);
  }
}

/**
 * 解析一段自然语言需求。
 *
 * @param {string} text 用户原话
 * @param {object} opts
 *   · `provider`   显式指定解析器（测试用）；不给则走降级链
 *   · `now`        时间基准（可复现测试用）
 *   · `knownPlaceNames` 已知地点名，用于识别必去/排除
 *   · `preferModel` 是否优先用模型（默认 true）
 */
async function parseIntents(text, opts) {
  opts = opts || {};
  const attempts = [];

  const chain = opts.provider
    ? [opts.provider]
    : opts.preferModel === false
      ? ['rulebased']
      : ['http', 'rulebased'];

  for (const name of chain) {
    const parser = createIntentParser(name, opts);

    if (parser.available === false) {
      attempts.push({ parser: name, ok: false, reason: 'NOT_CONFIGURED', message: '未配置，跳过' });
      continue;
    }

    const started = Date.now();
    const r = await parser.parse(text, opts);

    if (r.ok) {
      return {
        ok: true,
        parsed: r.parsed,
        parser: parser.name,
        promptVersion: parser.promptVersion,
        model: parser.model || null,
        keyMasked: parser.keyMasked || null,
        timingMs: r.timingMs != null ? r.timingMs : Date.now() - started,
        usage: r.usage || null,
        rawHead: r.rawHead || null,
        /** 走到这一步之前失败过谁 —— 降级要留痕，不能悄悄发生 */
        attempts,
        degraded: attempts.some((a) => !a.ok),
      };
    }

    attempts.push({
      parser: name,
      ok: false,
      reason: r.reason,
      message: r.message || null,
      timingMs: r.timingMs != null ? r.timingMs : Date.now() - started,
    });
  }

  // 规则解析必然可用，走到这里说明显式指定了不可用的 provider
  return {
    ok: false,
    parsed: null,
    attempts,
    reason: 'NO_PARSER_AVAILABLE',
    message: '没有可用的需求解析器',
  };
}

module.exports = {
  parseIntents,
  createIntentParser,
  createRuleParser,
  createFakeParser,
  rulebased,
  PROMPT_VERSION,
  RULE_PROMPT_VERSION,
};

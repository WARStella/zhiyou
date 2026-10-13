'use strict';

const resp = require('../lib/resp');
const { CODES, assert } = require('../lib/errors');
const { createIntentParser } = require('../lib/ai');
const rulebased = require('../lib/ai/rulebased');
const { logEvent } = require('../lib/trace');

/**
 * 大模型接口探针 —— 与 `map.probe` 同一个套路。
 *
 * 地图那条线是它救回来的（把原始返回带出来、逐项跑失败情形、
 * 不靠猜）。AI 这条线的不确定性只会更多：
 * Key 对不对、模型名对不对、返回结构是什么样、
 * `response_format` 支不支持、会不会包 markdown —— **全都得实测**。
 *
 * 所以这个探针的目标不是"报告成功"，而是**在失败时把原因指到具体一步**。
 */

/** 默认用一句有代表性的需求：有时间、有地点、有偏好 */
const DEFAULT_TEXT = '我下午想去中央大街附近逛逛，五点前结束，少走点路';

/** 单个情形的包装：任何异常都转成结构化条目，不让整份报告失败 */
async function runCase(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    return Object.assign({ name, durationMs: Date.now() - started }, detail);
  } catch (e) {
    return {
      name,
      ok: false,
      durationMs: Date.now() - started,
      reason: 'THREW',
      message: (e && (e.errMsg || e.message)) || String(e),
    };
  }
}

/** 只挑出界面真正要用的字段 —— 免得报告被无关内容淹掉 */
function summarizeParsed(parsed) {
  if (!parsed) return null;
  return {
    anchorText: parsed.anchorText || null,
    searchKeyword: parsed.searchKeyword || null,
    endClock: parsed.endClock ? parsed.endClock.text : null,
    startClock: parsed.startClock ? parsed.startClock.text : null,
    pace: parsed.pace || null,
    mustVisitTexts: parsed.mustVisitTexts || [],
    avoidTexts: parsed.avoidTexts || [],
    stayMinutes: parsed.stayMinutes == null ? null : parsed.stayMinutes,
    matchedCount: (parsed.matched || []).length,
    matched: parsed.matched || [],
    uncertainties: parsed.uncertainties || [],
    rawTextKeptAsIs: parsed.rawText === undefined ? null : !parsed.rawTextCorrected,
  };
}

async function probe(ctx) {
  const { repo, env, openid } = ctx;
  const p = ctx.payload || {};

  // 探针会真实调用外部服务（产生费用），仅在开发环境开放
  assert(env === 'dev', CODES.FORBIDDEN_ENV, `当前环境为 ${env}，AI 探针仅限 dev`);

  const text = (p.text || DEFAULT_TEXT).trim();
  const started = Date.now();

  /**
   * provider 与配置的取用：
   *   · 显式传 `provider` 时只用它（测试与排查用）；
   *   · 否则用默认的 http（DeepSeek），**不降级** ——
   *     探针要测的是这一条路通不通，降级会把它藏起来。
   */
  const makeParser = (overrides) =>
    createIntentParser(p.provider || 'http', {
      key: overrides && overrides.key !== undefined ? overrides.key : p.overrideKey,
      baseUrl: (overrides && overrides.baseUrl) || p.baseUrl,
      model: (overrides && overrides.model) || p.model,
      timeoutMs: p.timeoutMs,
    });

  const parser = makeParser();
  const results = [];

  // ① 主用例：真实调用一句话，把原始返回与解析结果都带出来
  results.push(
    await runCase('① 真实调用：一句话 → 结构化需求', async () => {
      if (!parser.available) {
        return {
          ok: false,
          reason: 'AI_KEY_NOT_CONFIGURED',
          message: '云函数环境变量 AI_API_KEY 未配置，无法调用大模型',
          hint: '云开发控制台 → 云函数 → api → 配置 → 环境变量 → 新增 AI_API_KEY',
        };
      }

      const r = await parser.parse(text, {});
      if (!r.ok) {
        return {
          ok: false,
          reason: r.reason,
          message: r.message,
          hint: r.hint || null,
          timingMs: r.timingMs,
          rawHead: r.rawHead || null,
        };
      }

      return {
        ok: true,
        timingMs: r.timingMs,
        usage: r.usage || null,
        parsed: summarizeParsed(r.parsed),
        /** 原始返回头部 —— 核对字段名与结构靠它，不靠记忆 */
        rawHead: r.rawHead || null,
        explanation: rulebased.explain(r.parsed),
        structured: rulebased.toStructured(r.parsed, {}).structured,
        constraints: rulebased.toStructured(r.parsed, {}).constraints,
        summary: `识别到 ${
          (r.parsed.matched || []).length
        } 项，${(r.parsed.uncertainties || []).length} 项待确认；检索词「${
          r.parsed.searchKeyword || '(无)'
        }」`,
      };
    })
  );

  // ② 无效 Key：确认鉴权失败被识别为失败，而不是被当成"模型没理解"
  results.push(
    await runCase('② 无效 Key（鉴权失败情形）', async () => {
      const bad = makeParser({ key: 'sk-INVALID_KEY_PROBE_0000' });
      const r = await bad.parse(text, {});
      return {
        ok: false,
        expectedFailure: true,
        reason: r.reason,
        message: r.message,
        summary: r.ok ? '⚠️ 无效 Key 竟然成功 —— 需检查鉴权配置' : `已正确拒绝：${r.message || r.reason}`,
      };
    })
  );

  // ③ 未配置 Key：确认缺依赖时给出可执行的修复指引，而不是含糊失败
  results.push(
    await runCase('③ 未配置 Key（缺失依赖情形）', async () => {
      const none = makeParser({ key: '' });
      const r = await none.parse(text, {});
      return {
        ok: false,
        expectedFailure: true,
        reason: r.reason,
        message: r.message,
        hint: r.hint || null,
        summary: r.message || r.reason,
      };
    })
  );

  // ④ 规则解析对照：同一条话用规则解析会得到什么 —— 两种解析的差距一目了然
  results.push(
    await runCase('④ 规则解析对照（不用模型会怎样）', async () => {
      const parsed = rulebased.parse(text, {});
      return {
        ok: true,
        informational: true,
        parsed: summarizeParsed(parsed),
        summary:
          `识别到 ${(parsed.matched || []).length} 项，` +
          `${(parsed.uncertainties || []).length} 项待确认；检索词「${parsed.searchKeyword || '(无)'}」`,
      };
    })
  );

  const critical = results.filter((r) => !r.expectedFailure && !r.informational);
  const criticalFailed = critical.filter((r) => !r.ok);
  const unexpectedSuccess = results.filter((r) => r.expectedFailure && r.ok);

  await logEvent(repo, {
    ts: new Date(ctx.now ? ctx.now : Date.now()),
    type: 'upstream_call',
    action: 'ai.probe',
    userId: openid,
    result: criticalFailed.length === 0 ? 'ok' : 'error',
    errCode: criticalFailed.length ? criticalFailed[0].reason || 'AI_PROBE_FAILED' : null,
    durationMs: Date.now() - started,
    // ① 最多 1 次真实模型调用；②③ 在配置校验阶段就返回了，不产生调用
    llmCalls: parser.available ? 1 : 0,
    detail: { text, provider: parser.name, model: parser.model || null },
  });

  return resp.ok({
    kind: 'aiProbe',
    provider: parser.name,
    keyConfigured: parser.available,
    keyMasked: parser.keyMasked || null,
    model: parser.model || null,
    promptVersion: parser.promptVersion || null,
    text,
    results,
    passed: critical.filter((r) => r.ok).length,
    total: critical.length,
    llmCalls: parser.available ? 1 : 0,
    verdict:
      criticalFailed.length === 0 && unexpectedSuccess.length === 0
        ? '关键用例通过；失败情形已被正确拒绝'
        : criticalFailed.length > 0
          ? '关键用例失败 —— 见 ok:false 条目；**此时系统会降级到规则解析**，' +
            '所以功能不会中断，但「模型理解」这项能力是缺的'
          : '失败情形竟然成功 —— 鉴权或配置可能有问题',
    checklist: [
      '模型名：AI_MODEL 默认 deepseek-chat。若报"模型不存在"，到 DeepSeek 控制台核对可用模型名',
      'Key 来源：必须是**为本项目单独申请**的 Key，不要复用其他工具的（账单会纠缠）',
      '返回结构：核对 ① 的 rawHead 与 parsed —— 模型可能返回了字段名对不上的 JSON',
      'JSON 容错：模型常把 JSON 包在 markdown 代码块里，已做容错；若仍失败见 rawHead',
      '额度：DeepSeek 控制台查看余额与用量；欠费会返回 402 类错误',
      '降级：任何失败都会退回规则解析（§6.5），功能不中断 —— 但**必须让人看得出来**',
    ],
    note:
      '探针会真实调用一次大模型（产生费用），仅在 dev 环境开放。' +
      'Key 只以掩码形式出现，不会泄露。',
  });
}

module.exports = { probe, DEFAULT_TEXT, summarizeParsed };

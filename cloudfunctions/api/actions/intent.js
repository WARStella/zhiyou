'use strict';

const resp = require('../lib/resp');
const { require_fields } = require('../lib/errors');
const { parseIntents, rulebased } = require('../lib/ai');
const { logEvent } = require('../lib/trace');
const C = require('../lib/repo/collections');

/**
 * 需求解析 —— 把一句话变成**可下发给规划器的结构化需求**。
 *
 * 这一步是 AI 层与算法层的接缝，也是 C 的活（当前由同一人承担）。
 *
 * ── 三条不许越过的线 ────────────────────────────────────────
 *
 * ① **原话必须原样落库**（`rawText`）。附录 C 的评测与可解释性都要它；
 *    只存解析结果等于把"模型理解错了什么"这件事永久销毁。
 *
 * ② **含糊表达不得换算成数值**（§6.2）。「有点累」进 `uncertainties`，
 *    不变成 `maxWalkMinutes: 30`。宁可少一个约束，不用猜的数值去算可行性。
 *
 * ③ **降级要留痕**。模型不可用时退回规则解析，`attempts` 里记着为什么 ——
 *    不能让人以为这是模型解析的结果。
 */
async function parse(ctx) {
  const { repo, openid, env } = ctx;
  const p = ctx.payload || {};
  require_fields(p, ['text']);

  const now = new Date(ctx.now ? ctx.now : Date.now());
  const started = Date.now();

  // 已知地点名 —— 用来判断"必去 XX / 别去 XX"里 XX 是不是真的地名，
  // 否则会把「一定要去看看」里的"看看"也当地点
  const places = await repo.find(C.PLACES, {}, { limit: 200 });
  const knownPlaceNames = places.map((x) => x.name).filter(Boolean);

  const r = await parseIntents(p.text, {
    provider: p.provider,
    preferModel: p.preferModel,
    now,
    knownPlaceNames,
    // 覆盖 Key 仅开发期可用（与 map.probe、place.search 同一约定）
    key: env === 'dev' ? p.overrideKey : undefined,
    baseUrl: env === 'dev' ? p.overrideBaseUrl : undefined,
    model: env === 'dev' ? p.overrideModel : undefined,
  });

  if (!r.ok) {
    await logEvent(repo, {
      ts: now,
      type: 'upstream_call',
      action: 'intent.parse',
      userId: openid,
      result: 'error',
      errCode: r.reason || 'NO_PARSER_AVAILABLE',
      durationMs: Date.now() - started,
      detail: { attempts: r.attempts },
    });
    return resp.ok({
      ok: false,
      reason: r.reason || 'NO_PARSER_AVAILABLE',
      message: r.message || '没有可用的需求解析器',
      attempts: r.attempts,
    });
  }

  const parsed = r.parsed;
  const { structured, constraints } = rulebased.toStructured(parsed, {
    now,
    startPoint: p.startPoint || null,
  });

  // 落库：rawText 原样保留，aiMeta 记下是谁解析的、降级了没有
  const requirement = await repo.insert(C.REQUIREMENTS, {
    scope: p.crewId ? 'team' : 'personal',
    ownerUserId: openid,
    crewId: p.crewId || null,
    tripId: null,
    rawText: p.text,
    structured,
    constraints,
    /**
     * `source` 增加 `rule` 取值：规则解析既不是模型（ai），
     * 也不是用户手填（manual）。混为一谈会让评测无法区分两类样本。
     */
    source: r.parser === 'http' ? 'ai' : 'rule',
    aiMeta: {
      parser: r.parser,
      model: r.model || null,
      promptVersion: r.promptVersion || null,
      degraded: r.degraded === true,
      attempts: r.attempts,
      timingMs: r.timingMs,
      usage: r.usage || null,
    },
    createdAt: now,
    updatedAt: now,
  });

  await logEvent(repo, {
    ts: now,
    type: 'upstream_call',
    action: 'intent.parse',
    userId: openid,
    result: 'ok',
    durationMs: Date.now() - started,
    detail: {
      parser: r.parser,
      degraded: r.degraded === true,
      matchedCount: (parsed.matched || []).length,
      uncertaintyCount: (parsed.uncertainties || []).length,
      llmCalls: r.parser === 'http' ? 1 : 0,
    },
  });

  return resp.ok({
    ok: true,
    requirementId: requirement._id,
    rawText: p.text,

    // ── 谁解析的、降级了没有：必须让界面能如实告知 ──
    parser: r.parser,
    degraded: r.degraded === true,
    attempts: r.attempts,
    promptVersion: r.promptVersion || null,
    model: r.model || null,
    timingMs: r.timingMs,

    // ── 解析结果 ──
    parsed,
    /** 可直接下发 `trip.plan` 的结构（只含已确定的字段） */
    structured,
    constraints,
    /** 人话解释：每一项是从原文哪一段来的 —— 界面直接展示，不藏依据 */
    explanation: rulebased.explain(parsed),
    /** **必须让用户确认**的项（§6.2）—— 界面要给选项，不能自动填 */
    uncertainties: parsed.uncertainties || [],
    /** 建议的检索关键词，前端可以直接拿它去调 place.search */
    searchKeyword: parsed.searchKeyword || null,
    matched: parsed.matched || [],
  });
}

module.exports = { parse };

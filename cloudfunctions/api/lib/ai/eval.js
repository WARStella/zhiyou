'use strict';

/**
 * 需求解析的**评分器** —— 纯函数，不发请求。
 *
 * ── 为什么需要它 ──────────────────────────────────────────
 *
 * 用户想做"模型超参"，目标是"让功能更准确"。
 * 但**没有评分器，"更准确"只是感觉**：
 * 加了 3 个 few-shot 到底有没有用？换个模型值不值？只有分数能回答。
 *
 * ── 两条纪律（都来自计划书）────────────────────────────────
 *
 * ① **只检查样例声明过的字段**。
 *    没写在 `expected` 里的字段一律不管 —— 否则合理的不同表达会被当成错误，
 *    指标就变成了"像不像参考答案"而不是"对不对"。
 *
 * ② **错误类型分开统计，不合成一个"准确率"**。
 *    这是 §C.3 的原话：「正常拒绝、误拒绝与错误放行必须分开报告 ——
 *    三者混成一个'准确率'会掩盖真实问题。」
 *    解析这边同理：
 *
 *      漏提取（MISS）    用户说了，系统没提取出来
 *      多提取（EXTRA）   用户没说，系统自己加了一个
 *      值错误（WRONG）   提取出来了，但值不对
 *      结构错（MALFORMED） 该给数组的给了字符串之类
 *
 *    **"少提取"和"多提取"是两种不同的毛病**：
 *    漏了时间用户会补，凭空加一个"必去"会直接改错行程 —— 后者严重得多。
 */

const KIND = {
  MISS: 'MISS',
  EXTRA: 'EXTRA',
  WRONG: 'WRONG',
  MALFORMED: 'MALFORMED',
};

/** 取点分路径的值（`a.b.c`） */
function get(obj, path) {
  return String(path)
    .split('.')
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** 从解析结果里取"有哪些检索词" —— 复数优先，退回单数 */
function keywordsOf(parsed) {
  const list = (parsed && parsed.searchKeywords) || [];
  if (list.length) return list.slice();
  return parsed && parsed.searchKeyword ? [parsed.searchKeyword] : [];
}

/** 从解析结果里取"每个地点各待多久" */
function stayByTextOf(parsed) {
  return (parsed && parsed.stayMinutesByText) || {};
}

/**
 * 评分一个样例。
 *
 * @param {object} sample   `{id, text, expected}`
 * @param {object} parsed   解析结果（`intent.parse` 的 `parsed`）
 * @returns {{id, checks[]}} 每条检查带 kind 与说明
 */
function scoreSample(sample, parsed) {
  const exp = (sample && sample.expected) || {};
  const checks = [];
  const push = (name, ok, kind, detail) => checks.push({ name, ok: Boolean(ok), kind, detail });

  // ── 时间 ──
  for (const field of ['startClock', 'endClock']) {
    if (!exp[field]) continue;
    const got = parsed && parsed[field];
    const want = exp[field];
    if (!got) {
      push(field, false, KIND.MISS, `用户说了时间，系统没提取出来（期望 ${want.hour}:${want.minute}）`);
    } else if (got.hour !== want.hour || got.minute !== want.minute) {
      push(field, false, KIND.WRONG, `期望 ${want.hour}:${want.minute}，实际 ${got.hour}:${got.minute}`);
    } else {
      push(field, true);
    }
  }

  // ── 地点：检索词 ──
  const kws = keywordsOf(parsed);
  for (const k of exp.searchKeywordsContain || []) {
    push(
      `searchKeywords⊇${k}`,
      kws.some((x) => String(x).indexOf(k) >= 0),
      KIND.MISS,
      `应当检索「${k}」，实际 ${JSON.stringify(kws)}`
    );
  }
  for (const k of exp.searchKeywordsNotContain || []) {
    /**
     * ⚠️ **必须用精确相等，不能用子串包含**（2026-10-13 修正）。
     *
     * 首版写的是 `indexOf(k) < 0`，于是：
     *     「和平路」包含「平路」→ 被判成"不该出现的检索词出现了"
     * 而「和平路」恰恰是**正确结果** —— 这正是今天反复踩的
     * **「字符串包含即相等」**那个毛病，这次出现在评分器自己身上。
     *
     * 评分器的假阳性比漏报更危险：它会让**正确的实现看起来是错的**，
     * 于是有人去"修"一个本来没坏的东西。
     */
    push(
      `searchKeywords⊅${k}`,
      !kws.some((x) => String(x).trim() === String(k).trim()),
      KIND.EXTRA,
      `不该把「${k}」当检索词 —— 用户明确不想去或它不是地名`
    );
  }
  if (exp.searchKeywordsAtLeast) {
    push(
      'searchKeywords 数量',
      kws.length >= exp.searchKeywordsAtLeast,
      KIND.MISS,
      `至少应有 ${exp.searchKeywordsAtLeast} 个检索词，实际 ${kws.length} 个：${JSON.stringify(kws)}`
    );
  }
  if (exp.searchKeywordsEmpty) {
    push(
      'searchKeywords 应为空',
      kws.length === 0,
      KIND.EXTRA,
      `认不出地点时**不能编一个检索词**，实际 ${JSON.stringify(kws)}`
    );
  }

  // ── 地点：必去 ──
  const must = (parsed && parsed.mustVisitTexts) || [];
  for (const k of exp.mustVisitTextsContain || []) {
    push(
      `mustVisit⊇${k}`,
      must.some((x) => String(x).indexOf(k) >= 0),
      KIND.MISS,
      `「${k}」应当进必去，实际 ${JSON.stringify(must)}`
    );
  }
  for (const k of exp.mustVisitTextsNotContain || []) {
    push(
      `mustVisit⊅${k}`,
      !must.some((x) => String(x).indexOf(k) >= 0),
      KIND.EXTRA,
      `「${k}」不该进必去 —— 系统自己加了一个，会直接改错行程`
    );
  }

  // ── 地点：排除 ──
  const avoid = (parsed && parsed.avoidTexts) || [];
  for (const k of exp.avoidTextsContain || []) {
    push(
      `avoid⊇${k}`,
      avoid.some((x) => String(x).indexOf(k) >= 0),
      KIND.MISS,
      `「${k}」应当进排除，实际 ${JSON.stringify(avoid)}`
    );
  }

  // ── 节奏 ──
  if (exp.pace) {
    push(
      'pace',
      parsed && parsed.pace === exp.pace,
      parsed && parsed.pace ? KIND.WRONG : KIND.MISS,
      `期望 ${exp.pace}，实际 ${parsed && parsed.pace}`
    );
  }

  // ── 停留时长（统一）──
  if (exp.stayMinutes != null) {
    push(
      'stayMinutes',
      parsed && parsed.stayMinutes === exp.stayMinutes,
      parsed && parsed.stayMinutes != null ? KIND.WRONG : KIND.MISS,
      `期望 ${exp.stayMinutes} 分钟，实际 ${parsed && parsed.stayMinutes}`
    );
  }
  if (exp.stayMinutesIsNull) {
    push(
      'stayMinutes 应为空',
      !parsed || parsed.stayMinutes == null,
      KIND.EXTRA,
      `这是**调整**语义（多待一会儿），不该被当成每站时长，实际 ${parsed && parsed.stayMinutes}`
    );
  }

  // ── 停留时长（按地点）──
  const byText = stayByTextOf(parsed);
  for (const [k, v] of Object.entries(exp.stayMinutesByTextContains || {})) {
    const keys = Object.keys(byText);
    const hit = keys.find((x) => x.indexOf(k) >= 0 || k.indexOf(x) >= 0);
    push(
      `stayByText[${k}]=${v}`,
      hit != null && byText[hit] === v,
      hit == null ? KIND.MISS : KIND.WRONG,
      hit == null
        ? `没有「${k}」的时长，实际 ${JSON.stringify(byText)}`
        : `「${k}」期望 ${v} 分钟，实际 ${byText[hit]}`
    );
  }

  // ── 调整语义 ──
  if (exp.extendStayMin != null) {
    push(
      'extendStayMin',
      parsed && parsed.extendStayMin === exp.extendStayMin,
      KIND.MISS,
      `期望延长 ${exp.extendStayMin} 分钟，实际 ${parsed && parsed.extendStayMin}`
    );
  }

  // ── 待确认项 ──
  const unc = (parsed && parsed.uncertainties) || [];
  if (exp.uncertaintiesAtLeast) {
    push(
      'uncertainties 数量',
      unc.length >= exp.uncertaintiesAtLeast,
      KIND.MISS,
      `含糊表达必须进 uncertainties（§6.2），至少 ${exp.uncertaintiesAtLeast} 条，实际 ${unc.length} 条`
    );
  }
  if (exp.uncertaintiesContainField) {
    for (const f of exp.uncertaintiesContainField) {
      push(
        `uncertainties⊇${f}`,
        unc.some((u) => u.field === f),
        KIND.MISS,
        `应当就「${f}」向用户确认`
      );
    }
  }
  if (exp.mustNotGuessMaxWalkMinutes) {
    /**
     * §6.2 的硬线：「有点累」**不得**被换算成 `maxWalkMinutes: 30`。
     * 宁可少一个约束，也不用猜出来的数值算可行性。
     */
    const guessed =
      (parsed && parsed.maxWalkMinutes != null) ||
      (parsed && Array.isArray(parsed.constraints) && parsed.constraints.some((c) => c && c.key === 'maxWalkMinutes'));
    push(
      '不得猜测 maxWalkMinutes',
      !guessed,
      KIND.EXTRA,
      '含糊表达被换算成了具体数值 —— 这是 §6.2 明确禁止的'
    );
  }

  for (const [path, want] of Object.entries(exp.fields || {})) {
    const got = get(parsed, path);
    push(`fields.${path}`, got === want, got == null ? KIND.MISS : KIND.WRONG, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
  }

  return { id: sample && sample.id, text: sample && sample.text, checks };
}

/**
 * 汇总一批样例的评分。
 *
 * **不输出"总分"** —— 与 §C.3「不设总耗时作为主指标」同一个精神：
 * 不同的错误有不同的代价，合成一个数会把它们抹平。
 */
function summarize(scored) {
  const byKind = { MISS: 0, EXTRA: 0, WRONG: 0, MALFORMED: 0 };
  let total = 0;
  let passed = 0;
  const failedSamples = [];

  for (const s of scored || []) {
    const checks = (s && s.checks) || [];
    const bad = checks.filter((c) => !c.ok);
    total += checks.length;
    passed += checks.length - bad.length;
    for (const c of bad) {
      const k = byKind[c.kind] != null ? c.kind : KIND.WRONG;
      byKind[k] += 1;
    }
    if (bad.length) {
      failedSamples.push({
        id: s.id,
        text: s.text,
        failures: bad.map((c) => ({ name: c.name, kind: c.kind, detail: c.detail })),
      });
    }
  }

  // 样例级：全部检查都通过的样例数
  const samples = (scored || []).length;
  const cleanSamples = samples - failedSamples.length;

  return {
    samples,
    cleanSamples,
    samplePassRate: samples ? Number((cleanSamples / samples).toFixed(4)) : null,
    checks: total,
    passed,
    checkPassRate: total ? Number((passed / total).toFixed(4)) : null,
    /** ⚠️ 分开报告 —— 合并会掩盖真实问题（§C.3） */
    byKind,
    /** 多提取与值错误比漏提取严重：前者会主动改错行程 */
    severity: {
      /** 用户说了没提取到 */
      miss: byKind.MISS,
      /** 用户没说系统自己加的 —— **最严重** */
      extra: byKind.EXTRA,
      wrong: byKind.WRONG,
      malformed: byKind.MALFORMED,
    },
    failedSamples,
    note:
      '不输出总分：漏提取、多提取、值错误代价不同，合并会掩盖问题（§C.3 同一条纪律）。' +
      '**多提取最严重** —— 系统替用户加一个"必去"，会直接改错行程。',
  };
}

module.exports = { scoreSample, summarize, KIND, keywordsOf, stayByTextOf };

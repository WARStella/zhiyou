'use strict';

/**
 * 步行估算的**离线评测器** —— 纯函数，不联网、不读库、不调模型。
 *
 * ── 它回答什么问题 ────────────────────────────────────────
 *
 *   **"现有规则在这批样本上的误差是多少？换一个模型能不能更好？"**
 *
 * 这是计划书 §6.8.5「P0 建基线」的验收口径。在它之前，
 * `ops.walkStats` 只能给**描述统计**（各区间的中位倍率），
 * 而"更准"这句话**没有对照就没有意义**：
 *
 *   · 没有基线，"准确率 92%" 不可验证（§6.8.7 第 2 条）；
 *   · 没有冻结集，调参调到好看只是**在自己看过的数据上好看**；
 *   · 两者都没有时，唯一的产出是一段**无法验证的代码**。
 *
 * ── 三个目标量，这里只评"距离" ────────────────────────────
 *
 *   ① `detourRatio`（路径 ÷ 直线）—— **两端都是真实几何量**，
 *      每次调地图接口自动产生，**不需要任何人走路**。
 *      → 本项目**唯一还能持续增长的定量标签**（计划书 §1.3）。
 *   ② `actualMinutes`（用户真实用时）—— 需要真人真走。
 *      没有外场实测时它**基本恒为 null** → 这里**只报覆盖率，不给分数**。
 *      给它编一个分数，等于用"没有数据"产出"看起来有数据"。
 *   ③ `predictedMinutes`（地图预测）—— 是**特征**，不是标签。
 *      拿它当标签是循环论证（`actions/trip.js` 已写明）。
 *
 * ── 两条纪律（写进代码，不靠人记）─────────────────────────
 *
 *   **纪律一：拟合只许看开发集。**
 *   `fit*` 只接受开发集；`evaluate` 会**再断言一次**。
 *   冻结集一旦参与拟合，分数就没有意义 —— 而这种错误**不会报错**，
 *   只会让结果看起来更好。所以宁可抛错，也不静默放过。
 *
 *   **纪律二：样本不够就直说，不给结论。**
 *   `ops.walkStats` 的口径是"少于 5 条不给建议系数"，
 *   这里沿用并放大：**少于 `MIN_SCORE_SAMPLES` 条一律判"不足以判断"**，
 *   分数置 null，而不是算一个看起来很精确的小数。
 */

/**
 * 距离分桶 —— **全项目唯一的定义**。
 *
 * ⚠️ 2026-10-15 之前，这份表同时存在于 `actions/user.js`（校准报告）
 * 与新写的评测器里。**两处定义必然漂移**，而漂移的表现是
 * "报告说 A、评测说 B"，**两边都不报错** —— 本项目在认地名上
 * 已经吃过一次"两套规则"的亏（哈工大：一个认、一个不认）。
 * 所以在加第二处之前先合并到一处。
 */
const DISTANCE_BUCKETS = [
  { label: '0–100 米', min: 0, max: 100 },
  { label: '100–300 米', min: 100, max: 300 },
  { label: '300–600 米', min: 300, max: 600 },
  { label: '600–1000 米', min: 600, max: 1000 },
  { label: '1000–2000 米', min: 1000, max: 2000 },
  { label: '2000 米以上', min: 2000, max: Infinity },
];

/** 一个区间的拟合至少要几条样本 —— 不足就不给系数（沿用 walkStats 的口径） */
const MIN_BUCKET_SAMPLES = 5;

/** 低于这个总数**一律不给结论**。30 是"能号称跑过一次评测"的最低限度，不是统计功效结论。 */
const MIN_SCORE_SAMPLES = 30;

/**
 * **独立路线数**的下限（2026-10-15 新增）。
 *
 * ⚠️ 为什么除了条数还要加这一道：同一路线被反复调用会产生多条记录
 * （一次规划 5 段、十次规划就有十条同路线记录）。**重复请求不提高信息量**，
 * 把它们当独立样本，等于用"同一条路走十遍"凑出 300 条样本量，
 * 而真实的独立路线可能只有 30 条。
 *
 * 所以两道门都要过：**条数 ≥ 30**（有得算）且**独立路线 ≥ 20**（算出来有意义）。
 * 值同样是人设定的，正式实测前冻结（§11.4）。
 */
const MIN_SCORE_GROUPS = 20;

/**
 * 判"打败了基线"的**最小相对改进**。
 *
 * ⚠️ 这是一个**人为设定**的阈值，不是一个算出来的数。它的作用是防止
 * "改进了 0.3% 就宣称胜利" —— 那点差别完全可能来自切分噪声。
 * 正式实测前**必须冻结它**，并写进报告（计划书 §11.4：
 * "正式测试前冻结主要指标、任务与参数"）。
 */
const MIN_RELATIVE_GAIN = 0.05;

/** 产品当前用的那个常数（`geo.DETOUR_FACTOR` 的历史值，用作对照基线之一） */
const PRODUCT_CONSTANT = 1.3;

/**
 * 分组切分工具 —— **哈希与路线组键都从那里来，本文件不再自己实现一份**。
 *
 * ⚠️ 2026-10-15 修正的真实缺陷：原先本文件按每条样本的 `_id` 哈希切分。
 * 而同一路线会被反复调用（一次规划 5 段），于是**近乎相同的样本
 * 同时落进开发集与冻结集** → 冻结集"见过"的东西，参数已经在开发集上
 * 调过了 → 分数偏乐观，**而且看起来一切正常**。
 *
 * 现在按**路线组**切：同一条路（含反向、含重复请求）整体落在同一侧。
 */
const splitLib = require('./dataset-split');

// ── 字段读取：新旧两种写法都要能读 ────────────────────────
//
// 2026-10-15 的字段改名（见 `actions/trip.js` 的写入处注释）：
//   actualMeters          → providerRouteMeters   （它一直是"路径距离"，不是实测）
//   predictedMinutes      → providerDurationSeconds
//   actualMinutes         → observedDurationSeconds
//
// 读的一方**两种都读**，因为库里同时存在新旧两种样本；
// 迁移完成后删掉旧的那几行即可。这里集中在一处，别处不许再判断字段名。

/** 路径距离（米）—— 本轮的参考标签 */
function routeMetersOf(sample) {
  if (!sample) return null;
  if (typeof sample.providerRouteMeters === 'number') return sample.providerRouteMeters;
  if (typeof sample.actualMeters === 'number') return sample.actualMeters; // 兼容
  return null;
}

/** 地图预测耗时（秒）—— 特征，不是标签 */
function providerSecondsOf(sample) {
  if (!sample) return null;
  if (typeof sample.providerDurationSeconds === 'number') return sample.providerDurationSeconds;
  if (typeof sample.predictedMinutes === 'number') return sample.predictedMinutes * 60; // 兼容
  return null;
}

/** 真人观测耗时（秒）—— 标签，没有就是没有 */
function observedSecondsOf(sample) {
  if (!sample) return null;
  if (typeof sample.observedDurationSeconds === 'number') return sample.observedDurationSeconds;
  if (typeof sample.actualMinutes === 'number') return sample.actualMinutes * 60; // 兼容
  return null;
}

/**
 * 质量分级：`excluded` 明确排除；`pending_review` **不参与拟合与评分**，
 * 但**一定计入报告**（否则"库里 260 条、用了 200 条"说不清）。
 */
function qualityOf(sample) {
  if (!sample) return 'excluded';
  if (sample.qualityStatus === 'excluded' || sample.excludedReason) return 'excluded';
  if (sample.qualityStatus === 'pending_review') return 'pending_review';
  return 'ok';
}

/** 中位数 —— 比均值抗离群（同一条路偶尔会有异常返回值）。空数组返回 null。 */
function median(nums) {
  if (!nums || !nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Number(((s[m - 1] + s[m]) / 2).toFixed(3));
}

/**
 * 可用的样本 —— 判据与 `ops.walkStats` **完全一致**（两端都是正的真实几何量），
 * 另加一条：**质量标记为待复核或已排除的不进拟合**。
 *
 * ⚠️ 排除掉的条数**必须一起返回**，不能静默丢：
 * "用了 200 条"与"库里有 260 条、60 条算不出倍率或待复核"是两句不同的话，
 * 后者能看出数据质量问题，前者会把问题藏起来。
 */
function usableSamples(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const usable = [];
  const excluded = [];
  const pendingReview = [];
  for (const s of list) {
    const q = qualityOf(s);
    if (q === 'pending_review') {
      pendingReview.push(s);
      continue;
    }
    if (q === 'excluded') {
      excluded.push(s);
      continue;
    }
    const ok =
      s &&
      typeof s.straightMeters === 'number' &&
      typeof routeMetersOf(s) === 'number' &&
      s.straightMeters > 0 &&
      routeMetersOf(s) > 0;
    if (ok) usable.push(s);
    else excluded.push(s);
  }
  return { usable, excluded, pendingReview };
}

/** 一条样本的真实倍率（目标量）。不可用时返回 null。 */
function trueRatio(sample) {
  if (!sample || typeof sample.straightMeters !== 'number') return null;
  const route = routeMetersOf(sample);
  if (!(sample.straightMeters > 0) || typeof route !== 'number') return null;
  return route / sample.straightMeters;
}

/** 一条样本落在哪个区间（找不到则返回 null，而不是硬塞进最后一桶） */
function bucketOf(straightMeters, buckets) {
  const list = buckets || DISTANCE_BUCKETS;
  for (const b of list) {
    if (straightMeters >= b.min && straightMeters < b.max) return b;
  }
  return null;
}

/**
 * 确定性切分：先取**路线组**，再按组把样本分成**开发集**与**冻结集**。
 *
 * ⚠️ 与 2026-10-15 之前的版本有三个区别，每一个都是缺陷修复：
 *
 *   ① **按组切，不按记录切** —— 否则同一路线的多次调用会同时进两侧，
 *      分数偏乐观且不报错（详见 `lib/dataset-split.js` 的说明）。
 *   ② **反向合并** —— A→B 与 B→A 是同一条路，组键排序后拼接。
 *   ③ **算不出组键的进 `ungrouped`**，不进任何一侧 ——
 *      把它们随便塞进某一侧，等于让"身份不明"的东西参与评分。
 */
function splitFrozen(rows, opts) {
  const o = opts || {};
  const { usable, excluded, pendingReview } = usableSamples(rows);
  const s = splitLib.splitByGroup(usable, {
    ratio: o.ratio,
    seed: o.seed == null ? 'zy-walk-2026' : o.seed,
    keyFn: splitLib.routeGroupKey,
  });
  return {
    dev: s.dev,
    frozen: s.frozen,
    excluded,
    pendingReview,
    ungrouped: s.ungrouped,
    groups: s.groups,
    ratio: s.ratio,
    seed: s.seed,
    total: usable.length,
    stats: s.stats,
  };
}

// ── 拟合：**只接受开发集** ────────────────────────────────

/** 基线一：单常数（产品现状）—— 把开发集的中位倍率当作常数 */
function fitConstant(dev) {
  const { usable } = usableSamples(dev);
  const ratios = usable.map(trueRatio).filter((r) => r !== null);
  return {
    kind: 'constant',
    factor: median(ratios),
    n: ratios.length,
    note: '单常数：把开发集的中位倍率当作固定系数（产品当前用 1.3）',
  };
}

/** 基线二：分段常数 —— 每个距离区间一个中位倍率 */
function fitBuckets(dev, buckets) {
  const list = buckets || DISTANCE_BUCKETS;
  const { usable } = usableSamples(dev);
  const factors = {};
  const counts = {};
  const insufficient = [];
  for (const b of list) {
    const inBucket = usable.filter((s) => {
      const bb = bucketOf(s.straightMeters, list);
      return bb && bb.label === b.label;
    });
    const ratios = inBucket.map(trueRatio).filter((r) => r !== null);
    counts[b.label] = ratios.length;
    /**
     * ⚠️ 样本不足**不给系数**（null），而不是"有多少算多少"。
     * 用 3 条样本定一个系数，会让这个区间在评测里**看起来有结论**。
     */
    if (ratios.length >= MIN_BUCKET_SAMPLES) {
      factors[b.label] = median(ratios);
    } else {
      factors[b.label] = null;
      insufficient.push(b.label);
    }
  }
  return {
    kind: 'buckets',
    bucketList: list,
    factors,
    counts,
    insufficient,
    n: usable.length,
    note: `分段常数：每区间 ${MIN_BUCKET_SAMPLES} 条以上才给系数，不足的区间回落到单常数`,
  };
}

/**
 * 预测一条样本的**路径距离**。
 *
 * ⚠️ **只读 `straightMeters`**（与模型自带的系数）—— 这是刻意的约束，不是巧合：
 * 模型要在**地图接口失败**时兜底，而那一刻路径距离、耗时、路线形状都不存在。
 * 所以输入只有直线距离；天气、星期、时段也不塞（要么拿不到，要么要用户额外说）。
 * 有测试守着这条契约（把样本里所有非 `straightMeters` 的字段换掉，预测必须不变）。
 *
 * `fallbackFactor` = 区间样本不足时用的系数（评测器传单常数的拟合值）；
 * 它是**明确写出来的参数**，不是隐藏在函数里的 1.3 ——
 * 否则"分段常数到底用了什么"在报告里说不清。
 */
function predictMeters(model, sample, fallbackFactor) {
  if (!model || !sample || typeof sample.straightMeters !== 'number') return null;
  let factor = null;
  if (model.kind === 'constant') {
    factor = model.factor;
  } else if (model.kind === 'buckets') {
    const b = bucketOf(sample.straightMeters, model.bucketList || DISTANCE_BUCKETS);
    factor = b ? model.factors[b.label] : null;
    if (factor == null) factor = fallbackFactor == null ? null : fallbackFactor;
  } else if (model.kind === 'fixed') {
    factor = model.factor;
  }
  if (factor == null) return null;
  return sample.straightMeters * factor;
}

/**
 * 在**给定样本集**上打分。返回的每个数都带"基于几条"。
 *
 * 指标口径：
 *   · `mapePercent` —— **中位数绝对百分比误差**（与 `ops.walkStats` 同名同义）。
 *     用中位数不用均值：一条上游异常返回值就能把均值拉走，
 *     而"中位数差 12%"是可以拿去答辩的句子，"均值差 340%"不是。
 *   · `biasPercent` —— **带符号**的中位相对误差。
 *     MAPE 只说"差多少"，不说"偏高还是偏低"；
 *     而"系统一贯高估 20%"是能直接指导修改的结论。
 */
function scoreMeters(model, samples, opts) {
  const o = opts || {};
  const fallbackFactor = o.fallbackFactor;
  const errs = [];
  const signed = [];
  const skipped = [];
  for (const s of samples || []) {
    const truth = routeMetersOf(s);
    const pred = predictMeters(model, s, fallbackFactor);
    if (truth == null || truth <= 0 || pred == null || !(pred > 0)) {
      skipped.push(s);
      continue;
    }
    const rel = (pred - truth) / truth;
    errs.push(Math.abs(rel));
    signed.push(rel);
  }
  const enough = errs.length >= MIN_SCORE_SAMPLES;
  return {
    n: errs.length,
    skipped: skipped.length,
    /** 样本不足时**分数一律为 null** —— 不给"看起来有结论"的数字 */
    mapePercent: enough ? Number((median(errs) * 100).toFixed(1)) : null,
    biasPercent: enough ? Number((median(signed) * 100).toFixed(1)) : null,
    medianAbsErrorMeters: enough
      ? Number(
          median(
            (samples || [])
              .map((s) => {
                const pred = predictMeters(model, s, fallbackFactor);
                const truth = routeMetersOf(s);
                return pred == null || typeof truth !== 'number' ? null : Math.abs(pred - truth);
              })
              .filter((x) => x !== null)
          ).toFixed(1)
        )
      : null,
    insufficient: !enough,
    reason: enough ? null : `评分样本只有 ${errs.length} 条，低于 ${MIN_SCORE_SAMPLES} 条 —— 不足以判断`,
  };
}

/**
 * 覆盖率报告 —— **"哪些目标还不能评"本身就是一个结论**。
 *
 * 三个要点：
 *
 * ① `observedDurationSeconds` 在无外场实测时基本恒为空（计划书 v7.1 §1.3）。
 *    与其在报告里留一个空表格，不如明确写出"0/240 条有时长标签，
 *    因此本轮不评时长模型"。
 *
 * ② **独立路线数与记录数分开报**。同一条路调十次是十条记录、一条路线 ——
 *    "重复请求可以留作稳定性记录，但不能当作新的独立路线"。
 *
 * ③ `pendingReview`（质量待复核）**单独一栏**：它们没参与拟合，
 *    但必须出现在报告里，否则"库里多少、用了多少"对不上。
 */
function coverage(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const { usable, excluded, pendingReview } = usableSamples(list);
  const withPredicted = usable.filter((s) => typeof providerSecondsOf(s) === 'number' && providerSecondsOf(s) > 0);
  const withObserved = usable.filter((s) => typeof observedSecondsOf(s) === 'number' && observedSecondsOf(s) > 0);
  const buckets = DISTANCE_BUCKETS.map((b) => {
    const inBucket = usable.filter((s) => {
      const bb = bucketOf(s.straightMeters);
      return bb && bb.label === b.label;
    });
    const groups = new Set(inBucket.map((s) => splitLib.routeGroupKey(s)).filter(Boolean));
    return { label: b.label, count: inBucket.length, groups: groups.size };
  });
  const byGroup = splitLib.coverageByGroup(usable, { keyFn: splitLib.routeGroupKey });
  return {
    total: list.length,
    usable: usable.length,
    excluded: excluded.length,
    pendingReview: pendingReview.length,
    withPredictedSeconds: withPredicted.length,
    withObservedSeconds: withObserved.length,
    /** 兼容旧名（10/15 之前只有分钟口径） */
    withPredictedMinutes: withPredicted.length,
    withActualMinutes: withObserved.length,
    buckets,
    /** 记录数 vs 独立路线数 —— 两个数一起看才有意义 */
    records: byGroup.records,
    distinctRoutes: byGroup.distinctGroups,
    repeatedRecords: byGroup.repeatedRecords,
    maxRepeats: byGroup.maxRepeats,
    ungrouped: byGroup.ungrouped,
    /** 时长模型能不能评 —— 判据是"有时长标签的条数"，不是总条数 */
    minutesTargetEvaluable: withObserved.length >= MIN_SCORE_SAMPLES,
  };
}

/**
 * 判决：候选**是否打败基线**。
 *
 * 抽成纯函数，因为它是整个评测里**唯一会下结论**的地方 ——
 * 内联在 `evaluate` 里就没法单独测，而"判决写错"的后果是
 * **宣布一个不存在的胜利**（§6.8.7 第 2 条明确禁止）。
 *
 * 三个出口必须分得开：
 *   · `NOT_BETTER` —— 更差或持平；
 *   · `GAIN_BELOW_THRESHOLD` —— 确实更好，但好得不够（可能是切分噪声）；
 *   · `null` —— 真的打败了。
 * "没打败"与"样本不够，无法判断"是两句不同的话，不在这里合并。
 */
function decide(baselineMape, candidateMape, minGain) {
  const threshold = typeof minGain === 'number' ? minGain : MIN_RELATIVE_GAIN;
  if (baselineMape == null || candidateMape == null) {
    return { beaten: false, blockedBy: 'NO_SCORE', gainPercent: null, reason: '有一侧没有分数' };
  }
  const gain = (baselineMape - candidateMape) / baselineMape;
  const strictBetter = candidateMape < baselineMape;
  const bigEnough = gain >= threshold;
  if (!strictBetter) {
    return { beaten: false, blockedBy: 'NOT_BETTER', gainPercent: Number((gain * 100).toFixed(1)), reason: '没有比基线更准' };
  }
  if (!bigEnough) {
    return {
      beaten: false,
      blockedBy: 'GAIN_BELOW_THRESHOLD',
      gainPercent: Number((gain * 100).toFixed(1)),
      reason: `改进 ${(gain * 100).toFixed(1)}% 小于预设阈值 ${(threshold * 100).toFixed(0)}% —— 可能来自切分噪声`,
    };
  }
  return { beaten: true, blockedBy: null, gainPercent: Number((gain * 100).toFixed(1)), reason: null };
}

/**
 * 主流程：切分 → **只在开发集上拟合** → 在冻结集上比较 → 给判决。
 *
 * 判决规则（三条，缺一不可）：
 *   ① 冻结集样本数 ≥ `MIN_SCORE_SAMPLES`；
 *   ② 候选的中位绝对百分比误差**严格小于**基线；
 *   ③ 相对改进 ≥ `MIN_RELATIVE_GAIN`。
 *
 * 三条里任何一条不满足，`beaten` 就是 false，并说明**卡在哪一条** ——
 * "没打败基线"与"样本不够，无法判断"是两句不同的话。
 */
function evaluate(rows, opts) {
  const o = opts || {};
  const split = splitFrozen(rows, o);
  const cov = coverage(rows);

  const baseline = o.baselineModel || { kind: 'fixed', factor: PRODUCT_CONSTANT, note: '产品现状：常数 1.3' };
  const fitted = fitConstant(split.dev);
  /**
   * ⚠️ **纪律一的落点**：两个候选都只用 `split.dev` 拟合。
   * 冻结集只在最后打分时出现一次。
   */
  const constantFit = { kind: 'constant', factor: fitted.factor, n: fitted.n, note: fitted.note };
  const bucketFit = fitBuckets(split.dev);

  const baseScore = scoreMeters(baseline, split.frozen);
  const constantScore = scoreMeters(constantFit, split.frozen);
  const bucketScore = scoreMeters(bucketFit, split.frozen, { fallbackFactor: fitted.factor });

  const base = baseScore.mapePercent;
  const candidates = [
    { name: '单常数（开发集中位倍率）', score: constantScore, model: constantFit },
    { name: '分段常数（开发集分区间中位倍率）', score: bucketScore, model: bucketFit },
    { name: '时长模型（用 observedDurationSeconds）', score: null, model: null },
  ];

  const results = candidates.map((c) => {
    if (!c.score) {
      return {
        name: c.name,
        evaluable: false,
        beaten: false,
        blockedBy: 'NO_TARGET',
        reason: `本轮没有时长标签（${cov.withActualMinutes}/${cov.usable} 条）—— 不评`,
        mapePercent: null,
      };
    }
    if (base == null || baseScore.insufficient) {
      return {
        name: c.name,
        evaluable: false,
        beaten: false,
        blockedBy: 'INSUFFICIENT_FROZEN',
        reason: baseScore.reason || '冻结集样本不足',
        mapePercent: c.score.mapePercent,
      };
    }
    if (c.score.insufficient) {
      return {
        name: c.name,
        evaluable: false,
        beaten: false,
        blockedBy: 'INSUFFICIENT_FROZEN',
        reason: c.score.reason,
        mapePercent: c.score.mapePercent,
      };
    }
    const d = decide(base, c.score.mapePercent, MIN_RELATIVE_GAIN);
    return {
      name: c.name,
      evaluable: true,
      baselineMapePercent: base,
      mapePercent: c.score.mapePercent,
      gainPercent: d.gainPercent,
      biasPercent: c.score.biasPercent,
      n: c.score.n,
      beaten: d.beaten,
      blockedBy: d.blockedBy,
      reason: d.reason,
    };
  });

  const frozenRowsEnough = split.frozen.length >= MIN_SCORE_SAMPLES;
  /**
   * ⚠️ **两道门**（2026-10-15 加）：条数够了不代表信息量够。
   * 同一条路调十次是十条记录、**一条**路线；用记录数当样本量，
   * 等于用"同一条路走十遍"凑出 300 条。
   */
  const frozenGroupsEnough = split.stats.frozenGroups >= MIN_SCORE_GROUPS;
  const frozenEnough = frozenRowsEnough && frozenGroupsEnough;
  const gateReason = !frozenRowsEnough
    ? `冻结集只有 ${split.frozen.length} 条记录（需要 ${MIN_SCORE_SAMPLES} 条）`
    : !frozenGroupsEnough
      ? `冻结集只覆盖 ${split.stats.frozenGroups} 条独立路线（需要 ${MIN_SCORE_GROUPS} 条）—— 重复请求不提高信息量`
      : null;

  return {
    kind: 'walkEval',
    frozenEnough,
    frozenRowsEnough,
    frozenGroupsEnough,
    gateReason,
    minScoreSamples: MIN_SCORE_SAMPLES,
    minScoreGroups: MIN_SCORE_GROUPS,
    minRelativeGain: MIN_RELATIVE_GAIN,
    split: {
      total: split.total,
      dev: split.dev.length,
      frozen: split.frozen.length,
      excluded: split.excluded.length,
      pendingReview: split.pendingReview.length,
      ungrouped: split.ungrouped.length,
      devGroups: split.stats.devGroups,
      frozenGroups: split.stats.frozenGroups,
      totalGroups: split.stats.totalGroups,
      multiItemGroups: split.stats.multiItemGroups,
      maxGroupSize: split.stats.maxGroupSize,
      ratio: split.ratio,
      seed: split.seed,
      rule: '按路线组切分：同组整体落一侧；反向（A→B 与 B→A）同组；重复请求同组',
    },
    coverage: cov,
    /**
     * **输入契约** —— 一条会决定成败的边界。
     *
     * 若模型的用途是"**地图接口失败时兜底**"，那么在地图失败的那一刻，
     * 路径距离、预测耗时、路线形状**统统拿不到**。它们只能是**标签**，不能是输入。
     * 首版因此只用 `straightMeters`（直线距离，手上有坐标就能算）：
     * 天气、星期、时段这些先不塞 —— 它们要么拿不到，要么需要用户额外说。
     */
    inputContract: {
      label: 'providerRouteMeters（地图返回的路径距离）',
      allowedInputs: ['straightMeters', 'mode'],
      forbiddenInputs: [
        'providerRouteMeters',
        'providerDurationSeconds',
        'provider',
        'routeGroupId',
        'polyline',
        'steps',
      ],
      why:
        '兜底模型在"地图接口失败"时被调用，那一刻地图返回的任何字段都不存在 —— ' +
        '把它们当输入，等于用一个在需要它时必然缺席的特征。',
    },
    baseline: { model: baseline, score: baseScore },
    fits: { constant: constantFit, buckets: bucketFit },
    candidates: results,
    verdict: buildVerdict({ frozenEnough, cov, results, split, base, gateReason }),
    note:
      '本评测器**只做距离目标**（直线 vs 路径，两端都是真实几何量）。' +
      '时长目标需要用户真实用时，无外场实测时基本为空 —— 它只报覆盖率，不给分数。',
  };
}

/** 一句话结论 —— 直接可贴进报告，且**包含"为什么不能下结论"** */
function buildVerdict({ frozenEnough, cov, results, split, base, gateReason }) {
  if (!frozenEnough) {
    return (
      `${gateReason || '冻结集样本不足'} —— **不足以判断**。` +
      `现有可用样本 ${cov.usable} 条、覆盖 ${cov.distinctRoutes} 条独立路线，` +
      `继续积累：每次真实调地图接口都会自动记一条` +
      `（注意样本偏向"未缓存过的路线"，见写入处的说明）。`
    );
  }
  const winners = results.filter((r) => r.beaten);
  const evaluable = results.filter((r) => r.evaluable);
  if (!evaluable.length) {
    return `冻结集 ${split.frozen.length} 条 / ${split.stats.frozenGroups} 条独立路线，但没有任何候选可评 —— 检查基线是否可用。`;
  }
  if (!winners.length) {
    return (
      `基线（常数 ${PRODUCT_CONSTANT}）在冻结集上的中位误差为 ${base}%；` +
      `**没有一个候选打败它**（阈值：相对改进 ≥ ${(MIN_RELATIVE_GAIN * 100).toFixed(0)}%）。` +
      `按 §6.8.5 的门，**停在这里就是结论** —— 在该样本量下规则已足够。`
    );
  }
  return (
    `基线中位误差 ${base}%（冻结集 ${split.frozen.length} 条 / ${split.stats.frozenGroups} 条独立路线）；` +
    winners.map((w) => `「${w.name}」将其降至 ${w.mapePercent}%（改进 ${w.gainPercent}%）`).join('；') +
    `。下一步才是考虑导出参数表（§6.8.2 形态①），并写进 logDecision。`
  );
}

module.exports = {
  DISTANCE_BUCKETS,
  MIN_BUCKET_SAMPLES,
  MIN_SCORE_SAMPLES,
  MIN_SCORE_GROUPS,
  MIN_RELATIVE_GAIN,
  PRODUCT_CONSTANT,
  median,
  // 字段读取（新旧两种写法都读）—— 别处不许再判断字段名
  routeMetersOf,
  providerSecondsOf,
  observedSecondsOf,
  qualityOf,
  usableSamples,
  trueRatio,
  bucketOf,
  // 哈希与路线组键**从 dataset-split 来**，这里只做转出，避免第二份实现
  hash32: splitLib.hash32,
  routeGroupKey: splitLib.routeGroupKey,
  /** 整个分组工具也转出 —— 测试要用 `assertGroupIntegrity` 做独立检查 */
  datasetSplit: splitLib,
  splitFrozen,
  fitConstant,
  fitBuckets,
  predictMeters,
  scoreMeters,
  coverage,
  decide,
  evaluate,
  buildVerdict,
};

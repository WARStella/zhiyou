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

/** 中位数 —— 比均值抗离群（同一条路偶尔会有异常返回值）。空数组返回 null。 */
function median(nums) {
  if (!nums || !nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Number(((s[m - 1] + s[m]) / 2).toFixed(3));
}

/**
 * 可用的样本 —— 判据与 `ops.walkStats` **完全一致**（两端都是正的真实几何量）。
 *
 * ⚠️ 排除掉的条数**必须一起返回**，不能静默丢：
 * "用了 200 条"与"库里有 260 条、60 条算不出倍率"是两句不同的话，
 * 后者能看出数据质量问题，前者会把问题藏起来。
 */
function usableSamples(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const usable = [];
  const excluded = [];
  for (const s of list) {
    const ok =
      s &&
      typeof s.straightMeters === 'number' &&
      typeof s.actualMeters === 'number' &&
      s.straightMeters > 0 &&
      s.actualMeters > 0;
    if (ok) usable.push(s);
    else excluded.push(s);
  }
  return { usable, excluded };
}

/** 一条样本的真实倍率（目标量）。不可用时返回 null。 */
function trueRatio(sample) {
  if (!sample || typeof sample.straightMeters !== 'number' || typeof sample.actualMeters !== 'number') {
    return null;
  }
  if (!(sample.straightMeters > 0)) return null;
  return sample.actualMeters / sample.straightMeters;
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
 * 稳定哈希（FNV-1a 32 位）—— **冻结切分靠它，不靠随机数**。
 *
 * 用随机切分的话，每次跑评测都会得到**不同的划分**，
 * 于是"这一版比上一版好"里面混进了切分噪声，而没人看得出来。
 * 哈希切分保证：**同一批数据、同一个种子 → 每次得到同一个冻结集**。
 */
function hash32(str) {
  let h = 0x811c9dc5;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** 一条样本的切分键 —— 优先用库里的 _id，退回"段 + 采样时刻" */
function splitKey(sample) {
  if (!sample) return '';
  if (sample._id) return String(sample._id);
  return `${sample.fromId || sample.fromName || '?'}->${sample.toId || sample.toName || '?'}@${
    sample.sampledAt || ''
  }`;
}

/**
 * 确定性切分：按哈希取模把样本分成**开发集**与**冻结集**。
 *
 * ⚠️ 用 `>= ratio` 而不是"排序后取前 N 条"：后者会把**同一时段的样本
 * 整批放进同一侧**（样本是按时间写入的），于是两边的分布不同，
 * 比较就变成了"不同场景之间的比较"。
 */
function splitFrozen(rows, opts) {
  const o = opts || {};
  const ratio = typeof o.ratio === 'number' ? o.ratio : 0.3;
  const seed = o.seed == null ? 'zy-walk-2026' : o.seed;
  const { usable, excluded } = usableSamples(rows);
  const dev = [];
  const frozen = [];
  for (const s of usable) {
    const h = hash32(`${seed}|${splitKey(s)}`);
    // 取模 1000，避免 ratio 的浮点乘法带来的边界抖动
    if (h % 1000 < Math.round(ratio * 1000)) frozen.push(s);
    else dev.push(s);
  }
  return { dev, frozen, excluded, ratio, seed, total: usable.length };
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
    const truth = s && typeof s.actualMeters === 'number' ? s.actualMeters : null;
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
                return pred == null || typeof s.actualMeters !== 'number'
                  ? null
                  : Math.abs(pred - s.actualMeters);
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
 * `actualMinutes` 在无外场实测时基本恒为 null（计划书 §1.3）。
 * 与其在报告里留一个空表格，不如明确写出"0/240 条有时长标签，
 * 因此本轮不评时长模型"。
 */
function coverage(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const { usable, excluded } = usableSamples(list);
  const withPredicted = usable.filter((s) => typeof s.predictedMinutes === 'number' && s.predictedMinutes > 0);
  const withActual = usable.filter((s) => typeof s.actualMinutes === 'number' && s.actualMinutes > 0);
  const buckets = DISTANCE_BUCKETS.map((b) => ({
    label: b.label,
    count: usable.filter((s) => {
      const bb = bucketOf(s.straightMeters);
      return bb && bb.label === b.label;
    }).length,
  }));
  return {
    total: list.length,
    usable: usable.length,
    excluded: excluded.length,
    withPredictedMinutes: withPredicted.length,
    withActualMinutes: withActual.length,
    buckets,
    /** 时长模型能不能评 —— 判据是"有时长标签的条数"，不是总条数 */
    minutesTargetEvaluable: withActual.length >= MIN_SCORE_SAMPLES,
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
    { name: '时长模型（用 actualMinutes）', score: null, model: null },
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

  const frozenEnough = split.frozen.length >= MIN_SCORE_SAMPLES;
  return {
    kind: 'walkEval',
    frozenEnough,
    minScoreSamples: MIN_SCORE_SAMPLES,
    minRelativeGain: MIN_RELATIVE_GAIN,
    split: {
      total: split.total,
      dev: split.dev.length,
      frozen: split.frozen.length,
      excluded: split.excluded.length,
      ratio: split.ratio,
      seed: split.seed,
    },
    coverage: cov,
    baseline: { model: baseline, score: baseScore },
    fits: { constant: constantFit, buckets: bucketFit },
    candidates: results,
    verdict: buildVerdict({ frozenEnough, cov, results, split, base }),
    note:
      '本评测器**只做距离目标**（直线 vs 路径，两端都是真实几何量）。' +
      '时长目标需要用户真实用时，无外场实测时基本为 null —— 它只报覆盖率，不给分数。',
  };
}

/** 一句话结论 —— 直接可贴进报告，且**包含"为什么不能下结论"** */
function buildVerdict({ frozenEnough, cov, results, split, base }) {
  if (!frozenEnough) {
    return (
      `冻结集只有 ${split.frozen.length} 条（需要 ${MIN_SCORE_SAMPLES} 条）—— **不足以判断**。` +
      `现有样本 ${cov.usable} 条，继续积累：每次真实调地图接口都会自动记一条。`
    );
  }
  const winners = results.filter((r) => r.beaten);
  const evaluable = results.filter((r) => r.evaluable);
  if (!evaluable.length) {
    return `冻结集 ${split.frozen.length} 条，但没有任何候选可评 —— 检查基线是否可用。`;
  }
  if (!winners.length) {
    return (
      `基线（常数 ${PRODUCT_CONSTANT}）在冻结集上的中位误差为 ${base}%；` +
      `**没有一个候选打败它**（阈值：相对改进 ≥ ${(MIN_RELATIVE_GAIN * 100).toFixed(0)}%）。` +
      `按 §6.8.5 的门，**停在这里就是结论** —— 在该样本量下规则已足够。`
    );
  }
  return (
    `基线中位误差 ${base}%；` +
    winners.map((w) => `「${w.name}」将其降至 ${w.mapePercent}%（改进 ${w.gainPercent}%）`).join('；') +
    `。下一步才是考虑导出参数表（§6.8.2 形态①），并写进 logDecision。`
  );
}

module.exports = {
  DISTANCE_BUCKETS,
  MIN_BUCKET_SAMPLES,
  MIN_SCORE_SAMPLES,
  MIN_RELATIVE_GAIN,
  PRODUCT_CONSTANT,
  median,
  usableSamples,
  trueRatio,
  bucketOf,
  hash32,
  splitKey,
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

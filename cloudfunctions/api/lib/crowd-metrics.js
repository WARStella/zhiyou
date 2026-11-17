'use strict';

/**
 * 人群计数的**离线误差指标** —— 纯函数，不读文件、不发请求、不碰模型。
 *
 * ── 为什么人数误差要单独一套指标 ────────────────────────────
 *
 * 检测模型的常规指标是 mAP / P / R，它们衡量"框得准不准"；
 * 而产品对用户说的是"**约 N 人**"。两者不是一回事：
 *   · 一张 50 人的照片漏检 5 个，mAP 可能仍有 0.8，但人数误差 10%；
 *   · 一张 2 人的照片漏检 1 个，mAP 已经很差，人数误差却只有 1。
 * 所以计数的验收口径必须是**人数误差**（MAE / RMSE / 偏差方向），
 * 不能拿检测指标代替。这条在计划书里也写成了一条独立的验收项。
 *
 * ── 为什么不给"修正系数" ───────────────────────────────────
 *
 * 用 MAE 反推一个"检测数 × 1.2"的魔法系数是最容易做、也最容易在
 * 下一批照片上错得离谱的做法：系数依赖拍摄距离、人群密度和机型，
 * 换一批样本就失效，而且失效时**没有任何迹象**。
 * 本模块只报告误差，不做补偿。要补偿必须按场景分层标定并单独验收。
 */

/**
 * 分桶用**真值**划分，而不用预测值。
 *
 * 为什么：用预测值分桶会掩盖"系统性低估"—— 全部预测成 3 人时，
 * 所有样本都会落进 1—5 桶，看上去每个桶都很准。只有按真值分桶，
 * "人越多误差越大"这件事才暴露得出来。
 */
const BUCKETS = [
  { key: 'none', label: '0 人', min: 0, max: 0 },
  { key: 'few', label: '1—5 人', min: 1, max: 5 },
  { key: 'some', label: '6—15 人', min: 6, max: 15 },
  { key: 'many', label: '16—50 人', min: 16, max: 50 },
  { key: 'crowd', label: '51 人以上', min: 51, max: Infinity },
];

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * 少于这么多张时**不给阈值推荐**。
 *
 * 这不是统计学结论，是产品纪律：20 张以下的调参一定能找到一个"MAE 最低"的
 * 阈值，但那个阈值换一批照片就变。把这种数字写进报告，比不写更糟 ——
 * 它看起来像结论，而且没人会去复核它的样本量。
 */
const MIN_SAMPLES = 20;

function bucketOf(expected) {
  return BUCKETS.find((b) => expected >= b.min && expected <= b.max) || BUCKETS[BUCKETS.length - 1];
}

/**
 * @param {Array<{id?:string, expected:number, predicted:number}>} samples
 *   `expected` = 人工数出来的人数（真值），`predicted` = 检测服务返回的 `count`
 * @returns {object} 汇总；样本为空时返回 `{n:0, note}` 而不是抛错
 */
function summarize(samples) {
  const rows = (samples || []).filter(Boolean);
  if (!rows.length) {
    return { n: 0, mae: null, rmse: null, bias: null, maxAbsError: null, exact: 0, over: 0, under: 0,
      buckets: [], note: '没有样本，无法给出误差。' };
  }
  rows.forEach((row, i) => {
    if (!isCount(row.expected) || !isCount(row.predicted)) {
      throw new Error(`第 ${i + 1} 条样本的人数不是非负整数：expected=${row.expected} predicted=${row.predicted}`);
    }
  });

  const n = rows.length;
  let absSum = 0, sqSum = 0, signedSum = 0, maxAbs = 0, exact = 0, over = 0, under = 0;
  for (const row of rows) {
    const diff = row.predicted - row.expected;
    absSum += Math.abs(diff);
    sqSum += diff * diff;
    signedSum += diff;
    maxAbs = Math.max(maxAbs, Math.abs(diff));
    if (diff === 0) exact += 1;
    else if (diff > 0) over += 1;
    else under += 1;
  }

  const buckets = BUCKETS.map((bucket) => {
    const inside = rows.filter((row) => row.expected >= bucket.min && row.expected <= bucket.max);
    if (!inside.length) return { key: bucket.key, label: bucket.label, n: 0, mae: null, bias: null };
    const mae = inside.reduce((sum, row) => sum + Math.abs(row.predicted - row.expected), 0) / inside.length;
    const bias = inside.reduce((sum, row) => sum + (row.predicted - row.expected), 0) / inside.length;
    return { key: bucket.key, label: bucket.label, n: inside.length, mae: round(mae), bias: round(bias) };
  }).filter((row) => row.n > 0);

  return {
    n,
    mae: round(absSum / n),
    rmse: round(Math.sqrt(sqSum / n)),
    /** 正 = 系统性多算，负 = 系统性少算。**只看 MAE 会看不出方向** */
    bias: round(signedSum / n),
    maxAbsError: maxAbs,
    exact, over, under,
    buckets,
    /**
     * 样本量的门槛不是统计学结论，而是一条产品纪律：
     * 少于 20 张的对照只能看方向，不能对外说"误差多少%"。
     */
    note: n < 20 ? `样本仅 ${n} 张，只能作为方向性观察，不能当作准确率结论。` : null,
  };
}

const round = (v) => Math.round(v * 100) / 100;

/**
 * 汇总"阈值网格"的标定结果 —— `services/crowd/tools/calibrate.py` 的输出。
 *
 * @param {Array<{iou:number, grid:Array<{threshold:number, samples:Array}>}>} groups
 * @returns {{rows:Array, best:object|null, note:string|null}}
 *   `rows` 每个 (iou, threshold) 一行；`best` 是 MAE 最小的一行，**样本不足时
 *   为 null**（宁可说"不知道"，也不给一个下次必然失效的推荐值）。
 *
 * 排序里 MAE 之后的两级 tie-break 都想过：
 *   · 先比 `|bias|` —— 两个阈值 MAE 一样时，系统性偏差小的那个更稳；
 *   · 再比阈值更高 —— 还一样就选更保守的（框少一点，宁可少算也不要凭空多出人）。
 */
function summarizeGrid(groups) {
  const rows = [];
  for (const group of groups || []) {
    if (!group) continue;
    const iou = Number.isFinite(group.iou) ? group.iou : null;
    for (const cell of group.grid || []) {
      if (!cell) continue;
      const threshold = Number.isFinite(cell.threshold) ? cell.threshold : null;
      const summary = summarize(cell.samples);
      rows.push({
        iou, threshold, n: summary.n, mae: summary.mae, rmse: summary.rmse,
        bias: summary.bias, exact: summary.exact, over: summary.over, under: summary.under,
      });
    }
  }
  if (!rows.length) return { rows: [], best: null, note: '没有可汇总的标定结果。' };

  const eligible = rows.filter((row) => row.n >= MIN_SAMPLES && row.mae !== null);
  const ranked = eligible.slice().sort((a, b) => (a.mae - b.mae)
    || (Math.abs(a.bias) - Math.abs(b.bias))
    || (b.threshold - a.threshold)
    || ((a.iou === null ? 0 : a.iou) - (b.iou === null ? 0 : b.iou)));

  const smallest = rows.reduce((min, row) => (row.n < min ? row.n : min), rows[0].n);
  return {
    rows,
    best: ranked[0] || null,
    note: eligible.length ? null
      : `每组只有 ${smallest} 张标注，未达到 ${MIN_SAMPLES} 张：只能看误差方向，不给出阈值推荐。`,
  };
}

module.exports = { summarize, summarizeGrid, BUCKETS, bucketOf, MIN_SAMPLES };

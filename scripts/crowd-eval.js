/**
 * 人群计数的离线误差报告。
 *
 *   node scripts/crowd-eval.js                     # 默认样例集
 *   node scripts/crowd-eval.js --set <path>        # 指定标注集
 *   node scripts/crowd-eval.js --json              # 机器可读
 *
 * 纪律（与 intent-eval / walk-eval 一致）：
 *   ① **没有样本就直说**，不拿合成数据冒充实测；
 *   ② 退出码恒为 0 —— 这是报告，不是测试；
 *   ③ 报告里必须写清"这批数字是什么数据"：合成样例只验证算法，
 *      真实标注才是误差结论。
 *
 * 数据从哪来：把若干张真实人群照片交给部署好的服务，记录 `count`，
 * 再由人对同一批照片里的人数人工点一遍，两项填进样例集即可。
 * 格式见 `test/fixtures/crowd-samples.json`。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { summarize, summarizeGrid, MIN_SAMPLES } = require('../cloudfunctions/api/lib/crowd-metrics');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const setIdx = args.indexOf('--set');
const setPath = setIdx >= 0 ? args[setIdx + 1]
  : path.join(__dirname, '..', 'test', 'fixtures', 'crowd-samples.json');
const signed = (v) => (v === null ? '—' : (v > 0 ? '+' : '') + v);

if (!fs.existsSync(setPath)) {
  console.log('没有找到标注样例集：' + setPath);
  console.log('');
  console.log('结论：没有人工对照样本，无法给出计数误差。');
  if (args.includes('--grid')) {
    console.log('标定表要先生成：在装了 torch 的机器上跑');
    console.log('  python services/crowd/tools/calibrate.py --manifest labels.json --out predictions.json');
  }
  console.log('这不是失败 —— 没有数据时不编一个数字出来，是本项目的固定纪律。');
  process.exit(0);
}

const raw = JSON.parse(fs.readFileSync(setPath, 'utf8'));

/**
 * 标定模式：读 `calibrate.py` 的输出（`groups` = 每个 IoU 一张阈值表）。
 *
 * 为什么放在这个脚本里而不是 Python：误差公式只有这一份。标定脚本负责
 * "把不同阈值下的检出数跑出来"，误差与推荐由这里算 —— 两处各写一份 MAE
 * 必然漂移，而漂移时两边都不报错。
 */
if (args.includes('--grid') || Array.isArray(raw.groups)) {
  const meta = raw.meta || {};
  const summary = summarizeGrid(raw.groups || []);
  if (asJson) {
    console.log(JSON.stringify({ set: path.basename(setPath), meta, ...summary }, null, 2));
    process.exit(0);
  }
  console.log('════════════════════════════════════════════════════════');
  console.log(' 人群计数 · 置信度 / IoU 标定报告（B1 推理侧）');
  console.log('════════════════════════════════════════════════════════');
  console.log('');
  console.log(' 标注集：' + (meta.name || path.basename(setPath)) + ' · ' + (meta.samples || '?') + ' 张');
  console.log(' 条件  ：输入 ' + (meta.imgsz || '?') + ' · 切片 ' + (meta.tilingMode || '?')
    + ' · 权重 ' + (meta.weights || '?') + ' · 生成于 ' + (meta.generatedAt || '?'));
  console.log('');
  if (!summary.rows.length) {
    console.log(' 表里没有可汇总的行：' + summary.note);
    process.exit(0);
  }
  console.log('   IoU   conf      n     MAE      RMSE     bias    完全命中');
  for (const row of summary.rows) {
    console.log('   ' + String(row.iou === null ? '—' : row.iou.toFixed(2)).padStart(4)
      + '   ' + String(row.threshold === null ? '—' : row.threshold.toFixed(2)).padStart(4)
      + '   ' + String(row.n).padStart(3)
      + '   ' + String(row.mae === null ? '—' : row.mae.toFixed(2)).padStart(6)
      + '   ' + String(row.rmse === null ? '—' : row.rmse.toFixed(2)).padStart(6)
      + '   ' + String(signed(row.bias)).padStart(6)
      + '   ' + String(row.exact).padStart(4));
  }
  console.log('');
  if (summary.best) {
    console.log(' 推荐：conf=' + summary.best.threshold.toFixed(2)
      + (summary.best.iou === null ? '' : ' · NMS IoU=' + summary.best.iou.toFixed(2)));
    console.log(' 依据：MAE=' + summary.best.mae + ' 人 / RMSE=' + summary.best.rmse
      + ' / bias=' + signed(summary.best.bias) + ' 人每张（n=' + summary.best.n + '）');
  } else {
    console.log(' 不推荐阈值：' + summary.note);
    console.log(' 需要 ≥' + MIN_SAMPLES + ' 张标注照片才能从"哪档看着顺眼"变成"哪档有依据"。');
  }
  console.log('');
  console.log(' 说明：这是**在标注集上调出来的阈值**，不是准确率。换一批照片（不同机型、');
  console.log('       不同距离）要重新标；报告 MAE 时必须同时写样本量与这批照片的来源。');
  if (meta.synthetic) {
    console.log('');
    console.log(' ⚠️ 这份表标记为 synthetic：数字只验证算法，不能当作检测结果。');
  }
  process.exit(0);
}

const samples = raw.samples || [];
if (!samples.length) {
  console.log('样例集为空，无法评测。');
  process.exit(0);
}

const summary = summarize(samples);

if (asJson) {
  console.log(JSON.stringify({
    set: path.basename(setPath),
    setName: raw.meta && raw.meta.name,
    synthetic: Boolean(raw.meta && raw.meta.synthetic),
    total: samples.length,
    summary,
  }, null, 2));
  process.exit(0);
}

console.log('════════════════════════════════════════════════════════');
console.log(' 人群计数 · 人数误差报告');
console.log('════════════════════════════════════════════════════════');
console.log('');
console.log(' 样例集：' + (raw.meta && raw.meta.name ? raw.meta.name : path.basename(setPath)) + ' · ' + samples.length + ' 张');
if (raw.meta && raw.meta.synthetic) {
  console.log('');
  console.log(' ⚠️ 这批是**合成样例**（synthetic: true）。');
  console.log('    下面的数字只验证误差算法本身，**不能**当作检测准确率或对外宣传依据。');
  console.log('    要得到真实结论，请用部署好的服务对真实照片计数，再由人工点一遍作答。');
}
console.log('');
console.log(' 平均绝对误差 MAE ：' + summary.mae + ' 人');
console.log(' 均方根误差 RMSE  ：' + summary.rmse + ' 人');
console.log(' 系统性偏差 bias  ：' + signed(summary.bias) + ' 人/张（正=偏多算，负=偏少算）');
console.log(' 最大单张偏差     ：' + summary.maxAbsError + ' 人');
console.log(' 完全命中 / 多算 / 少算 ：' + summary.exact + ' / ' + summary.over + ' / ' + summary.under + ' 张');
console.log('');
console.log(' 分桶（按**真值**划分，避免"全猜 3 人"看起来每桶都准）：');
for (const bucket of summary.buckets) {
  console.log('   · ' + bucket.label.padEnd(8, ' ') + '  n=' + String(bucket.n).padStart(3) +
    '  MAE=' + String(bucket.mae).padStart(6) + '  bias=' + signed(bucket.bias));
}
if (summary.note) {
  console.log('');
  console.log(' 结论口径：' + summary.note);
}
console.log('');
console.log(' 说明：MAE 是"每张照片平均差几个人"，不随人数规模变化，便于横向比较；');
console.log('       RMSE 对大偏差更敏感（方差大的模型会被放大）；bias 说明误差的方向。');
console.log('       三个数要一起看 —— 只看 MAE 会把"系统性少算一半"当成"平均差 2 人"。');

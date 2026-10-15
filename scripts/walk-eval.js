'use strict';

/**
 * 步行估算的**离线评测入口**。
 *
 * 用法：
 *
 *   node scripts/walk-eval.js --samples <导出的 json>        # 真实样本
 *   node scripts/walk-eval.js --samples <json> --ratio 0.3   # 换冻结比例
 *   node scripts/walk-eval.js --demo                         # 合成数据自检（**不是实测**）
 *
 * ── 它为什么存在 ─────────────────────────────────────────
 *
 * 计划书 §6.8.5 的 P0 验收是：
 *
 *   > **能回答"现有规则在这批样本上的准确率是多少"。**
 *
 * 这句话在 2026-10-15 之前**答不出来** —— `ops.walkStats` 给的是描述统计
 * （各区间的中位倍率），没有对照、没有冻结集，因此"更准"无从谈起。
 *
 * ── 三条设计纪律（与评测器一致，这里负责"不让人绕过"）──
 *
 * ① **没有样本就直说没有**，不用合成数据补上。
 *    `--demo` 必须显式指定，且报告开头会印一行"合成数据"。
 * ② **退出码恒为 0**：这是**报告**，不是测试。
 *    样本不足是**结论**（"还不足以判断"），不是失败。
 *    用退出码报失败会诱使人为了"让 CI 变绿"去砍阈值。
 * ③ 输出**同时支持纯文本与 `--json`**：文本给人看，JSON 给归档与对比。
 */

const fs = require('fs');
const path = require('path');

const W = require('../cloudfunctions/api/lib/walk-eval');

/** 解析 `--key value` 与 `--flag` */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[a.slice(2)] = next;
        i++;
      } else {
        out[a.slice(2)] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/**
 * 合成数据 —— **只在 `--demo` 下使用**。
 *
 * ⚠️ 它的唯一用途是"验证评测器本身能跑通"（切分、拟合、判决的逻辑）。
 * 它**不是实测数据**，因此：
 *   · 报告开头必须印"合成数据"；
 *   · 数值**不得**被引用到任何材料里（计划书 §11.4：
 *     "实测、模拟回放和合成案例分别报告"）。
 *
 * 生成规则刻意做成"分段常数是**对的**"（倍率随距离递减，
 * 与 10/13 实测的 605 米 → 1.35、10 米 → 7.6 同向），
 * 这样 demo 下应当看到"分段常数打败单常数" —— 否则说明评测器自己有问题。
 */
function demoRows(n) {
  const rows = [];
  const distances = [40, 80, 150, 250, 400, 550, 750, 900, 1200, 1600, 2200, 3000];
  for (let i = 0; i < (n || 240); i++) {
    const straight = distances[i % distances.length] * (1 + ((i * 37) % 11) / 100);
    // 短距离绕路更多：分段的"真值"
    const base = straight < 100 ? 4.2 : straight < 300 ? 2.1 : straight < 600 ? 1.62 : straight < 1000 ? 1.41 : 1.28;
    const noise = 1 + (((i * 53) % 17) - 8) / 100; // ±8%
    const actual = straight * base * noise;
    rows.push({
      _id: `demo_${i}`,
      mode: 'walking',
      weather: null,
      timeBucket: 'noon',
      weekday: i % 7,
      straightMeters: Math.round(straight),
      actualMeters: Math.round(actual),
      detourRatio: Number((actual / straight).toFixed(3)),
      predictedMinutes: Math.round(actual / 70),
      actualMinutes: null,
      fromName: `合成 A${i % 5}`,
      toName: `合成 B${i % 7}`,
      sampledAt: '2026-10-15T00:00:00.000Z',
    });
  }
  return rows;
}

function loadRows(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  /**
   * 兼容两种形状：`ops.exportWalkSamples` 的响应（`{ok, data:{samples}}`）
   * 与直接的一个数组。**不猜**：都不是就明确报错。
   */
  const rows =
    Array.isArray(data) ? data :
    data && Array.isArray(data.samples) ? data.samples :
    data && data.data && Array.isArray(data.data.samples) ? data.data.samples :
    null;
  if (!rows) {
    throw new Error('认不出这份文件的形状：期望数组，或 ops.exportWalkSamples 的响应');
  }
  return rows;
}

/** 表格打印（纯文本，等宽对齐按字符数近似 —— 中文会略宽，可接受） */
function printReport(rep, meta) {
  const L = [];
  L.push('════════════════════════════════════════════════════════════');
  L.push(' 步行估算评测 · 离线 · 纯函数');
  L.push('════════════════════════════════════════════════════════════');
  if (meta.synthetic) {
    L.push('');
    L.push('  ⚠️⚠️  合成数据（--demo）—— 仅用于验证评测器本身，**不是实测**  ⚠️⚠️');
    L.push('  这些数字不得引用到任何材料里（计划书 §11.4）。');
  }
  L.push('');
  L.push(` 样本来源：${meta.source}`);
  L.push(` 切分：种子 ${rep.split.seed} · 冻结比例 ${rep.split.ratio} · 哈希确定性切分`);
  L.push(` 总量：可用 ${rep.split.total} 条 · 开发集 ${rep.split.dev} · 冻结集 ${rep.split.frozen} · 排除 ${rep.split.excluded}`);
  L.push('');
  L.push(' 覆盖率');
  L.push(`   · 有真实用时标签（actualMinutes）：${rep.coverage.withActualMinutes} / ${rep.coverage.usable}` +
    (rep.coverage.minutesTargetEvaluable ? ' → 可评时长模型' : ' → **不足以评时长模型**'));
  L.push(`   · 有地图预测（特征，非标签）：${rep.coverage.withPredictedMinutes}`);
  L.push('   · 分桶：' + rep.coverage.buckets.map((b) => `${b.label} ${b.count}`).join(' · '));
  L.push('');
  L.push(` 基线：常数 ${W.PRODUCT_CONSTANT}（产品现状）`);
  L.push(`   · 冻结集条数 ${rep.baseline.score.n}（跳过 ${rep.baseline.score.skipped}）`);
  L.push(`   · 中位绝对百分比误差：${rep.baseline.score.mapePercent == null ? '不足以判断' : rep.baseline.score.mapePercent + '%'}`);
  L.push(`   · 带符号偏差（中位）：${rep.baseline.score.biasPercent == null ? '—' : rep.baseline.score.biasPercent + '%'}`);
  L.push('');
  L.push(' 候选（**只用开发集拟合**）');
  for (const c of rep.candidates) {
    const flag = c.evaluable ? (c.beaten ? '✅ 打败基线' : '⛔ 未打败') : '⏸ 不可评';
    L.push(`   · ${c.name}`);
    L.push(`     ${flag}` + (c.mapePercent == null ? '' : ` · 中位误差 ${c.mapePercent}%`) +
      (c.gainPercent == null ? '' : ` · 改进 ${c.gainPercent}%`));
    if (c.reason) L.push(`     原因：${c.reason}`);
  }
  L.push('');
  L.push(' 结论');
  L.push('   ' + rep.verdict);
  L.push('');
  L.push(` 备注：${rep.note}`);
  L.push(` 门：冻结集 ≥ ${rep.minScoreSamples} 条；相对改进 ≥ ${(rep.minRelativeGain * 100).toFixed(0)}%（该阈值需在正式实测前冻结，见 §11.4）`);
  L.push('');
  return L.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const synthetic = args.demo === true;
  let rows;
  let source;

  if (synthetic) {
    rows = demoRows(args.rows ? Number(args.rows) : 240);
    source = '合成数据（--demo）';
  } else if (typeof args.samples === 'string') {
    const file = path.resolve(args.samples);
    rows = loadRows(file);
    source = file;
  } else {
    console.log(
      '没有给样本，因此**没有评分**。\n\n' +
      '  · 真实样本：ops.exportWalkSamples（仅 dev）导出后\n' +
      '      node scripts/walk-eval.js --samples <json>\n' +
      '  · 只想验证评测器本身能跑：\n' +
      '      node scripts/walk-eval.js --demo\n\n' +
      '不用合成数据顶替真实样本 —— 那正是本项目记录过的那条教训。'
    );
    process.exit(0);
  }

  const opts = {};
  if (args.ratio) opts.ratio = Number(args.ratio);
  if (args.seed) opts.seed = args.seed;

  const rep = W.evaluate(rows, opts);

  if (args.json) {
    console.log(JSON.stringify({ synthetic, source, report: rep }, null, 2));
  } else {
    console.log(printReport(rep, { synthetic, source }));
  }
  // 报告不是测试：样本不足是结论，不是失败。
  process.exit(0);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('评测未能运行：' + ((e && e.message) || e));
    process.exit(2);
  }
}

module.exports = { demoRows, parseArgs, loadRows };

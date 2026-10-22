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
 * ⚠️ 它的唯一用途是"验证评测器本身能跑通"（切分、拟合、打分、判决的逻辑）。
 * 它**不是实测数据**，因此：
 *   · 报告开头必须印"合成数据"；
 *   · 数值**不得**被引用到任何材料里（计划书 §11.4：
 *     "实测、模拟回放和合成案例分别报告"）。
 *
 * ── 生成规则（2026-10-15 改）────────────────────────────
 *
 * 刻意做成"分段常数是**对的**"（倍率随距离递减，与 10/13 实测的
 * 605 米 → 1.35、10 米 → 7.6 同向），这样 demo 下应当看到
 * "分段常数打败单常数" —— 否则说明评测器自己有问题。
 *
 * 另外**刻意造出重复请求**：每条路线取 3 次（真实中"同一段反复规划"
 * 就是这样）。这同时验证了分组切分：3 条重复记录必须同组、同侧。
 * 于是"记录 300 条"对应的**独立路线只有 100 条** —— 报告里两个数都印出来。
 */
function demoRows(n) {
  const rows = [];
  const routes = n || 100; // **独立路线数**（不是记录数）
  const repeats = 3;
  const distances = [40, 80, 150, 250, 400, 550, 750, 900, 1200, 1600, 2200, 3000];
  for (let i = 0; i < routes; i++) {
    const straight = distances[i % distances.length] * (1 + ((i * 37) % 11) / 100);
    // 短距离绕路更多：分段的"真值"
    const base = straight < 100 ? 4.2 : straight < 300 ? 2.1 : straight < 600 ? 1.62 : straight < 1000 ? 1.41 : 1.28;
    const fromId = `p_a${i % 10}`;
    const toId = `p_b${Math.floor(i / 10)}`;
    const routeGroupId = [fromId, toId].sort().join('|');
    for (let k = 0; k < repeats; k++) {
      const noise = 1 + (((i * 53 + k * 11) % 17) - 8) / 100; // ±8%
      const routeMeters = straight * base * noise;
      rows.push({
        _id: `demo_${i}_${k}`,
        schemaVersion: 2,
        sampleId: `demo#${i}-${k}`,
        routeGroupId,
        mode: 'walking',
        weather: null,
        timeBucket: 'noon',
        weekday: i % 7,
        straightMeters: Math.round(straight),
        providerRouteMeters: Math.round(routeMeters),
        detourRatio: Number((routeMeters / straight).toFixed(3)),
        providerDurationSeconds: Math.round((routeMeters / 70) * 60),
        upstreamDurationUnit: 'minutes',
        observedDurationSeconds: null,
        qualityStatus: 'ok',
        excludedReason: null,
        provider: 'demo',
        fromName: `合成 A${i % 10}`,
        toName: `合成 B${Math.floor(i / 10)}`,
        fromId,
        toId,
        sampledAt: '2026-10-15T00:00:00.000Z',
      });
    }
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
  L.push(` 切分：${rep.split.rule}`);
  L.push(`       种子 ${rep.split.seed} · 冻结比例 ${rep.split.ratio}`);
  L.push(
    ` 总量：可用 ${rep.split.total} 条 · 开发集 ${rep.split.dev} · 冻结集 ${rep.split.frozen}` +
      ` · 排除 ${rep.split.excluded} · 待复核 ${rep.split.pendingReview} · 算不出组 ${rep.split.ungrouped}`
  );
  L.push(
    ` 分组：独立路线 全部 ${rep.split.totalGroups} · 开发 ${rep.split.devGroups} · 冻结 ${rep.split.frozenGroups}` +
      ` · 组内多于一条的 ${rep.split.multiItemGroups}（最大 ${rep.split.maxGroupSize} 条）`
  );
  L.push('');
  L.push(' 覆盖率');
  L.push(
    `   · 记录 ${rep.coverage.records} 条 vs **独立路线 ${rep.coverage.distinctRoutes} 条**` +
      `（重复 ${rep.coverage.repeatedRecords} 条，最多重复 ${rep.coverage.maxRepeats} 次）` +
      ` —— 重复不提高信息量，因此门的判据用独立路线数`
  );
  L.push(`   · 有真实用时标签（observedDurationSeconds）：${rep.coverage.withObservedSeconds} / ${rep.coverage.usable}` +
    (rep.coverage.minutesTargetEvaluable ? ' → 可评时长模型' : ' → **不足以评时长模型**'));
  L.push(`   · 有地图预测（特征，非标签）：${rep.coverage.withPredictedSeconds}`);
  L.push('   · 分桶（记录 / 独立路线）：' + rep.coverage.buckets.map((b) => `${b.label} ${b.count}/${b.groups}`).join(' · '));
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
  L.push(
    ` 门：冻结集 ≥ ${rep.minScoreSamples} 条记录（当前 ${rep.split.frozen}）` +
      ` 且 ≥ ${rep.minScoreGroups} 条独立路线（当前 ${rep.split.frozenGroups}）；` +
      `相对改进 ≥ ${(rep.minRelativeGain * 100).toFixed(0)}%（阈值需在正式实测前冻结，见 §11.4）`
  );
  L.push('');
  L.push(' 输入契约（决定成败的边界）');
  L.push(`   标签：${rep.inputContract.label}`);
  L.push(`   允许的输入：${rep.inputContract.allowedInputs.join(' · ')}`);
  L.push(`   禁止作为输入：${rep.inputContract.forbiddenInputs.join(' · ')}`);
  L.push('');
  return L.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const synthetic = args.demo === true;
  let rows;
  let source;

  if (synthetic) {
    // 参数含义是**独立路线数**（不是记录数）—— 每条路线会取 3 次
    rows = demoRows(args.rows ? Number(args.rows) : 100);
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

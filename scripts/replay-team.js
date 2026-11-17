#!/usr/bin/env node
'use strict';

/**
 * 团队流程回放 —— 命令行入口。
 *
 * 跑 `data/team-replay/cases.v1.json` 里指定的案例，把**执行记录**写到
 * `data/team-replay/records/<YYYY-MM-DD>.json`（目录不存在就创建）。
 *
 * 用法：
 *   node scripts/replay-team.js                    # 跑本批 6 条
 *   node scripts/replay-team.js --cases=replay-001,replay-021
 *   node scripts/replay-team.js --dir=<目录>        # 改记录输出目录
 *   node scripts/replay-team.js --quiet            # 只打印汇总
 *
 * 退出码：全部 passed → 0；有 failed/blocked → 1。
 * ⚠️ **有 blocked 时退出码也是 1**，而且记录文件照写 ——
 *    "跑过了、留了证据、但认定实现有缺陷"必须与"全绿"区分开，
 *    否则一条红的案例会因为退出码为 0 而被当成通过。
 */

const path = require('node:path');

const runner = require('../test/replay-runner');

function parseArgs(argv) {
  const out = { cases: null, dir: null, quiet: false, help: false };
  for (const arg of argv) {
    if (arg === '--quiet' || arg === '-q') out.quiet = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('--cases=')) out.cases = arg.slice('--cases='.length).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith('--dir=')) out.dir = path.resolve(arg.slice('--dir='.length));
    else {
      console.error(`无法识别的参数：${arg}（用 --help 看用法）`);
      process.exit(2);
    }
  }
  return out;
}

const USAGE = `
团队流程回放执行器

  node scripts/replay-team.js [选项]

选项
  --cases=<id,id>   只跑指定案例（默认：${runner.REPLAY_CASE_IDS.join(', ')}）
  --dir=<目录>      记录输出目录（默认：data/team-replay/records）
  --quiet, -q       只打印汇总
  --help, -h        显示本说明

输出
  执行记录 JSON，含：数据哈希、每步的 requestId 与响应摘要、每条不变量的
  机器判定结果与证据、以及 blocked 案例的 finding。
`;

function pad(s, n) {
  const str = String(s);
  // 中文按两个字宽算，否则表格会歪
  const width = [...str].reduce((w, ch) => w + (/[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
  return str + ' '.repeat(Math.max(0, n - width));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE.trim());
    return 0;
  }

  const { record, results } = await runner.runTeamReplay({ caseIds: args.cases || runner.REPLAY_CASE_IDS });
  const file = runner.writeRecord(record, args.dir);

  const levelOrder = ['indoor_device', 'synthetic', 'replay'];
  const levels = Object.keys(record.summary.byEvidenceLevel).sort(
    (a, b) => levelOrder.indexOf(a) - levelOrder.indexOf(b)
  );

  if (!args.quiet) {
    console.log(`数据：${path.relative(process.cwd(), runner.DATASET_PATH)}`);
    console.log(`哈希：sha256:${record.sourceSha256}`);
    console.log(`执行：${record.executedAt}  环境：内存仓储 + 与线上同一条 invoke 路径\n`);
    console.log(`${pad('案例', 14)}${pad('证据级', 16)}${pad('状态', 10)}${pad('不变量(机器)', 14)}${pad('不许发生', 12)}说明`);
    console.log('-'.repeat(96));
    for (const r of results) {
      const note =
        r.status === 'blocked'
          ? `blocked：${String((r.finding && r.finding.symptom) || '').slice(0, 40)}…`
          : r.status === 'passed'
            ? `${r.steps.length} 步、${r.machineInvariants.checks} 条机器子检查全过`
            : '见记录里的 finding';
      console.log(
        `${pad(r.caseId, 14)}${pad(r.evidenceLevel, 16)}${pad(r.status, 10)}` +
          `${pad(`${r.machineInvariants.passed}/${r.machineInvariants.total}`, 14)}` +
          `${pad(`${r.mustNotHappen.passed}/${r.mustNotHappen.total}`, 12)}${note}`
      );
    }
    console.log('-'.repeat(96));
  }

  const s = record.summary;
  console.log(
    `\n合计：执行 ${s.executed} 条 —— 通过 ${s.passed}、失败 ${s.failed}、blocked ${s.blocked}`
  );
  console.log(
    `机器判定的不变量：${s.machineInvariants.passed}/${s.machineInvariants.total} 条` +
      `（共 ${s.machineInvariants.checks} 条子检查）；人工项：${s.manualInvariants} 条（不计入通过）`
  );
  console.log(`绝不允许发生的现象：${s.mustNotHappen.passed}/${s.mustNotHappen.total} 条未出现`);
  /**
   * ⚠️ 三种证据级**分开报告**：把 synthetic 的通过数与 indoor_device 的通过数
   * 加在一起说"都过了"，是把"规则在构造条件下成立"与"两台设备点得通"混为一谈。
   */
  console.log('按证据级分开报告（不得合并）：');
  for (const lvl of levels) {
    const b = record.summary.byEvidenceLevel[lvl];
    console.log(`  · ${pad(lvl, 16)}执行 ${b.executed}：通过 ${b.passed}、失败 ${b.failed}、blocked ${b.blocked}`);
  }
  console.log(`\n记录已写入：${file}`);

  if (s.blocked || s.failed) {
    console.log('\n⚠️ 有案例未通过，退出码为 1。');
    for (const r of results) {
      if (r.status === 'blocked') {
        console.log(`\n[blocked] ${r.caseId}：${(r.finding && r.finding.symptom) || ''}`);
      } else if (r.status === 'failed') {
        console.log(`\n[failed] ${r.caseId}：${(r.finding && r.finding.detail) || ''}`);
      }
    }
  }

  return s.passed === s.executed ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error('执行器异常：', (e && e.stack) || e);
    process.exitCode = 2;
  });

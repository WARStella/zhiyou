/**
 * 需求解析的离线评测入口（规则层）。
 *
 *   node scripts/intent-eval.js                 # 开发集，文本报告
 *   node scripts/intent-eval.js --json          # 机器可读
 *   node scripts/intent-eval.js --set <path>    # 指定样例集
 *
 * 纪律（与 walk-eval 一致）：
 *   ① 没有样本就直说，不拿合成数据冒充实测；
 *   ② 退出码恒为 0 —— 这是报告，不是测试；
 *   ③ 报告里必须写清"解析器是谁"（规则 / 模型）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const rulebased = require('../cloudfunctions/api/lib/ai/rulebased');
const { createHttpParser } = require('../cloudfunctions/api/lib/ai/http');
const { scoreSample, summarize } = require('../cloudfunctions/api/lib/ai/eval');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const useModel = args.includes('--model');
const concIdx = args.indexOf('--concurrency');
const concurrency = concIdx >= 0 ? Math.max(1, parseInt(args[concIdx + 1], 10) || 1) : 1;
const envIdx = args.indexOf('--env-file');
const envFile = envIdx >= 0 ? args[envIdx + 1] : null;

function loadEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Za-z0-9_]+)\s*[=\s]\s*(\S+)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const setIdx = args.indexOf('--set');
const setPath = setIdx >= 0 ? args[setIdx + 1]
  : path.join(__dirname, '..', 'test', 'fixtures', 'intent-samples.json');

if (!fs.existsSync(setPath)) {
  console.log('没有找到样例集：' + setPath);
  console.log('结论：样本不足，无法给出准确率。');
  process.exit(0);
}

const raw = JSON.parse(fs.readFileSync(setPath, 'utf8'));
const samples = raw.samples || [];
if (!samples.length) {
  console.log('样例集为空，无法评测。');
  process.exit(0);
}

(async () => {
const env = envFile ? loadEnv(envFile) : {};
let parser;
if (useModel) {
  parser = createHttpParser({ key: env.AI_API_KEY || process.env.AI_API_KEY || '',
                              baseUrl: env.AI_BASE_URL, model: env.AI_MODEL,
                              timeoutMs: 60000 });
  if (!parser.available) {
    console.log('没有可用的 AI_API_KEY，模型层无法评测。');
    process.exit(0);
  }
} else {
  parser = { name: 'rulebased', promptVersion: 'rulebased-v2', model: null };
}

const scored = [];
let modelFailures = 0;
async function runOne(s) {
  let parsed = null;
  if (useModel) {
    let r = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        r = await parser.parse(s.text);
        if (r && r.ok) break;
      } catch (e) { r = null; }
      await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
    }
    if (r && r.ok) parsed = r.parsed;
    else { modelFailures += 1; parsed = {}; }
  } else {
    parsed = rulebased.parse(s.text);
  }
  const sr = scoreSample(s, parsed);
  return { id: sr.id, text: s.text, checks: sr.checks };
}
if (useModel && concurrency > 1) {
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < samples.length) {
      const idx = cursor;
      cursor += 1;
      scored[idx] = await runOne(samples[idx]);
    }
  });
  await Promise.all(workers);
} else {
  for (const s of samples) scored.push(await runOne(s));
}
const summary = summarize(scored);

if (asJson) {
  console.log(JSON.stringify({
    parser: parser.name,
    set: path.basename(setPath),
    setName: raw.meta && raw.meta.name,
    total: samples.length,
    summary,
    scored,
  }, null, 2));
  process.exit(0);
}

const pct = (x) => (x * 100).toFixed(1) + '%';
console.log('════════════════════════════════════════════════════════════');
console.log(' 需求解析评测 · ' + (useModel ? '模型层' : '规则层'));
console.log('════════════════════════════════════════════════════════════');
console.log('');
console.log(' 解析器：' + parser.name + '（' + parser.promptVersion + '）' + (useModel ? ' · 调用模型 ' + parser.model : ' · 未调用模型'));
console.log(' 样例集：' + (raw.meta && raw.meta.name ? raw.meta.name : path.basename(setPath))
  + ' · ' + samples.length + ' 条');
console.log('');

const total = summary.checks ? summary.checks.total : undefined;
console.log(' 字段检查：' + JSON.stringify(summary.count ? summary.count : summary));
console.log('');

// 逐条失败明细
const failed = scored.filter((s) => (s.checks || []).some((c) => !c.ok));
console.log(' 未全部通过的样例：' + failed.length + ' / ' + samples.length);
for (const f of failed.slice(0, 12)) {
  const bad = f.checks.filter((c) => !c.ok).map((c) => c.name + ':' + c.kind);
  console.log('   · ' + f.id + '  ' + bad.join('、'));
}
console.log('');
console.log(' 说明：本报告只反映' + (useModel ? '模型层' : '规则层') + '在开发集上的表现。');
if (useModel) console.log(' 模型调用失败条数：' + modelFailures);
})();

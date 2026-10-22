'use strict';

/**
 * **冻结清单**生成器 —— 把一次切分固定下来，写成可归档的清单文件。
 *
 * 用法：
 *
 *   node scripts/dataset-split.js --cases <数据文件> --kind route  --out <清单文件>
 *   node scripts/dataset-split.js --cases <数据文件> --kind intent --out <清单文件>
 *   node scripts/dataset-split.js --cases <数据文件> --kind route --show   # 只看分组，不写文件
 *
 * ── 为什么"固定随机种子"还不够 ────────────────────────────
 *
 * 种子只保证**同一批数据**切分可复现。而数据是会变的：
 * 明天多两百条样本，同一个种子算出来的划分与今天**不同** ——
 * 于是"上个月那条基线是在哪一批数据上跑的"就说不清了。
 *
 * 所以清单里必须同时冻结四样东西（用户建议，2026-10-15）：
 *
 *   ① **数据版本**（`datasetVersion`）
 *   ② **源文件内容哈希**（`sourceSha256`）—— 改一个字就变
 *   ③ **切分结果本身**（每个组去哪一侧），而不是"用什么规则算的"
 *   ④ **参数**（种子、比例、规则、门限）
 *
 * ── 一条纪律：不覆盖已存在的清单 ──────────────────────────
 *
 * 已冻结的清单**默认拒绝覆盖**，要覆盖必须显式 `--force`。
 * 冻结的东西能随手改掉，就不叫冻结。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const S = require('../cloudfunctions/api/lib/dataset-split');
const W = require('../cloudfunctions/api/lib/walk-eval');

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

/** 认得出三种形状：裸数组、`{cases}`、`{samples}`、以及云函数响应 `{data:{samples}}` */
function loadItems(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  const items =
    Array.isArray(data) ? data :
    data && Array.isArray(data.cases) ? data.cases :
    data && Array.isArray(data.samples) ? data.samples :
    data && data.data && Array.isArray(data.data.samples) ? data.data.samples :
    null;
  if (!items) throw new Error('认不出这份数据的形状：期望数组，或 {cases:[]} / {samples:[]}');
  return { items, datasetVersion: (data && data.datasetVersion) || null };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.cases !== 'string') {
    console.log(
      '用法：node scripts/dataset-split.js --cases <数据文件> --kind route|intent --out <清单文件>\n' +
      '     加 --show 只看分组不写文件；--force 覆盖已存在的清单（默认拒绝）。'
    );
    process.exit(0);
  }

  const kind = args.kind === 'intent' ? 'intent' : 'route';
  const keyFn = kind === 'intent' ? S.intentGroupKey : S.routeGroupKey;
  const src = path.resolve(args.cases);
  const { items, datasetVersion } = loadItems(src);
  const ratio = args.ratio ? Number(args.ratio) : 0.3;
  const seed = typeof args.seed === 'string' ? args.seed : 'zy-split-2026';

  const split = S.splitByGroup(items, { ratio, seed, keyFn });
  const cov = S.coverageByGroup(items, { keyFn });
  const integrity = S.assertGroupIntegrity({ dev: split.dev, frozen: split.frozen }, keyFn);

  const lines = [];
  lines.push('── 分组切分 ────────────────────────────────────────────');
  lines.push(` 数据：${src}`);
  lines.push(` 类型：${kind === 'intent' ? 'AI 需求样例（按 scenarioGroupId 分组）' : '路线样本（按路线组，含反向与重复）'}`);
  lines.push(` 数据版本：${datasetVersion || '（文件里没写 datasetVersion —— 建议补上）'}`);
  lines.push(` 记录 ${split.stats.total} 条 → 独立组 ${split.stats.totalGroups} 个` +
    `（组内多于一条的 ${split.stats.multiItemGroups} 个，最大 ${split.stats.maxGroupSize} 条）`);
  lines.push(` 开发集：${split.stats.devRecords} 条 / ${split.stats.devGroups} 组`);
  lines.push(` 冻结集：${split.stats.frozenRecords} 条 / ${split.stats.frozenGroups} 组`);
  lines.push(` 算不出组（不进任何一侧）：${split.ungrouped.length} 条`);
  if (kind === 'route') {
    lines.push(` 记录 ${cov.records} 条 vs 独立路线 ${cov.distinctGroups} 条（重复 ${cov.repeatedRecords} 条）`);
    lines.push(` 门的判据是**独立路线数**：需要 ≥ ${W.MIN_SCORE_GROUPS} 条` +
      `（当前冻结 ${split.stats.frozenGroups} 条 → ${split.stats.frozenGroups >= W.MIN_SCORE_GROUPS ? '过' : '未过'}）`);
  }
  lines.push(` 组完整性：${integrity.ok ? '✅ 没有组跨侧' : '❌ 有 ' + integrity.violations.length + ' 个组跨侧'}`);
  lines.push('');
  console.log(lines.join('\n'));

  if (args.show) {
    console.log('（--show：不写清单文件）');
    process.exit(integrity.ok ? 0 : 1);
  }

  if (!integrity.ok) {
    console.error('组跨侧 → 拒绝写清单。这属于实现缺陷，先修切分，不要冻结一份错的清单。');
    process.exit(1);
  }

  const out = path.resolve(typeof args.out === 'string' ? args.out : `${src}.split.json`);
  if (fs.existsSync(out) && args.force !== true) {
    console.error(
      `清单已存在，拒绝覆盖：${out}\n` +
      '  冻结的东西能随手改掉就不叫冻结。确实要重做请显式加 --force，\n' +
      '  并把旧清单留档（它说明"上个月那条基线是在哪一批数据上跑的"）。'
    );
    process.exit(1);
  }

  const manifest = {
    kind: 'datasetSplitManifest',
    datasetKind: kind,
    datasetVersion: datasetVersion || null,
    createdAt: new Date().toISOString(),
    source: { file: path.basename(src), sha256: sha256(src), records: split.stats.total },
    params: {
      ratio,
      seed,
      rule: kind === 'intent'
        ? '按 scenarioGroupId 分组：同场景的改写句与多轮对话整体落一侧'
        : '按路线组分组：同组整体落一侧；反向同组；重复请求同组',
      minScoreGroups: kind === 'route' ? W.MIN_SCORE_GROUPS : null,
    },
    counts: {
      totalRecords: split.stats.total,
      totalGroups: split.stats.totalGroups,
      devRecords: split.stats.devRecords,
      devGroups: split.stats.devGroups,
      frozenRecords: split.stats.frozenRecords,
      frozenGroups: split.stats.frozenGroups,
      ungrouped: split.ungrouped.length,
      multiItemGroups: split.stats.multiItemGroups,
      maxGroupSize: split.stats.maxGroupSize,
    },
    integrity: { ok: integrity.ok, violations: integrity.violations },
    /** 切分**结果本身**（不是规则）—— 每个组去哪一侧 */
    groups: split.groups,
    note:
      '本清单冻结的是"这一批数据的这一次切分"。数据一变，源文件哈希就变，' +
      '必须重新生成清单并留档旧清单 —— 否则说不清某条基线是在哪批数据上跑的。',
  };

  fs.writeFileSync(out, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`✅ 清单已写入：${out}`);
  console.log(`   源文件哈希：${manifest.source.sha256.slice(0, 16)}…（数据一改就变）`);
  process.exit(0);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('生成失败：' + ((e && e.message) || e));
    process.exit(2);
  }
}

module.exports = { parseArgs, loadItems };

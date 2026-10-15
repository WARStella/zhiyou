'use strict';

/**
 * 步行估算评测器的测试。
 *
 * 这一环的风险**不在算法**，在两件事：
 *
 *   ① **泄漏**：冻结集参与了拟合 → 分数虚高，而且**不报错**；
 *   ② **没数据也出结论**：样本只有 12 条却报"误差 8.3%"，
 *      看起来像跑过一次评测。
 *
 * 所以下面绝大多数用例守的是这两条，而不是"拟合得准不准"。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const W = require('../cloudfunctions/api/lib/walk-eval');
const { makeWorld, expectOk } = require('./helpers');
const C = require('../cloudfunctions/api/lib/repo/collections');

/** 造一条样本 —— 倍率由 straight 与 ratio 决定 */
const s = (id, straight, ratio, extra) =>
  Object.assign(
    {
      _id: id,
      straightMeters: straight,
      actualMeters: Math.round(straight * ratio),
      detourRatio: Number(ratio.toFixed(3)),
      predictedMinutes: Math.round((straight * ratio) / 70),
      actualMinutes: null,
      mode: 'walking',
      fromName: 'A',
      toName: 'B',
      sampledAt: '2026-10-15T00:00:00.000Z',
    },
    extra || {}
  );

/** 一批"长距离倍率小、短距离倍率大"的样本 —— 与 10/13 实测同向 */
function batch(n) {
  const rows = [];
  const dist = [40, 80, 150, 250, 400, 550, 750, 900, 1200, 1600, 2200, 3000];
  for (let i = 0; i < n; i++) {
    const straight = dist[i % dist.length] * (1 + ((i * 37) % 11) / 100);
    const ratio = straight < 100 ? 3.0 : straight < 300 ? 2.0 : straight < 600 ? 1.6 : 1.4;
    rows.push(s(`w_${i}`, Math.round(straight), ratio));
  }
  return rows;
}

// ── 纪律一：冻结集不许参与拟合 ────────────────────────────

test('**改冻结集的标签，拟合结果必须一模一样**（防泄漏）', () => {
  /**
   * 这是本文件最重要的一条。
   *
   * 泄漏的表现不是报错，而是**分数变好** —— 所以只断言"分数在动"是没用的，
   * 必须断言**拟合出来的参数没动**：参数只该由开发集决定。
   */
  const rows = batch(200);

  const a = W.evaluate(rows);
  // 把冻结集的真实距离全部改成离谱值 → 只有分数该变，系数不该变
  const poisoned = rows.map((r) => {
    const isFrozen = W.hash32(`zy-walk-2026|${W.splitKey(r)}`) % 1000 < 300;
    return isFrozen ? Object.assign({}, r, { actualMeters: r.actualMeters * 7 }) : r;
  });
  const b = W.evaluate(poisoned);

  assert.ok(a.split.frozen > 0 && a.split.dev > 0, '这组数据必须两侧都非空，否则这条测试是空的');
  assert.deepEqual(
    b.fits.constant.factor,
    a.fits.constant.factor,
    '单常数只能由开发集决定 —— 冻结集变了它不该变'
  );
  assert.deepEqual(
    b.fits.buckets.factors,
    a.fits.buckets.factors,
    '分段系数同理'
  );
  assert.notDeepEqual(
    b.baseline.score.mapePercent,
    a.baseline.score.mapePercent,
    '冻结集被改坏之后，分数**应该**变差 —— 否则说明打分根本没用到它'
  );
});

test('切分是确定性的：同一批数据、同一个种子 → 同一个划分', () => {
  /**
   * 用随机切分的话，每次跑评测的划分都不同，
   * 于是"这一版比上一版好"里混进了切分噪声，而没人看得出来。
   */
  const rows = batch(120);
  const a = W.splitFrozen(rows, { ratio: 0.3 });
  const b = W.splitFrozen(rows, { ratio: 0.3 });

  assert.deepEqual(
    a.frozen.map((x) => x._id),
    b.frozen.map((x) => x._id)
  );
  assert.deepEqual(
    a.dev.map((x) => x._id),
    b.dev.map((x) => x._id)
  );
  assert.equal(a.dev.length + a.frozen.length + a.excluded.length, a.total, '切分不许丢样本');

  const other = W.splitFrozen(rows, { ratio: 0.3, seed: '另一个种子' });
  assert.notDeepEqual(
    other.frozen.map((x) => x._id),
    a.frozen.map((x) => x._id),
    '换种子就该换划分 —— 否则种子没有生效'
  );
});

test('切分不按顺序切 —— 否则两边分布不同', () => {
  /**
   * 样本是按时间写入的。"排序后取前 N 条当冻结集"会把**同一时段**
   * 整批放进同一侧，比较就变成"不同场景之间的比较"。
   *
   * 判据：冻结集在**前一半**与**后一半**里都应当有样本。
   */
  const rows = batch(120);
  const { frozen } = W.splitFrozen(rows, { ratio: 0.3 });
  const ids = new Set(frozen.map((x) => x._id));
  const firstHalf = rows.slice(0, 60).filter((r) => ids.has(r._id)).length;
  const secondHalf = rows.slice(60).filter((r) => ids.has(r._id)).length;
  assert.ok(firstHalf > 0 && secondHalf > 0, `冻结集分布偏了：前 half ${firstHalf} 条、后 half ${secondHalf} 条`);
});

// ── 纪律二：样本不够就直说 ────────────────────────────────

test('样本不足：**不给分数、不给结论**，并说清卡在哪一条', () => {
  const rep = W.evaluate(batch(20)); // 20 < MIN_SCORE_SAMPLES(30)

  assert.equal(rep.frozenEnough, false);
  assert.match(rep.verdict, /不足以判断/);
  assert.match(rep.verdict, /继续积累/);
  assert.equal(rep.baseline.score.mapePercent, null, '基线也不该给分数 —— 它同样基于这二三十条');
  for (const c of rep.candidates) {
    assert.equal(c.evaluable, false, `${c.name} 不该被评`);
    assert.equal(c.beaten, false, '样本不够时**绝不能**判"打败基线"');
  }
  assert.match(rep.baseline.score.reason, /不足以判断|低于/);
});

test('空输入不抛异常，且结论是"没有样本"', () => {
  const rep = W.evaluate([]);
  assert.equal(rep.split.total, 0);
  assert.equal(rep.frozenEnough, false);
  assert.equal(rep.coverage.usable, 0);
  assert.equal(rep.coverage.minutesTargetEvaluable, false);
  assert.match(rep.verdict, /不足以判断/);
});

// ── 判决：三种出口必须分得开 ──────────────────────────────

test('判决三出口：真的更好 / 好得不够 / 没更好', () => {
  /**
   * 这是本项目里**唯一会下"打败了基线"这个结论**的地方。
   * 判错的方向是不对称的：说"没打败"最多保守，
   * 说"打败了"而其实没有，就是 §6.8.7 第 2 条禁止的那种宣称。
   */
  const better = W.decide(20, 10, 0.05);
  assert.equal(better.beaten, true);
  assert.equal(better.blockedBy, null);
  assert.equal(better.gainPercent, 50);

  const marginal = W.decide(20, 19.5, 0.05); // 改进 2.5% < 5%
  assert.equal(marginal.beaten, false);
  assert.equal(marginal.blockedBy, 'GAIN_BELOW_THRESHOLD');
  assert.match(marginal.reason, /切分噪声/);

  const worse = W.decide(20, 20, 0.05);
  assert.equal(worse.beaten, false);
  assert.equal(worse.blockedBy, 'NOT_BETTER', '持平不算打败');

  const noScore = W.decide(null, 10, 0.05);
  assert.equal(noScore.beaten, false);
  assert.equal(noScore.blockedBy, 'NO_SCORE', '"没有分数"与"没打败"是两件事');
});

test('阈值是参数，不是写死的运气 —— 放宽到 0 就会判赢', () => {
  const strict = W.decide(20, 19.5, 0.05);
  const loose = W.decide(20, 19.5, 0);
  assert.equal(strict.beaten, false);
  assert.equal(loose.beaten, true);
  assert.equal(W.MIN_RELATIVE_GAIN, 0.05, '默认阈值需在正式实测前冻结（§11.4）');
});

// ── 打分口径 ──────────────────────────────────────────────

test('中位数抗离群：一条 100 倍的上游异常值不该带偏分数', () => {
  const clean = [];
  for (let i = 0; i < 60; i++) clean.push(s(`c_${i}`, 500, 1.3));
  const withOutlier = clean.concat([s('bad', 500, 100)]);

  const model = { kind: 'fixed', factor: W.PRODUCT_CONSTANT };
  const a = W.scoreMeters(model, clean);
  const b = W.scoreMeters(model, withOutlier);

  assert.equal(a.mapePercent, 0, '完全吻合时误差必须真的为 0');
  assert.equal(b.mapePercent, 0, '中位数应当无视那条离群值');
  assert.equal(b.n, 61, '被算进去的条数要如实报');
});

test('偏差是**带符号**的 —— "一贯高估"与"一贯低估"必须能分开', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(s(`h_${i}`, 500, 1.6)); // 真实倍率 1.6
  const under = W.scoreMeters({ kind: 'fixed', factor: 1.3 }, rows); // 预测偏低
  const over = W.scoreMeters({ kind: 'fixed', factor: 2.0 }, rows); // 预测偏高

  assert.ok(under.biasPercent < 0, `低估时偏差应为负，实得 ${under.biasPercent}`);
  assert.ok(over.biasPercent > 0, `高估时偏差应为正，实得 ${over.biasPercent}`);
});

test('脏数据被排除，但**条数如实报出**，不静默丢', () => {
  const rows = [
    s('ok1', 500, 1.3),
    s('ok2', 800, 1.3),
    s('zero', 0, 1.3),
    s('neg', -100, 1.3),
    { _id: 'missing', straightMeters: 300 }, // 没有 actualMeters
    s('zeroactual', 400, 0),
  ];
  const { usable, excluded } = W.usableSamples(rows);
  assert.equal(usable.length, 2);
  assert.equal(excluded.length, 4);

  const rep = W.evaluate(rows);
  assert.equal(rep.split.excluded, 4, '"用了 2 条"与"库里有 6 条、4 条算不出倍率"是两句不同的话');
});

test('分桶边界：左闭右开，且 0 米归入第一档而不是被丢掉', () => {
  const find = (m) => W.bucketOf(m).label;
  assert.equal(find(0), '0–100 米');
  assert.equal(find(99.9), '0–100 米');
  assert.equal(find(100), '100–300 米', '100 归下一档 —— 与 ops.walkStats 的分桶一致');
  assert.equal(find(2000), '2000 米以上');
  assert.equal(find(999999), '2000 米以上');
});

test('区间样本不足时**不给系数**，并在报告里点名', () => {
  // 只在 300–600 米这一档放够样本，其余各档各放 2 条
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(s(`b_${i}`, 400 + i, 1.6));
  for (let i = 0; i < 2; i++) rows.push(s(`s_${i}`, 50 + i, 3.0));
  const fit = W.fitBuckets(rows);
  assert.ok(fit.factors['300–600 米'] > 0, '样本够的区间要给系数');
  assert.equal(fit.factors['0–100 米'], null, '只有 2 条 → 不给系数（阈值 5 条）');
  assert.ok(fit.insufficient.includes('0–100 米'), '不足的区间要点名，不能只是留空');
});

// ── 与既有报告的单一事实来源 ──────────────────────────────

test('分桶定义只有一处：ops.walkStats 与评测器用的是同一张表', async () => {
  /**
   * ⚠️ 2026-10-15 之前这份表有两份副本（`actions/user.js` 与评测器）。
   * 两处定义必然漂移，而漂移的表现是"报告说 A、评测说 B"，**两边都不报错**。
   * 这条测试守住"收口"这个结论 —— 有人再复制一份就会红。
   */
  const w = await makeWorld();
  const d = expectOk(await w.A('ops.walkStats', {}));
  assert.deepEqual(
    d.buckets.map((b) => b.label),
    W.DISTANCE_BUCKETS.map((b) => b.label),
    '校准报告与评测器的分桶必须一致'
  );
  assert.equal(d.currentConstant, W.PRODUCT_CONSTANT, '对照的常数也要是同一个来源');
});

// ── 导出接口 ──────────────────────────────────────────────

test('样本导出：dev 可用，且**不带任何身份标识**', async () => {
  const w = await makeWorld();
  await w.repo.insert(C.WALK_SAMPLES, s('e_1', 500, 1.3));

  const d = expectOk(await w.A('ops.exportWalkSamples', {}));
  assert.equal(d.kind, 'walkSamplesExport');
  assert.equal(d.count, 1);
  assert.equal(d.samples.length, 1, '评测器直接吃这个数组 —— 少了它，导出接口就只是个数数工具');
  assert.equal(d.truncated, false);
  assert.equal(d.schemaVersion, 1, '导出格式有版本 —— 字段变了离线分析才不会悄悄错位');
  assert.equal(d.withActualMinutes, 0, '没有真实用时就要如实报 0，而不是省掉这个字段');
  assert.match(d.howTo, /walk-eval\.js/);

  const forbidden = ['openid', 'userId', 'ownerUserId', '_openid'];
  for (const row of d.samples) {
    for (const k of forbidden) {
      assert.equal(k in row, false, `导出行里不该有 ${k} —— 这个集合可以导出正是因为它不含身份信息`);
    }
  }
});

test('样本导出：非 dev 环境被拒', async () => {
  const w = await makeWorld({ env: 'prod' });
  const res = await w.A('ops.exportWalkSamples', {});
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'FORBIDDEN_ENV');
});

// ── 端到端：评测器自己跑得通 ──────────────────────────────

test('端到端：合成数据上，评测器能给出"分段常数更好"这个结论', () => {
  /**
   * ⚠️ 这条用的是**合成数据**，它验证的是**评测器本身**（切分→拟合→打分→判决）
   * 能不能走通，**不是**本项目的实测结果。
   * 计划书 §11.4：实测、模拟回放和合成案例**分别报告**。
   */
  const { demoRows } = require('../scripts/walk-eval');
  const rep = W.evaluate(demoRows(240));

  assert.equal(rep.frozenEnough, true);
  const bucket = rep.candidates.find((c) => c.name.includes('分段常数'));
  assert.ok(bucket.evaluable, '样本量足够时它应当可评');
  assert.equal(bucket.beaten, true, '合成数据的真实规律就是分段的 —— 跑不出这个结论说明评测器有问题');
  assert.equal(rep.coverage.minutesTargetEvaluable, false, '合成数据也没有时长标签，必须如实说');
});

test('纯函数：同输入两次结果一致，且**不修改入参**', () => {
  const rows = batch(80);
  const snapshot = JSON.stringify(rows);
  const a = W.evaluate(rows);
  const b = W.evaluate(rows);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(rows), snapshot, '评测器不许改动传进来的样本');
});

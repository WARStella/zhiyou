'use strict';

/**
 * 分组切分工具的测试。
 *
 * 这一环守的是**数据泄漏**：同一路线／同一场景的样本跨了开发集与冻结集，
 * 分数就会虚高 —— 而**它不会报错**，只会让结果看起来更好。
 *
 * 所以这里反复断言的是同一件事的不同侧面：
 * **一个组，整体落在同一侧。**
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../cloudfunctions/api/lib/dataset-split');

// ── 路线组键 ──────────────────────────────────────────────

test('路线组键：A→B 与 B→A 同组（同一条路，换个方向）', () => {
  const a = S.routeGroupKey({ fromId: 'p_1', toId: 'p_2' });
  const b = S.routeGroupKey({ fromId: 'p_2', toId: 'p_1' });
  assert.equal(a, b);
  assert.equal(a, 'p_1|p_2');
});

test('路线组键：已存好的 routeGroupId 优先，历史数据才现算', () => {
  assert.equal(S.routeGroupKey({ routeGroupId: 'g-1', fromId: 'p_1', toId: 'p_2' }), 'g-1');
  assert.equal(S.routeGroupKey({ fromName: '中央大街', toName: '防洪纪念塔' }), 'name_中央大街|name_防洪纪念塔');
});

test('路线组键：信息不足返回 null，**不返回空串**', () => {
  assert.equal(S.routeGroupKey({ straightMeters: 500 }), null);
  assert.equal(S.routeGroupKey(null), null);
  /**
   * 关键差别：返回 `''` 会让所有算不出的样本**合成一个巨大的组**，
   * 而且看起来像"切分成功了"。null 迫使调用方显式处理。
   */
  assert.notEqual(S.routeGroupKey({ straightMeters: 500 }), '');
});

test('写入口与读入口算出的组键必须一致', () => {
  /**
   * ⚠️ 这条守的是一个很容易犯的错：写样本时用端点对象算一次，
   * 读样本时用 `fromId`/`toId` 再算一次 —— 两处只要优先级不同，
   * 就会得到**两个键**，于是同一个组被当成两个组切开，泄漏又回来了。
   */
  const from = { _id: 'p_1', name: '中央大街', location: { latitude: 45.7756, longitude: 126.6175 } };
  const to = { _id: 'p_2', name: '防洪纪念塔', location: { latitude: 45.7807, longitude: 126.6184 } };

  const atWrite = S.routeGroupKeyOfEndpoints(from, to);
  const atRead = S.routeGroupKey({ fromId: from._id, toId: to._id });
  assert.equal(atWrite, atRead);
  // 反向也一样
  assert.equal(S.routeGroupKeyOfEndpoints(to, from), atRead);
});

// ── AI 场景组键 ───────────────────────────────────────────

test('AI 样例：同一个 scenarioGroupId 的改写句与多轮对话同组', () => {
  const c1 = { caseId: 'intent-001', scenarioGroupId: 'keep-last-stop-01' };
  const c2 = { caseId: 'intent-002', scenarioGroupId: 'keep-last-stop-01' };
  const c3 = { caseId: 'intent-003', scenarioGroupId: 'other-01' };
  assert.equal(S.intentGroupKey(c1), S.intentGroupKey(c2));
  assert.notEqual(S.intentGroupKey(c1), S.intentGroupKey(c3));
  // 没有组的退回 caseId（单条成组，不会把不相干的样例粘在一起）
  assert.equal(S.intentGroupKey({ caseId: 'intent-009' }), 'intent-009');
});

// ── 按组切分 ──────────────────────────────────────────────

test('按组切分：组不跨侧，且两侧数量与记录数对得上', () => {
  const items = [];
  for (let i = 0; i < 50; i++) {
    for (let k = 0; k < 4; k++) items.push({ _id: `c${i}_${k}`, scenarioGroupId: `g${i}` });
  }
  const sp = S.splitByGroup(items, { ratio: 0.3, keyFn: S.intentGroupKey });

  assert.equal(sp.stats.total, 200);
  assert.equal(sp.stats.totalGroups, 50, '同组的 4 条只算一个组');
  assert.equal(sp.stats.devGroups + sp.stats.frozenGroups, 50, '组数：两侧相加等于总组数');
  assert.equal(
    sp.stats.devRecords + sp.stats.frozenRecords,
    200,
    '记录数：两侧相加等于全部记录（200 条记录 ≠ 50 个组，两个数都要对）'
  );
  assert.equal(sp.dev.length + sp.frozen.length + sp.ungrouped.length, 200);
  assert.equal(sp.stats.maxGroupSize, 4);

  const check = S.assertGroupIntegrity({ dev: sp.dev, frozen: sp.frozen }, S.intentGroupKey);
  assert.equal(check.ok, true, '按组切分之后不该出现跨侧的组');
});

test('按组切分：比例落在合理范围（不是精确值，但要大致对）', () => {
  const items = [];
  for (let i = 0; i < 400; i++) items.push({ _id: `x${i}`, scenarioGroupId: `g${i}` });
  const sp = S.splitByGroup(items, { ratio: 0.3, keyFn: S.intentGroupKey });
  const share = sp.frozen.length / 400;
  assert.ok(share > 0.2 && share < 0.4, `冻结比例偏了：${share}`);
});

test('按组切分是确定性的，且换种子会换划分', () => {
  const items = [];
  for (let i = 0; i < 60; i++) items.push({ _id: `x${i}`, scenarioGroupId: `g${i}` });
  const a = S.splitByGroup(items, { keyFn: S.intentGroupKey });
  const b = S.splitByGroup(items, { keyFn: S.intentGroupKey });
  assert.deepEqual(a.groups, b.groups);
  const c = S.splitByGroup(items, { seed: '别的种子', keyFn: S.intentGroupKey });
  assert.notDeepEqual(a.groups, c.groups);
});

test('按组切分：算不出组的进 ungrouped，账要平', () => {
  const items = [
    { _id: 'a', scenarioGroupId: 'g1' },
    { _id: 'b', scenarioGroupId: 'g1' },
    { _id: 'c' }, // 没有 caseId 也没有组 → 算不出
  ];
  const sp = S.splitByGroup(items, { keyFn: S.intentGroupKey });
  assert.equal(sp.ungrouped.length, 1);
  assert.equal(sp.stats.total, 3);
  assert.equal(sp.dev.length + sp.frozen.length + sp.ungrouped.length, 3);
});

// ── 覆盖度：记录数 vs 独立组数 ────────────────────────────

test('覆盖度：重复请求不算独立路线', () => {
  const rows = [];
  for (let i = 0; i < 12; i++) {
    for (let k = 0; k < 8; k++) rows.push({ fromId: `p_a${i}`, toId: `p_b${i}` });
  }
  const cov = S.coverageByGroup(rows);
  assert.equal(cov.records, 96, '96 条记录');
  assert.equal(cov.distinctGroups, 12, '但只有 12 条独立路线');
  assert.equal(cov.repeatedRecords, 84);
  assert.equal(cov.maxRepeats, 8);
  assert.equal(cov.ungrouped, 0);
});

test('哈希稳定：同样的输入永远同样的值（切分可复现的前提）', () => {
  assert.equal(S.hash32('abc'), S.hash32('abc'));
  assert.notEqual(S.hash32('abc'), S.hash32('abd'));
  assert.equal(typeof S.hash32('中文也要稳定'), 'number');
  assert.ok(S.hash32('中文也要稳定') >= 0, '必须是 32 位无符号，不能出现负数');
});

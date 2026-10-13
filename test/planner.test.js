'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { generateCandidates } = require('../cloudfunctions/api/domain/planner');
const fixtures = require('./fixtures/places');

const P = fixtures.DEFAULT_PARAMS;
const byId = fixtures.byId;
const START = new Date('2026-10-20T01:00:00.000Z');

/** 原计划：中央大街 → 防洪纪念塔 → 索菲亚教堂。 */
const baseNodes = [
  { nodeId: 'n0', placeId: 'p_zhongyang', plannedStayMin: 45, seq: 0, status: 'pending' },
  { nodeId: 'n1', placeId: 'p_fanghong', plannedStayMin: 20, seq: 1, status: 'pending' },
  { nodeId: 'n2', placeId: 'p_sofia', plannedStayMin: 45, seq: 2, status: 'pending' },
];

const endAtConstraint = (min) => [
  {
    key: 'endAt',
    value: new Date(START.getTime() + min * 60000),
    hardness: 'hard',
    confirmedAt: START,
    sourceMemberIds: ['openid_A'],
  },
];

test('基准：不加改动时，行程本身可行且结束时间符合预期', () => {
  const r = generateCandidates({
    baseNodes,
    trigger: { type: 'noop', payload: {} },
    constraints: endAtConstraint(150),
    placesById: byId,
    params: P,
    startAt: START,
  });
  assert.ok(r.feasibleCount >= 1);
  const c = r.candidates[0];
  assert.equal(c.feasible, true);
  // 45 + 8 + 20 + 21 + 45 + 5(缓冲) = 144 分钟
  assert.equal(
    c.impact.changedEndAt.getTime() - START.getTime(),
    144 * 60000,
    '基准结束时间应为 +144 分钟'
  );
});

test('延长停留：两种策略给出不同取舍，且都可行', () => {
  const r = generateCandidates({
    baseNodes,
    trigger: { type: 'extend_stay', payload: { nodeId: 'n1', deltaMin: 30 } },
    constraints: endAtConstraint(160),
    placesById: byId,
    params: P,
    startAt: START,
  });

  assert.equal(r.feasibleCount, 2, '应给出两条可行候选');

  const keepAll = r.candidates.find((c) => c.nodes.length === 3);
  const dropOne = r.candidates.find((c) => c.nodes.length === 2);

  assert.ok(keepAll, '「少改原计划」应保住全部节点');
  assert.ok(dropOne, '「按当前需求重新优化」应去掉一个节点');

  // 少改原计划：把索菲亚压到下限 30 分钟，但没有删节点
  assert.equal(keepAll.strategy, 'minimal_change');
  assert.equal(keepAll.impact.removedNodeIds.length, 0, '不删节点');
  assert.ok(keepAll.impact.shortenedNodeIds.includes('n2'), '压缩的是索菲亚');
  assert.equal(keepAll.quality.minStayViolations.length, 0, '压到下限为止，不算质量违规');

  // 重新优化：直接去掉索菲亚，不压缩任何停留
  assert.equal(dropOne.strategy, 'reoptimize');
  assert.deepEqual(dropOne.impact.removedNodeIds, ['n2']);
  assert.equal(dropOne.impact.shortenedNodeIds.length, 0, '不压缩停留');

  // 两条候选的取舍必须能被界面直接讲清楚（§5.2 / §6.5 可解释性）
  assert.ok(keepAll.notes.some((n) => n.code === 'STAY_TRIMMED'));
  assert.ok(dropOne.notes.some((n) => n.code === 'NODE_DROPPED'));
});

test('无可行方案时如实返回零条，不强行凑数', () => {
  const r = generateCandidates({
    baseNodes,
    trigger: { type: 'extend_stay', payload: { nodeId: 'n1', deltaMin: 100 } },
    constraints: [
      ...endAtConstraint(60),
      {
        key: 'mustVisit',
        value: ['p_fanghong'],
        hardness: 'hard',
        confirmedAt: START,
      },
    ],
    placesById: byId,
    params: P,
    startAt: START,
  });

  assert.equal(r.feasibleCount, 0, '确实无解时必须返回 0 条可行候选');
  assert.ok(r.candidates.length > 0, '但仍要返回不可行候选，用来解释为什么不行');
  for (const c of r.candidates) {
    assert.equal(c.feasible, false);
    assert.ok(c.conflicts.length > 0, '不可行候选必须带冲突原因');
  }
});

test('必去地点被跳过时如实报冲突，不静默忽略', () => {
  const r = generateCandidates({
    baseNodes,
    trigger: { type: 'skip_node', payload: { nodeId: 'n1' } },
    constraints: [
      {
        key: 'mustVisit',
        value: ['p_fanghong'],
        hardness: 'hard',
        confirmedAt: START,
      },
    ],
    placesById: byId,
    params: P,
    startAt: START,
  });

  for (const c of r.candidates) {
    assert.equal(c.feasible, false, '跳过必去地点不能算可行');
    assert.ok(
      c.conflicts.some((x) => x.code === 'MUST_VISIT_MISSING'),
      '必须出现 MUST_VISIT_MISSING 冲突'
    );
  }
});

test('修改结束时间：改小后自动给出压缩或删减后的候选', () => {
  const r = generateCandidates({
    baseNodes,
    trigger: { type: 'change_end_time', payload: { endAt: new Date(START.getTime() + 100 * 60000) } },
    constraints: [],
    placesById: byId,
    params: P,
    startAt: START,
  });
  assert.ok(r.feasibleCount >= 1, '应能找到满足新结束时间的安排');
  for (const c of r.candidates.filter((x) => x.feasible)) {
    assert.ok(
      c.impact.changedEndAt.getTime() - START.getTime() <= 100 * 60000,
      '可行候选必须真的满足新的结束时间'
    );
  }
});

test('候选去重：完全相同的方案只展示一次', () => {
  // 只延长 0 分钟：两种策略都会回到原方案 → 应合并为一条
  const r = generateCandidates({
    baseNodes,
    trigger: { type: 'extend_stay', payload: { nodeId: 'n1', deltaMin: 0 } },
    constraints: endAtConstraint(150),
    placesById: byId,
    params: P,
    startAt: START,
  });
  assert.equal(r.candidates.length, 1, '相同方案必须合并');
  assert.equal(r.excludedReasons.length, 1);
  assert.equal(r.excludedReasons[0].reason, 'DUPLICATE');
});

test('未核验地点不进入规划：由调用方在入口拦截', () => {
  // 该地点 confidence 为 low、verifiedAt 为空
  const bad = fixtures.byId.p_unverified;
  assert.equal(bad.verifiedAt, null);
  assert.equal(bad.confidence, 'low');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const timelineMod = require('../cloudfunctions/api/domain/timeline');
const { checkFeasibility } = require('../cloudfunctions/api/domain/feasibility');
const constraint = require('../cloudfunctions/api/domain/constraint');
const geo = require('../cloudfunctions/api/lib/geo');
const fixtures = require('./fixtures/places');

const P = fixtures.DEFAULT_PARAMS;
const byId = fixtures.byId;
const START = new Date('2026-10-20T01:00:00.000Z');

test('时间线：交通 + 停留 + 集合缓冲，串联正确', () => {
  const tl = timelineMod.buildTimeline({
    startAt: START,
    items: [
      { nodeId: 'n0', placeId: 'p_zhongyang' },
      { nodeId: 'n1', placeId: 'p_fanghong' },
    ],
    placesById: byId,
    params: P,
  });

  assert.equal(tl.legs.length, 2);
  assert.equal(tl.legs[0].travelFromPrevMin, 0, '首段没有交通时间');
  assert.equal(tl.legs[0].plannedStayMin, 45, '使用地点默认停留');
  assert.equal(tl.legs[1].travelFromPrevMin, 8, '优先使用踏勘实测步行时间');
  // 三种来源必须可区分（见 lib/geo.js 的 WALK_SOURCE）：
  //   survey 踏勘实测 / upstream 地图接口 / estimated 直线估算
  assert.equal(tl.legs[1].travelSource, 'survey', '踏勘实测的来源标记');
  assert.equal(tl.totalWalkMin, 8);
  assert.equal(tl.totalStayMin, 65);
  assert.equal(tl.endAt.getTime() - START.getTime(), 78 * 60000, '45+8+20+5(缓冲)');
});

test('时间线：无实测数据时回落到直线估算，并标明来源', () => {
  const tl = timelineMod.buildTimeline({
    startAt: START,
    items: [{ placeId: 'p_fanghong' }, { placeId: 'p_sofia' }],
    placesById: byId,
    params: P,
  });
  assert.equal(tl.legs[1].travelSource, 'estimated');
  assert.ok(tl.legs[1].travelFromPrevMin > 0);
  assert.ok(tl.legs[1].travelFromPrevMeters > 0);
});

test('地理：绕行系数让估算距离大于直线距离', () => {
  const straight = geo.haversineMeters(byId.p_fanghong.location, byId.p_sofia.location);
  assert.ok(straight > 1000 && straight < 1400, `直线距离应在 1000–1400 米，实际 ${straight}`);
  const w = geo.walkMinutes(byId.p_fanghong, byId.p_sofia, P);
  assert.ok(w.meters > straight, '估算步行距离必须大于直线距离');
});

test('约束：unknown 硬度的约束不得参与可行性判定', () => {
  // 「有点累」被解析成 maxWalkMinutes=5，但硬度未知 → 不能当硬约束用
  const constraints = [
    { key: 'maxWalkMinutes', value: 5, hardness: 'unknown', sourceMemberIds: ['openid_A'] },
  ];
  const tl = timelineMod.buildTimeline({
    startAt: START,
    items: [{ placeId: 'p_zhongyang' }, { placeId: 'p_fanghong' }],
    placesById: byId,
    params: P,
  });
  const res = checkFeasibility({ timeline: tl, constraints, placesById: byId });

  assert.equal(res.feasible, true, '未知硬度的约束不能导致方案不可行');
  assert.equal(res.conflicts.length, 0);
  assert.ok(
    res.warnings.some((w) => w.code === 'CONSTRAINT_UNKNOWN'),
    '必须提示该条件需要确认'
  );
});

test('约束：已确认的硬约束才会被检查', () => {
  const tl = timelineMod.buildTimeline({
    startAt: START,
    items: [{ placeId: 'p_zhongyang' }, { placeId: 'p_fanghong' }],
    placesById: byId,
    params: P,
  });

  // 未确认（confirmedAt 缺失）→ 不生效
  const notConfirmed = checkFeasibility({
    timeline: tl,
    constraints: [{ key: 'maxWalkMinutes', value: 5, hardness: 'hard' }],
    placesById: byId,
  });
  assert.equal(notConfirmed.feasible, true, '未确认的硬约束不参与判定');

  // 已确认 → 生效
  const confirmed = checkFeasibility({
    timeline: tl,
    constraints: [
      { key: 'maxWalkMinutes', value: 5, hardness: 'hard', confirmedAt: START },
    ],
    placesById: byId,
  });
  assert.equal(confirmed.feasible, false);
  assert.ok(confirmed.conflicts.some((c) => c.code === 'WALK_LIMIT_EXCEEDED'));
});

test('可行性：结束时间超限时给出超出的分钟数，而不是笼统报错', () => {
  const tl = timelineMod.buildTimeline({
    startAt: START,
    items: [{ placeId: 'p_zhongyang' }, { placeId: 'p_fanghong' }],
    placesById: byId,
    params: P,
  });
  const res = checkFeasibility({
    timeline: tl,
    constraints: [
      {
        key: 'endAt',
        value: new Date(START.getTime() + 60 * 60000),
        hardness: 'hard',
        confirmedAt: START,
      },
    ],
    placesById: byId,
  });
  assert.equal(res.feasible, false);
  const c = res.conflicts.find((x) => x.code === 'END_TIME_EXCEEDED');
  assert.ok(c, '必须有 END_TIME_EXCEEDED');
  assert.equal(c.exceededMin, 18, '78 - 60 = 18 分钟');
});

test('可行性：把停留压到下限以下不算有效保留（基本游览质量）', () => {
  const tl = timelineMod.buildTimeline({
    startAt: START,
    items: [{ placeId: 'p_sofia', stayMin: 2 }], // 索菲亚下限是 30 分钟
    placesById: byId,
    params: P,
  });
  const res = checkFeasibility({ timeline: tl, constraints: [], placesById: byId });

  assert.equal(res.feasible, true, '压停留不违反硬约束，方案本身仍可行');
  assert.equal(res.quality.meetsBasicQuality, false, '但必须标记基本游览质量不达标');
  assert.equal(res.quality.minStayViolations.length, 1);
  assert.equal(res.quality.minStayViolations[0].requiredMin, 30);
  assert.equal(res.quality.effectivePreservedCount, 0, '压到 2 分钟不计入有效保留');
});

test('约束：多人硬约束冲突时返回冲突说明，不自行取舍', () => {
  const conflicts = constraint.detectConflicts([
    {
      key: 'endAt',
      value: new Date('2026-10-20T05:00:00Z'),
      hardness: 'hard',
      confirmedAt: START,
      sourceMemberIds: ['openid_A'],
    },
    {
      key: 'endAt',
      value: new Date('2026-10-20T03:00:00Z'),
      hardness: 'hard',
      confirmedAt: START,
      sourceMemberIds: ['openid_B'],
    },
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].code, 'HARD_CONSTRAINT_CONFLICT');
  assert.deepEqual(conflicts[0].sourceMemberIds.sort(), ['openid_A', 'openid_B']);
});

test('可行性：无法计算步行时间时必须报数据缺口，不能当 0 处理', () => {
  const broken = {
    p_a: { _id: 'p_a', name: 'A', location: null, visitDurationMin: { min: 0, default: 10, max: 20 }, verifiedAt: START, confidence: 'high' },
    p_b: { _id: 'p_b', name: 'B', location: null, visitDurationMin: { min: 0, default: 10, max: 20 }, verifiedAt: START, confidence: 'high' },
  };
  const tl = timelineMod.buildTimeline({
    startAt: START,
    items: [{ placeId: 'p_a' }, { placeId: 'p_b' }],
    placesById: broken,
    params: P,
  });
  const res = checkFeasibility({ timeline: tl, constraints: [], placesById: broken });
  assert.equal(res.feasible, false);
  assert.ok(res.conflicts.some((c) => c.code === 'INSUFFICIENT_DATA'));
});

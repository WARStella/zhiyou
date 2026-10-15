'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const meet = require('../cloudfunctions/api/domain/meet');
const fixtures = require('./fixtures/places');

const P = fixtures.DEFAULT_PARAMS;
const byId = fixtures.byId;
const NOW = new Date('2026-10-20T01:00:00.000Z');
const ctx = { now: NOW };

function baseTask(over) {
  return Object.assign(
    {
      _id: 'meet_1',
      crewId: 'crew_1',
      tripId: null,
      initiatorUserId: 'openid_A',
      status: 'proposed',
      version: 1,
      plannedMeetAt: new Date(NOW.getTime() + 30 * 60000),
      allArrivedAt: null,
      departedAt: null,
      participants: [
        { userId: 'openid_A', status: 'confirmed', confirmedVersion: 1, confirmedAt: NOW },
        { userId: 'openid_B', status: 'confirmed', confirmedVersion: 1, confirmedAt: NOW },
        { userId: 'openid_C', status: 'confirmed', confirmedVersion: 1, confirmedAt: NOW },
      ],
    },
    over || {}
  );
}

test('版本规则：携带旧版本的确认必须被拒绝', () => {
  const task = baseTask({ version: 2 }); // 地点/时间已改，版本升到 2
  const r = meet.applyConfirm(task, 'openid_B', 'confirm', NOW, 1); // 成员手里还是版本 1

  assert.equal(r.invalidated, true, '旧版本确认不能生效');
  assert.equal(r.patch, null, '不得写入任何东西');
  assert.match(r.reason, /版本/);
});

test('版本规则：版本升级后旧的已确认状态自动失效', () => {
  const stale = baseTask({ version: 2 }); // 参与者的 confirmedVersion 还是 1
  assert.equal(meet.effectiveConfirmed(stale).length, 0, '旧确认不计入有效确认');
  assert.equal(meet.allConfirmed(stale), false, '不能视为已确认');
  assert.equal(meet.staleConfirmations(stale).length, 3, '必须能列出失效的确认，供界面提示重新确认');
});

test('三人全部确认后才进入 confirmed 状态', () => {
  let task = baseTask({
    participants: [
      { userId: 'openid_A', status: 'confirmed', confirmedVersion: 1, confirmedAt: NOW },
      { userId: 'openid_B', status: 'invited', confirmedVersion: null },
      { userId: 'openid_C', status: 'invited', confirmedVersion: null },
    ],
  });

  let r = meet.applyConfirm(task, 'openid_B', 'confirm', NOW, 1);
  task = Object.assign({}, task, r.patch);
  assert.equal(task.status, 'proposed', '还差一人，不能进入 confirmed');

  r = meet.applyConfirm(task, 'openid_C', 'confirm', NOW, 1);
  task = Object.assign({}, task, r.patch);
  assert.equal(task.status, 'confirmed');
  assert.equal(meet.allConfirmed(task), true);
});

test('有人拒绝时回到待协商，不把沉默当同意', () => {
  const task = baseTask({ status: 'confirmed' });
  const r = meet.applyConfirm(task, 'openid_C', 'decline', NOW, 1);
  assert.equal(r.patch.status, 'proposed', '拒绝后需要重新协商');
});

test('三时间分离：到齐写②，出发写③，两者绝不混用', () => {
  let task = baseTask({ status: 'confirmed' });
  const tArriveA = new Date(NOW.getTime() + 10 * 60000);
  const tArriveC = new Date(NOW.getTime() + 18 * 60000);
  const tDepart = new Date(NOW.getTime() + 40 * 60000);

  // 第一人到达：不写 ②
  let r = meet.applyArrive(task, 'openid_A', tArriveA);
  task = Object.assign({}, task, r.patch);
  assert.equal(r.allArrived, false);
  assert.equal(task.allArrivedAt, null, '未全员到齐不得写 allArrivedAt');

  // 第二人到达
  r = meet.applyArrive(task, 'openid_B', tArriveA);
  task = Object.assign({}, task, r.patch);
  assert.equal(task.allArrivedAt, null);

  // 最后一人到达：写 ②
  r = meet.applyArrive(task, 'openid_C', tArriveC);
  task = Object.assign({}, task, r.patch);
  assert.equal(r.allArrived, true);
  assert.equal(task.status, 'arrived_all');
  assert.equal(task.allArrivedAt.getTime(), tArriveC.getTime(), '② 是最后一人到达的时刻');
  assert.equal(task.departedAt, null, '到齐不等于出发，③ 必须仍为空');

  // 发起人点击"前往下一站"：写 ③
  const d = meet.applyDepart(task, tDepart, 1);
  assert.ok(d.patch, '应允许出发');
  task = Object.assign({}, task, d.patch);
  assert.equal(task.status, 'departed');
  assert.equal(task.departedAt.getTime(), tDepart.getTime(), '③ 是发起人操作的时刻');

  // 核心断言：② 与 ③ 相差 22 分钟，绝不能被当成同一个时间
  const gap = (task.departedAt - task.allArrivedAt) / 60000;
  assert.equal(gap, 22, '到齐与出发之间相隔的时间必须被保留下来');
});

test('三时间分离：未到齐时不能标记出发', () => {
  const task = baseTask({ status: 'proposed' });
  const d = meet.applyDepart(task, NOW, 1);
  assert.ok(d.error, '应被拒绝');
  assert.equal(d.error.code, 'INVALID_PARAM');
  assert.equal(d.patch, null);
});

test('出发后评估后续影响：延迟导致不可行时一次性提出调整', () => {
  const trip = {
    _id: 'trip_1',
    version: 3,
    nodes: [
      { nodeId: 'n0', placeId: 'p_zhongyang', plannedStayMin: 45, seq: 0, status: 'done', plannedArriveAt: NOW },
      { nodeId: 'n1', placeId: 'p_fanghong', plannedStayMin: 20, seq: 1, status: 'pending', plannedArriveAt: new Date(NOW.getTime() + 60 * 60000) },
      { nodeId: 'n2', placeId: 'p_sofia', plannedStayMin: 45, seq: 2, status: 'pending', plannedArriveAt: new Date(NOW.getTime() + 90 * 60000) },
    ],
  };
  const task = baseTask({
    status: 'arrived_all',
    plannedMeetAt: new Date(NOW.getTime() + 60 * 60000),
    allArrivedAt: new Date(NOW.getTime() + 60 * 60000),
    departedAt: new Date(NOW.getTime() + 110 * 60000), // 比计划晚 50 分钟出发
    linkToTrip: { affectsNodeId: 'n1' },
  });

  const impact = meet.evaluateDepartImpact({
    task,
    trip,
    placesById: byId,
    params: P,
    constraints: [
      {
        key: 'endAt',
        value: new Date(NOW.getTime() + 200 * 60000),
        hardness: 'hard',
        confirmedAt: NOW,
      },
    ],
    departedAt: task.departedAt,
  });

  assert.equal(impact.affectsTrip, true);
  assert.equal(impact.delayMin, 50, '延迟按计划集合时间与实际出发时间之差计算');
  assert.equal(impact.shouldReevaluate, true, '后续已不可行，必须提出调整');
  assert.ok(impact.conflicts.length > 0, '要带上冲突原因');
});

test('集合点推荐：minimax 规则，且返回候选排除原因', () => {
  const members = [
    { userId: 'openid_A', point: { latitude: 45.7755, longitude: 126.6174 }, reportedAt: NOW, source: 'gps' },
    { userId: 'openid_B', point: { latitude: 45.7812, longitude: 126.6186 }, reportedAt: NOW, source: 'manual' },
    { userId: 'openid_C', point: { latitude: 45.7831, longitude: 126.6191 }, reportedAt: NOW, source: 'gps' },
  ];

  const r = meet.recommendMeetPoints({
    members,
    candidatePlaces: [byId.p_fanghong, byId.p_stalin, byId.p_zhongyang, byId.p_unverified],
    params: P,
    ctx,
  });

  assert.ok(r.candidates.length >= 2);
  // 防洪纪念塔位于三人之间，最远步行时间应最小
  assert.equal(r.candidates[0].placeId, 'p_fanghong', 'minimax 应选中三人中间的集合点');

  // 夹具中 confidence 为 low 的地点被排除，与实地核验状态无关。
  const why = r.excluded.find((x) => x.placeId === 'p_unverified');
  assert.ok(why, '未核验地点必须出现在排除原因里，不能静默丢弃');
  assert.equal(why.reason, 'PLACE_NOT_MEETING_POINT');
  assert.match(why.message, /可信度较低/);
  assert.doesNotMatch(why.message, /实地核验/);

  // 每个候选都要有各成员步行时间
  assert.equal(r.candidates[0].estimates.length, 3);
  // 最远步行时间单调不减
  const maxes = r.candidates.map((c) => c.maxWalkMin);
  for (let i = 1; i < maxes.length; i++) assert.ok(maxes[i] >= maxes[i - 1], '候选应按 minimax 排序');

  // 排除原因必须给出，而不是静默丢弃
  const bad = r.excluded.find((e) => e.placeId === 'p_unverified');
  assert.ok(bad, '未核验地点应被排除');
  assert.equal(bad.reason, 'PLACE_NOT_MEETING_POINT');
  assert.match(bad.message, /可信度较低/);
  assert.doesNotMatch(bad.message, /实地核验/);
});

test('集合点推荐：位置过期时不给推荐，而是明确说明需要重新定位', () => {
  const staleAt = new Date(NOW.getTime() - 10 * 60000); // 10 分钟前
  const members = [
    { userId: 'openid_A', point: { latitude: 45.7755, longitude: 126.6174 }, reportedAt: NOW, source: 'gps' },
    { userId: 'openid_B', point: { latitude: 45.7812, longitude: 126.6186 }, reportedAt: staleAt, source: 'gps' },
  ];

  const r = meet.recommendMeetPoints({
    members,
    candidatePlaces: [byId.p_fanghong, byId.p_zhongyang],
    params: P,
    ctx,
  });

  assert.equal(r.candidates.length, 0, '有人位置过期时不产生"当前可执行"的推荐');
  assert.ok(r.excluded.every((e) => e.reason === 'LOCATION_STALE'));
  assert.match(r.excluded[0].message, /过期/);
});

test('集合点推荐：距离过远时排除，并说明有多远', () => {
  const members = [
    { userId: 'openid_A', point: { latitude: 45.7755, longitude: 126.6174 }, reportedAt: NOW, source: 'gps' },
    { userId: 'openid_B', point: { latitude: 45.7812, longitude: 126.6186 }, reportedAt: NOW, source: 'gps' },
    { userId: 'openid_C', point: { latitude: 45.757, longitude: 126.642 }, reportedAt: NOW, source: 'manual' },
  ];
  const r = meet.recommendMeetPoints({
    members,
    candidatePlaces: [byId.p_stalin],
    params: P,
    ctx,
  });
  assert.equal(r.candidates.length, 0);
  const e = r.excluded.find((x) => x.reason === 'TOO_FAR');
  assert.ok(e, '应因距离过远被排除');
  assert.ok(e.meters > 3000, '必须给出实际估计距离');
});

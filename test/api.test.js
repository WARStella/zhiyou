'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeWorld, makeCrew, expectOk, expectFail, NOW, C } = require('./helpers');
const fixtures = require('./fixtures/places');

const VALID_PLACES = ['p_zhongyang', 'p_fanghong', 'p_sofia'];

test('工程能启动：登录 + 健康检查返回环境与数据状态', async () => {
  const w = await makeWorld();

  const login = expectOk(await w.A('user.login', {}));
  assert.ok(login.userId);
  assert.equal(login.isNew, true);
  assert.equal(expectOk(await w.A('user.login', {})).isNew, false, '二次登录不再建档');

  const health = expectOk(await w.A('ops.health', {}));
  assert.equal(health.ok, true);
  assert.equal(health.repo, 'memory');
  assert.equal(health.algoVersion, 'planner-0.1.0');
  // 夹具里有 6 个已核验地点 + 1 个未核验
  assert.equal(health.data.places, fixtures.places.length);
  assert.equal(health.data.verifiedPlaces, fixtures.places.length - 1);
});

test('未知接口与未登录都返回结构化错误，不抛异常', async () => {
  const w = await makeWorld();
  const e1 = expectFail(await w.A('not.an.action', {}), 'NOT_IMPLEMENTED');
  assert.ok(e1.message.includes('not.an.action'));

  const { invoke } = require('../cloudfunctions/api/lib/invoke');
  const res = await invoke({ action: 'user.login', payload: {} }, { repo: w.repo, openid: null });
  expectFail(res, 'AUTH_REQUIRED');
});

test('小队权限：非成员一律读不到队伍信息', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);

  const outsider = w.clientFor('openid_D');
  expectFail(await outsider('crew.get', { crewId }), 'FORBIDDEN_NOT_MEMBER');
  expectFail(await outsider('loc.list', { crewId }), 'FORBIDDEN_NOT_MEMBER');
  expectFail(await outsider('loc.report', { crewId, point: { latitude: 45.78, longitude: 126.62 }, source: 'gps' }), 'FORBIDDEN_NOT_MEMBER');

  // 刻意不区分"队伍不存在"与"你不是成员"
  assert.equal(expectFail(await outsider('crew.get', { crewId }), 'FORBIDDEN_NOT_MEMBER').message.includes('不存在'), false);
});

test('加入小队是幂等的，重复加入不产生重复成员', async () => {
  const w = await makeWorld();
  const created = expectOk(await w.A('crew.create', { name: '三人队' }));
  expectOk(await w.B('crew.join', { inviteCode: created.inviteCode }));

  const again = expectOk(await w.B('crew.join', { inviteCode: created.inviteCode }));
  assert.equal(again.joined, false, '重复加入应直接返回');

  const members = await w.repo.find(C.CREW_MEMBERS, { crewId: created.crewId });
  assert.equal(members.length, 2, '不应插入重复成员记录');
});

test('位置：上报、时效计算、关闭共享后不返回坐标', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);

  expectOk(await w.A('loc.report', { crewId, point: { latitude: 45.7756, longitude: 126.6175 }, accuracyM: 20, source: 'gps' }));
  // B 用手动选点（位置接口未批时的降级路径）
  expectOk(await w.B('loc.report', { crewId, point: { latitude: 45.781, longitude: 126.6185 }, source: 'manual' }));

  let list = expectOk(await w.A('loc.list', { crewId }));
  assert.equal(list.members.length, 3);
  const bLoc = list.members.find((m) => m.userId === 'openid_B');
  assert.equal(bLoc.source, 'manual', '界面必须能看出坐标是手动选的');
  assert.equal(bLoc.stale, false);
  assert.equal(list.staleThresholdSec, 120);

  // 推进 10 分钟：位置应被判定为过期，且必须回传时效
  list = expectOk(await w.A('loc.list', { crewId }, { now: w.plusMin(10) }));
  const aLoc = list.members.find((m) => m.userId === 'openid_A');
  assert.equal(aLoc.stale, true);
  assert.ok(aLoc.ageSeconds >= 600);

  // C 关闭共享
  expectOk(await w.C('loc.stopSharing', { crewId, sharing: false }));
  list = expectOk(await w.A('loc.list', { crewId }));
  const cLoc = list.members.find((m) => m.userId === 'openid_C');
  assert.equal(cLoc.sharingOff, true);
  assert.equal(cLoc.point, undefined, '关闭共享后绝不能返回坐标');

  // 关闭后也不接受上报
  expectFail(
    await w.C('loc.report', { crewId, point: { latitude: 45.78, longitude: 126.62 }, source: 'gps' }),
    'LOCATION_SHARING_OFF'
  );
});

test('退出小队后访问立即撤销', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);

  expectOk(await w.B('loc.report', { crewId, point: { latitude: 45.78, longitude: 126.62 }, source: 'gps' }));
  expectOk(await w.B('crew.leave', { crewId }));

  // 退出者本人也读不到队伍
  expectFail(await w.B('loc.list', { crewId }), 'FORBIDDEN_NOT_MEMBER');
  expectFail(await w.B('crew.get', { crewId }), 'FORBIDDEN_NOT_MEMBER');

  // 队伍中也不再出现该成员
  const list = expectOk(await w.A('loc.list', { crewId }));
  assert.equal(list.members.some((m) => m.userId === 'openid_B'), false);
});

test('幂等：同一 requestId 重复调用不会重复执行', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);

  const rid = 'fixed-request-id-001';
  const first = expectOk(
    await w.A('loc.report', { crewId, point: { latitude: 45.7756, longitude: 126.6175 }, source: 'gps' }, { requestId: rid })
  );
  const second = await w.A(
    'loc.report',
    { crewId, point: { latitude: 45.9, longitude: 126.9 }, source: 'gps' },
    { requestId: rid }
  );

  assert.equal(second.ok, true);
  assert.equal(second.meta.replayed, true, '第二次必须标记为重放');
  assert.equal(second.data.locationId, first.locationId, '必须返回首次结果');
  assert.equal(second.data.reportedAt, first.reportedAt);

  const count = await w.repo.count(C.LOCATIONS, { userId: 'openid_A' });
  assert.equal(count, 1, '数据库中只能有一条位置记录');
});

test('规划：未核验地点可进路线（带标注），缺坐标的才拒绝，且不可行时不落库', async () => {
  const w = await makeWorld();

  // 未核验但**有坐标** → 允许安排，随结果标注使用边界
  const res = expectOk(
    await w.A('trip.plan', {
      placeIds: ['p_zhongyang', 'p_unverified'],
      startAt: NOW,
      constraints: [],
    })
  );
  assert.equal(res.saved, true, '未核验地点应可作行程节点');
  assert.equal(res.unverifiedNotice.count, 1);
  assert.equal(res.unverifiedNotice.placeIds[0], 'p_unverified');
  assert.equal(res.feasible, true);

  // 缺坐标 → 拒绝，且不落库（不可执行的东西绝不能保存成行程）
  await w.repo.__seed(C.PLACES, [
    { _id: 'p_noloc', name: '没有坐标的地点', category: 'sight', verifiedAt: new Date(NOW), confidence: 'high' },
  ]);
  const bad = expectOk(
    await w.A('trip.plan', { placeIds: ['p_zhongyang', 'p_noloc'], startAt: NOW, constraints: [] })
  );
  assert.equal(bad.feasible, false);
  assert.equal(bad.saved, false);
  assert.equal(bad.reason, 'PLACE_NOT_LOCATABLE');
  assert.ok(bad.conflicts.some((c) => c.code === 'INSUFFICIENT_DATA'));
  assert.match(bad.conflicts[0].message, /坐标/);
  assert.equal(await w.repo.count(C.TRIPS, {}), 1, '只有成功那次落库');
});

test('规划：硬约束不可行时返回冲突原因，且不保存', async () => {
  const w = await makeWorld();
  const res = expectOk(
    await w.A('trip.plan', {
      placeIds: VALID_PLACES,
      startAt: NOW,
      constraints: [
        {
          key: 'endAt',
          value: new Date(NOW.getTime() + 60 * 60000),
          hardness: 'hard',
          confirmedAt: NOW,
        },
      ],
    })
  );

  assert.equal(res.feasible, false);
  assert.equal(res.saved, false);
  const c = res.conflicts.find((x) => x.code === 'END_TIME_EXCEEDED');
  assert.ok(c && c.exceededMin > 0, '要给出具体超出多少分钟');
  assert.equal(await w.repo.count(C.TRIPS, {}), 0);
});

test('规划 → 调整 → 确认：版本推进且旧版本确认失效', async () => {
  const w = await makeWorld();

  // 1) 生成行程
  const planned = expectOk(
    await w.A('trip.plan', {
      placeIds: VALID_PLACES,
      startAt: NOW,
      constraints: [
        { key: 'endAt', value: new Date(NOW.getTime() + 150 * 60000), hardness: 'hard', confirmedAt: NOW },
      ],
    })
  );
  assert.equal(planned.feasible, true);
  assert.equal(planned.saved, true);
  assert.equal(planned.version, 1);
  assert.equal(planned.nodes.length, 3);
  const tripId = planned.tripId;

  // 2) 提交两次调整，都基于版本 1
  const p1 = expectOk(
    await w.A('trip.adjust', {
      tripId,
      trigger: { type: 'extend_stay', payload: { nodeId: planned.nodes[1].nodeId, deltaMin: 30 } },
      constraints: [],
    })
  );
  const p2 = expectOk(
    await w.A('trip.adjust', {
      tripId,
      trigger: { type: 'extend_stay', payload: { nodeId: planned.nodes[1].nodeId, deltaMin: 30 } },
      constraints: [],
    })
  );
  assert.equal(p1.baseVersion, 1);
  assert.equal(p2.baseVersion, 1);
  assert.ok(p1.candidates.length >= 1);

  // 调整接口本身不改行程
  const untouched = expectOk(await w.A('trip.get', { tripId }));
  assert.equal(untouched.trip.version, 1, 'adjust 不得修改行程版本');

  // 3) 确认第一个提案 → 版本推进到 2
  const feasibleCand = p1.candidates.find((c) => c.feasible);
  const applied = expectOk(
    await w.A('trip.confirmChange', { proposalId: p1.proposalId, candidateId: feasibleCand.candidateId })
  );
  assert.equal(applied.applied, true);
  assert.equal(applied.version, 2);
  assert.ok(applied.changes.length > 0, '必须回传"改了什么"，供界面展示');

  // 4) 用基于旧版本的第二个提案确认 → 必须失败
  const conflict = expectFail(
    await w.A('trip.confirmChange', { proposalId: p2.proposalId, candidateId: p2.candidates[0].candidateId }),
    'VERSION_CONFLICT'
  );
  assert.equal(conflict.details.currentVersion, 2);
  assert.equal(conflict.details.proposalBaseVersion, 1);

  // 5) 行程版本仍是 2，没有被旧确认偷偷改写
  const after = expectOk(await w.A('trip.get', { tripId }));
  assert.equal(after.trip.version, 2);

  // 6) 版本快照留痕，可回答"当时系统看到的是什么"
  const versions = await w.repo.find(C.TRIP_VERSIONS, { tripId }, { sort: { version: 1 } });
  assert.equal(versions.length, 2, '初始版本 + 调整后版本各一份快照');
  assert.deepEqual(versions.map((v) => v.version), [1, 2]);
});

test('不可行的候选不允许被确认生效', async () => {
  const w = await makeWorld();
  // 中央大街是必去地点，且其停留下限 20 分钟 + 5 分钟缓冲 = 25 分钟，
  // 因此把结束时间压到 10 分钟以内时，两种策略都无解 —— 用来验证"不强行凑数"。
  const planned = expectOk(
    await w.A('trip.plan', {
      placeIds: VALID_PLACES,
      startAt: NOW,
      constraints: [
        { key: 'endAt', value: new Date(NOW.getTime() + 150 * 60000), hardness: 'hard', confirmedAt: NOW },
        { key: 'mustVisit', value: ['p_zhongyang'], hardness: 'hard', confirmedAt: NOW },
      ],
    })
  );

  const p = expectOk(
    await w.A('trip.adjust', {
      tripId: planned.tripId,
      trigger: { type: 'change_end_time', payload: { endAt: new Date(NOW.getTime() + 10 * 60000) } },
      constraints: [],
    })
  );
  assert.equal(p.noFeasible, true, '这个调整应该没有可行方案');
  assert.ok(p.candidates.every((c) => !c.feasible));

  expectFail(
    await w.A('trip.confirmChange', { proposalId: p.proposalId, candidateId: p.candidates[0].candidateId }),
    'INFEASIBLE_HARD_CONSTRAINT'
  );
});

test('集合全流程：发起 → 确认 → 到齐(②) → 出发(③)，三时间分开记录', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);

  // 三人各报位置，供推荐使用
  expectOk(await w.A('loc.report', { crewId, point: { latitude: 45.7755, longitude: 126.6174 }, source: 'gps' }));
  expectOk(await w.B('loc.report', { crewId, point: { latitude: 45.7812, longitude: 126.6186 }, source: 'manual' }));
  expectOk(await w.C('loc.report', { crewId, point: { latitude: 45.7831, longitude: 126.6191 }, source: 'gps' }));

  // 推荐集合点：候选带各成员步行时间，排除项带原因
  const rec = expectOk(await w.A('meet.recommend', { crewId }));
  assert.ok(rec.candidates.length >= 2);
  assert.ok(rec.candidates[0].estimates.length === 3);
  assert.match(rec.rule, /minimax/);

  const best = rec.candidates[0];
  const plannedMeetAt = new Date(NOW.getTime() + 30 * 60000);

  // 发起集合任务
  const created = expectOk(
    await w.A('meet.create', {
      crewId,
      placeId: best.placeId,
      placeName: best.placeName,
      plannedMeetAt,
      method: 'recommended',
      walkEstimates: best.estimates,
      excludedCandidates: rec.excluded,
    })
  );
  const meetTaskId = created.meetTaskId;
  assert.equal(created.status, 'proposed');
  assert.equal(created.version, 1);

  // 不带版本号的确认必须被拒绝
  expectFail(await w.B('meet.confirm', { meetTaskId, decision: 'confirm' }), 'INVALID_PARAM');

  // 携带正确版本的确认
  expectOk(await w.B('meet.confirm', { meetTaskId, decision: 'confirm' }, { expectedVersion: 1 }));
  const allC = expectOk(await w.C('meet.confirm', { meetTaskId, decision: 'confirm' }, { expectedVersion: 1 }));
  assert.equal(allC.allConfirmed, true);
  assert.equal(allC.status, 'confirmed');

  // 三人陆续到达
  expectOk(await w.A('meet.arrive', { meetTaskId }));
  expectOk(await w.B('meet.arrive', { meetTaskId }));
  const last = expectOk(await w.C('meet.arrive', { meetTaskId }, { now: w.plusMin(12) }));

  assert.equal(last.status, 'arrived_all');
  assert.ok(last.allArrivedAt, '② 实际全员到齐时间必须写入');
  assert.equal(last.tripUpdated, false, '到齐不改路线');
  assert.match(last.message, /暂不调整/);

  // 到此为止 ③ 仍为空
  let snapshot = expectOk(await w.A('meet.get', { meetTaskId }));
  assert.equal(snapshot.meetTask.allArrivedAt, last.allArrivedAt);
  assert.equal(snapshot.meetTask.departedAt, null, '未点击出发前 ③ 必须为空');

  // 发起人确认出发（③）
  const departed = expectOk(
    await w.A('meet.depart', { meetTaskId }, { expectedVersion: 1, now: w.plusMin(25) })
  );
  assert.equal(departed.status, 'departed');
  assert.ok(departed.departedAt);
  assert.equal(departed.delayMin, 0, '按计划时间出发，延迟为 0');

  snapshot = expectOk(await w.A('meet.get', { meetTaskId }));
  const gap =
    (new Date(snapshot.meetTask.departedAt) - new Date(snapshot.meetTask.allArrivedAt)) / 60000;
  assert.equal(gap, 13, '② 与 ③ 相差 13 分钟，必须分别保留');

  // 重复点击出发不覆盖首次出发时间
  const again = expectOk(await w.A('meet.depart', { meetTaskId }, { expectedVersion: 1, now: w.plusMin(40) }));
  assert.equal(again.alreadyDeparted, true);
  assert.equal(again.departedAt, departed.departedAt);
});

test('集合延迟会反馈到后续行程，并一次性给出调整候选', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);

  const planned = expectOk(
    await w.A('trip.plan', {
      crewId,
      placeIds: VALID_PLACES,
      startAt: NOW,
      constraints: [
        { key: 'endAt', value: new Date(NOW.getTime() + 150 * 60000), hardness: 'hard', confirmedAt: NOW },
      ],
    })
  );
  assert.equal(planned.feasible, true);

  // 集合约定在出发后很久，且实际拖了 40 分钟
  const plannedMeetAt = new Date(NOW.getTime() + 30 * 60000);
  const created = expectOk(
    await w.A('meet.create', {
      crewId,
      tripId: planned.tripId,
      placeName: '防洪纪念塔',
      point: { latitude: 45.781, longitude: 126.6185 },
      plannedMeetAt,
      method: 'manual',
    })
  );
  const meetTaskId = created.meetTaskId;

  expectOk(await w.B('meet.confirm', { meetTaskId, decision: 'confirm' }, { expectedVersion: 1 }));
  expectOk(await w.C('meet.confirm', { meetTaskId, decision: 'confirm' }, { expectedVersion: 1 }));

  for (const who of ['A', 'B', 'C']) expectOk(await w[who]('meet.arrive', { meetTaskId }));

  const departed = expectOk(
    await w.A('meet.depart', { meetTaskId }, { expectedVersion: 1, now: w.plusMin(70) })
  );

  assert.equal(departed.delayMin, 40, '延迟 40 分钟');
  assert.ok(departed.tripImpact, '必须反馈到行程');
  assert.equal(departed.tripImpact.delayMin, 40);
  // 后续安排已经不可行 → 应带出调整候选，且只在此刻提出
  assert.equal(departed.tripImpact.shouldReevaluate, true);
  assert.ok(departed.proposal, '应一次性给出调整候选');
  assert.ok(departed.proposal.candidates.length > 0);
});

test('集合任务：获得分享卡片不等于获得权限', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);

  const created = expectOk(
    await w.A('meet.create', {
      crewId,
      placeName: '防洪纪念塔',
      point: { latitude: 45.781, longitude: 126.6185 },
      plannedMeetAt: new Date(NOW.getTime() + 30 * 60000),
      method: 'manual',
    })
  );

  const outsider = w.clientFor('openid_E');
  expectFail(await outsider('meet.get', { meetTaskId: created.meetTaskId }), 'FORBIDDEN_NOT_MEMBER');
});

test('ops.initDb：显式创建全部集合、灌种子、并拒绝非 dev 环境', async () => {
  const w = await makeWorld();

  const res = expectOk(await w.A('ops.initDb', { confirm: true }));
  assert.equal(res.collectionsEnsured, 14, '必须把 14 个集合都显式建出来');
  assert.ok(Array.isArray(res.collectionsCreated));
  assert.ok(res.manualIndexes.length >= 10, '必须返回需要手工创建的索引清单');
  assert.match(res.note, /未核验/, '必须说明种子数据不可用于规划');

  // 未显式 confirm → 拒绝
  expectFail(await w.A('ops.initDb', {}), 'INVALID_PARAM');

  // 非 dev 环境 → 拒绝（避免在生产环境灌测试数据）
  const prod = await makeWorld({ env: 'prod' });
  expectFail(await prod.A('ops.initDb', { confirm: true }), 'FORBIDDEN_ENV');
});

test('非预期错误：开发环境暴露定位信息，生产环境一律隐藏', async () => {
  const { invoke } = require('../cloudfunctions/api/lib/invoke');
  const { createMemoryRepo } = require('../cloudfunctions/api/lib/repo/memory');

  /** 让指定集合上的操作抛非预期异常，其余转发给内存仓储。 */
  function makeFailingRepo(failOn) {
    const inner = createMemoryRepo();
    const guard = (coll) => {
      if (coll === failOn) throw new RangeError(`stub failure on ${coll}`);
    };
    return {
      __kind: 'stub',
      findOne: (c, q, o) => (guard(c), inner.findOne(c, q, o)),
      find: (c, q, o) => (guard(c), inner.find(c, q, o)),
      count: (c, q) => (guard(c), inner.count(c, q)),
      insert: (c, d) => (guard(c), inner.insert(c, d)),
      update: (c, i, p) => inner.update(c, i, p),
      remove: (c, i) => inner.remove(c, i),
      ensureCollection: () => true,
    };
  }

  // ① 失败在幂等包装里（operations 集合）
  const devEarly = await invoke(
    { action: 'user.login', requestId: 'r1', payload: {} },
    { repo: makeFailingRepo('operations'), openid: 'openid_A', env: 'dev' }
  );
  assert.equal(devEarly.ok, false);
  assert.equal(devEarly.error.code, 'INTERNAL');
  assert.equal(devEarly.error.details.stage, 'idempotency', '必须指出失败阶段');
  assert.match(devEarly.error.message, /stub failure/, '开发环境要带上原始错误信息');
  assert.equal(devEarly.error.details.name, 'RangeError');
  assert.ok(devEarly.error.details.stackTop.length > 0, '要给出堆栈头部');

  // ② 失败在业务处理里（users 集合）
  const devLate = await invoke(
    { action: 'user.login', requestId: 'r2', payload: {} },
    { repo: makeFailingRepo('users'), openid: 'openid_A', env: 'dev' }
  );
  assert.equal(devLate.error.details.stage, 'handler');

  // ③ 生产环境：同一错误，不泄露任何内部结构
  const prod = await invoke(
    { action: 'user.login', requestId: 'r3', payload: {} },
    { repo: makeFailingRepo('users'), openid: 'openid_A', env: 'prod' }
  );
  assert.equal(prod.ok, false);
  assert.equal(prod.error.code, 'INTERNAL');
  assert.equal(prod.error.message, '服务异常，请稍后重试', '生产环境不得出现内部信息');
  assert.equal(prod.error.details, null, '生产环境不得返回堆栈或阶段');
});

test('业务异常不受影响：错误码与提示原样返回，且不带堆栈', async () => {
  const w = await makeWorld();
  const err = expectFail(await w.clientFor('openid_Z')('crew.get', { crewId: 'nope' }), 'FORBIDDEN_NOT_MEMBER');
  assert.equal(err.details, null, '预期内业务错误不应带诊断信息');
  assert.doesNotMatch(err.message, /stack|RangeError/i);
});

test('地点准入分级：未核验可作行程节点，但不能作集合点', async () => {
  const w = await makeWorld();

  // ① 未核验地点**允许**进入行程。
  //    首版把核验做成"全有或全无"，结果是地点检索回来的 POI 一个都用不了，
  //    与「外部检索保证覆盖度、实地踏勘保证可信度」的目标直接矛盾。
  const planned = expectOk(
    await w.A('trip.plan', { placeIds: ['p_unverified'], startAt: NOW, constraints: [] })
  );
  assert.equal(planned.saved, true, '未核验地点应可作行程节点');
  assert.ok(planned.unverifiedNotice, '必须随结果标注，不得静默');
  assert.equal(planned.unverifiedNotice.count, 1);
  assert.equal(planned.unverifiedNotice.scope, 'tripNodeOnly', '要说明使用边界');
  assert.match(planned.unverifiedNotice.warning, /不能作为集合点/);
  assert.equal(planned.unverifiedNotice.places[0].placeId, 'p_unverified');

  // ② 全部已核验时不得无端报警
  const clean = expectOk(
    await w.A('trip.plan', { placeIds: VALID_PLACES, startAt: NOW, constraints: [] })
  );
  assert.equal(clean.unverifiedNotice, null);

  // ③ 缺坐标必须拒绝 —— 会让步行时间失真，整条时间线就没意义了
  await w.repo.__seed(C.PLACES, [
    {
      _id: 'p_noloc',
      name: '没有坐标的地点',
      category: 'sight',
      verifiedAt: new Date(NOW),
      confidence: 'high',
    },
  ]);
  const noLoc = expectOk(
    await w.A('trip.plan', { placeIds: ['p_noloc'], startAt: NOW, constraints: [] })
  );
  assert.equal(noLoc.saved, false, '缺坐标必须拒绝');
  assert.equal(noLoc.reason, 'PLACE_NOT_LOCATABLE');
  assert.match(noLoc.conflicts[0].message, /坐标/);
});

test('place.list 按用途分别标注准入，而不是一个含糊的 usable', async () => {
  const w = await makeWorld();
  const res = expectOk(await w.A('place.list', {}));

  const unverified = res.places.find((x) => x.placeId === 'p_unverified');
  assert.equal(unverified.tripNodeAllowed, true, '未核验地点可作行程节点');
  assert.equal(unverified.meetingPointAllowed, false, '未核验地点不可作集合点');
  assert.equal(unverified.verified, false);

  const verified = res.places.find((x) => x.placeId === 'p_zhongyang');
  assert.equal(verified.tripNodeAllowed, true);
  assert.equal(verified.meetingPointAllowed, true);
  assert.equal(verified.verified, true);

  // 计数便于界面直接展示，不用自己遍历
  assert.equal(res.counts.tripNodeAllowed, fixtures.places.length);
  assert.equal(res.counts.meetingPointAllowed, fixtures.places.length - 1);

  // verifiedOnly 现在明确指"可作集合点"
  const onlyMeet = expectOk(await w.A('place.list', { verifiedOnly: true }));
  assert.equal(onlyMeet.total, fixtures.places.length - 1);
  assert.equal(onlyMeet.places.every((x) => x.meetingPointAllowed), true);
});

test('集合点推荐必须排除未核验地点，并说明它可作为游览节点', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);

  const res = expectOk(await w.A('meet.recommend', { crewId }));
  const excludedIds = (res.excluded || []).map((x) => x.placeId);
  assert.equal(excludedIds.includes('p_unverified'), true, '未核验地点不得作集合点');

  const why = (res.excluded || []).find((x) => x.placeId === 'p_unverified');
  assert.equal(why.reason, 'PLACE_NOT_MEETING_POINT');
  assert.match(why.message, /可安排为游览节点/, '要说清它还能用来做什么，而不是只说不合格');
});

test('行程页设的结束时间会成为硬约束：ISO 字符串 + confirmedAt 即生效', async () => {
  const w = await makeWorld();

  // 前端就是这么发的：value 是 ISO 字符串，confirmedAt 是用户确认的时刻
  const tooEarly = new Date(NOW.getTime() + 30 * 60000).toISOString();
  const res = expectOk(
    await w.A('trip.plan', {
      placeIds: VALID_PLACES,
      startAt: NOW,
      constraints: [
        {
          key: 'endAt',
          value: tooEarly,
          hardness: 'hard',
          confirmedAt: new Date(NOW).toISOString(),
          confirmedBy: 'user',
        },
      ],
    })
  );

  assert.equal(res.saved, false, '结束时间太早必须判定不可行，而不是默默超时');
  assert.ok(
    res.conflicts.some((c) => c.hardConstraintKey === 'endAt'),
    '冲突要指明是哪个硬约束造成的'
  );
});

test('约束缺 confirmedAt 就不算硬约束 —— 界面漏传会被静默忽略，必须有测试守住', async () => {
  const w = await makeWorld();
  const tooEarly = new Date(NOW.getTime() + 30 * 60000).toISOString();

  const res = expectOk(
    await w.A('trip.plan', {
      placeIds: VALID_PLACES,
      startAt: NOW,
      // 少了 confirmedAt —— 服务端按 §6.2 视为"未确认"，不参与可行性判定
      constraints: [{ key: 'endAt', value: tooEarly, hardness: 'hard' }],
    })
  );

  assert.equal(
    res.saved,
    true,
    '未确认的约束不参与判定（§6.2）。这条测试存在的意义是：' +
      '一旦它变成 false，说明服务端的判定规则变了，前端要跟着改。'
  );
});

test('规划会真的调用地图步行接口，并把结果缓存下来', async () => {
  const w = await makeWorld();
  const legs = VALID_PLACES.length - 1;

  // ① 第一次：只对**缺失的**路段取，已有的踏勘记录不重复取。
  //    首版规划器只用 walkableTo 缓存或直线估算，**从不调用地图接口** ——
  //    于是"根据路况计算"名不副实（实测同一条路直线估算与真实路线差 1.35 倍）。
  const first = expectOk(
    await w.A('trip.plan', { placeIds: VALID_PLACES, startAt: NOW, constraints: [] })
  );
  assert.equal(first.walkTimes.fromCache, 1, '夹具里 p_zhongyang→p_fanghong 有踏勘实测，应直接命中');
  assert.equal(first.walkTimes.mapApiCalls, 1, '只对缺失的那一段发请求，不浪费配额');
  assert.equal(first.walkTimes.fetchedFromMap, 1);
  assert.equal(first.walkTimes.upstreamFailed, 0);
  assert.equal(first.walkTimes.bySource.survey, 1, '踏勘记录优先于地图接口');
  assert.equal(first.walkTimes.bySource.upstream, 1, '缺的那段来自地图接口');
  assert.match(first.walkTimes.note, /真实步行路线/);

  // ② 第二次：全部命中缓存，零配额，且结果稳定
  const second = expectOk(
    await w.A('trip.plan', { placeIds: VALID_PLACES, startAt: NOW, constraints: [] })
  );
  assert.equal(second.walkTimes.mapApiCalls, 0, '第二次应全部命中缓存，不重复消耗配额');
  assert.equal(second.walkTimes.fromCache, 2);
  assert.equal(second.summary.totalWalkMin, first.summary.totalWalkMin, '缓存后结果必须一致');
  assert.equal(
    second.walkTimes.bySource.upstream,
    1,
    '缓存来源仍是 upstream —— **不能因为存下来了就当成踏勘实测**'
  );

  // ③ 缓存确实落库了（下次别的行程也能用）
  const place = await w.repo.get(C.PLACES, VALID_PLACES[1]);
  const rec = (place.walkableTo || []).find((x) => x.placeId === VALID_PLACES[2]);
  assert.ok(rec, '缺的那段应已写入 places 缓存');
  assert.equal(rec.source, 'upstream', '缓存来源必须标为地图接口，不能冒充踏勘');
  assert.equal(typeof rec.walkMin, 'number');
});

test('地图接口取不到路线时回落直线估算，并如实报告失败段', async () => {
  const w = await makeWorld();

  // 通过假服务的故障注入开关模拟上游故障。
  // 不能用替换模块的办法：trip.js 在加载时就解构捕获了 provider 工厂。
  process.env.MAP_FAKE_FAIL = 'walk';
  try {
    const res = expectOk(
      await w.A('trip.plan', { placeIds: VALID_PLACES, startAt: NOW, constraints: [] })
    );

    assert.equal(res.walkTimes.upstreamFailed, 1, '失败段数要如实报告');
    assert.equal(res.walkTimes.bySource.estimated, 1);
    assert.equal(res.walkTimes.bySource.survey, 1, '已有踏勘记录不受上游故障影响');
    assert.match(res.walkTimes.note, /直线估算/, '必须说明回落到了估算，不能含糊');
    assert.equal(res.walkTimes.failures[0].reason, 'UPSTREAM_FAILED');
    assert.ok(res.saved, '取不到路线不该让规划整体失败 —— 但要标注来源');

    // **未取到的时间绝不能写进缓存**，否则会把一次估算变成永久事实
    const place = await w.repo.get(C.PLACES, VALID_PLACES[1]);
    const rec = (place.walkableTo || []).find((x) => x.placeId === VALID_PLACES[2]);
    assert.equal(rec, undefined, '失败时不得写缓存');
  } finally {
    delete process.env.MAP_FAKE_FAIL;
  }
});

test('起点：行程从"我的位置"算起，而不是假装人已在第一个景点门口', async () => {
  const w = await makeWorld();
  const res = expectOk(
    await w.A('trip.plan', {
      placeIds: ['p_sofia'],
      startAt: NOW,
      constraints: [],
      startPoint: { latitude: 45.78, longitude: 126.63, label: '我的位置' },
    })
  );

  assert.ok(res.startPoint, '要回传出发位置');
  assert.equal(res.startPoint.label, '我的位置');
  assert.ok(res.startLeg.minutes > 0, '第一段必须有耗时');
  assert.equal(res.startLeg.source, 'upstream', '真实路线优先');

  const n0 = res.nodes[0];
  assert.equal(n0.travelFromStart, true, '要标明这段是从出发位置算的');
  assert.equal(n0.travelFromPrevMin, res.startLeg.minutes);
  assert.equal(n0.travelSource, 'upstream');
  assert.equal(n0.travelMode, 'walking', '出行方式字段要下发（首版恒为步行，字段预留）');
  assert.ok(
    res.summary.totalWalkMin >= res.startLeg.minutes,
    '起点段必须计入总步行，否则总时间会偏乐观'
  );

  // 不给起点时不得凭空造一段交通
  const w2 = await makeWorld();
  const noStart = expectOk(
    await w2.A('trip.plan', { placeIds: ['p_sofia'], startAt: NOW, constraints: [] })
  );
  assert.equal(noStart.startPoint, null);
  assert.equal(noStart.startLeg, null);
  assert.equal(noStart.nodes[0].travelFromPrevMin, 0);
  assert.equal(noStart.nodes[0].travelFromStart, false);
});

test('调整分级：无取舍时一键生效，有取舍时才要求确认', async () => {
  const V = ['p_zhongyang', 'p_fanghong', 'p_sofia'];
  const hard = (min) => [
    {
      key: 'endAt',
      value: new Date(NOW.getTime() + min * 60000).toISOString(),
      hardness: 'hard',
      confirmedAt: new Date(NOW).toISOString(),
    },
  ];
  const extend = (trip, deltaMin) => ({
    tripId: trip.tripId,
    expectedVersion: trip.version,
    trigger: { type: 'extend_stay', payload: { nodeId: trip.nodes[0].nodeId, deltaMin } },
  });

  // ── 时间宽松：延长停留不牺牲任何安排 → 一键生效 ──
  const w = await makeWorld();
  const loose = expectOk(
    await w.A('trip.plan', { placeIds: V, startAt: NOW, constraints: hard(200) })
  );
  const auto = expectOk(await w.A('trip.adjust', extend(loose, 10)));

  assert.equal(auto.applied, true, '没有取舍时应直接生效');
  assert.equal(auto.appliedReason, 'no_tradeoff');
  assert.ok(auto.version > loose.version, '自动生效同样要推进版本');
  assert.match(auto.note, /没有牺牲任何已有安排/);

  // ⚠️ 走的是**正式确认路径**，不是绕过确认的旁路 —— 否则两套行为迟早不一致
  const prop = await w.repo.get(C.CHANGE_PROPOSALS, auto.proposalId);
  assert.equal(prop.status, 'confirmed');
  assert.equal(prop.autoApplied, true);
  assert.equal(prop.autoReason, 'no_tradeoff');

  // ── 时间紧：延长停留必须压缩后续 → 交给用户选 ──
  const w2 = await makeWorld();
  const tight = expectOk(
    await w2.A('trip.plan', { placeIds: V, startAt: NOW, constraints: hard(160) })
  );
  const manual = expectOk(await w2.A('trip.adjust', extend(tight, 30)));

  assert.equal(manual.applied, false, '有取舍时必须让用户选');
  assert.ok(manual.candidates.length >= 1);
  assert.equal(
    manual.candidates.every((c) => c.tradeoff.has),
    true,
    '这些候选都牺牲了别的安排'
  );
  assert.equal(manual.candidates.every((c) => c.requiresConfirmation), true);
  assert.match(manual.confirmationRule, /牺牲/);
});

test('团队行程一律要求确认，不能被"无取舍"简化掉', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);
  const trip = expectOk(
    await w.A('trip.plan', { placeIds: VALID_PLACES, startAt: NOW, constraints: [], crewId })
  );

  const res = expectOk(
    await w.A('trip.adjust', {
      tripId: trip.tripId,
      expectedVersion: trip.version,
      trigger: { type: 'extend_stay', payload: { nodeId: trip.nodes[0].nodeId, deltaMin: 10 } },
    })
  );

  assert.equal(res.applied, false, '团队行程必须由成员确认（§8.1）');
  assert.match(res.confirmationRule, /团队/);
});

test('ops.selfTest：测量各类写入形态，并只写 selftest 集合', async () => {
  const w = await makeWorld();
  const res = expectOk(await w.A('ops.selfTest', {}));

  assert.equal(res.collection, 'selftest');
  assert.ok(res.results.length >= 9, '要覆盖建集合/插入/嵌套/数组/null/乐观锁');
  assert.equal(res.criticalFailureCount, 0, '不应有真正阻断性的失败');
  assert.equal(res.skippedCount, 0, '前置步骤通过时不应有跳过项');
  assert.match(res.verdict, /均可用/);
  assert.deepEqual(res.knownLimitations, [], '内存仓储下连已知限制都不失败');

  // 乐观锁那一项必须真的验证了"版本不匹配不写入"
  const cas = res.results.find((r) => /乐观锁/.test(r.name));
  assert.equal(cas.detail.staleUpdated, 0, '旧版本号必须写不进去');
  assert.equal(cas.detail.goodUpdated, 1);
  assert.equal(cas.detail.newVersion, 2);

  // 只允许在 dev 环境执行
  const prod = await makeWorld({ env: 'prod' });
  expectFail(await prod.A('ops.selfTest', {}), 'FORBIDDEN_ENV');

  // 反复自检不得堆积探针文档
  await w.A('ops.selfTest', {});
  await w.A('ops.selfTest', {});
  assert.equal(await w.repo.count('selftest', { tag: 'probe' }), 1, '每次自检先清理上一次');
});

test('ops.selfTest：前置步骤失败时后续标记为跳过，而不是级联报错', async () => {
  const { invoke } = require('../cloudfunctions/api/lib/invoke');
  const { createMemoryRepo } = require('../cloudfunctions/api/lib/repo/memory');

  // 复现 2026-10-13 云上的真实情形：建集合被拒 → selftest 集合不存在 → 插入报 -502005
  const inner = createMemoryRepo();
  const repo = {
    __kind: 'stub',
    ensureCollection: async () => ({ created: false, existed: false, error: 'permission denied' }),
    insert: async (c, d) => {
      if (c === 'selftest') {
        const e = new Error('collection.add:fail -502005 database collection not exists');
        e.errCode = -502005;
        throw e;
      }
      return inner.insert(c, d);
    },
    find: (c, q, o) => inner.find(c, q, o),
    findOne: (c, q, o) => inner.findOne(c, q, o),
    count: (c, q) => inner.count(c, q),
    get: (c, i) => inner.get(c, i),
    update: (c, i, p) => inner.update(c, i, p),
    updateCas: (c, i, v, p) => inner.updateCas(c, i, v, p),
    remove: (c, i) => inner.remove(c, i),
  };

  const res = await invoke(
    { action: 'ops.selfTest', requestId: 'selftest-fail', payload: {} },
    { repo, openid: 'openid_A', env: 'dev' }
  );

  assert.equal(res.ok, true, '自检本身要成功返回，由 results 说明问题');

  // ① 建集合失败，且真实原因原样上报（早期版本把它吞了）
  assert.equal(res.data.results[0].ok, false);
  assert.match(res.data.results[0].errMsg, /permission denied/);

  // ④ 插入失败：这是"docId 为空"的上游原因
  const insertStep = res.data.results.find((r) => /插入/.test(r.name));
  assert.equal(insertStep.ok, false);
  assert.equal(insertStep.errCode, -502005);

  // 依赖 docId 的步骤全部跳过
  const dependent = res.data.results.filter((r) => /更新|乐观锁/.test(r.name));
  assert.ok(dependent.length >= 5);
  assert.ok(dependent.every((r) => r.skipped === true), '依赖前置结果的步骤必须跳过');

  // 核心断言：不得出现级联噪音
  const noise = res.data.results.filter((r) => /docId必须为字符串或数字/.test(r.errMsg || ''));
  assert.equal(noise.length, 0, '不得出现"docId必须为字符串或数字"这类级联报错掩盖真因');

  // 真因只有两条：建集合失败、插入失败
  assert.equal(res.data.failedCount, 2);
  assert.equal(res.data.skippedCount, dependent.length);
});

test('幂等：卡死的 in_progress 记录不会永久阻塞（超时用例）', async () => {
  const w = await makeWorld();
  const rid = 'stuck-request-1';

  // 手工塞一条"卡死"的 in_progress 记录（模拟上一次执行中途进程终止）
  await w.repo.insert(C.OPERATIONS, {
    requestId: rid,
    userId: 'openid_A',
    action: 'user.login',
    status: 'in_progress',
    responseJson: '',
    createdAt: new Date(w.NOW.getTime() - 10 * 60 * 1000), // 10 分钟前
    finishedAt: null,
  });

  // 10 分钟后重试 → 应放行，而不是永远 RATE_LIMITED
  const ok = expectOk(await w.A('user.login', {}, { requestId: rid }));
  assert.ok(ok.userId);

  // 刚刚开始的 in_progress 仍然要拦（防并发重复执行）
  const rid2 = 'fresh-request-2';
  await w.repo.insert(C.OPERATIONS, {
    requestId: rid2,
    userId: 'openid_A',
    action: 'user.login',
    status: 'in_progress',
    responseJson: '',
    createdAt: new Date(w.NOW.getTime()),
    finishedAt: null,
  });
  expectFail(await w.A('user.login', {}, { requestId: rid2 }), 'RATE_LIMITED');
});

test('ops.verifyIndexes：唯一索引必须实测生效，且测试数据要清理干净', async () => {
  const w = await makeWorld();
  const res = expectOk(await w.A('ops.verifyIndexes', {}));

  assert.equal(res.kind, 'verifyIndexes');
  assert.equal(res.total, 3, '三个唯一索引都要撞一遍');
  assert.equal(res.passed, 3);
  assert.match(res.verdict, /均已实测生效/);
  assert.deepEqual(res.fixHint, []);

  // 每一项都必须确认"第二次写入被拒"，而不是笼统通过
  for (const r of res.results) {
    assert.equal(r.duplicateRejected, true, `${r.name} 必须实测到重复被拒`);
    assert.match(r.verdict, /已生效/);
  }

  // 测试数据不得残留：leftover 必须为 0，且业务集合里确实没有 tag
  assert.equal(res.leftover, 0, '测试数据必须清理干净');
  assert.equal(await w.repo.count(C.USERS, { tag: 'idxcheck' }), 0);
  assert.equal(await w.repo.count(C.OPERATIONS, { tag: 'idxcheck' }), 0);
  assert.equal(await w.repo.count(C.CREW_MEMBERS, { tag: 'idxcheck' }), 0);

  // 只允许在 dev 环境执行
  const prod = await makeWorld({ env: 'prod' });
  expectFail(await prod.A('ops.verifyIndexes', {}), 'FORBIDDEN_ENV');
});

test('ops.verifyIndexes：索引缺失时必须报出来，而不是静默通过', async () => {
  const { invoke } = require('../cloudfunctions/api/lib/invoke');
  const { createMemoryRepo } = require('../cloudfunctions/api/lib/repo/memory');

  // 用一个"不拦重复"的仓储模拟索引没生效（真实成因：字段建错/没保存成功）
  const inner = createMemoryRepo();
  const permissive = {
    __kind: 'permissive',
    insert: async (c, d) => {
      const row = Object.assign({ _id: `x_${Math.random().toString(36).slice(2)}` }, d);
      await inner.__seed(c, [row]); // 绕过唯一校验
      return row;
    },
    find: (c, q, o) => inner.find(c, q, o),
    findOne: (c, q, o) => inner.findOne(c, q, o),
    count: (c, q) => inner.count(c, q),
    get: (c, i) => inner.get(c, i),
    update: (c, i, p) => inner.update(c, i, p),
    updateCas: (c, i, v, p) => inner.updateCas(c, i, v, p),
    remove: (c, i) => inner.remove(c, i),
    ensureCollection: async () => ({ created: true, existed: false, error: null }),
  };

  const res = await invoke(
    { action: 'ops.verifyIndexes', requestId: 'idx-fail', payload: {} },
    { repo: permissive, openid: 'openid_A', env: 'dev' }
  );

  assert.equal(res.ok, true, '校验本身要成功返回，由 results 说明问题');
  assert.equal(res.data.passed, 0, '重复写入被接受 = 索引未生效');
  assert.match(res.data.verdict, /未生效/);
  assert.equal(res.data.fixHint.length, 3, '每一项都要给出修复指引');
  assert.match(res.data.fixHint[0], /索引管理/);
});

test('events 与决策记录：成功与失败都留痕，可用于定位失败原因', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);

  await w.A('trip.plan', {
    crewId,
    placeIds: ['p_unverified'],
    startAt: NOW,
    constraints: [],
  });
  expectFail(await w.clientFor('openid_Z')('crew.get', { crewId }), 'FORBIDDEN_NOT_MEMBER');

  const events = await w.repo.find(C.EVENTS, { type: 'api_call' });
  assert.ok(events.length >= 2);

  const denied = events.find((e) => e.errCode === 'FORBIDDEN_NOT_MEMBER');
  assert.ok(denied, '权限拒绝必须记录错误码，而不是只记"接口错误"');
  assert.ok(denied.action === 'crew.get');
  assert.equal(typeof denied.durationMs, 'number');

  const decisions = await w.repo.find(C.DECISIONS, { kind: 'plan' });
  assert.ok(decisions.length >= 1, '规划必须留下决策记录');
  assert.ok(decisions[0].algoVersion, '决策记录必须带算法版本，供 11/5 固定测试集与版本核查');
  assert.ok(decisions[0].inputDigest);
});

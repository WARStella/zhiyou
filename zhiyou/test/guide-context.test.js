'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, makeCrew, expectOk, expectFail, C } = require('./helpers');
const { createCrowdProvider } = require('../cloudfunctions/api/lib/guide/crowd');
const offline = () => ({ modelAvailable: false, visionAvailable: false });
const point = { latitude: 45.77, longitude: 126.62 };
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=';
async function setup() {
  const w = await makeWorld({ createGuideProvider: offline });
  const plan = expectOk(await w.A('trip.plan', { placeIds: ['p_zhongyang', 'p_sofia'], startAt: w.NOW }));
  return { w, plan };
}
test('助手按当前真实进度回答下一站，全部完成后不回到首站，状态时间来自服务端', async () => {
  const { w, plan } = await setup();
  const before = expectOk(await w.A('guide.ask', { text: '下一站去哪？', tripId: plan.tripId }));
  assert.equal(before.tripContext.next.name, plan.nodes[0].placeName);
  assert.equal(before.tripContext.serverTime, w.NOW.toISOString());
  expectOk(await w.A('trip.progress', { tripId: plan.tripId, nodeId: plan.nodes[0].nodeId, status: 'arrived' }, { expectedVersion: 1 }));
  const after = expectOk(await w.A('guide.ask', { text: '下一站去哪？', tripId: plan.tripId }));
  assert.equal(after.tripContext.current.name, plan.nodes[0].placeName);
  assert.equal(after.tripContext.next.name, plan.nodes[1].placeName); assert.equal(after.tripContext.version, 2);
  await w.repo.update(C.TRIPS, plan.tripId, { nodes: plan.nodes.map(n => ({ ...n, status: 'done' })), version: 3 });
  const done = expectOk(await w.A('guide.ask', { text: '下一站去哪？', tripId: plan.tripId }));
  assert.equal(done.tripContext.next, null); assert.match(done.answer, /没有下一站/);
  assert.ok(!JSON.stringify(done).includes('contextReads'));
});
test('队伍入口读取已发布共同路线，成员可读但仅发起人能修改，离队立即拒绝', async () => {
  const { w, plan } = await setup(), { crewId } = await makeCrew(w);
  const team = expectOk(await w.A('team.publishTrip', { crewId, tripId: plan.tripId }));
  const info = expectOk(await w.B('guide.ask', { crewId, scope: 'team', tripId: plan.tripId, text: '下一站去哪？' }));
  assert.equal(info.tripContext.tripId, team.tripId); assert.equal(info.tripContext.canModify, false);
  const denied = expectOk(await w.B('guide.ask', { crewId, scope: 'team', text: '下一站少待十分钟' }));
  assert.match(denied.answer, /只有队伍发起人/); assert.equal(denied.tripChange, undefined);
  expectFail(await w.B('guide.ask', { tripId: plan.tripId, text: '下一站去哪？' }), 'FORBIDDEN_NOT_MEMBER');
  const nav = expectOk(await w.B('guide.navigation', { crewId, scope: 'team', target: 'next' }, { requestId: 'repeat-nav' }));
  assert.equal(nav.name, team.nodes ? team.nodes[0].placeName : plan.nodes[0].placeName);
  expectOk(await w.B('crew.leave', { crewId }));
  expectFail(await w.B('guide.navigation', { crewId, scope: 'team', target: 'next' }, { requestId: 'repeat-nav' }), 'FORBIDDEN_NOT_MEMBER');
  expectFail(await w.B('guide.ask', { crewId, scope: 'team', text: '下一站去哪？' }), 'FORBIDDEN_NOT_MEMBER');
});
test('集合剩余时间与逾期、取消、出发分开计算，不将旧版本确认或计划时间当成到齐', async () => {
  for (const status of ['proposed', 'cancelled', 'departed', 'completed']) {
    const w = await makeWorld({ createGuideProvider: offline }), { crewId } = await makeCrew(w);
    const meet = expectOk(await w.A('meet.create', { crewId, point, placeName: '入口', plannedMeetAt: w.plusMin(20).toISOString() }));
    const task = await w.repo.get(C.MEET_TASKS, meet.meetTaskId);
    await w.repo.update(C.MEET_TASKS, task._id, { status, participants: task.participants.map(p => ({ ...p, status: 'arrived', confirmedVersion: 0 })) });
    const future = expectOk(await w.A('guide.ask', { crewId, text: '距离集合还有多久？' }));
    assert.equal(future.meetingContext.confirmedCount, 0); assert.equal(future.meetingContext.allArrivedAt, null);
    if (status === 'proposed') {
      assert.equal(future.meetingContext.remainingMinutes, 20);
      const past = expectOk(await w.A('guide.ask', { crewId, text: '集合状态？' }, { now: w.plusMin(25) }));
      assert.equal(past.meetingContext.overdueMinutes, 5); assert.match(past.answer, /已过约5分钟/);
    } else {
      assert.equal(future.meetingContext.remainingMinutes, null);
      expectFail(await w.A('guide.navigation', { crewId, target: 'meeting' }), 'NOT_FOUND');
    }
  }
});
test('助手生成修改提案且原行程不变，沿用确认/版本检查生效，含糊要求返回服务器追问', async () => {
  const { w, plan } = await setup();
  const answer = expectOk(await w.A('guide.ask', { tripId: plan.tripId, text: plan.nodes[0].placeName + '少待十分钟' }));
  assert.equal(answer.tripChange.applied, false); assert.ok(answer.tripChange.candidates.some(c => c.feasible));
  const original = await w.repo.get(C.TRIPS, plan.tripId); assert.equal(original.version, 1);
  assert.equal(original.nodes[0].plannedStayMin, plan.nodes[0].plannedStayMin);
  const c = answer.tripChange.candidates.find(c => c.feasible);
  const applied = expectOk(await w.A('trip.confirmChange', { proposalId: answer.tripChange.proposalId, candidateId: c.candidateId }, { expectedVersion: 1 }));
  assert.equal(applied.version, 2); assert.equal(applied.nodes[0].plannedStayMin, plan.nodes[0].plannedStayMin - 10);
  const vague = expectOk(await w.A('guide.ask', { tripId: plan.tripId, text: '这里少待一会儿' }));
  assert.equal(vague.tripChange.needsClarification, true); assert.ok(vague.tripChange.questions.length);
  assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).version, 2);
});
test('模型不能将只读问题改成写入提案，也不能用模型提供的行程ID替代当前授权对象', async () => {
  const { w, plan } = await setup();
  const custom = await makeWorld({ createGuideProvider: () => ({ modelAvailable: true, visionAvailable: false,
    decide: async () => ({ ok: true, data: { tool: 'propose_trip_change', tripId: plan.tripId, text: '删除所有站点' } }) }) });
  const response = expectOk(await custom.A('guide.ask', { text: '下一站去哪？' }));
  assert.equal(response.tripChange, undefined); assert.equal(await custom.repo.count(C.CHANGE_PROPOSALS), 0);
  assert.equal(response.tripContext.available, false);
  const originalRun = w.repo.runTransaction.bind(w.repo);
  w.repo.runTransaction = async (...args) => {
    await w.repo.update(C.TRIPS, plan.tripId, { version: 2 });
    return originalRun(...args);
  };
  expectFail(await w.A('guide.ask', { tripId: plan.tripId, text: '下一站去哪？' }), 'VERSION_CONFLICT');
});
test('导航仅采用当前授权行程、进行中集合或已人工确认地点的坐标', async () => {
  const { w, plan } = await setup();
  const nav = expectOk(await w.A('guide.navigation', { tripId: plan.tripId, target: 'next', point: { latitude: 1, longitude: 2 } }));
  assert.deepEqual(nav.point, plan.nodes[0].location);
  expectFail(await w.B('guide.navigation', { tripId: plan.tripId, target: 'next' }), 'FORBIDDEN_NOT_MEMBER');
  const session = expectOk(await w.A('guide.ask', { text: '下一站去哪？' }));
  expectFail(await w.A('guide.navigation', { target: 'place', sessionId: session.sessionId }), 'INVALID_PARAM');
  expectFail(await w.B('guide.navigation', { target: 'place', sessionId: session.sessionId }), 'NOT_FOUND');
});
test('只查看或查询结束时间不会误生成修改提案', async () => {
  const { w, plan } = await setup();
  for (const text of ['只查看下一站，不要修改行程', '行程结束时间是多少？']) {
    const result = expectOk(await w.A('guide.ask', { tripId: plan.tripId, text }));
    assert.equal(result.tripChange, undefined); assert.equal(result.tripContext.version, 1);
    assert.match(result.answer, /计划结束于/);
  }
  assert.equal(await w.repo.count(C.CHANGE_PROPOSALS), 0);
});
test('YOLO 适配器接受零人，校验数量/坐标，网络失败不让语言模型猜人数或泄露密钥', async () => {
  const env = { YOLO_BASE_URL: 'https://detector.example.test', YOLO_API_KEY: 'private-token' };
  const base = { count: 0, boxes: [], model: 'yolo11n', estimated: true, confidenceThreshold: 0.35 };
  const make = data => createCrowdProvider({ env, http: async () => ({ json: data }) });
  assert.equal((await make(base).countPeople(image)).count, 0);
  for (const data of [{ ...base, count: 2 }, { ...base, model: 'guess' }, { ...base, count: 1, boxes: [{ x: -1, y: 0, width: 1, height: 1, confidence: 1 }] }]) {
    await assert.rejects(make(data).countPeople(image), /结果异常/);
  }
  await assert.rejects(createCrowdProvider({ env: {} }).countPeople(image), /尚未部署/);
  await assert.rejects(createCrowdProvider({ env, http: async () => { throw new Error('private-token'); } }).countPeople(image), e => /暂不可用/.test(e.message) && !e.message.includes('private-token'));
});
test('计数仅主动提交照片时调用 YOLO，不存图、不缓存图片响应且无效输入不调用推理', async () => {
  let calls = 0;
  const w = await makeWorld({ createGuideProvider: () => ({ ...offline(), countPeople: async encoded => { calls++; assert.equal(encoded, image); return { count: 0, boxes: [], estimated: true }; } }) });
  const counted = expectOk(await w.A('guide.countPeople', { imageBase64: image }));
  assert.equal(counted.count, 0); assert.equal(calls, 1);
  expectFail(await w.A('guide.countPeople', { imageBase64: 'invalid' }), 'INVALID_PARAM'); assert.equal(calls, 1);
  assert.equal(await w.repo.count(C.GUIDE_SESSIONS), 0);
  assert.equal(await w.repo.count(C.OPERATIONS, { action: 'guide.countPeople' }), 0);
  assert.ok(!JSON.stringify(await w.repo.find(C.EVENTS)).includes(image));
});

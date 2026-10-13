'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, makeCrew, expectOk, expectFail, C } = require('./helpers');

async function meeting() {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);
  const task = expectOk(await w.A('meet.create', {
    crewId, placeId: 'p_zhongyang', plannedMeetAt: w.plusMin(30),
  }));
  return { w, id: task.meetTaskId };
}
async function confirmAll(w, id) {
  const responses = await Promise.all(['B', 'C'].map(who =>
    w[who]('meet.confirm', { meetTaskId: id, decision: 'confirm' }, { expectedVersion: 1 })));
  responses.forEach(expectOk);
}
async function arriveAll(w, id) {
  const responses = await Promise.all(['A', 'B', 'C'].map(who =>
    w[who]('meet.arrive', { meetTaskId: id })));
  responses.forEach(expectOk);
}

test('同时确认：两位成员均成功且状态不丢失，提案版本保持不变', async () => {
  const { w, id } = await meeting();
  await confirmAll(w, id);
  const task = await w.repo.get(C.MEET_TASKS, id);
  assert.equal(task.status, 'confirmed');
  assert.equal(task.version, 1);
  assert.ok(task.participants.every(p => p.status === 'confirmed' && p.confirmedVersion === 1));
});

test('同时到达：三位成员的到达记录均保留，重复到达不改首次到齐时间', async () => {
  const { w, id } = await meeting();
  await confirmAll(w, id);
  await arriveAll(w, id);
  const before = await w.repo.get(C.MEET_TASKS, id);
  assert.equal(before.status, 'arrived_all');
  assert.ok(before.participants.every(p => p.status === 'arrived'));
  expectOk(await w.A('meet.arrive', { meetTaskId: id }, { now: w.plusMin(8) }));
  assert.equal((await w.repo.get(C.MEET_TASKS, id)).allArrivedAt, before.allArrivedAt);
});

test('旧任务没有 revision 时仍能并发确认且不丢记录', async () => {
  const { w, id } = await meeting();
  const legacy = await w.repo.get(C.MEET_TASKS, id);
  delete legacy.revision;
  await w.repo.__seed(C.MEET_TASKS, [legacy]);
  await confirmAll(w, id);
  assert.equal((await w.repo.get(C.MEET_TASKS, id)).status, 'confirmed');
});

test('只有一人到达时发起人也不能出发', async () => {
  const { w, id } = await meeting();
  await confirmAll(w, id);
  expectOk(await w.A('meet.arrive', { meetTaskId: id }));
  expectFail(await w.A('meet.depart', { meetTaskId: id }, { expectedVersion: 1 }), 'INVALID_PARAM');
  assert.equal((await w.repo.get(C.MEET_TASKS, id)).departedAt, null);
});

test('全员到齐后仍仅发起人可出发，必须传正确版本', async () => {
  const { w, id } = await meeting();
  await confirmAll(w, id);
  await arriveAll(w, id);
  expectFail(await w.B('meet.depart', { meetTaskId: id }, { expectedVersion: 1 }), 'FORBIDDEN_NOT_MEMBER');
  expectFail(await w.A('meet.depart', { meetTaskId: id }), 'INVALID_PARAM');
  expectFail(await w.A('meet.depart', { meetTaskId: id }, { expectedVersion: 0 }), 'VERSION_CONFLICT');
  const first = expectOk(await w.A('meet.depart', { meetTaskId: id }, { expectedVersion: 1 }));
  const repeated = expectOk(await w.A('meet.depart', { meetTaskId: id }, { expectedVersion: 1, now: w.plusMin(10) }));
  assert.equal(repeated.departedAt, first.departedAt);
});

test('集合已出发后旧确认不能让参与人状态倒退', async () => {
  const { w, id } = await meeting();
  await confirmAll(w, id);
  await arriveAll(w, id);
  expectOk(await w.A('meet.depart', { meetTaskId: id }, { expectedVersion: 1 }));
  expectFail(await w.B('meet.confirm', { meetTaskId: id, decision: 'confirm' }, { expectedVersion: 1 }), 'INVALID_PARAM');
});

test('同一请求编号不能跨用户或跨 action 重放；合法重试仍可重放', async () => {
  const w = await makeWorld();
  const options = { requestId: 'identity-regression' };
  const first = expectOk(await w.A('crew.create', { name: 'A' }, options));
  expectFail(await w.B('crew.create', { name: 'B' }, options), 'INVALID_PARAM');
  expectFail(await w.A('crew.get', { crewId: first.crewId }, options), 'INVALID_PARAM');
  const retry = await w.A('crew.create', { name: 'A' }, options);
  assert.equal(expectOk(retry).crewId, first.crewId);
  assert.equal(retry.meta.replayed, true);
});

async function sampleWorld() {
  const w = await makeWorld();
  const trip = await w.repo.insert(C.TRIPS, {
    mode: 'personal', ownerUserId: 'openid_A', version: 2,
    generatedBy: { planRunId: 'run-a' },
    nodes: [
      { nodeId: 'n1', placeId: 'p1', status: 'done', actualLeaveAt: w.plusMin(-10) },
      { nodeId: 'n2', placeId: 'p2', status: 'pending' },
    ],
  });
  for (const planRunId of ['run-a', 'run-b']) {
    await w.repo.insert(C.WALK_SAMPLES, { planRunId, fromId: 'p1', toId: 'p2', actualMinutes: null });
  }
  await w.repo.insert(C.WALK_SAMPLES, { fromId: 'p1', toId: 'p2', actualMinutes: null });
  return { w, trip, payload: { tripId: trip._id, nodeId: 'n2', status: 'arrived' } };
}

test('进度版本过期或缺失：不允许提前写入训练标签', async () => {
  const { w, payload } = await sampleWorld();
  expectFail(await w.A('trip.progress', payload, { expectedVersion: 1 }), 'VERSION_CONFLICT');
  expectFail(await w.A('trip.progress', payload), 'INVALID_PARAM');
  assert.ok((await w.repo.find(C.WALK_SAMPLES, {})).every(s => s.actualMinutes === null));
});

test('成功进度只回填本行程样本：同路段其他行程及无绑定旧样本保持未标注', async () => {
  const { w, payload } = await sampleWorld();
  expectOk(await w.A('trip.progress', payload, { expectedVersion: 2 }));
  const rows = await w.repo.find(C.WALK_SAMPLES, {});
  assert.equal(rows.find(s => s.planRunId === 'run-a').actualMinutes, 10);
  assert.ok(rows.filter(s => s.planRunId !== 'run-a').every(s => s.actualMinutes === null));
});

test('同一时刻生成的两条行程拥有不同采样关联号', async () => {
  const w = await makeWorld();
  const payload = { placeIds: ['p_zhongyang', 'p_fanghong', 'p_sofia'], startAt: w.NOW, constraints: [] };
  const a = expectOk(await w.A('trip.plan', payload));
  // Clear route caches so the second plan also queries the fake provider and records samples.
  await w.repo.__seed(C.PLACES, require('./helpers').fixtures.places);
  const b = expectOk(await w.B('trip.plan', payload));
  const ta = await w.repo.get(C.TRIPS, a.tripId);
  const tb = await w.repo.get(C.TRIPS, b.tripId);
  assert.notEqual(ta.generatedBy.planRunId, tb.generatedBy.planRunId);
  const samples = await w.repo.find(C.WALK_SAMPLES, {});
  assert.ok(samples.some(s => s.planRunId === ta.generatedBy.planRunId));
  assert.ok(samples.some(s => s.planRunId === tb.generatedBy.planRunId));
});

test('并发出发只提交一次，另一次读取已提交的出发时间', async () => {
  const { w, id } = await meeting();
  await confirmAll(w, id);
  await arriveAll(w, id);
  const responses = await Promise.all([1, 2].map(min =>
    w.A('meet.depart', { meetTaskId: id }, { expectedVersion: 1, now: w.plusMin(min) })));
  const data = responses.map(expectOk);
  assert.equal(data[0].departedAt, data[1].departedAt);
  assert.equal(data.filter(x => x.alreadyDeparted).length, 1);
});

test('云仓储条件写包含修订号、版本、状态，冲突时返回零更新', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const path = require('node:path');
  const moduleBox = { exports: {} };
  let observed;
  const db = {
    command: { exists: value => ({ exists: value }) },
    collection: name => ({ where: query => ({ update: async ({ data }) => {
      observed = { name, query, data };
      return { stats: { updated: 0 } };
    } }) }),
  };
  const filename = path.join(__dirname, '../cloudfunctions/api/lib/repo/cloud.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: moduleBox, console,
    require: name => name === 'wx-server-sdk'
      ? { __zy_inited: true, database: () => db }
      : require('../cloudfunctions/api/lib/repo/query'),
  }, { filename });
  const repo = moduleBox.exports.createCloudRepo();
  const saved = await repo.updateIf('meet_tasks', 'task1', {
    revision: { __op: 'exists', value: false }, version: 1, status: 'proposed',
  }, { revision: 1, participants: [{ userId: 'A', status: 'confirmed' }] });
  assert.equal(saved.updated, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(observed.query)), {
    _id: 'task1', revision: { exists: false }, version: 1, status: 'proposed',
  });
  assert.equal(observed.data.revision, 1);
  assert.equal(observed.data.participants[0].status, 'confirmed');
});

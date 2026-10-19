'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, expectOk, expectFail, C } = require('./helpers');
const { loadPage } = require('./page-harness');
const parser = require('../cloudfunctions/api/lib/ai/trip-change');
const resolver = require('../cloudfunctions/api/lib/trip-change');

const places = ['城市公园', '艺术展馆', '河畔步道'].map((name, i) => ({ name,
  location: { latitude: 45.77, longitude: 126.62 + i * 0.001 },
  visitDurationMin: { default: 30, min: 5, max: 120 } }));

test('取消剩余安排表达不依赖地点名，否定或单站修改不能扩大成全部取消', () => {
  for (const text of ['都不去了', '全部不去了', '剩下的都不去了', '后面的都不去了',
    '所有站点都不去', '取消剩余行程', '全部取消', '跳过剩下的站点']) {
    const parsed = parser.ruleParse(text);
    assert.deepEqual(parsed.uncertainties, [], text);
    assert.equal(parsed.operations.length, 1, text);
    assert.equal(parsed.operations[0].type, 'skip_remaining', text);
  }
  for (const text of ['城市公园不去了', '不要全部取消', '不要都不去了', '有点累了']) {
    assert.ok(parser.ruleParse(text).operations.every(op => op.type !== 'skip_remaining'), text);
  }
});

test('整句取消全部剩余站点走页面生成与确认，确认前不变，确认后保留记录并结束', async () => {
  const w = await makeWorld();
  const plan = expectOk(await w.A('trip.plan', { places, startAt: w.NOW }));
  const page = loadPage('miniprogram/pages/trip/index.js', { api: {
    'trip.adjustText': (p, o) => w.A('trip.adjustText', { ...p, preferModel: false }, o),
    'trip.confirmChange': (p, o) => w.A('trip.confirmChange', p, o),
  } });
  try {
    page.applyTrip(plan, '');
    page.onChangeText({ detail: { value: '都不去了' } });
    await page.submitTextChange();
    assert.equal(page.data.changeQuestions.length, 0);
    assert.equal(page.data.changeNeedsRewrite, false);
    const feasible = page.data.proposalCandidates.find(c => c.feasible);
    assert.ok(feasible);
    assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).nodes.filter(n => n.status === 'pending').length, 3);
    await page.confirmCandidate({ currentTarget: { dataset: { cid: feasible.candidateId } } });
    assert.equal(page.data.rawNodes.length, 3);
    assert.ok(page.data.rawNodes.every(n => n.status === 'skipped'));
    assert.equal(page.data.currentLeg, null);
    assert.equal(page.data.summary.totalStayMin, 0);
    const saved = await w.repo.get(C.TRIPS, plan.tripId);
    assert.equal(saved.status, 'finished');
    assert.equal(saved.version, 2);
    assert.equal(new Date(saved.plannedEndAt).getTime(), w.NOW.getTime());
    const snapshot = await w.repo.findOne(C.TRIP_VERSIONS, { tripId: plan.tripId, version: 2 });
    assert.ok(snapshot.snapshot.nodes.every(n => n.status === 'skipped'));
  } finally { page.restore(); }
});

test('取消范围只包含尚未到达的站点，已完成与正在游览的记录不被改写', async () => {
  const w = await makeWorld();
  const plan = expectOk(await w.A('trip.plan', { places, startAt: w.NOW }));
  const before = (await w.repo.get(C.TRIPS, plan.tripId)).nodes.map((n, i) => ({ ...n,
    status: i === 0 ? 'done' : i === 1 ? 'arrived' : 'pending',
    ...(i < 2 ? { actualArriveAt: w.NOW } : {}),
  }));
  await w.repo.update(C.TRIPS, plan.tripId, { nodes: before });
  const proposal = expectOk(await w.A('trip.adjustText', { tripId: plan.tripId,
    text: '取消剩余行程', preferModel: false }, { expectedVersion: 1 }));
  const applied = expectOk(await w.A('trip.confirmChange', { proposalId: proposal.proposalId,
    candidateId: proposal.candidates.find(c => c.feasible).candidateId }, { expectedVersion: 1 }));
  assert.equal(applied.nodes[0].status, 'done');
  assert.equal(applied.nodes[1].status, 'arrived');
  assert.equal(new Date(applied.nodes[1].actualArriveAt).getTime(), before[1].actualArriveAt.getTime());
  assert.equal(applied.nodes[2].status, 'skipped');
});

test('批量取消是一项操作，超过十个站点也不因展开操作数而失败', async () => {
  const w = await makeWorld();
  const manyPlaces = Array.from({ length: 12 }, (_, i) => ({ ...places[0], name: '地点' + i,
    location: { latitude: 45.77, longitude: 126.62 + i * 0.001 } }));
  const plan = expectOk(await w.A('trip.plan', { places: manyPlaces, startAt: w.NOW }));
  const proposal = expectOk(await w.A('trip.adjustText', { tripId: plan.tripId,
    text: '剩下的都不去了', preferModel: false }, { expectedVersion: 1 }));
  assert.equal(proposal.needsClarification, false);
  assert.equal(proposal.noFeasible, false);
  const stored = await w.repo.get(C.CHANGE_PROPOSALS, proposal.proposalId);
  assert.equal(stored.trigger.payload.operations.length, 1);
  assert.equal(stored.trigger.payload.operations[0].payload.nodeIds.length, 12);
});

test('模型漏掉全部范围时规则兜底，不能猜出批量取消意图', async () => {
  const answer = await parser.parse('都不去了', {}, { key: 'fake-test-only', http: async () => ({ json: {
    choices: [{ message: { content: JSON.stringify({ operations: [
      { type: 'skip_node', target: '都', evidence: '都不去了' }], uncertainties: [] }) } }],
  } }) });
  assert.equal(answer.parser, 'rulebased');
  assert.equal(answer.parsed.operations[0].type, 'skip_remaining');
  assert.equal(parser.validShape({ operations: [{ type: 'skip_remaining', evidence: '有点累了' }], uncertainties: [] }), false);
});

test('不能用伪造批量取消改写已到达历史或只指定一部分站点', async () => {
  const w = await makeWorld();
  const plan = expectOk(await w.A('trip.plan', { places, startAt: w.NOW }));
  await w.repo.update(C.TRIPS, plan.tripId, { nodes: plan.nodes.map((n, i) => i === 0 ? { ...n, status: 'arrived' } : n) });
  for (const nodeIds of [[plan.nodes[0].nodeId], [plan.nodes[1].nodeId], plan.nodes.map(n => n.nodeId)]) {
    expectFail(await w.A('trip.adjust', { tripId: plan.tripId, trigger: { type: 'batch', payload: { operations: [
      { type: 'skip_remaining', payload: { nodeIds } }],
    } } }, { expectedVersion: 1 }), 'INVALID_PARAM');
  }
  const context = resolver.buildContext({ nodes: [{ ...plan.nodes[0], status: 'arrived' }] });
  const result = resolver.resolve(parser.ruleParse('都不去了'), context, {}, w.NOW, 'user', {});
  assert.equal(result.operations.length, 0);
  assert.match(result.questions[0].prompt, /没有尚未到达/);
});

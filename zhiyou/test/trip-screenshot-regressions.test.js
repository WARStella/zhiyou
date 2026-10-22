'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, expectOk, expectFail, C, defaultMapFactory } = require('./helpers');
const { loadPage } = require('./page-harness');
const parser = require('../cloudfunctions/api/lib/ai/trip-change');
const resolver = require('../cloudfunctions/api/lib/trip-change');
const { parseTransit } = require('../cloudfunctions/api/lib/transit/amap');
const transitFixture = require('./fixtures/upstream/direction-transit-integrated-harbin.json');

const startPoint = { latitude: 45.75, longitude: 126.60 };
const place = { name: '哈尔滨学院', location: { latitude: 45.70, longitude: 126.62 },
  visitDurationMin: { default: 45, min: 5, max: 180 } };

async function oneStop(opts = {}) {
  const w = await makeWorld(opts);
  const plan = expectOk(await w.A('trip.plan', { places: [place], startPoint, startAt: w.NOW }));
  return { w, plan };
}
async function textChange(w, plan, text, extra = {}) {
  return expectOk(await w.A('trip.adjustText', { tripId: plan.tripId, text, preferModel: false, ...extra },
    { expectedVersion: plan.version }));
}
async function confirm(w, plan, proposal) {
  return expectOk(await w.A('trip.confirmChange', { proposalId: proposal.proposalId,
    candidateId: proposal.candidates.find(c => c.feasible).candidateId }, { expectedVersion: plan.version }));
}

test('截图一句话同时改地铁与总停留，查询真实线路、确认后保存，并在后续快捷调整中保留', async () => {
  const transit = parseTransit(transitFixture.body);
  let requests = 0;
  const { w, plan } = await oneStop({ createTransitProvider: () => ({ route: async () => {
    requests++; return { ok: true, ...transit };
  } }) });
  requests = 0;
  const page = loadPage('miniprogram/pages/trip/index.js', { api: {
    'trip.adjustText': (p, o) => w.A('trip.adjustText', { ...p, preferModel: false }, o),
    'trip.confirmChange': (p, o) => w.A('trip.confirmChange', p, o),
  } });
  try {
    page.applyTrip(plan, '');
    page.onChangeText({ detail: { value: '我要坐地铁去，然后停留五十分钟' } });
    await page.submitTextChange();
    assert.equal(page.data.changeNeedsRewrite, false);
    assert.equal(page.data.changeQuestions.length, 0);
    assert.ok(requests > 0);
    const proposed = (await w.repo.get(C.CHANGE_PROPOSALS, page.data.proposal.proposalId)).candidates.find(c => c.feasible);
    assert.equal(proposed.nodes[0].travelMode, 'subway');
    assert.equal(proposed.nodes[0].plannedStayMin, 50);
    assert.ok(proposed.nodes[0].travelTransit.lineNames.length);
    assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).nodes[0].plannedStayMin, 45);
    await page.confirmCandidate({ currentTarget: { dataset: { cid: proposed.candidateId } } });
    assert.equal(page.data.startLeg.mode, '地铁');
    assert.equal(page.data.rawNodes[0].plannedStayMin, 50);
    const saved = await w.repo.get(C.TRIPS, plan.tripId);
    const shortened = expectOk(await w.A('trip.adjust', { tripId: plan.tripId,
      trigger: { type: 'shorten_stay', payload: { nodeId: saved.nodes[0].nodeId, deltaMin: 5 } } },
    { expectedVersion: saved.version }));
    assert.equal(shortened.applied, true);
    assert.equal(shortened.nodes[0].travelMode, 'subway');
    assert.deepEqual(shortened.nodes[0].travelTransit, proposed.nodes[0].travelTransit);
    assert.equal(shortened.nodes[0].travelFromPrevMin, proposed.nodes[0].travelFromPrevMin);
  } finally { page.restore(); }
});

test('模型遗漏出行方式时降级，不能只执行同一句的停留时间', async () => {
  const text = '我要坐地铁去，然后停留五十分钟';
  const answer = await parser.parse(text, {}, { key: 'fake-test-only', http: async () => ({ json: {
    choices: [{ message: { content: JSON.stringify({ operations: [
      { type: 'set_stay', target: '', minutes: 50, evidence: '停留五十分钟' }],
    uncertainties: ['改乘地铁属于出行方式修改，暂不支持'] }) } }],
  } }) });
  assert.equal(answer.parser, 'rulebased');
  assert.deepEqual(answer.parsed.operations.map(o => o.type), ['change_travel_mode', 'set_stay']);
  assert.deepEqual(answer.parsed.uncertainties, []);
  assert.equal(parser.validShape({ operations: [{ type: 'change_travel_mode', mode: 'subway', evidence: '开车去' }], uncertainties: [] }), false);
});

test('模型遗漏停留时间时同样补全整句；新增地铁站不误作出行方式修改', async () => {
  const answer = await parser.parse('我要坐地铁去，然后停留五十分钟', {}, { key: 'fake-test-only', http: async () => ({ json: {
    choices: [{ message: { content: JSON.stringify({ operations: [
      { type: 'change_travel_mode', mode: 'subway', target: '', evidence: '我要坐地铁去' }], uncertainties: [] }) } }],
  } }) });
  assert.equal(answer.parser, 'rulebased');
  assert.equal(answer.parsed.operations[1].minutes, 50);
  for (const text of ['新增一站地铁站', '再去地铁站', '去地铁站']) {
    assert.equal(parser.ruleParse(text).operations[0].type, 'add_node');
  }
});

test('地铁不可用时保留偏好未满足的原因，不把其他方式冒充地铁', async () => {
  const { w, plan } = await oneStop({
    createMapProvider: (...args) => ({ ...defaultMapFactory(...args), distanceMatrix: async (from, tos, mode) => ({
      ok: true, elements: [{ usable: true, distanceMeters: 6000,
        durationMinutes: { walking: 90, bicycling: 30, driving: 15 }[mode] }],
    }) }),
    createTransitProvider: () => ({ route: async () => ({ ok: false, message: '没有地铁路线' }) }),
  });
  const proposal = await textChange(w, plan, '我要坐地铁去，然后停留五十分钟');
  const node = proposal.candidates.find(c => c.feasible).nodes[0];
  assert.notEqual(node.travelMode, 'subway');
  assert.equal(node.travelPreferredMode, 'subway');
  assert.equal(node.travelMatchedPreference, false);
  assert.match(node.travelReason, /地铁/);
  assert.equal(node.plannedStayMin, 50);
  assert.ok(proposal.candidates[0].notes.some(note => note.code === 'TRAVEL_MODE_RESULT' && /没有地铁路线/.test(note.message)));
});

test('所有交通都不可用时拒绝生成假修改，不沿用旧方式冒充已处理', async () => {
  const { w, plan } = await oneStop({ createTransitProvider: () => ({ route: async () => ({ ok: false, message: '没有地铁路线' }) }) });
  const before = await w.repo.get(C.TRIPS, plan.tripId);
  const error = expectFail(await w.A('trip.adjustText', { tripId: plan.tripId,
    text: '我要坐地铁去，然后停留五十分钟', preferModel: false }, { expectedVersion: 1 }), 'INVALID_PARAM');
  assert.match(error.message, /没有.*地铁/);
  assert.deepEqual((await w.repo.get(C.TRIPS, plan.tripId)).nodes, before.nodes);
});

test('单站或多站改去哈西万达均默认下一目标；模型缺少原站的提示不锁死追问', async () => {
  const text = '改去哈西万达';
  const model = await parser.parse(text, {}, { key: 'fake-test-only', http: async () => ({ json: {
    choices: [{ message: { content: JSON.stringify({ operations: [
      { type: 'replace_node', target: null, destination: '哈西万达', evidence: text }],
    uncertainties: ['未说明替换哪一站，需系统追问'] }) } }],
  } }) });
  assert.deepEqual(model.parsed.uncertainties, []);
  const { w, plan } = await oneStop();
  const context = resolver.buildContext(await w.repo.get(C.TRIPS, plan.tripId));
  const destinationChoices = { 0: { places: [{ _id: 'wanda', name: '哈西万达广场', address: '中兴大道' }] } };
  const one = resolver.resolve(model.parsed, structuredClone(context), {}, w.NOW, 'openid_A', destinationChoices);
  assert.deepEqual(one.questions.map(q => q.kind), ['place']);
  const multiple = structuredClone(context);
  multiple.nodes.push({ ...multiple.nodes[0], nodeId: 'second', seq: 1 });
  const many = resolver.resolve(model.parsed, multiple, {}, w.NOW, 'openid_A', destinationChoices);
  assert.deepEqual(many.questions.map(q => q.kind), ['place']);
  const answered = resolver.resolve(model.parsed, multiple, { '0.node': plan.nodes[0].nodeId }, w.NOW, 'openid_A', destinationChoices);
  assert.deepEqual(answered.questions.map(q => q.kind), ['place']);
  const ready = resolver.resolve(model.parsed, context, { '0.place': 'wanda' }, w.NOW, 'openid_A', destinationChoices);
  assert.equal(ready.questions.length, 0);
  assert.equal(ready.operations[0].payload.newPlaceId, 'wanda');
});

test('跳过最后一站生成可确认的结束方案，确认前不变，确认后保留跳过记录并退出导航', async () => {
  const { w, plan } = await oneStop();
  const page = loadPage('miniprogram/pages/trip/index.js', { api: {
    'trip.adjust': (p, o) => w.A('trip.adjust', p, o),
    'trip.confirmChange': (p, o) => w.A('trip.confirmChange', p, o),
  } });
  try {
    page.applyTrip(plan, '');
    await page.nodeAction({ currentTarget: { dataset: { nodeid: plan.nodes[0].nodeId, key: 'skip' } } });
    assert.notEqual(page.data.proposalMode, 'none');
    assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).nodes[0].status, 'pending');
    const cid = page.data.proposalCandidates.find(c => c.feasible).candidateId;
    await page.confirmCandidate({ currentTarget: { dataset: { cid } } });
    assert.equal(page.data.rawNodes[0].status, 'skipped');
    assert.equal(page.data.currentLeg, null);
    assert.equal(page.data.startLeg, null);
    assert.equal(page.data.summary.totalStayMin, 0);
    const stored = await w.repo.get(C.TRIPS, plan.tripId);
    assert.equal(stored.status, 'finished');
    assert.equal(stored.version, 2);
    assert.equal(new Date(stored.plannedEndAt).getTime(), w.NOW.getTime());
    assert.equal(stored.nodes[0].status, 'skipped');
    const snapshot = await w.repo.findOne(C.TRIP_VERSIONS, { tripId: plan.tripId, version: 2 });
    assert.equal(snapshot.snapshot.nodes[0].status, 'skipped');
  } finally { page.restore(); }
});

test('规划修复删光节点仍报冲突，主动跳过受保护最后一站也不能绕过必去条件', async () => {
  for (const protect of [false, true]) {
    const { w, plan } = await oneStop();
    await w.repo.update(C.TRIPS, plan.tripId, { constraints: [protect
      ? { key: 'mustVisit', value: [plan.nodes[0].placeId], hardness: 'hard', confirmedAt: w.NOW }
      : { key: 'endAt', value: w.plusMin(-1), hardness: 'hard', confirmedAt: w.NOW }] });
    const proposal = expectOk(await w.A('trip.adjust', { tripId: plan.tripId, trigger: {
      type: protect ? 'skip_node' : 'extend_stay', payload: { nodeId: plan.nodes[0].nodeId, deltaMin: 10 },
    } }, { expectedVersion: 1 }));
    assert.equal(proposal.noFeasible, true);
    assert.ok(proposal.candidates.every(c => !c.feasible));
    expectFail(await w.A('trip.confirmChange', { proposalId: proposal.proposalId,
      candidateId: proposal.candidates[0].candidateId }, { expectedVersion: 1 }), 'INFEASIBLE_HARD_CONSTRAINT');
    assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).nodes[0].status, 'pending');
  }
});

test('已到达站的交通不能改写；非法出行方式不能绕过批量入口', async () => {
  const { w, plan } = await oneStop();
  expectFail(await w.A('trip.adjust', { tripId: plan.tripId, trigger: { type: 'batch', payload: {
    operations: [{ type: 'change_travel_mode', payload: { nodeId: plan.nodes[0].nodeId, mode: 'airplane' } }],
  } } }, { expectedVersion: 1 }), 'INVALID_PARAM');
  expectOk(await w.A('trip.progress', { tripId: plan.tripId, nodeId: plan.nodes[0].nodeId, status: 'arrived' }, { expectedVersion: 1 }));
  const result = await textChange(w, { ...plan, version: 2 }, '第一站改坐地铁');
  assert.equal(result.needsClarification, true);
  assert.equal(result.questions[0].kind, 'node');
  assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).nodes[0].status, 'arrived');
});

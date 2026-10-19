'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeWorld, makeCrew, expectOk, expectFail, C, defaultMapFactory } = require('./helpers');
const { loadPage } = require('./page-harness');
const parser = require('../cloudfunctions/api/lib/ai/trip-change');
const resolver = require('../cloudfunctions/api/lib/trip-change');

const places = ['中央大街', '圣索菲亚教堂', '防洪纪念塔'].map((name, i) => ({ name,
  location: { latitude: 45.77, longitude: 126.62 + i * 0.001 },
  visitDurationMin: { default: 60, min: 5, max: 180 } }));
async function setup(extra) {
  const w = await makeWorld();
  const plan = expectOk(await w.A('trip.plan', Object.assign({ places, startAt: w.NOW }, extra)));
  return { w, plan };
}
async function change(w, tripId, text, extra) {
  const t = await w.repo.get(C.TRIPS, tripId);
  return expectOk(await w.A('trip.adjustText', { tripId, text, preferModel: false, ...extra }, { expectedVersion: t.version }));
}
async function confirm(w, p) {
  return expectOk(await w.A('trip.confirmChange', { proposalId: p.proposalId,
    candidateId: p.candidates.find(c => c.feasible).candidateId }, { expectedVersion: p.baseVersion }));
}

test('自然语言少停生成候选，确认后再少停基于最新值与最近修改对象，保留快照和版本', async () => {
  const { w, plan } = await setup();
  const a = await change(w, plan.tripId, '中央大街少待十五分钟');
  assert.equal(a.applied, false);
  assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).nodes[0].plannedStayMin, 60);
  assert.ok(a.candidates.every(c => c.requiresConfirmation));
  const first = await confirm(w, a);
  assert.equal(first.nodes[0].plannedStayMin, 45);
  const b = await change(w, plan.tripId, '再少待十分钟');
  assert.equal(b.needsClarification, false);
  const second = await confirm(w, b);
  assert.equal(second.nodes[0].plannedStayMin, 35);
  assert.equal(second.version, 3);
  const stored = await w.repo.get(C.TRIPS, plan.tripId);
  assert.equal(stored.changeContext.lastTargetNodeId, plan.nodes[0].nodeId);
  const snapshot = await w.repo.findOne(C.TRIP_VERSIONS, { tripId: plan.tripId, version: 3 });
  assert.equal(snapshot.snapshot.nodes[0].plannedStayMin, 35);
  assert.equal(snapshot.snapshot.changeContext.lastText, '再少待十分钟');
});

test('未确认方案继续补充保留最后一站，合并原修改后一次确认；旧方案失效', async () => {
  const { w, plan } = await setup();
  const a = await change(w, plan.tripId, '中央大街多待二十分钟');
  const b = await change(w, plan.tripId, '最后一站别删', { previousProposalId: a.proposalId });
  assert.deepEqual(b.interpretation.turns, ['中央大街多待二十分钟', '最后一站别删']);
  assert.equal((await w.repo.get(C.CHANGE_PROPOSALS, a.proposalId)).status, 'superseded');
  expectFail(await w.A('trip.confirmChange', { proposalId: a.proposalId, candidateId: a.candidates[0].candidateId }, { expectedVersion: 1 }), 'INVALID_PARAM');
  const done = await confirm(w, b);
  assert.equal(done.nodes[0].plannedStayMin, 80);
  const trip = await w.repo.get(C.TRIPS, plan.tripId);
  assert.ok(trip.constraints.some(c => c.key === 'mustVisit' && c.value.includes(plan.nodes[2].placeId)));
  const later = await change(w, plan.tripId, '最后一站不去了');
  assert.equal(later.noFeasible, true, '不能默默撤销此前确认的保留要求');
});

test('当前到达站与多个操作：设定总时长、跳过与保留严格分开', async () => {
  const { w, plan } = await setup();
  expectOk(await w.A('trip.progress', { tripId: plan.tripId, nodeId: plan.nodes[0].nodeId, status: 'arrived' }, { expectedVersion: 1 }));
  const proposal = await change(w, plan.tripId, '这里停留四十分钟，教堂不去了，最后一站不要删除');
  assert.equal(proposal.needsClarification, false);
  const done = await confirm(w, proposal);
  assert.equal(done.nodes.length, 2);
  assert.equal(done.nodes[0].plannedStayMin, 40);
  assert.equal(done.nodes[0].status, 'arrived');
  assert.equal(done.nodes[1].placeName, '防洪纪念塔');
});

test('没有到达状态的这里与模糊时长逐步追问，回答绑定服务器草稿，不猜数值', async () => {
  const { w, plan } = await setup();
  const draft = await change(w, plan.tripId, '这里少停一会儿');
  assert.equal(draft.needsClarification, true);
  assert.equal(draft.questions[0].kind, 'node');
  const firstAnswer = { '0.node': plan.nodes[1].nodeId };
  const minutes = await change(w, plan.tripId, null, { draftId: draft.draftId, answers: firstAnswer });
  assert.equal(minutes.questions[0].kind, 'minutes');
  const ready = await change(w, plan.tripId, null, { draftId: draft.draftId, answers: { ...firstAnswer, '0.minutes': '10' } });
  const done = await confirm(w, ready);
  assert.equal(done.nodes[1].plannedStayMin, 50);
  assert.equal(done.nodes[0].plannedStayMin, 60);
  expectFail(await w.A('trip.adjustText', { tripId: plan.tripId, draftId: draft.draftId, answers: firstAnswer }, { expectedVersion: done.version }), 'INVALID_PARAM');
});

test('同名或简称命中多个节点时询问，不把已完成节点误当下一站，历史必去条件已满足', async () => {
  const { w, plan } = await setup();
  await w.repo.update(C.TRIPS, plan.tripId, { nodes: plan.nodes.map((n, i) => ({ ...n, status: i === 0 ? 'done' : 'pending',
    placeName: i === 0 ? n.placeName : '入口' })), constraints: [{ key: 'mustVisit', value: [plan.nodes[0].placeId], hardness: 'hard', confirmedAt: w.NOW }] });
  const ambiguous = await change(w, plan.tripId, '入口少停十分钟');
  assert.equal(ambiguous.questions[0].options.length, 2);
  const draft = await change(w, plan.tripId, '第一站少停十分钟');
  assert.ok(draft.needsClarification);
  assert.ok(draft.questions[0].options.every(o => o.value !== plan.nodes[0].nodeId));
  const valid = await change(w, plan.tripId, '第二站少停十分钟');
  const done = await confirm(w, valid);
  assert.equal(done.nodes.length, 3);
  assert.equal(done.nodes[0].status, 'done');
  assert.equal(done.nodes[1].plannedStayMin, 50);
});

test('结束时间按北京时间追问上下午，确认后约束持续生效，不能只改一轮', async () => {
  const { w, plan } = await setup();
  const draft = await change(w, plan.tripId, '五点前结束');
  assert.equal(draft.questions[0].kind, 'clock');
  const ready = await change(w, plan.tripId, null, { draftId: draft.draftId, answers: { '0.clock': '17:00' } });
  await confirm(w, ready);
  const trip = await w.repo.get(C.TRIPS, plan.tripId);
  assert.equal(trip.constraints.find(c => c.key === 'endAt').value, '2026-10-20T09:00:00.000Z');
  const second = await change(w, plan.tripId, '中央大街多待一小时');
  const saved = await w.repo.get(C.CHANGE_PROPOSALS, second.proposalId);
  assert.equal(saved.nextConstraints.find(c => c.key === 'endAt').value, '2026-10-20T09:00:00.000Z');
});

test('不足、非法数值与不支持的要求不能部分生效；负向表达不误作跳过', async () => {
  const { w, plan } = await setup();
  for (const text of ['中央大街少停六十分钟', '中央大街多待-5分钟', '中央大街少待十分钟，新增一个咖啡馆', '中央大街和教堂不去了', '不要少停十分钟']) {
    const answer = await change(w, plan.tripId, text);
    assert.ok(answer.needsClarification, text);
    assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).version, 1);
  }
  for (const text of ['最后一站不要取消', '不要跳过最后一站', '最后一站别删']) {
    const p = await change(w, plan.tripId, text);
    assert.ok(p.candidates.every(c => c.nodes.some(n => n.nodeId === plan.nodes[2].nodeId)));
  }
});

test('旧版本、过期草稿、非本人草稿及团队队员修改被拒绝', async () => {
  const { w, plan } = await setup();
  expectFail(await w.B('trip.adjustText', { tripId: plan.tripId, text: '少停十分钟', preferModel: false }, { expectedVersion: 1 }), 'FORBIDDEN_NOT_MEMBER');
  expectFail(await w.A('trip.adjustText', { tripId: plan.tripId, text: '少停十分钟' }), 'INVALID_PARAM');
  const draft = await change(w, plan.tripId, '这里少停一会儿');
  await w.repo.update(C.CHANGE_PROPOSALS, draft.draftId, { expiresAt: new Date(w.NOW - 1) });
  expectFail(await w.A('trip.adjustText', { tripId: plan.tripId, draftId: draft.draftId }, { expectedVersion: 1 }), 'INVALID_PARAM');
  const { crewId } = await makeCrew(w);
  const team = expectOk(await w.A('trip.plan', { places, startAt: w.NOW, crewId }));
  expectFail(await w.B('trip.adjustText', { tripId: team.tripId, text: '最后一站别删', preferModel: false }, { expectedVersion: 1 }), 'FORBIDDEN_NOT_MEMBER');
  const p = await change(w, team.tripId, '中央大街少停十分钟');
  assert.equal((await w.repo.get(C.TRIPS, team.tripId)).version, 1);
  await confirm(w, p);
  expectFail(await w.A('trip.adjustText', { tripId: team.tripId, text: '最后一站别删', preferModel: false }, { expectedVersion: 1 }), 'VERSION_CONFLICT');
});

test('HTTP 模型收到当前行程而无成员身份；数字须有原文依据，错误模型输出降级', async () => {
  const context = resolver.buildContext({ version: 4, nodes: [], constraints: [{ key: 'endAt', value: 'x', sourceMemberIds: ['secret-openid'] }] });
  let sent;
  const result = await parser.parse('这里多待一会儿', context, { key: 'fake-test-only', http: async (url, opts) => {
    sent = JSON.parse(opts.body);
    return { httpStatus: 200, json: { choices: [{ message: { content: JSON.stringify({ rawText: '', operations: [
      { type: 'extend_stay', target: '这里', evidence: '这里多待一会儿', minutes: 20 }], uncertainties: [] }) } }] } };
  } });
  assert.equal(result.parser, 'http');
  assert.equal(result.parsed.operations[0].minutes, null);
  assert.match(sent.messages[1].content, /"version":4/);
  assert.ok(!JSON.stringify(sent).includes('secret-openid'));
  const fallback = await parser.parse('最后一站别删', context, { key: 'fake-test-only', http: async () => ({
    json: { choices: [{ message: { content: '{"operations":[{"type":"delete_all"}],"uncertainties":[]}' } }] } }) });
  assert.equal(fallback.degraded, true);
  assert.equal(fallback.parsed.operations[0].type, 'protect_node');
  const offline = await parser.parse('中央大街少停十分钟', context, { key: 'fake-test-only', http: async () => { throw new Error('offline'); } });
  assert.equal(offline.parser, 'rulebased');
  assert.equal(offline.attempts[0].reason, 'AI_UPSTREAM_FAILED');
});

function pageFor(w, plan) {
  const p = loadPage('miniprogram/pages/trip/index.js', { api: {
    'trip.adjustText': (payload, opts) => w.A('trip.adjustText', { ...payload, preferModel: false }, opts),
    'trip.confirmChange': (payload, opts) => w.A('trip.confirmChange', payload, opts),
    'trip.get': (payload, opts) => w.A('trip.get', payload, opts),
  } });
  p.applyTrip(plan, ''); return p;
}
test('实际页面连续输入、追问、选方案确认与再次修改连通，放弃方案保留原行程', async () => {
  const { w, plan } = await setup(); const p = pageFor(w, plan);
  try {
    p.onChangeText({ detail: { value: '中央大街少停十五分钟' } });
    await p.submitTextChange();
    assert.equal(p.data.busy, ''); assert.equal(p.data.proposal.isText, true);
    assert.equal(p.data.rawNodes[0].plannedStayMin, 60);
    await p.confirmCandidate({ currentTarget: { dataset: { cid: p.data.proposalCandidates.find(c => c.feasible).candidateId } } });
    assert.equal(p.data.rawNodes[0].plannedStayMin, 45);
    assert.ok(p.data.summary);
    p.onChangeText({ detail: { value: '再少待十分钟' } }); await p.submitTextChange();
    await p.confirmCandidate({ currentTarget: { dataset: { cid: p.data.proposalCandidates.find(c => c.feasible).candidateId } } });
    assert.equal(p.data.rawNodes[0].plannedStayMin, 35);
    assert.equal(p.data.trip.version, 3);
    p.onChangeText({ detail: { value: '最后一站不去了' } }); await p.submitTextChange(); p.discardProposal();
    assert.equal(p.data.rawNodes.length, 3); assert.equal(p.data.proposal, null);
    p.onChangeText({ detail: { value: '这里多待一会儿' } }); await p.submitTextChange();
    assert.equal(p.data.changeQuestions[0].kind, 'node');
    p.answerChangeQuestion({ currentTarget: { dataset: { key: '0.node', value: plan.nodes[1].nodeId } } });
    await p.submitTextChange();
    p.answerChangeQuestion({ currentTarget: { dataset: { key: '0.minutes' } }, detail: { value: '5' } });
    await p.submitTextChange();
    assert.equal(p.data.changeQuestions.length, 0); assert.ok(p.data.proposal);
  } finally { p.restore(); }
});

test('实际页面版本冲突刷新当前节点，旧追问不沿用；迟到响应不能污染重置后的行程', async () => {
  const { w, plan } = await setup(); const p = pageFor(w, plan);
  try {
    expectOk(await w.A('trip.progress', { tripId: plan.tripId, nodeId: plan.nodes[0].nodeId, status: 'arrived' }, { expectedVersion: 1 }));
    p.onChangeText({ detail: { value: '中央大街少停十分钟' } }); await p.submitTextChange();
    assert.equal(p.data.trip.version, 2); assert.match(p.data.changeError, /行程已更新/);
    assert.equal(p.data.rawNodes[0].status, 'arrived');
    assert.equal(p.data.busy, '');
  } finally { p.restore(); }
  let release;
  const q = loadPage('miniprogram/pages/trip/index.js', { api: {
    'trip.adjustText': () => new Promise(resolve => { release = resolve; }),
  } });
  try {
    q.applyTrip(plan, ''); q.onChangeText({ detail: { value: '最后一站别删' } });
    const waiting = q.submitTextChange(); q.resetTrip();
    release({ ok: true, data: { interpretation: { turns: ['old'] }, needsClarification: true, draftId: 'old', questions: [] } });
    await waiting; assert.equal(q.data.trip, null); assert.equal(q.data.changeDraftId, ''); assert.equal(q.data.busy, '');
  } finally { q.restore(); }
});

test('自然语言输入与追问的模板事件都有真实处理函数', () => {
  const xml = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/trip/index.wxml'), 'utf8');
  for (const name of ['onChangeText', 'answerChangeQuestion', 'submitTextChange']) assert.ok(xml.includes('="' + name + '"'));
});

test('未确认的增减连续叠加，第二轮按待确认的时长理解，放弃不保存上下文', async () => {
  const { w, plan } = await setup();
  const a = await change(w, plan.tripId, '中央大街多停二十分钟');
  const b = await change(w, plan.tripId, '再少停十分钟', { previousProposalId: a.proposalId });
  assert.equal(b.candidates.find(c => c.feasible).nodes[0].plannedStayMin, 70);
  assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).changeContext, undefined);
  const confirmed = await confirm(w, b);
  assert.equal(confirmed.nodes[0].plannedStayMin, 70);
});

test('只改停留保留原地铁时长、线路与来源，跳过中间站后不复用原地铁段', async () => {
  const { w, plan } = await setup();
  const transit = { segments: [{ mode: 'subway', lineName: '地铁 2 号线' }], fare: 2 };
  const nodes = plan.nodes.map((n, i) => i === 2 ? { ...n, travelMode: 'subway', travelFromPrevMin: 7,
    travelFromPrevMeters: 2000, travelSource: 'upstream', travelProvider: 'amap-transit', travelTransit: transit } : n);
  await w.repo.update(C.TRIPS, plan.tripId, { nodes });
  const p = await change(w, plan.tripId, '中央大街少停十分钟');
  const c = p.candidates.find(c => c.feasible);
  assert.equal(c.nodes[0].travelFromStart, false, '没有起点段时不能凭空增加一个零分钟起点段');
  assert.equal(c.nodes[2].travelMode, 'subway'); assert.equal(c.nodes[2].travelFromPrevMin, 7);
  assert.deepEqual(c.nodes[2].travelTransit, transit);
  const applied = await confirm(w, p);
  assert.equal(applied.nodes[2].travelSource, 'upstream');
  assert.ok(applied.summary.totalWalkMin < 7, '地铁时间不能记成步行');
  const skip = await change(w, plan.tripId, '教堂不去了');
  const last = skip.candidates.find(c => c.feasible).nodes.slice(-1)[0];
  assert.equal(last.travelMode, 'walking'); assert.equal(last.travelSource, 'estimated');
  assert.notEqual(last.travelFromPrevMeters, 2000);
});

test('保护所有剩余地点且时间不足时明确无可行方案，任何候选都不能强行确认', async () => {
  const { w, plan } = await setup();
  const p = await change(w, plan.tripId, '第一站别删，第二站别删，最后一站别删，09:30前结束');
  assert.equal(p.noFeasible, true);
  assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).version, 1);
  expectFail(await w.A('trip.confirmChange', { proposalId: p.proposalId, candidateId: p.candidates[0].candidateId },
    { expectedVersion: 1 }), 'INFEASIBLE_HARD_CONSTRAINT');
});

test('相同请求重放仍检查解散后的成员权限，不能绕过鉴权返回旧解释', async () => {
  const w = await makeWorld(); const { crewId } = await makeCrew(w);
  const plan = expectOk(await w.A('trip.plan', { places, startAt: w.NOW, crewId }));
  const payload = { tripId: plan.tripId, text: '最后一站别删', preferModel: false };
  const options = { requestId: 'text-replay-after-close', expectedVersion: 1 };
  expectOk(await w.A('trip.adjustText', payload, options));
  expectOk(await w.A('team.close', { crewId }));
  expectFail(await w.A('trip.adjustText', payload, options), 'FORBIDDEN_NOT_MEMBER');
});

test('跨行程或伪造创建人的草稿不可使用，伪造节点答案不会修改其他节点', async () => {
  const { w, plan } = await setup();
  const draft = await change(w, plan.tripId, '这里少停十分钟');
  const other = expectOk(await w.A('trip.plan', { places: places.slice(0, 1), startAt: w.NOW }));
  expectFail(await w.A('trip.adjustText', { tripId: other.tripId, draftId: draft.draftId }, { expectedVersion: 1 }), 'NOT_FOUND');
  const bad = await change(w, plan.tripId, null, { draftId: draft.draftId, answers: { '0.node': 'not-a-node' } });
  assert.equal(bad.needsClarification, true);
  await w.repo.update(C.CHANGE_PROPOSALS, draft.draftId, { createdByUserId: 'openid_B' });
  expectFail(await w.A('trip.adjustText', { tripId: plan.tripId, draftId: draft.draftId }, { expectedVersion: 1 }), 'NOT_FOUND');
});

test('批量入口拒绝嵌套、未知操作和完成节点，不能绕过自然语言验证直接构造非法候选', async () => {
  const { w, plan } = await setup();
  for (const operation of [{ type: 'batch', payload: { operations: [] } }, { type: 'delete_all', payload: {} },
    { type: 'set_stay', payload: { nodeId: plan.nodes[0].nodeId, stayMin: -5 } }]) {
    expectFail(await w.A('trip.adjust', { tripId: plan.tripId, trigger: { type: 'batch', payload: { operations: [operation] } } }), 'INVALID_PARAM');
  }
  expectOk(await w.A('trip.progress', { tripId: plan.tripId, nodeId: plan.nodes[0].nodeId, status: 'done' }, { expectedVersion: 1 }));
  expectFail(await w.A('trip.adjust', { tripId: plan.tripId,
    trigger: { type: 'batch', payload: { operations: [{ type: 'skip_node', payload: { nodeId: plan.nodes[0].nodeId } }] } } }), 'INVALID_PARAM');
});

const campuses = [
  { poiId: 'hit-main', title: '哈尔滨工业大学(一校区)', address: '西大直街 92 号', category: '教育学校',
    location: { latitude: 45.765, longitude: 126.62 } },
  { poiId: 'hit-second', title: '哈尔滨工业大学(二校区)', address: '黄河路 73 号', category: '教育学校',
    location: { latitude: 45.765, longitude: 126.63 } },
];
async function replacementWorld(opts) {
  opts = opts || {};
  const calls = { search: [], matrix: [] };
  const w = await makeWorld({ seedPlaces: [], createTransitProvider: () => null,
    createMapProvider: (name, settings) => {
      const base = defaultMapFactory(name, settings);
      return { ...base,
        searchPlaces: async input => {
          calls.search.push(input);
          return opts.search ? opts.search(input) : { ok: true, count: 2, items: campuses };
        },
        distanceMatrix: async (...args) => {
          calls.matrix.push(args);
          if (opts.matrix) return opts.matrix(...args);
          return base.distanceMatrix(...args);
        },
      };
    },
  });
  const plan = expectOk(await w.A('trip.plan', { places, startAt: w.NOW, ...opts.plan }));
  calls.matrix = [];
  return { w, plan, calls };
}

test('截图原话及常见换点句解析为一次替换，不先删节点、不把了当作地点名', () => {
  assert.equal(parser.ruleParse('第一站停留改为三十分钟').operations[0].type, 'set_stay');
  for (const text of ['不去最后一个地方了，改去哈工大', '最后一站不去了，改去哈工大',
    '把最后一站换成哈工大', '不去最后一个地方了改去哈工大']) {
    const p = parser.ruleParse(text);
    assert.equal(p.uncertainties.length, 0, text);
    assert.equal(p.operations.length, 1, text);
    assert.equal(p.operations[0].type, 'replace_node');
    assert.equal(p.operations[0].destination, '哈工大');
    assert.equal(resolver.resolveNode(p.operations[0].target, { nodes: [
      { nodeId: 'last', seq: 0, status: 'pending' }], }, null)[0].nodeId, 'last');
  }
});

test('真实页面换哈工大：选校区后生成候选，确认前不删旧站；不向地点库写入', async () => {
  const { w, plan, calls } = await replacementWorld(); const p = pageFor(w, plan);
  const before = (await w.repo.get(C.TRIPS, plan.tripId)).nodes;
  try {
    p.onChangeText({ detail: { value: '不去最后一个地方了，改去哈工大' } });
    await p.submitTextChange();
    const q = p.data.changeQuestions[0];
    assert.equal(q.kind, 'place'); assert.equal(q.options.length, 2);
    assert.match(q.options[1].label, /二校区.*黄河路/);
    assert.equal(p.data.changeNeedsRewrite, false);
    assert.equal(calls.search[0].keyword, '哈工大');
    assert.equal(calls.search[0].region, '哈尔滨'); assert.equal(calls.search[0].center, undefined);
    assert.deepEqual((await w.repo.get(C.TRIPS, plan.tripId)).nodes, before);
    p.answerChangeQuestion({ currentTarget: { dataset: { key: q.key, value: q.options[1].value } } });
    await p.submitTextChange();
    assert.equal(calls.search.length, 1, '草稿回答复用检索快照');
    assert.equal(p.data.proposal.isText, true);
    assert.equal(p.data.rawNodes[2].placeName, '防洪纪念塔');
    await p.confirmCandidate({ currentTarget: { dataset: { cid: p.data.proposalCandidates.find(c => c.feasible).candidateId } } });
    assert.equal(p.data.rawNodes.length, 3);
    assert.equal(p.data.rawNodes[2].placeName, campuses[1].title);
    assert.deepEqual(p.data.rawNodes[2].placeSnapshot.location, campuses[1].location);
    assert.equal(await w.repo.count(C.PLACES, {}), 0);
    assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).version, 2);
    assert.match(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/trip/index.wxml'), 'utf8'), /question.kind === 'place'/);
  } finally { p.restore(); }
});

test('换点前后连续补充理解新地点，保留真实历史，确认后仍可再次替换', async () => {
  const { w, plan } = await replacementWorld();
  expectOk(await w.A('trip.progress', { tripId: plan.tripId, nodeId: plan.nodes[0].nodeId, status: 'done' }, { expectedVersion: 1 }));
  const draft = await change(w, plan.tripId, '不去最后一个地方了，改去哈工大');
  const a = await change(w, plan.tripId, null, { draftId: draft.draftId, answers: { '0.place': 'poi_hit-main' } });
  const b = await change(w, plan.tripId, '一校区少停十分钟', { previousProposalId: a.proposalId });
  assert.equal(b.needsClarification, false);
  const done = await confirm(w, b);
  assert.equal(done.nodes[0].status, 'done');
  assert.equal(done.nodes[2].placeName, campuses[0].title);
  assert.equal(done.nodes[2].plannedStayMin, 35); // POI 默认 45 分钟，再少停 10 分钟。
  const again = await change(w, plan.tripId, '最后一站换成哈工大');
  const c = await change(w, plan.tripId, null, { draftId: again.draftId, answers: { '0.place': 'poi_hit-second' } });
  const doneAgain = await confirm(w, c);
  assert.equal(doneAgain.nodes[2].placeName, campuses[1].title);
  assert.equal(doneAgain.nodes[0].status, 'done');
  const snapshot = await w.repo.findOne(C.TRIP_VERSIONS, { tripId: plan.tripId, version: doneAgain.version });
  assert.equal(snapshot.snapshot.nodes[2].placeSnapshot._id, 'poi_hit-second');
});

test('伪造选点 ID 或坐标不能绕过草稿；省略原站默认下一目标，已到达站不能替换', async () => {
  const { w, plan } = await replacementWorld();
  const draft = await change(w, plan.tripId, '最后一站改去哈工大');
  for (const answer of ['poi_invented', { _id: 'poi_hit-main', location: { longitude: 999 } }]) {
    const invalid = await change(w, plan.tripId, null, { draftId: draft.draftId,
      answers: { '0.place': answer }, changePlaces: { poi_invented: campuses[0] } });
    assert.equal(invalid.needsClarification, true); assert.equal(invalid.questions[0].kind, 'place');
  }
  const noTarget = await change(w, plan.tripId, '改去哈工大');
  assert.equal(noTarget.questions[0].kind, 'place');
  expectOk(await w.A('trip.progress', { tripId: plan.tripId, nodeId: plan.nodes[0].nodeId, status: 'arrived' }, { expectedVersion: 1 }));
  const arrived = await change(w, plan.tripId, '第一站换成哈工大');
  assert.equal(arrived.questions[0].kind, 'node');
  assert.ok(arrived.questions[0].options.every(o => o.value !== plan.nodes[0].nodeId));
  assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).nodes[0].status, 'arrived');
});

test('改成去A省略原站时替换下一待前往站，跳过历史和当前已到达站，忽略最近修改对象', async () => {
  const { w, plan } = await replacementWorld();
  const original = (await w.repo.get(C.TRIPS, plan.tripId)).nodes;
  await w.repo.update(C.TRIPS, plan.tripId, {
    nodes: original.map((n, i) => ({ ...n, status: i === 0 ? 'arrived' : 'pending' })),
    changeContext: { lastTargetNodeId: original[2].nodeId },
  });
  for (const text of ['改去哈工大', '改成去哈工大', '改为去哈工大']) {
    const draft = await change(w, plan.tripId, text);
    assert.deepEqual(draft.questions.map(q => q.kind), ['place'], text);
    const proposal = await change(w, plan.tripId, null, { draftId: draft.draftId,
      answers: { '0.place': 'poi_hit-main' } });
    const candidate = proposal.candidates.find(c => c.feasible);
    assert.equal(candidate.nodes[0].placeId, original[0].placeId);
    assert.equal(candidate.nodes[0].status, 'arrived');
    assert.equal(candidate.nodes[1].nodeId, original[1].nodeId);
    assert.equal(candidate.nodes[1].placeId, 'poi_hit-main');
    assert.equal(candidate.nodes[2].placeId, original[2].placeId);
    assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).version, 1, '选点生成方案后仍等待确认');
  }
  const explicit = await change(w, plan.tripId, '最后一站改成去哈工大');
  const final = await change(w, plan.tripId, null, { draftId: explicit.draftId,
    answers: { '0.place': 'poi_hit-second' } });
  const confirmed = await confirm(w, final);
  assert.equal(confirmed.nodes[1].placeId, original[1].placeId);
  assert.equal(confirmed.nodes[2].placeId, 'poi_hit-second');
});

test('省略替换原站按序选择下一待前往站，模型不能补成最后一站，无待前往站时不改到达历史', async () => {
  const text = '改成去哈工大';
  const result = await parser.parse(text, {}, { key: 'fake-test-only', http: async () => ({ json: {
    choices: [{ message: { content: JSON.stringify({ operations: [{ type: 'replace_node',
      target: '最后一站', destination: '哈工大', evidence: text }], uncertainties: [] }) } }],
  } }) });
  assert.equal(result.parser, 'http');
  assert.equal(result.parsed.operations[0].target, null);
  const nodes = [
    { nodeId: 'later', placeId: 'c', placeName: '后站', seq: 4, status: 'pending' },
    { nodeId: 'done', placeId: 'a', placeName: '旧站', seq: 0, status: 'done' },
    { nodeId: 'skipped', placeId: 's', placeName: '跳过站', seq: 1, status: 'skipped' },
    { nodeId: 'next', placeId: 'b', placeName: '下一站', seq: 3, status: 'pending' },
    { nodeId: 'here', placeId: 'h', placeName: '当前站', seq: 2, status: 'arrived' },
  ];
  const choices = { 0: { places: [{ _id: 'new', name: '哈尔滨工业大学' }] } };
  const resolved = resolver.resolve(result.parsed, { nodes: structuredClone(nodes), lastTargetNodeId: 'later' },
    { '0.place': 'new' }, new Date(), 'user', choices);
  assert.equal(resolved.operations[0].payload.nodeId, 'next');
  const none = resolver.resolve(result.parsed, { nodes: nodes.filter(n => n.status !== 'pending') },
    {}, new Date(), 'user', choices);
  assert.equal(none.operations.length, 0);
  assert.match(none.questions[0].prompt, /没有待前往/);
});

test('搜不到、上游失败或无效坐标时整次换点不执行，保留行程并给可改写提示', async () => {
  for (const up of [{ ok: true, items: [], count: 0 }, { throws: true },
    { ok: false, reason: 'TIMEOUT', message: '地图请求超时' },
    { ok: true, items: [{ ...campuses[0], location: { latitude: 45, longitude: 999 } }], count: 1 }]) {
    const { w, plan } = await replacementWorld({ search: async () => {
      if (up.throws) throw new Error('network socket disconnected');
      return up;
    } });
    const before = (await w.repo.get(C.TRIPS, plan.tripId)).nodes;
    const draft = await change(w, plan.tripId, '不去最后一个地方了，改去哈工大');
    assert.equal(draft.needsClarification, true); assert.equal(draft.questions[0].kind, 'rewrite');
    if (up.ok === false) assert.match(draft.questions[0].prompt, /超时/);
    assert.deepEqual((await w.repo.get(C.TRIPS, plan.tripId)).nodes, before);
    assert.equal(await w.repo.count(C.CHANGE_PROPOSALS, { status: 'proposed' }), 0);
  }
});

test('模型支持换点及删后改去的归并；遗漏替换或编造目的地时规则兜底', async () => {
  const text = '不去最后一个地方了，改去哈工大';
  const model = async operations => parser.parse(text, { nodes: [] }, { key: 'fake-test-only', http: async () => ({
    json: { choices: [{ message: { content: JSON.stringify({ operations, uncertainties: [] }) } }] },
  }) });
  const good = await model([{ type: 'skip_node', target: '最后一个地方', evidence: '不去最后一个地方了' },
    { type: 'replace_node', target: '最后一站', destination: '哈工大', evidence: '改去哈工大' }]);
  assert.equal(good.parser, 'http'); assert.equal(good.parsed.operations.length, 1);
  assert.equal(good.parsed.operations[0].target, '最后一个地方');
  for (const ops of [[{ type: 'skip_node', target: '最后一个地方', evidence: '不去最后一个地方了' }],
    [{ type: 'replace_node', target: '最后一个地方', destination: '模型虚构地点', evidence: text }]]) {
    const fallback = await model(ops);
    assert.equal(fallback.degraded, true); assert.equal(fallback.parsed.operations[0].type, 'replace_node');
    assert.equal(fallback.parsed.operations[0].destination, '哈工大');
  }
});

test('换中间站重新查询两端交通，不复用旧地铁耗时；失败如实估算，决策记录请求数', async () => {
  const { w, plan, calls } = await replacementWorld({ matrix: async () => ({ ok: false, requestCount: 1, reason: 'TIMEOUT' }) });
  await w.repo.update(C.TRIPS, plan.tripId, { nodes: plan.nodes.map((n, i) => i === 2 ? { ...n,
    travelMode: 'subway', travelFromPrevMin: 777, travelSource: 'upstream', travelTransit: { fare: 9 } } : n) });
  const draft = await change(w, plan.tripId, '第二站换成哈工大');
  const p = await change(w, plan.tripId, null, { draftId: draft.draftId, answers: { '0.place': 'poi_hit-main' } });
  const nodes = p.candidates.find(c => c.feasible).nodes;
  assert.equal(nodes[1].placeName, campuses[0].title);
  assert.equal(nodes[2].travelSource, 'estimated'); assert.notEqual(nodes[2].travelFromPrevMin, 777);
  assert.equal(nodes[2].travelTransit, null);
  assert.ok(calls.matrix.some(args => args[0].latitude === campuses[0].location.latitude));
  assert.ok(calls.matrix.some(args => args[1][0].latitude === campuses[0].location.latitude));
  const decisions = await w.repo.find(C.DECISIONS, { tripId: plan.tripId, kind: 'adjust' });
  assert.equal(decisions[0].mapApiCalls, calls.matrix.length);
  assert.ok(decisions[0].mapApiCalls > 0);
});

test('受保护旧站不能被静默替换，要求的新站也不能被时间修复策略丢弃', async () => {
  const { w, plan } = await replacementWorld();
  await w.repo.update(C.TRIPS, plan.tripId, { constraints: [{ key: 'mustVisit', value: [plan.nodes[2].placeId],
    hardness: 'hard', confirmedAt: w.NOW }] });
  const d = await change(w, plan.tripId, '最后一站换成哈工大');
  const blocked = await change(w, plan.tripId, null, { draftId: d.draftId, answers: { '0.place': 'poi_hit-main' } });
  assert.equal(blocked.noFeasible, true);
  assert.ok(blocked.candidates.every(c => !c.feasible));
  assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).version, 1);
  await w.repo.update(C.TRIPS, plan.tripId, { constraints: [] });
  const tight = await change(w, plan.tripId, '最后一站换成哈工大，09:01前结束');
  const limited = await change(w, plan.tripId, null, { draftId: tight.draftId, answers: { '0.place': 'poi_hit-main' } });
  assert.equal(limited.noFeasible, true);
  assert.ok(limited.candidates.every(c => !c.feasible || c.nodes.some(n => n.placeId === 'poi_hit-main')));
});

test('换点检索过程中版本变化，不能生成绑定旧版本的选点草稿', async () => {
  let world, tripId;
  const { w, plan } = await replacementWorld({ search: async () => {
    await world.repo.updateCas(C.TRIPS, tripId, 1, { title: '已被其他操作更新' });
    return { ok: true, count: 2, items: campuses };
  } });
  world = w; tripId = plan.tripId;
  expectFail(await w.A('trip.adjustText', { tripId, text: '最后一站换成哈工大', preferModel: false },
    { expectedVersion: 1 }), 'VERSION_CONFLICT');
  assert.equal(await w.repo.count(C.CHANGE_PROPOSALS, { kind: 'natural_language_draft' }), 0);
});

test('先调整其他站再换最后一站，下一句再少停继续针对新地点，数值与最近对象一致', async () => {
  const { w, plan } = await replacementWorld();
  const first = await change(w, plan.tripId, '第一站少停十分钟');
  const draft = await change(w, plan.tripId, '最后一站换成哈工大', { previousProposalId: first.proposalId });
  const replacement = await change(w, plan.tripId, null, { draftId: draft.draftId, answers: { '0.place': 'poi_hit-main' } });
  const applied = await confirm(w, replacement);
  assert.equal(applied.nodes[0].plannedStayMin, 50);
  const next = await change(w, plan.tripId, '再少停十分钟');
  const done = await confirm(w, next);
  assert.equal(done.nodes[0].plannedStayMin, 50);
  assert.equal(done.nodes[2].plannedStayMin, 35);
});

test('新增与替换语义分开：原话、标点分句、末尾追加都不丢参照站', () => {
  for (const text of ['我去完哈尔滨学院想再去哈工大', '去完哈尔滨学院后再去哈工大',
    '哈尔滨学院之后再去哈工大', '去完哈尔滨学院，然后再去哈工大']) {
    const p = parser.ruleParse(text);
    assert.deepEqual(p.uncertainties, [], text); assert.equal(p.operations.length, 1);
    assert.equal(p.operations[0].type, 'add_node'); assert.equal(p.operations[0].target, '哈尔滨学院');
    assert.equal(p.operations[0].destination, '哈工大'); assert.equal(p.operations[0].position, 'after');
  }
  for (const text of ['再去哈工大', '新增一站哈工大', '我还想去哈工大']) {
    const p = parser.ruleParse(text); assert.deepEqual(p.uncertainties, []);
    assert.equal(p.operations[0].type, 'add_node'); assert.equal(p.operations[0].position, 'end');
  }
  assert.equal(parser.ruleParse('去完哈尔滨学院').operations.length, 0);
  assert.equal(parser.ruleParse('最后一站换成哈工大').operations[0].type, 'replace_node');
  assert.equal(parser.ruleParse('哈工大不去了').operations[0].type, 'skip_node');
  const two = parser.ruleParse('去完哈尔滨学院再去哈工大，然后再去中央大街');
  assert.equal(two.operations.length, 2); assert.equal(two.operations[0].destination, '哈工大');
  assert.equal(two.operations[1].destination, '中央大街');
});

const collegePlaces = [{ ...places[0], name: '哈尔滨学院' }, ...places.slice(1)];
async function chooseAdded(w, plan, text, extra, answer) {
  const draft = await change(w, plan.tripId, text, extra);
  assert.equal(draft.needsClarification, true); assert.equal(draft.questions[0].kind, 'place');
  return change(w, plan.tripId, null, { draftId: draft.draftId,
    answers: { [draft.questions[0].key]: answer || 'poi_hit-main' } });
}

test('新增适用于不同地点：中央大街后去太阳岛，交通查询使用选定 POI 的坐标', async () => {
  const destination = { poiId: 'sun-test', title: '太阳岛', address: '测试景区入口', category: '景区',
    location: { latitude: 45.789, longitude: 126.601 } };
  const { w, plan, calls } = await replacementWorld({ search: async () => ({ ok: true, count: 1, items: [destination] }) });
  const proposal = await chooseAdded(w, plan, '去完中央大街想再去太阳岛', null, 'poi_sun-test');
  assert.equal(calls.search[0].keyword, '太阳岛');
  const done = await confirm(w, proposal);
  assert.deepEqual(done.nodes.map(n => n.placeName), ['中央大街', '太阳岛', '圣索菲亚教堂', '防洪纪念塔']);
  assert.deepEqual(done.nodes[1].placeSnapshot.location, destination.location);
  assert.ok(calls.matrix.some(args => args[0].latitude === plan.nodes[0].location.latitude &&
    args[0].longitude === plan.nodes[0].location.longitude &&
    args[1].some(point => point.latitude === destination.location.latitude && point.longitude === destination.location.longitude)));
  assert.ok(calls.matrix.some(args => args[0].latitude === destination.location.latitude &&
    args[0].longitude === destination.location.longitude &&
    args[1].some(point => point.latitude === plan.nodes[1].location.latitude && point.longitude === plan.nodes[1].location.longitude)));
  assert.equal(await w.repo.count(C.PLACES, {}), 0);
});

test('真实页面新增哈工大：选校区后插在哈尔滨学院之后，原站保留、确认前不变、不写地点库', async () => {
  const { w, plan, calls } = await replacementWorld({ plan: { places: collegePlaces } });
  const p = pageFor(w, plan); const before = (await w.repo.get(C.TRIPS, plan.tripId)).nodes;
  try {
    p.onChangeText({ detail: { value: '我去完哈尔滨学院想再去哈工大' } }); await p.submitTextChange();
    const q = p.data.changeQuestions[0]; assert.equal(q.kind, 'place'); assert.equal(q.options.length, 2);
    assert.match(q.options[1].label, /二校区.*黄河路/);
    assert.deepEqual((await w.repo.get(C.TRIPS, plan.tripId)).nodes, before);
    p.answerChangeQuestion({ currentTarget: { dataset: { key: q.key, value: 'poi_hit-second' } } }); await p.submitTextChange();
    assert.equal(calls.search.length, 1); assert.equal(p.data.proposal.isText, true);
    assert.equal(p.data.rawNodes.length, 3); assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).version, 1);
    const candidate = p.data.proposalCandidates.find(c => c.feasible);
    await p.confirmCandidate({ currentTarget: { dataset: { cid: candidate.candidateId } } });
    assert.deepEqual(p.data.rawNodes.map(n => n.placeName), ['哈尔滨学院', campuses[1].title, '圣索菲亚教堂', '防洪纪念塔']);
    assert.deepEqual(p.data.rawNodes.filter(n => n.placeName !== campuses[1].title).map(n => n.nodeId), before.map(n => n.nodeId));
    assert.equal(new Set(p.data.rawNodes.map(n => n.nodeId)).size, 4);
    assert.deepEqual(p.data.rawNodes[1].placeSnapshot.location, campuses[1].location);
    assert.equal(await w.repo.count(C.PLACES, {}), 0);
    const decision = await w.repo.findOne(C.DECISIONS, { tripId: plan.tripId, kind: 'adjust' });
    assert.equal(decision.mapApiCalls, calls.matrix.length); assert.ok(calls.matrix.length >= 2);
    assert.ok(calls.matrix.some(args => args[0].latitude === campuses[1].location.latitude));
    assert.ok(calls.matrix.some(args => args[1][0].latitude === campuses[1].location.latitude));
  } finally { p.restore(); }
});

test('新增未确认时继续少停，确认后再少停仍针对同一新增节点，不重复新增', async () => {
  const { w, plan } = await replacementWorld();
  const added = await chooseAdded(w, plan, '新增一站哈工大');
  const id = added.candidates.find(c => c.feasible).nodes[3].nodeId;
  assert.match(id, /^n_add_/);
  const shortened = await change(w, plan.tripId, '再少停十分钟', { previousProposalId: added.proposalId });
  assert.equal(shortened.needsClarification, false);
  const done = await confirm(w, shortened);
  assert.equal(done.nodes.length, 4); assert.equal(done.nodes[3].nodeId, id); assert.equal(done.nodes[3].plannedStayMin, 35);
  const again = await change(w, plan.tripId, '再少停五分钟'); const next = await confirm(w, again);
  assert.equal(next.nodes[3].nodeId, id); assert.equal(next.nodes[3].plannedStayMin, 30);
  const snapshot = await w.repo.findOne(C.TRIP_VERSIONS, { tripId: plan.tripId, version: next.version });
  assert.equal(snapshot.snapshot.nodes[3].placeSnapshot._id, 'poi_hit-main');
});

test('同一句新增后调整停留，先选新增地点，再将后续指代解析到新节点', async () => {
  const { w, plan } = await replacementWorld();
  const draft = await change(w, plan.tripId, '新增一站哈工大，再少停十分钟');
  assert.equal(draft.questions.length, 1); assert.equal(draft.questions[0].kind, 'place');
  const proposal = await change(w, plan.tripId, null, { draftId: draft.draftId, answers: { '0.place': 'poi_hit-main' } });
  const done = await confirm(w, proposal);
  assert.equal(done.nodes.length, 4); assert.equal(done.nodes[3].plannedStayMin, 35);
  assert.equal(done.nodes[0].plannedStayMin, 60);
});

test('已完成节点可作新增参照；全程完成后仍能追加，历史进度和实际时间完整保留', async () => {
  for (const count of [1, 3]) {
    const { w, plan, calls } = await replacementWorld({ plan: { places: collegePlaces } });
    for (let i = 0; i < count; i++) expectOk(await w.A('trip.progress', {
      tripId: plan.tripId, nodeId: plan.nodes[i].nodeId, status: 'done',
    }, { expectedVersion: i + 1 }));
    const before = await w.repo.get(C.TRIPS, plan.tripId);
    const proposal = await chooseAdded(w, plan, count === 1 ? '我去完哈尔滨学院想再去哈工大' : '新增一站哈工大');
    const done = await confirm(w, proposal);
    assert.equal(done.nodes.length, 4);
    assert.deepEqual(done.nodes.slice(0, count), before.nodes.slice(0, count));
    assert.equal(done.nodes[count].placeName, campuses[0].title);
    assert.ok(calls.matrix.some(args => args[0].longitude === before.nodes[count - 1].location.longitude));
    expectFail(await w.A('trip.adjustText', { tripId: plan.tripId, text: '第一站少停十分钟', preferModel: false },
      { expectedVersion: before.version }), 'VERSION_CONFLICT');
  }
});

test('新增参照站歧义和伪造答案先追问，重复地点可确认新增独立站次', async () => {
  const { w, plan } = await replacementWorld({ plan: { places: collegePlaces.map(p => ({ ...p, name: '学院' })) } });
  const draft = await change(w, plan.tripId, '学院之后再去哈工大');
  assert.equal(draft.questions[0].kind, 'node'); assert.equal(draft.questions[0].options.length, 3);
  const bad = await change(w, plan.tripId, null, { draftId: draft.draftId, answers: { '0.node': 'invented' } });
  assert.equal(bad.questions[0].kind, 'node');
  const chosen = await change(w, plan.tripId, null, { draftId: draft.draftId,
    answers: { '0.node': plan.nodes[1].nodeId, '0.place': 'poi_invented' }, changePlaces: { poi_invented: campuses[0] } });
  assert.equal(chosen.questions[0].kind, 'place'); assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).version, 1);
  const proposal = await change(w, plan.tripId, null, { draftId: draft.draftId,
    answers: { '0.node': plan.nodes[1].nodeId, '0.place': 'poi_hit-main' } });
  await confirm(w, proposal);
  const duplicate = await change(w, plan.tripId, '新增一站哈工大');
  const repeated = await change(w, plan.tripId, null, { draftId: duplicate.draftId, answers: { '0.place': 'poi_hit-main' } });
  assert.equal(repeated.needsClarification, false);
  assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).nodes.length, 4);
  await confirm(w, repeated);
  const visits = (await w.repo.get(C.TRIPS, plan.tripId)).nodes.filter(n => n.placeId === 'poi_hit-main');
  assert.equal(visits.length, 2);
  assert.equal(new Set(visits.map(n => n.nodeId)).size, 2);
});

test('新增搜索失败整次不执行；时间不足不能删掉用户新选地点或顺序参照站冒充可行', async () => {
  const empty = await replacementWorld({ search: async () => ({ ok: false, reason: 'TIMEOUT', message: '地图请求超时' }) });
  const draft = await change(empty.w, empty.plan.tripId, '第一站少停十分钟，新增一站哈工大');
  assert.equal(draft.needsClarification, true); assert.equal(draft.questions[0].kind, 'rewrite');
  assert.equal((await empty.w.repo.get(C.TRIPS, empty.plan.tripId)).nodes[0].plannedStayMin, 60);
  const { w, plan } = await replacementWorld({ plan: { places: collegePlaces } });
  const proposal = await chooseAdded(w, plan, '我去完哈尔滨学院想再去哈工大，09:30前结束');
  assert.equal(proposal.noFeasible, true);
  assert.ok(proposal.candidates.every(c => !c.feasible));
  expectFail(await w.A('trip.confirmChange', { proposalId: proposal.proposalId, candidateId: proposal.candidates[0].candidateId },
    { expectedVersion: 1 }), 'INFEASIBLE_HARD_CONSTRAINT');
  assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).nodes.length, 3);
});

test('模型新增解析可用，遗漏新增、改成替换或捏造地点/参照站时降级', async () => {
  const text = '我去完哈尔滨学院想再去哈工大';
  const good = { type: 'add_node', target: '哈尔滨学院', destination: '哈工大', position: 'after', evidence: text };
  const run = operations => parser.parse(text, { nodes: [] }, { key: 'fake-test-only', http: async () => ({
    json: { choices: [{ message: { content: JSON.stringify({ operations, uncertainties: [] }) } }] },
  }) });
  assert.equal((await run([good])).parser, 'http');
  for (const ops of [[], [{ ...good, type: 'replace_node' }], [{ ...good, destination: '虚构地点' }],
    [{ ...good, target: '虚构参照' }], [{ ...good, target: null, position: 'end' }]]) {
    const fallback = await run(ops);
    assert.equal(fallback.degraded, true); assert.equal(fallback.parsed.operations[0].type, 'add_node');
    assert.equal(fallback.parsed.operations[0].target, '哈尔滨学院');
  }
});

test('批量新增不能复用历史节点 ID、引用不存在的参照站或缺少地点快照', async () => {
  const { w, plan } = await setup();
  for (const payload of [{ nodeId: plan.nodes[0].nodeId, newPlaceId: 'p1', insertion: 'end' },
    { nodeId: 'new-node', newPlaceId: 'p1', insertion: 'after', afterNodeId: 'missing' },
    { nodeId: 'new-node', newPlaceId: 'missing-place', insertion: 'end' }]) {
    const r = await w.A('trip.adjust', { tripId: plan.tripId, trigger: { type: 'batch', payload: {
      operations: [{ type: 'add_node', payload }],
    } }, autoApply: 'never' }, { expectedVersion: 1 });
    assert.equal(r.ok, false); assert.ok(['INVALID_PARAM', 'NOT_FOUND'].includes(r.error.code));
    assert.equal((await w.repo.get(C.TRIPS, plan.tripId)).version, 1);
  }
  expectFail(await w.A('trip.adjust', { tripId: plan.tripId, trigger: { type: 'add_node', payload: {
    nodeId: plan.nodes[0].nodeId, newPlaceId: 'p1', insertion: 'end',
  } } }), 'INVALID_PARAM');
});

test('连续两项新增逐项选点，草稿保持两个新 ID，后续修改仍针对最后新增的地点', async () => {
  const { w, plan } = await replacementWorld({ plan: { places: collegePlaces } });
  const draft = await change(w, plan.tripId, '去完哈尔滨学院再去哈工大，然后再去哈工大二校区');
  const first = await change(w, plan.tripId, null, { draftId: draft.draftId, answers: { '0.place': 'poi_hit-main' } });
  assert.equal(first.needsClarification, true); assert.equal(first.questions[0].key, '1.place');
  const second = await change(w, plan.tripId, null, { draftId: draft.draftId,
    answers: { '0.place': 'poi_hit-main', '1.place': 'poi_hit-second' } });
  assert.equal(second.needsClarification, false);
  const next = await change(w, plan.tripId, '再少停十分钟', { previousProposalId: second.proposalId });
  const done = await confirm(w, next);
  assert.equal(done.nodes.length, 5); assert.equal(new Set(done.nodes.map(n => n.nodeId)).size, 5);
  assert.equal(done.nodes[1].placeName, campuses[0].title);
  assert.equal(done.nodes[4].placeName, campuses[1].title); assert.equal(done.nodes[4].plannedStayMin, 35);
});

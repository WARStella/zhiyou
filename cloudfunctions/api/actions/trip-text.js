'use strict';

const C = require('../lib/repo/collections');
const { assert, CODES, require_fields } = require('../lib/errors');
const { requireCrewOwner, canBeTripNode } = require('../lib/authz');
const time = require('../lib/time');
const resp = require('../lib/resp');
const { parse } = require('../lib/ai/trip-change');
const { buildContext, resolve, activeNodes } = require('../lib/trip-change');
const { logEvent } = require('../lib/trace');
const { randomUUID } = require('crypto');

async function searchDestinations(ctx, parsed) {
  const choices = {};
  for (let i = 0; i < parsed.operations.length; i++) {
    const op = parsed.operations[i];
    if (!['replace_node', 'add_node'].includes(op.type)) continue;
    // 与行程初次选点共用全城 POI 检索；候选只存草稿，不写地点库。
    let response;
    try {
      response = await require('./place').search(Object.assign({}, ctx, {
        payload: { keyword: op.destination, scope: 'city', limit: 8 },
      }));
    } catch (_) {
      choices[i] = { places: [], message: `“${op.destination}”检索暂时无法连接地图服务，请稍后重新提交。` };
      continue;
    }
    const data = response.data || {};
    choices[i] = {
      places: (data.candidates || []).filter(canBeTripNode).map(p => ({
        _id: p.itemId, name: p.name, address: p.address || null, location: p.location,
        category: p.category || null, visitDurationMin: p.visitDurationMin,
        verifiedAt: null, confidence: 'low', dataSource: p.dataSource || 'tencent-poi',
        walkableTo: [], __persisted: false,
      })).filter(p => p._id),
      message: data.ok === false
        ? `“${op.destination}”检索失败：${data.message || data.reason || '地图服务暂不可用'}。${data.hint || '请稍后重新提交。'}`
        : `没有搜到可用的“${op.destination}”，请补充具体地点或校区后重新提交。`,
    };
  }
  return choices;
}

async function authorizeChange(ctx) {
  const { repo, openid, payload: p } = ctx;
  require_fields(p, ['tripId']);
  const trip = await repo.get(C.TRIPS, p.tripId);
  assert(trip, CODES.NOT_FOUND, '行程不存在');
  if (trip.mode === 'team') await requireCrewOwner(repo, trip.crewId, openid);
  else assert(trip.ownerUserId === openid, CODES.FORBIDDEN_NOT_MEMBER, '无权修改该行程');
  assert(ctx.expectedVersion != null, CODES.INVALID_PARAM, '自然语言修改需要 expectedVersion');
  assert(trip.version === ctx.expectedVersion, CODES.VERSION_CONFLICT, '行程已更新，请刷新后重新提交修改');
  return trip;
}

async function adjustText(ctx) {
  const { repo, openid, payload: p } = ctx;
  const trip = await authorizeChange(ctx);
  const now = new Date(time.nowMs(ctx));
  let draft;
  if (p.draftId) {
    draft = await repo.get(C.CHANGE_PROPOSALS, p.draftId);
    assert(draft && draft.kind === 'natural_language_draft' && draft.tripId === trip._id && draft.createdByUserId === openid,
      CODES.NOT_FOUND, '待确认需求不存在');
    assert(draft.status === 'clarifying' && new Date(draft.expiresAt) > now, CODES.INVALID_PARAM, '这次追问已失效，请重新输入');
    assert(draft.baseVersion === trip.version, CODES.VERSION_CONFLICT, '行程已更新，请重新输入修改');
  } else {
    assert(typeof p.text === 'string' && p.text.trim().length > 0 && p.text.length <= 1000,
      CODES.INVALID_PARAM, '请输入修改要求（最多 1000 字）');
    let prior = null;
    if (p.previousProposalId) {
      prior = await repo.get(C.CHANGE_PROPOSALS, p.previousProposalId);
      assert(prior && prior.tripId === trip._id && prior.createdByUserId === openid && prior.naturalLanguage,
        CODES.NOT_FOUND, '上次修改方案不存在');
      assert(prior.status === 'proposed' && new Date(prior.expiresAt) > now, CODES.INVALID_PARAM, '上次修改方案已失效，请重新输入');
      assert(prior.baseVersion === trip.version, CODES.VERSION_CONFLICT, '上次修改基于旧版本，请重新输入');
    }
    const previousOps = prior ? prior.trigger.payload.operations : [];
    const changePlaces = prior && prior.changePlaces || {};
    const context = buildContext(trip, previousOps, changePlaces);
    const ai = await parse(p.text.trim(), context, { preferModel: !(ctx.env === 'dev' && p.preferModel === false) });
    // 新节点身份只由服务器生成，草稿追问及后续连续修改沿用同一 ID。
    ai.parsed.operations = ai.parsed.operations.map(op => op.type === 'add_node'
      ? Object.assign({}, op, { newNodeId: 'n_add_' + randomUUID() }) : op);
    const destinationChoices = ai.parsed.uncertainties.length ? {} : await searchDestinations(ctx, ai.parsed);
    draft = { kind: 'natural_language_draft', tripId: trip._id, baseVersion: trip.version,
      status: 'clarifying', rawText: p.text, parsed: ai.parsed,
      parser: ai.parser, promptVersion: ai.promptVersion, model: ai.model, degraded: ai.degraded, attempts: ai.attempts,
      previousOps, changePlaces, destinationChoices, previousProposalId: p.previousProposalId || null,
      turns: (prior ? prior.naturalLanguage.turns : []).concat([p.text]).slice(-10),
      createdByUserId: openid, createdAt: now, expiresAt: new Date(now.getTime() + 30 * time.MIN) };
  }
  assert(activeNodes(trip).length || draft.previousOps.concat(draft.parsed.operations).some(o => o.type === 'add_node'),
    CODES.INVALID_PARAM, '行程已全部完成，可新增地点继续行程；历史站点不能修改');
  const context = buildContext(trip, draft.previousOps, draft.changePlaces);
  const result = resolve(draft.parsed, context, p.answers, now, openid, draft.destinationChoices);
  assert(draft.previousOps.length + result.operations.length <= 10, CODES.INVALID_PARAM, '一次最多合并十项修改，请先确认或放弃已有方案');
  await authorizeChange(ctx); // 理解请求耗时期间，成员身份或行程版本都可能变化。
  const info = { rawText: draft.rawText, turns: draft.turns, summary: result.summary,
    parser: draft.parser, promptVersion: draft.promptVersion, model: draft.model, degraded: draft.degraded, attempts: draft.attempts };
  if (result.questions.length) {
    if (!draft._id) draft = await repo.insert(C.CHANGE_PROPOSALS, draft);
    return resp.ok({ needsClarification: true, draftId: draft._id, baseVersion: trip.version,
      questions: result.questions, interpretation: info, applied: false });
  }
  const operations = draft.previousOps.concat(result.operations);
  const changePlaces = Object.assign({}, draft.changePlaces);
  for (const op of result.operations.filter(o => ['replace_node', 'add_node'].includes(o.type))) {
    const selected = Object.values(draft.destinationChoices || {}).reduce((all, s) => all.concat(s.places), [])
      .find(p => p._id === op.payload.newPlaceId);
    if (selected) changePlaces[selected._id] = selected;
  }
  const response = await require('./trip').adjust(Object.assign({}, ctx, { changeInterpretation: info, changePlaces, payload: {
    tripId: trip._id, trigger: { type: 'batch', payload: { operations } }, autoApply: 'never',
  } }));
  if (draft._id) await repo.update(C.CHANGE_PROPOSALS, draft._id, { status: 'resolved' });
  if (draft.previousProposalId) await repo.updateIf(C.CHANGE_PROPOSALS, draft.previousProposalId,
    { status: 'proposed' }, { status: 'superseded' });
  await logEvent(repo, { ts: now, action: 'trip.adjustText', type: 'state_change', userId: openid, tripId: trip._id,
    detail: { proposalId: response.data.proposalId, parser: info.parser, promptVersion: info.promptVersion,
      degraded: info.degraded, operationCount: operations.length } });
  response.data.interpretation = info;
  response.data.needsClarification = false;
  return response;
}

module.exports = { adjustText, authorizeChange };

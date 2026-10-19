'use strict';

const { randomUUID } = require('crypto');
const C = require('../lib/repo/collections');
const { assert, CODES } = require('../lib/errors');
const resp = require('../lib/resp');
const { requireCrewMember } = require('../lib/authz');
const { coord } = require('../lib/geo');
const { decodeImage } = require('../lib/ocr/image');
const { createGuideProvider } = require('../lib/guide/provider');
const { runAgent } = require('../lib/guide/agent');
const { validateContextReads, selectTrip } = require('../lib/guide/context-tools');
const SESSION_MS = 30 * 60 * 1000;

const publicView = session => ({ ...session.lastResponse, sessionId: session._id, version: session.version,
  expiresAt: session.expiresAt, messages: session.messages, place: session.place, candidates: session.candidates });

async function loadOwned(ctx, allowExpired) {
  const id = ctx.payload.sessionId;
  assert(typeof id === 'string' && id.length > 0 && id.length <= 100, CODES.INVALID_PARAM, '会话编号无效');
  const session = await ctx.repo.get(C.GUIDE_SESSIONS, id);
  assert(session && session.ownerId === ctx.openid, CODES.NOT_FOUND, '游览会话不存在');
  assert(allowExpired || new Date(session.expiresAt).getTime() > new Date(ctx.now || Date.now()).getTime(), CODES.NOT_FOUND, '游览会话已过期，请重新开始');
  return session;
}
async function authorize(ctx, crewId) {
  return crewId ? requireCrewMember(ctx.repo, crewId, ctx.openid) : null;
}
async function get(ctx) {
  const session = await loadOwned(ctx);
  assert((ctx.payload.crewId || null) === session.crewId, CODES.FORBIDDEN_NOT_MEMBER, '队伍已变化，请重新开始会话');
  await authorize(ctx, session.crewId);
  return resp.ok(publicView(session));
}
async function close(ctx) {
  const session = await loadOwned(ctx, true);
  // 允许已离队的本人清除自己的私有会话，不返回旧对话。
  await ctx.repo.remove(C.GUIDE_SESSIONS, session._id);
  return resp.ok({ closed: true });
}
async function navigation(ctx) {
  const p = ctx.payload, crewId = p.crewId || null;
  assert(p.crewId === undefined || p.crewId === null || (typeof p.crewId === 'string' && p.crewId.length <= 100), CODES.INVALID_PARAM, '队伍编号无效');
  assert(['next', 'meeting', 'place'].includes(p.target), CODES.INVALID_PARAM, '请选择导航目的地');
  assert(p.scope === undefined || ['trip', 'team'].includes(p.scope), CODES.INVALID_PARAM, '行程上下文无效');
  assert(!p.tripId || (typeof p.tripId === 'string' && p.tripId.length <= 100), CODES.INVALID_PARAM, '行程编号无效');
  await authorize(ctx, crewId);
  let point, name, address = '';
  if (p.target === 'next') {
    const trip = await selectTrip(ctx, { crewId }, p, {});
    assert(trip && trip.status === 'active', CODES.NOT_FOUND, '没有可导航的当前行程');
    const node = (trip.nodes || []).slice().sort((a, b) => a.seq - b.seq).find(n => n.status === 'pending');
    assert(node, CODES.NOT_FOUND, '没有待前往的下一站');
    point = coord(node.location); name = node.placeName;
  } else if (p.target === 'meeting') {
    assert(crewId, CODES.INVALID_PARAM, '请先加入队伍');
    const tasks = await ctx.repo.find(C.MEET_TASKS, { crewId }, { sort: { createdAt: -1 }, limit: 1 });
    const task = tasks[0];
    assert(task && !['cancelled', 'departed', 'completed'].includes(task.status), CODES.NOT_FOUND, '没有进行中的集合');
    point = coord(task.point); name = task.placeName;
  } else {
    const session = await loadOwned(ctx);
    assert(session.crewId === crewId, CODES.FORBIDDEN_NOT_MEMBER, '队伍已变化，请重新确认地点');
    assert(session.place, CODES.INVALID_PARAM, '请先确认一个地点');
    point = coord(session.place.point); name = session.place.name; address = session.place.address || '';
  }
  assert(point, CODES.INVALID_PARAM, '目的地没有有效坐标，请重新确认地点');
  await authorize(ctx, crewId);
  return resp.ok({ point, name, address, target: p.target, serverTime: new Date(ctx.now || Date.now()).toISOString() });
}
async function countPeople(ctx) {
  const image = decodeImage(ctx.payload.imageBase64);
  const now = new Date(ctx.now || Date.now());
  const recent = await ctx.repo.find(C.EVENTS, { action: 'guide.countPeople', userId: ctx.openid, type: 'api_call' }, { sort: { ts: -1 }, limit: 6 });
  assert(recent.filter(row => new Date(row.ts).getTime() >= now.getTime() - 60000).length < 6,
    CODES.RATE_LIMITED, '计数请求过于频繁，请一分钟后再试');
  const provider = (ctx.createGuideProvider || createGuideProvider)();
  assert(typeof provider.countPeople === 'function', CODES.NOT_IMPLEMENTED, 'YOLO 人群计数服务尚未配置');
  return resp.ok(await provider.countPeople(image.bytes.toString('base64')));
}

async function ask(ctx) {
  const p = ctx.payload, now = new Date(ctx.now || Date.now());
  assert(p.tripId === undefined || p.tripId === null || (typeof p.tripId === 'string' && p.tripId.length > 0 && p.tripId.length <= 100), CODES.INVALID_PARAM, '行程编号无效');
  assert(p.scope === undefined || ['trip', 'team'].includes(p.scope), CODES.INVALID_PARAM, '行程上下文无效');
  assert(p.crewId === undefined || p.crewId === null || (typeof p.crewId === 'string' && p.crewId.length <= 100), CODES.INVALID_PARAM, '队伍编号无效');
  assert(p.text === undefined || typeof p.text === 'string', CODES.INVALID_PARAM, '提问格式无效');
  const text = String(p.text || '').trim();
  assert(text.length <= 1000, CODES.INVALID_PARAM, '问题最多 1000 字');
  const image = p.imageBase64 === undefined ? null : decodeImage(p.imageBase64);
  assert(text || image || p.candidateId, CODES.INVALID_PARAM, '请输入问题或选择照片');
  const crewId = p.crewId || null;
  const member = await authorize(ctx, crewId);
  const recent = await ctx.repo.find(C.EVENTS, { action: 'guide.ask', userId: ctx.openid, type: 'api_call' }, { sort: { ts: -1 }, limit: 6 });
  assert(recent.filter(row => new Date(row.ts).getTime() >= now.getTime() - 60000).length < 6,
    CODES.RATE_LIMITED, '助手请求过于频繁，请一分钟后再试');
  let session;
  if (p.sessionId) {
    session = await loadOwned(ctx);
    assert(session.crewId === crewId, CODES.FORBIDDEN_NOT_MEMBER, '队伍已变化，请重新开始会话');
    assert(Number.isSafeInteger(ctx.expectedVersion) && ctx.expectedVersion === session.version, CODES.VERSION_CONFLICT, '游览会话已更新，请刷新后再提问');
  } else {
    assert(!p.candidateId, CODES.INVALID_PARAM, '请先搜索地点，再确认候选');
    session = await ctx.repo.insert(C.GUIDE_SESSIONS, { _id: randomUUID(), ownerId: ctx.openid,
      crewId, version: 0, place: null, candidates: [], clues: [], pendingQuestion: '', messages: [], lastResponse: null,
      expiresAt: new Date(now.getTime() + SESSION_MS) });
  }
  const state = JSON.parse(JSON.stringify(session));
  let question = text || '这张照片是哪里？请介绍这个地方。';
  if (p.candidateId) {
    assert(!image && !text && typeof p.candidateId === 'string', CODES.INVALID_PARAM, '确认地点时请使用当前候选');
    const candidate = state.candidates.find(row => row.id === p.candidateId);
    assert(candidate, CODES.INVALID_PARAM, '候选已失效，请重新搜索并选择');
    state.place = { name: candidate.name, address: candidate.address, point: candidate.point };
    state.candidates = [];
    question = state.pendingQuestion || '请介绍这个地方';
    state.pendingQuestion = '';
  } else if (state.candidates.length) {
    // 新提问开始新一次检索，旧候选不再可确认。
    state.candidates = [];
  }
  const { contextReads, ...result } = await runAgent(ctx, state, { text: question, image, center: coord(p.center), tripId: p.tripId || null, scope: p.scope || 'trip' },
    (ctx.createGuideProvider || createGuideProvider)());
  await authorize(ctx, crewId);
  const messages = state.messages.concat([{ role: 'user', text: question, hasImage: Boolean(image), at: now.toISOString() },
    { role: 'assistant', text: result.answer, at: now.toISOString() }]).slice(-8);
  const saved = await ctx.repo.runTransaction(async tx => {
    const current = await tx.get(C.GUIDE_SESSIONS, session._id);
    assert(current && current.ownerId === ctx.openid && current.version === session.version, CODES.VERSION_CONFLICT, '会话已更新或清除，请刷新后再试');
    if (crewId) {
      const crew = await tx.get(C.CREWS, crewId), currentMember = await tx.get(C.CREW_MEMBERS, member._id);
      assert(crew && crew.status === 'active' && currentMember && currentMember.status === 'active', CODES.FORBIDDEN_NOT_MEMBER, '你已退出队伍，或队伍已解散');
    }
    await validateContextReads(tx, contextReads, ctx.openid);
    const patch = { version: current.version + 1, place: state.place, candidates: state.candidates,
      clues: state.clues || [], pendingQuestion: state.pendingQuestion, messages, lastResponse: result,
      expiresAt: new Date(now.getTime() + SESSION_MS) };
    await tx.update(C.GUIDE_SESSIONS, session._id, patch);
    return { ...current, ...patch };
  }, [C.GUIDE_SESSIONS, C.CREWS, C.CREW_MEMBERS, C.TRIPS, C.MEET_TASKS]);
  return resp.ok(publicView(saved), { mapApiCalls: result.mapApiCalls });
}

module.exports = { ask, get, close, navigation, countPeople, SESSION_MS };

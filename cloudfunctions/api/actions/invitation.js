'use strict';
const { randomBytes } = require('crypto');
const C = require('../lib/repo/collections');
const resp = require('../lib/resp');
const { assert, CODES } = require('../lib/errors');
const { requireCrewMember, getMembership } = require('../lib/authz');
const { mutateCrew, requireMember } = require('../lib/crew-mutation');
const { createInviteProvider } = require('../lib/invitation');
const { joinCrew } = require('./crew');
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const now = ctx => new Date(ctx.now || Date.now());
const validToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{24}$/.test(token);
const live = (crew, ctx) => crew && crew.status === 'active' && crew.invitationStatus === 'active' &&
  validToken(crew.invitationToken) && new Date(crew.invitationExpiresAt).getTime() > now(ctx).getTime();
function assertToken(token) { assert(validToken(token), CODES.INVALID_PARAM, '邀请格式无效，请重新打开同伴发来的邀请'); }
function assertCrewId(crewId) { assert(typeof crewId === 'string' && crewId.length > 0 && crewId.length <= 100, CODES.INVALID_PARAM, '队伍参数无效'); }
function view(crew, ctx) {
  if (!live(crew, ctx)) return null;
  return { token: crew.invitationToken, expiresAt: new Date(crew.invitationExpiresAt).toISOString(),
    createdAt: new Date(crew.invitationCreatedAt).toISOString(),
    path: '/pages/invite/index?token=' + crew.invitationToken, scene: 'i' + crew.invitationToken };
}
async function get(ctx) {
  const { crewId } = ctx.payload;
  assertCrewId(crewId);
  const member = await requireCrewMember(ctx.repo, crewId, ctx.openid);
  const crew = await ctx.repo.get(C.CREWS, crewId);
  return resp.ok({ crewId, name: crew.name, canManage: member.role === 'owner', invitation: view(crew, ctx), serverTime: now(ctx).toISOString() });
}
async function create(ctx) {
  const { crewId, refresh, previousToken } = ctx.payload;
  assertCrewId(crewId);
  assert(refresh === undefined || typeof refresh === 'boolean', CODES.INVALID_PARAM, '邀请更新参数无效');
  if (refresh) assertToken(previousToken);
  const token = randomBytes(18).toString('base64url');
  const result = await mutateCrew(ctx, crewId, [ctx.openid], async ({ crew, members }) => {
    requireMember(members, ctx.openid, true);
    if (refresh) assert(crew.invitationToken === previousToken, CODES.VERSION_CONFLICT, '邀请已更新，请刷新后再操作');
    if (!refresh && live(crew, ctx)) return { result: { crewId, invitation: view(crew, ctx) } };
    const patch = { invitationToken: token, invitationStatus: 'active', invitationCreatedBy: ctx.openid,
      invitationCreatedAt: now(ctx), invitationExpiresAt: new Date(now(ctx).getTime() + TTL_MS) };
    return { crewPatch: patch, result: { crewId, invitation: view({ ...crew, ...patch }, ctx) } };
  });
  return resp.ok(result);
}
async function revoke(ctx) {
  const { crewId, token } = ctx.payload; assertToken(token); assertCrewId(crewId);
  const result = await mutateCrew(ctx, crewId, [ctx.openid], async ({ crew, members }) => {
    requireMember(members, ctx.openid, true);
    assert(crew.invitationToken === token, CODES.VERSION_CONFLICT, '邀请已更新，请刷新后再操作');
    return { crewPatch: { invitationStatus: 'revoked', invitationExpiresAt: now(ctx) }, result: { revoked: true } };
  });
  return resp.ok(result);
}
async function load(ctx) {
  const { token } = ctx.payload; assertToken(token);
  const crew = await ctx.repo.findOne(C.CREWS, { invitationToken: token });
  assert(live(crew, ctx), CODES.NOT_FOUND, '邀请已过期、撤销或小队已解散，请向同伴索取新邀请');
  const creator = await getMembership(ctx.repo, crew._id, crew.invitationCreatedBy);
  assert(creator && creator.role === 'owner', CODES.NOT_FOUND, '邀请已失效，请向小队发起人索取新邀请');
  return crew;
}
async function preview(ctx) {
  const crew = await load(ctx), member = await getMembership(ctx.repo, crew._id, ctx.openid);
  return resp.ok({ crewId: crew._id, name: crew.name, memberCount: crew.memberCount || 0,
    expiresAt: new Date(crew.invitationExpiresAt).toISOString(), alreadyMember: Boolean(member), serverTime: now(ctx).toISOString() });
}
async function join(ctx) {
  const before = await load(ctx);
  const result = await joinCrew(ctx, before._id, async ({ crew, members }) => {
    assert(live(crew, ctx) && crew.invitationToken === ctx.payload.token, CODES.NOT_FOUND, '邀请已失效，请重新打开新邀请');
    const creator = members.get(crew.invitationCreatedBy);
    assert(creator && creator.status === 'active' && creator.role === 'owner', CODES.NOT_FOUND, '邀请已失效，请索取新邀请');
  }, [before.invitationCreatedBy]);
  return resp.ok(result);
}
async function qr(ctx) {
  assertCrewId(ctx.payload.crewId);
  const before = await load(ctx);
  assert(before._id === ctx.payload.crewId, CODES.INVALID_PARAM, '邀请与当前队伍不匹配');
  await requireCrewMember(ctx.repo, before._id, ctx.openid);
  const recent = await ctx.repo.find(C.EVENTS, { action: 'crew.inviteQr', userId: ctx.openid, type: 'api_call' }, { sort: { ts: -1 }, limit: 6 });
  assert(recent.filter(e => new Date(e.ts).getTime() >= now(ctx).getTime() - 60000).length < 6, CODES.RATE_LIMITED, '小程序码生成频繁，请稍后重试');
  const data = await (ctx.createInviteProvider || createInviteProvider)().generate('i' + ctx.payload.token, ctx.env);
  const after = await load(ctx);
  assert(after._id === before._id, CODES.NOT_FOUND, '邀请已更新，请重试');
  await requireCrewMember(ctx.repo, before._id, ctx.openid);
  return resp.ok({ ...data, expiresAt: new Date(after.invitationExpiresAt).toISOString() });
}
module.exports = { get, create, revoke, preview, join, qr, TTL_MS };

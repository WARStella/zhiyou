'use strict';

/**
 * 订阅消息的接口层：记录/撤销/查询**本人**的提醒意向。
 *
 * 刻意只做这三件事，**不提供"给别人发通知"的接口**：
 * 收件人永远由 `lib/subscribe/service.js` 从当前有效成员里算，
 * 客户端拿不到、也指定不了收件人。这样"越权推送"在接口层就不存在。
 *
 * 另一个边界：这里只记"用户点过同意/拒绝"，**不假定微信允许发送**。
 * 真实结果一律看微信返回，见 `lib/subscribe/provider.js`。
 */

const { requireCrewMember } = require('../lib/authz');
const { CODES, assert } = require('../lib/errors');
const resp = require('../lib/resp');
const { NOTICE_KINDS } = require('../lib/subscribe/templates');
const { recordIntent, revokeIntent, listIntents } = require('../lib/subscribe/service');

const KINDS = Object.values(NOTICE_KINDS);
const SOURCES = ['team-page', 'profile', 'notice-tap'];

function assertKind(kind) {
  assert(typeof kind === 'string' && KINDS.includes(kind), CODES.INVALID_PARAM,
    '提醒类型无效', { allowed: KINDS });
}

/**
 * 上报一次订阅结果。
 *
 * 客户端在 `wx.requestSubscribeMessage` 回调里，把**每个模板各自的**结果
 * 一条条上报（微信允许一次请求多个模板，结果也逐个返回）。
 * 不能只传一个布尔：用户可能同意集合提醒、拒绝消息提醒。
 */
async function report(ctx) {
  const { repo, openid, payload: p } = ctx;
  await requireCrewMember(repo, p.crewId, openid);
  assert(Array.isArray(p.results) && p.results.length > 0, CODES.INVALID_PARAM,
    '缺少订阅结果');
  assert(p.results.length <= 3, CODES.INVALID_PARAM, '一次最多上报三类提醒');
  const source = p.source === undefined ? 'team-page' : p.source;
  assert(SOURCES.includes(source), CODES.INVALID_PARAM, '来源无效');

  const saved = [];
  for (const row of p.results) {
    assert(row && typeof row === 'object', CODES.INVALID_PARAM, '订阅结果格式无效');
    assertKind(row.kind);
    /**
     * 只有明确的 `'accept'` 记为同意；`'reject' | 'ban' | 'filter'` 以及
     * 任何未知字符串都记为"未同意"。**不把"没拿到值"当成同意** ——
     * 订阅失败却记成已订阅，会让人以为能收到通知，而实际一条都收不到。
     */
    const accepted = row.status === 'accept';
    saved.push(await recordIntent(ctx, { crewId: p.crewId, kind: row.kind, accepted, source }));
  }
  return resp.ok({ results: saved, intents: await listIntents(ctx, { crewId: p.crewId }) });
}

/** 本人关闭某类提醒（或全部）。 */
async function revoke(ctx) {
  const { repo, openid, payload: p } = ctx;
  await requireCrewMember(repo, p.crewId, openid);
  const kinds = p.kind === undefined ? KINDS : [p.kind];
  for (const kind of kinds) assertKind(kind);
  const results = [];
  for (const kind of kinds) results.push(await revokeIntent(ctx, { crewId: p.crewId, kind }));
  return resp.ok({ results });
}

/** 查询本人在当前队伍的提醒状态，供队伍页显示。 */
async function status(ctx) {
  const { repo, openid, payload: p } = ctx;
  await requireCrewMember(repo, p.crewId, openid);
  const intents = await listIntents(ctx, { crewId: p.crewId });
  return resp.ok({
    intents,
    /**
     * `canSend` 的语义要说清：它只表示"服务端记着用户同意过"，
     * **不代表微信此刻一定允许发送**（次数可能已用尽）。
     */
    note: '已同意 ≠ 一定送达；微信一次性订阅按次数消耗，实际以微信返回为准',
  });
}

module.exports = { report, revoke, status };

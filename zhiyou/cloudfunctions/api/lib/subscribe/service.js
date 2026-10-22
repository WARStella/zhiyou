'use strict';

/**
 * 订阅消息的**业务层** —— 谁该收到、能不能发、发完怎么记。
 *
 * 这一层刻意的分工：
 *   · `templates.js` 只管"字段长什么样"（纯映射）；
 *   · `provider.js` 只管"这一次调用微信成没成"（transport）；
 *   · 本文件管**业务判断**：收件人范围、授权是否还有效、同一件事只发一次。
 *
 * ── 三条不能违反的边界 ──────────────────────────────────
 *
 * ① **收件人只能来自当前有效成员。** 离队、被移除、队伍解散，
 *    一律不再推送；删除订阅意向记录不等于撤回用户已看过的消息。
 * ② **本人不发给自己。** 自己发的消息/自己创建的集合不提醒自己。
 * ③ **一次事件最多发一次。** 去重键先抢占再发送；抢不到说明已经有人
 *    处理过（并发或重试），直接跳过 —— 聊天自己的重试不能变成重复通知。
 *
 * ── "未知结果"怎么处理 ─────────────────────────────────
 *
 * 云调用抛异常时**无法判断消息到底发出去没有**。此时：
 * 不自动重试（否则同一句话可能收到两条），记录 `delivered: 'unknown'`，
 * 并把结果留在 `notice_log` 里等人看。这是交接文档第 3 节第 6 条的要求。
 */

const C = require('../repo/collections');
const { NOTICE_KINDS, TEMPLATES, buildData, landingPage } = require('./templates');

/** 同一类事件的最短合并窗口：一次授权只花一次，别让几句话各花一次。 */
const MERGE_WINDOW_MS = 60 * 1000;
/** 一个人在一支队伍里对同一模板最多保留多久的"仍可发送"判断。 */
const INTENT_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * 记录一次"用户主动订阅"。
 *
 * ⚠️ 客户端回传的 accept **不能**当作"微信允许无限发送"的凭证：
 * 一次 accept 只是一次额度（部分模板可能一次给多条，但次数由微信掌握）。
 * 所以这里只增量累加"用户表达过同意"，真实能否发送始终以微信返回为准。
 *
 * 也不无条件覆盖已有状态：重复点击订阅是累加可信度，不是重置。
 */
async function recordIntent(ctx, { crewId, kind, accepted, source }) {
  const repo = ctx.repo;
  const now = new Date(ctx.now || Date.now());
  const template = TEMPLATES[kind];
  if (!template) return { ok: false, reason: 'UNKNOWN_KIND' };

  const id = `${crewId}_${ctx.openid}_${kind}`;
  const existing = await repo.get(C.SUBSCRIBE_INTENTS, id);
  const base = existing || {
    _id: id, crewId, userId: ctx.openid, kind, templateId: template.templateId,
    acceptedCount: 0, rejectedCount: 0, firstAcceptedAt: null, lastAcceptedAt: null,
    source: null, revokedAt: null,
  };
  /**
   * `accepted === false` 表示"用户这次拒绝/系统判定不可达"。
   * 拒绝也要记：否则用户点了拒绝、我们却以为从没问过，下次还会再弹。
   */
  const patch = accepted
    ? {
      acceptedCount: (base.acceptedCount || 0) + 1,
      firstAcceptedAt: base.firstAcceptedAt || now,
      lastAcceptedAt: now,
      revokedAt: null,
      source: source || base.source || 'team-page',
    }
    : {
      rejectedCount: (base.rejectedCount || 0) + 1,
      lastRejectedAt: now,
      source: source || base.source || 'team-page',
    };
  const doc = Object.assign({}, base, patch, { templateId: template.templateId,
    updatedAt: now, expiresAt: new Date(now.getTime() + INTENT_TTL_MS) });
  if (existing) await repo.update(C.SUBSCRIBE_INTENTS, id, doc);
  else await repo.insert(C.SUBSCRIBE_INTENTS, doc);
  return { ok: true, kind, accepted: Boolean(accepted),
    acceptedCount: doc.acceptedCount, rejectedCount: doc.rejectedCount };
}

/** 用户主动关掉提醒：把意向标记为 revoked，但不删除历史计数（可查证）。 */
async function revokeIntent(ctx, { crewId, kind }) {
  const id = `${crewId}_${ctx.openid}_${kind}`;
  const existing = await ctx.repo.get(C.SUBSCRIBE_INTENTS, id);
  if (!existing) return { ok: true, revoked: false, reason: 'NO_INTENT' };
  await ctx.repo.update(C.SUBSCRIBE_INTENTS, id, {
    revokedAt: new Date(ctx.now || Date.now()), updatedAt: new Date(ctx.now || Date.now()),
  });
  return { ok: true, revoked: true, kind };
}

/**
 * 读本人在这支队伍里的订阅状态（给队伍页显示"是否已开启提醒"）。
 *
 * 同时返回 `templateId`：**客户端要靠它调 `wx.requestSubscribeMessage`**。
 * 模板 ID 不是密钥（它本来就会出现在客户端调用里），放这里比在前后端
 * 各写一份常量更安全 —— 两处常量一旦漂移，订阅会静默失效。
 */
async function listIntents(ctx, { crewId }) {
  const rows = await ctx.repo.find(C.SUBSCRIBE_INTENTS, { crewId, userId: ctx.openid }, { limit: 10 });
  const map = new Map(rows.map((row) => [row.kind, row]));
  return Object.values(NOTICE_KINDS).map((kind) => {
    const row = map.get(kind);
    const template = TEMPLATES[kind];
    return {
      kind,
      label: template ? template.label : kind,
      templateId: template ? template.templateId : null,
      subscribed: Boolean(row && (row.acceptedCount || 0) > 0 && !row.revokedAt),
      acceptedCount: row ? row.acceptedCount || 0 : 0,
      lastAcceptedAt: row && row.lastAcceptedAt ? row.lastAcceptedAt : null,
    };
  });
}

/**
 * 抢占去重键。
 *
 * 用"先查、再写、写失败即认输"而不是"查了就当抢到"：并发下
 * 两个请求可能都查到"没有"，此时**唯一索引**才是裁决者（`notice_log.dedupeKey`）。
 * 写被拒就说明别人抢到了，本条直接放弃 —— 这是"同一句话不发两条通知"的落地方式。
 */
async function claimEvent(ctx, { dedupeKey, crewId, kind, payload }) {
  const now = new Date(ctx.now || Date.now());
  const existing = await ctx.repo.get(C.NOTICE_LOG, dedupeKey);
  if (existing) return { claimed: false, existing };
  try {
    await ctx.repo.insert(C.NOTICE_LOG, {
      _id: dedupeKey, dedupeKey, crewId, kind, status: 'claimed', claimedAt: now,
      recipients: [], attempts: [], updatedAt: now,
    });
    return { claimed: true, existing: null };
  } catch (e) {
    // 唯一键冲突（云上 -502001 / 内存 isDuplicateKey）→ 别人已经抢到
    const again = await ctx.repo.get(C.NOTICE_LOG, dedupeKey);
    if (again) return { claimed: false, existing: again };
    throw e;
  }
}

/**
 * 取当前**有效收件人**：`status === 'active'` 且不是本人，且队伍仍在。
 *
 * 这里是唯一决定"谁可以收到"的地方。动作层不要各自再算一遍 ——
 * 一旦有两处判断，漏判的那一处就会成为越权推送的入口。
 */
async function resolveRecipients(ctx, { crewId, excludeUserId }) {
  const crew = await ctx.repo.get(C.CREWS, crewId);
  if (!crew || crew.status !== 'active') return { ok: false, reason: 'CREW_NOT_ACTIVE', recipients: [] };
  const members = await ctx.repo.find(C.CREW_MEMBERS, { crewId, status: 'active' }, { limit: 50 });
  const recipients = members
    .filter((m) => m.userId && m.userId !== excludeUserId)
    .map((m) => m.userId);
  return { ok: true, reason: null, recipients };
}

/** 某人对某类通知现在还能不能发。真实额度仍以微信返回为准。 */
async function intentAllows(repo, { crewId, userId, kind }) {
  const row = await repo.get(C.SUBSCRIBE_INTENTS, `${crewId}_${userId}_${kind}`);
  if (!row) return { allowed: false, reason: 'NO_INTENT' };
  if (row.revokedAt) return { allowed: false, reason: 'REVOKED' };
  if ((row.acceptedCount || 0) <= 0) return { allowed: false, reason: 'NEVER_ACCEPTED' };
  return { allowed: true, reason: null, intent: row };
}

/**
 * 只提醒**还没看到**的人。
 *
 * 为什么必须有这一条：一次订阅授权就是一个次数。给一个已经看完消息的人
 * 再推一条，等于把额度花在一个不需要它的人身上，等真正离线的队友需要提醒时
 * 已经没有次数了。所以 `chatLastReadSeq` 已经覆盖到最新消息的成员直接跳过。
 *
 * 判断依据只有服务端的已读游标 —— **不能用"刚拉取过"推断**（拉取 ≠ 已读）。
 */
async function readGuardAllows(repo, { crewId, userId, kind, latestSeq }) {
  if (kind !== NOTICE_KINDS.CREW_MESSAGE) return { allowed: true, reason: null };
  if (!Number.isSafeInteger(latestSeq) || latestSeq <= 0) return { allowed: true, reason: null };
  const member = await repo.findOne(C.CREW_MEMBERS, { crewId, userId, status: 'active' });
  if (!member) return { allowed: false, reason: 'NOT_ACTIVE_MEMBER' };
  const readSeq = Number.isSafeInteger(member.chatLastReadSeq) ? member.chatLastReadSeq : 0;
  if (readSeq >= latestSeq) return { allowed: false, reason: 'ALREADY_READ' };
  return { allowed: true, reason: null };
}

/**
 * 发一类通知。
 *
 * @param {object} ctx  invoke 的 callCtx（需要 repo / now / createSubscribeProvider）
 * @param {object} args
 * @param {string} args.kind            `NOTICE_KINDS` 之一
 * @param {string} args.crewId
 * @param {string} [args.excludeUserId] 不发给自己（默认就是调用者）
 * @param {string} args.dedupeKey       业务事件唯一键，重复调用只发一次
 * @param {object} args.values          业务字段（见 templates.js 的映射）
 * @param {object} [args.pageParams]    落地页参数（只放非敏感定位线索）
 */
async function notify(ctx, args) {
  const { kind, crewId, dedupeKey, values } = args;
  const excludeUserId = args.excludeUserId === undefined ? ctx.openid : args.excludeUserId;
  const outcome = {
    kind, crewId, dedupeKey,
    claimed: false, skipped: null,
    recipients: [], delivered: 0, unsubscribed: 0, failed: 0, unknown: 0,
  };

  const template = TEMPLATES[kind];
  if (!template) { outcome.skipped = 'UNKNOWN_KIND'; return outcome; }
  if (!dedupeKey || !crewId) { outcome.skipped = 'INVALID_ARGUMENT'; return outcome; }

  const data = buildData(kind, values);
  if (!data.ok) { outcome.skipped = data.reason; outcome.missing = data.missing; return outcome; }

  const claim = await claimEvent(ctx, { dedupeKey, crewId, kind, payload: values });
  if (!claim.claimed) { outcome.skipped = 'ALREADY_SENT'; return outcome; }
  outcome.claimed = true;

  const resolved = await resolveRecipients(ctx, { crewId, excludeUserId });
  if (!resolved.ok) {
    await finishLog(ctx, dedupeKey, { status: 'skipped', reason: resolved.reason });
    outcome.skipped = resolved.reason;
    return outcome;
  }

  const provider = createProvider(ctx);
  const page = landingPage(kind, Object.assign({ crewId }, args.pageParams || {}));
  const attempts = [];

  for (const userId of resolved.recipients) {
    const allowed = await intentAllows(ctx.repo, { crewId, userId, kind });
    if (!allowed.allowed) {
      attempts.push({ userId, status: 'skipped', reason: allowed.reason });
      continue;
    }
    /**
     * 已读的人不提醒 —— 一次授权就是一个次数，别花在已经看到的人身上。
     * 这一条放在意向检查之后，避免为了查已读把"从未订阅"的人也算进来。
     */
    const unread = await readGuardAllows(ctx.repo, { crewId, userId, kind,
      latestSeq: args.latestSeq });
    if (!unread.allowed) {
      attempts.push({ userId, status: 'skipped', reason: unread.reason });
      continue;
    }
    outcome.recipients.push(userId);
    /**
     * 单人发送失败**不影响其他人**；也不影响已经落库的业务数据
     * （消息发送成功 ≠ 通知发送成功，二者在日志里分开）。
     *
     * ⚠️ 这里必须自己 try/catch，不能只靠 provider 的返回值：
     * provider 内部抛异常（网络、SDK 内部错误）时，若让异常冒出循环，
     * 后面所有收件人都会被跳过 —— 一个人的故障变成全队收不到提醒。
     */
    let result;
    try {
      result = await provider.send({
        openid: userId, templateId: template.templateId, page, data: data.data,
      });
    } catch (e) {
      result = { ok: false, delivered: false, unknown: true, reachable: null,
        reason: 'SEND_THREW', errCode: (e && e.errCode) || null,
        errMsg: (e && (e.errMsg || e.message)) || String(e) };
    }
    if (result.ok) { outcome.delivered += 1; attempts.push({ userId, status: 'delivered' }); }
    else if (result.reachable === false) {
      outcome.unsubscribed += 1;
      attempts.push({ userId, status: 'unsubscribed', reason: result.reason, errCode: result.errCode });
      /**
       * 微信明确说"用户没订阅/次数用尽"时，把意向标记为 revoked：
       * 既避免后续反复对同一个人排队，也让队伍页的"已开启"状态与实际一致。
       * **不删记录**，保留可查证。
       */
      await ctx.repo.update(C.SUBSCRIBE_INTENTS, `${crewId}_${userId}_${kind}`, {
        revokedAt: new Date(ctx.now || Date.now()), revokeReason: result.reason,
      }).catch(() => {});
    } else if (result.unknown) {
      outcome.unknown += 1;
      attempts.push({ userId, status: 'unknown', reason: result.reason, errCode: result.errCode,
        errMsg: result.errMsg });
    } else {
      outcome.failed += 1;
      attempts.push({ userId, status: 'failed', reason: result.reason,
        retryable: result.retryable === true, errCode: result.errCode });
    }
  }

  const status = outcome.delivered > 0 ? 'sent'
    : (outcome.unknown > 0 ? 'unknown' : (outcome.recipients.length ? 'failed' : 'skipped'));
  await finishLog(ctx, dedupeKey, { status, recipients: resolved.recipients, attempts,
    delivered: outcome.delivered, unsubscribed: outcome.unsubscribed,
    failed: outcome.failed, unknown: outcome.unknown, reason: outcome.skipped });
  return outcome;
}

async function finishLog(ctx, dedupeKey, patch) {
  try {
    await ctx.repo.update(C.NOTICE_LOG, dedupeKey, Object.assign({}, patch,
      { updatedAt: new Date(ctx.now || Date.now()) }));
  } catch (e) {
    // 日志写不进去不得影响主流程，但必须可见（与 invoke 的事件日志同一处理口径）
    console.error('[subscribe] 通知日志写入失败', dedupeKey, e && e.message);
  }
}

/** provider 由入口注入；测试注入替身，线上回落云调用。 */
function createProvider(ctx) {
  if (typeof ctx.createSubscribeProvider === 'function') return ctx.createSubscribeProvider();
  if (ctx.createSubscribeProvider) return ctx.createSubscribeProvider;
  // 动作层没有注入时**显式返回不可用**，不静默去连真实云调用。
  return { name: 'none', send: async () => ({ ok: false, delivered: false,
    reason: 'PROVIDER_NOT_CONFIGURED', retryable: false, reachable: null }) };
}

module.exports = { recordIntent, revokeIntent, listIntents, notify, claimEvent,
  resolveRecipients, intentAllows, readGuardAllows, MERGE_WINDOW_MS, INTENT_TTL_MS };

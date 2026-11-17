'use strict';

const { createHash } = require('crypto');
const C = require('../lib/repo/collections');
const { requireCrewMember } = require('../lib/authz');
const { assert, fail, CODES } = require('../lib/errors');
const resp = require('../lib/resp');
const { crewMemberKey } = require('../lib/crew-member-key');
const { onCrewMessageSent } = require('../lib/subscribe/notify-triggers');

const MAX_TEXT = 1000;
const messageView = (row, userId, avatarFileId) => ({ messageId: row._id, seq: row.seq, text: row.text,
  senderKey: crewMemberKey(row.crewId, row.senderUserId),
  avatarFileId: avatarFileId || null,
  nickname: row.nickname || null, isMine: row.senderUserId === userId, source: row.source,
  sentAt: row.sentAt, clientMessageId: row.senderUserId === userId ? row.clientMessageId : null });
async function send(ctx) {
  const { repo, openid, payload: p } = ctx;
  const member = await requireCrewMember(repo, p.crewId, openid);
  assert(typeof p.text === 'string' && p.text.trim().length > 0 && p.text.length <= MAX_TEXT,
    CODES.INVALID_PARAM, '消息不能为空，最多 1000 字');
  assert(typeof p.clientMessageId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(p.clientMessageId),
    CODES.INVALID_PARAM, '缺少有效消息编号，请重新发送');
  assert(p.source === undefined || ['text', 'speech'].includes(p.source), CODES.INVALID_PARAM, '消息来源无效');
  const text = p.text.trim(), source = p.source || 'text';
  const id = createHash('sha256').update(JSON.stringify([p.crewId, openid, p.clientMessageId])).digest('hex');
  const user = await repo.findOne(C.USERS, { openid });
  const now = new Date(ctx.now || Date.now());
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const saved = await repo.runTransaction(async tx => {
        const crew = await tx.get(C.CREWS, p.crewId);
        const currentMember = await tx.get(C.CREW_MEMBERS, member._id);
        assert(crew && crew.status === 'active' && currentMember && currentMember.status === 'active',
          CODES.FORBIDDEN_NOT_MEMBER, '你已退出队伍，或队伍已解散');
        const existing = await tx.get(C.CREW_MESSAGES, id);
        if (existing) {
          assert(existing.text === text && existing.source === source, CODES.INVALID_PARAM, '同一消息编号不能发送不同内容');
          return { row: existing, replayed: true };
        }
        assert(!currentMember.chatLastSentAt || now - new Date(currentMember.chatLastSentAt) >= 1000,
          CODES.RATE_LIMITED, '发送太快，请稍等一秒再试');
        const seq = (crew.chatSeq || 0) + 1;
        const row = await tx.insert(C.CREW_MESSAGES, { _id: id, crewId: p.crewId, seq,
          senderUserId: openid, nickname: user && user.nickname || null,
          clientMessageId: p.clientMessageId, text, source, sentAt: now });
        await tx.update(C.CREW_MEMBERS, member._id, { chatLastSentAt: now });
        // 同成员变更共用队伍事务，退出/解散不能与发送交错留下半次写入。
        await tx.update(C.CREWS, p.crewId, { chatSeq: seq, revision: (crew.revision || 0) + 1 });
        return { row, replayed: false };
      }, [C.CREWS, C.CREW_MEMBERS, C.CREW_MESSAGES]);
      /**
       * 消息已经落库，**先发通知再返回**，但通知失败绝不影响这次发送。
       *
       * 为什么在这里触发而不是另起定时任务：
       *   · 小程序切到后台后前端定时器不工作，提醒必须由云端发起；
       *   · `chat.send` 是消息落库的唯一入口，放在这里才能保证"发了就有通知的机会"，
       *     不会因为客户端之后的任何行为漏掉。
       *
       * 连发多条不会连发多次：`onCrewMessageSent` 内部按 60 秒窗口合并去重，
       * 一次授权只花一次（详见 `lib/subscribe/notify-triggers.js`）。
       */
      if (!saved.replayed) {
        await onCrewMessageSent(ctx, {
          crewId: p.crewId, senderUserId: openid, text,
          senderNickname: (user && user.nickname) || '队友',
          sentAt: saved.row.sentAt || now,
          /** 已读覆盖到这条的人不提醒自己 */
          seq: saved.row.seq,
        });
      }
      return resp.ok({ message: messageView(saved.row, openid, user && user.avatarFileId), replayed: saved.replayed },
        { serverTime: now.toISOString() });
    } catch (e) {
      if (e.code !== CODES.VERSION_CONFLICT && !e.transactionConflict) throw e;
    }
  }
  throw fail(CODES.RATE_LIMITED, '队伍消息较多，请稍后重试');
}

async function list(ctx) {
  const { repo, openid, payload: p } = ctx;
  await requireCrewMember(repo, p.crewId, openid);
  assert(!(p.afterSeq !== undefined && p.beforeSeq !== undefined), CODES.INVALID_PARAM, '不能同时查询新消息和历史消息');
  const limit = p.limit === undefined ? 30 : p.limit;
  assert(Number.isInteger(limit) && limit > 0 && limit <= 50, CODES.INVALID_PARAM, '每次读取 1—50 条消息');
  const after = p.afterSeq !== undefined, before = p.beforeSeq !== undefined;
  const seq = after ? p.afterSeq : p.beforeSeq;
  if (after || before) assert(Number.isSafeInteger(seq) && seq >= (after ? 0 : 1), CODES.INVALID_PARAM, '消息游标无效');
  const query = { crewId: p.crewId };
  if (after || before) query.seq = { __op: after ? 'gt' : 'lt', value: seq };
  const rows = await repo.find(C.CREW_MESSAGES, query, { sort: { seq: after ? 1 : -1 }, limit: limit + 1 });
  const page = rows.slice(0, limit);
  if (!after) page.reverse();
  const senderIds = [...new Set(page.map(row => row.senderUserId))];
  const users = senderIds.length ? await repo.find(C.USERS, { openid: { __op: 'in', value: senderIds } }, { limit: 50 }) : [];
  const avatars = new Map(users.map(user => [user.openid, user.avatarFileId]));
  // 消息及头像查询期间退出/解散后，不返回刚读出的内容。
  const member = await requireCrewMember(repo, p.crewId, openid);
  return resp.ok({ messages: page.map(row => messageView(row, openid, avatars.get(row.senderUserId))), hasMore: rows.length > limit,
    oldestSeq: page.length ? page[0].seq : null,
    latestSeq: page.length ? page[page.length - 1].seq : (after ? seq : 0),
    /**
     * 本人的已读位置随消息一起返回：客户端据此判断"有没有未读"，
     * 而**不是**用"刚拉到了几条"来推断 —— 拉取不等于已读。
     */
    lastReadSeq: Number.isSafeInteger(member.chatLastReadSeq) ? member.chatLastReadSeq : 0 },
  { serverTime: new Date(ctx.now || Date.now()).toISOString() });
}

/**
 * **本人已读游标**（2026-10-17 新增）。
 *
 * ── 为什么必须有它 ────────────────────────────────────
 *
 * 交接文档点名的缺口：队伍页只有"消息拉取游标"（`afterSeq`），没有
 * "用户真的看到了哪一条"的持久化状态。两者混为一谈时会出现两种错：
 *   · 地图页后台预取了几条 → 以为用户已读 → 新消息不再提醒，用户永远看不到；
 *   · 或者反过来：已经看过的消息仍然提醒，通知次数被白白消耗。
 *
 * 所以「已读」只能由**真正展示之后**的显式调用推进，
 * 拉取接口、地图预取、推送成功都不自动等于已读。
 *
 * ── 只增不减 ──────────────────────────────────────────
 *
 * 指针倒退没有意义，而且会让"已经提醒过"的消息重新变成未读、再花一次授权。
 * 所以只取 `max(旧值, 新值)`，且**不超过队伍当前的 chatSeq** ——
 * 客户端传一个未来序号不该被记成"读取了还没发的消息"。
 */
async function markRead(ctx) {
  const { repo, openid, payload: p } = ctx;
  const member = await requireCrewMember(repo, p.crewId, openid);
  assert(Number.isSafeInteger(p.seq) && p.seq >= 0, CODES.INVALID_PARAM, '已读序号无效');
  const crew = await repo.get(C.CREWS, p.crewId);
  const latest = (crew && crew.chatSeq) || 0;
  const next = Math.min(p.seq, latest);
  const previous = Number.isSafeInteger(member.chatLastReadSeq) ? member.chatLastReadSeq : 0;
  const now = new Date(ctx.now || Date.now());
  if (next <= previous) {
    // 不倒退，也不重复写库（避免每次滚动都产生一次写）。
    return resp.ok({ lastReadSeq: previous, advanced: false, latestSeq: latest },
      { serverTime: now.toISOString() });
  }
  await repo.update(C.CREW_MEMBERS, member._id, { chatLastReadSeq: next, chatLastReadAt: now });
  return resp.ok({ lastReadSeq: next, advanced: true, latestSeq: latest },
    { serverTime: now.toISOString() });
}

module.exports = { send, list, markRead, MAX_TEXT };

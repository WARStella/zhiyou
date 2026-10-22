'use strict';

/**
 * 把**业务事件**翻译成通知调用 —— 业务动作与通知服务之间的唯一接缝。
 *
 * ── 为什么要有这一层 ──────────────────────────────────
 *
 * `chat.send`、`meet.create`、`meet.confirm` 各自只需要一行调用，
 * 但"用什么去重键、字段从哪儿取、失败要不要影响主流程"这些判断
 * 不能散落在三个动作里：一旦有一处把异常抛出去，用户就会看到
 * "消息发失败"（实际消息已经落库）；一旦去重键算得不一致，
 * 同一句话就会发两条通知。所以集中在这里，并且**所有触发器都吞异常**。
 *
 * ── 一条铁律 ──────────────────────────────────────────
 *
 * **通知失败永远不会让业务失败。** 消息已经发出去、集合已经定下来，
 * 这时推送失败只是"这次没提醒到"，不是"这次操作失败"。
 * 交接文档第 3 节第 6 条明确要求：通知失败不应让已落库的聊天或集合操作显示为发送失败。
 */

const { NOTICE_KINDS } = require('./templates');
const { notify } = require('./service');

/** 聊天提醒的合并窗口：同一支队伍在这段时间内的多条消息只花一次授权。 */
const CHAT_MERGE_WINDOW_MS = 60 * 1000;

/**
 * 聊天提醒的去重键。
 *
 * 用**时间窗**而不是逐条消息：一次授权只够发一条，逐条发等于几秒钟就耗光。
 * 窗口内的第二条消息命中同一个键 → `notice_log` 里已存在 → 直接跳过。
 * 这样"连发三条"只会通知一次，且内容取**最新**那条（后到的没抢到键，
 * 但提示文案里说的是"有新消息"，与具体哪一条无关）。
 */
function chatDedupeKey(crewId, nowMs) {
  const bucket = Math.floor(nowMs / CHAT_MERGE_WINDOW_MS);
  return `crew_message:${crewId}:${bucket}`;
}

function meetDedupeKey(crewId, meetId, phase) {
  return `meet_${phase}:${crewId}:${meetId}`;
}

/**
 * 包一层：把任何异常都吃掉并记日志。
 *
 * 刻意不用 `Promise.reject` 后统一 catch —— 那样调用方一个疏忽就会漏掉，
 * 而"漏掉"的表现是用户看到操作失败。这里让**这个函数自己**永不抛。
 */
async function safeNotify(ctx, args, label) {
  try {
    return await notify(ctx, args);
  } catch (e) {
    console.error('[subscribe] 通知触发失败（不影响业务）', label, e && e.message);
    return { skipped: 'TRIGGER_ERROR', label, message: e && e.message };
  }
}

/**
 * 有人发了消息 → 提醒**其他**当前成员回队伍看。
 *
 * @param {object} ctx   chat.send 的 callCtx
 * @param {object} args  { crewId, senderNickname, sentAt, senderUserId }
 */
async function onCrewMessageSent(ctx, args) {
  const nowMs = new Date(ctx.now || Date.now()).getTime();
  return safeNotify(ctx, {
    kind: NOTICE_KINDS.CREW_MESSAGE,
    crewId: args.crewId,
    /** 发给别人：本人自己发的消息不需要提醒自己 */
    excludeUserId: args.senderUserId,
    dedupeKey: chatDedupeKey(args.crewId, nowMs),
    /** 已读位置覆盖到这条消息的成员不再提醒（一次授权只够发一次）。 */
    latestSeq: args.seq,
    values: {
      content: args.text || '队伍里有新消息',
      sentAt: args.sentAt || ctx.now || Date.now(),
      senderNickname: args.senderNickname || '队友',
    },
    pageParams: {},
  }, 'crew_message');
}

/**
 * 集合被创建/约定 → 通知队员去哪里、几点。
 *
 * 去重键带 `meetId`：同一次集合只通知一次；改了集合时间地点**不是**
 * "状态变化"，是否要再通知由触发侧显式决定，不在这里偷偷重发。
 */
async function onMeetCreated(ctx, args) {
  return safeNotify(ctx, {
    kind: NOTICE_KINDS.MEET_CREATED,
    crewId: args.crewId,
    excludeUserId: args.actorUserId,
    dedupeKey: meetDedupeKey(args.crewId, args.meetId, 'created'),
    values: {
      activityName: args.activityName || '队伍集合',
      meetingPlace: args.meetingPlace || '集合地点待定',
      meetingTime: args.meetingTime,
      remark: args.remark || '打开「队伍」页查看集合点与集合时间',
    },
    pageParams: args.meetId ? { meetId: args.meetId } : {},
  }, 'meet_created');
}

/**
 * 集合状态真的变化（确认、取消）→ 通知队员。
 *
 * ⚠️ 用途收窄：这不是"任意行程修改通知"。普通聊天、路线调整、
 * 改时间改地点都**不该**走这里 —— 否则这个模板就变成了万能推送。
 */
async function onMeetStatusChanged(ctx, args) {
  return safeNotify(ctx, {
    kind: NOTICE_KINDS.MEET_STATUS_CHANGED,
    crewId: args.crewId,
    excludeUserId: args.actorUserId,
    dedupeKey: meetDedupeKey(args.crewId, args.meetId, `status:${args.status}`),
    values: {
      activityName: args.activityName || '队伍集合',
      tip: args.tip || '集合状态有变化，请回队伍页查看',
      reason: args.reason || '集合状态已更新',
      changedAt: args.changedAt || ctx.now || Date.now(),
    },
    pageParams: args.meetId ? { meetId: args.meetId } : {},
  }, 'meet_status_changed');
}

module.exports = { chatDedupeKey, meetDedupeKey, safeNotify,
  onCrewMessageSent, onMeetCreated, onMeetStatusChanged, CHAT_MERGE_WINDOW_MS };

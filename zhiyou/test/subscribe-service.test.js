'use strict';

/**
 * 订阅消息的**服务层回归** —— 覆盖交接文档第 7 节点名的那些情形。
 *
 * 这里全部走真实 `invoke` 路径（只有仓储与 provider 是替身），
 * 所以验的是"线上真正执行的代码"，不是某个孤立函数。
 *
 * ⚠️ **绝不使用真实订阅次数**：所有用例都注入 `createFakeSubscribeProvider`。
 * 用用户自己的授权额度做自动化回归，等于把额度当耗材。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSubscribeProvider } = require('../cloudfunctions/api/lib/subscribe/fake');
const { NOTICE_KINDS, TEMPLATES } = require('../cloudfunctions/api/lib/subscribe/templates');
const { chatDedupeKey, meetDedupeKey, CHAT_MERGE_WINDOW_MS } =
  require('../cloudfunctions/api/lib/subscribe/notify-triggers');
const { makeWorld, makeCrew, expectOk, expectFail, C } = require('./helpers');

const point = { latitude: 45.77, longitude: 126.62 };

/** 世界 + 一份可观察的假发送器。 */
async function worldWithProvider(mode) {
  const provider = createFakeSubscribeProvider({ mode });
  const world = await makeWorld({ createSubscribeProvider: () => provider });
  return { world, provider };
}

/** 让 three 个成员都"同意"某类提醒 —— 走真实接口，不直接写库。 */
async function subscribeAll(world, crewId, kinds) {
  for (const who of ['A', 'B', 'C']) {
    expectOk(await world[who]('subscribe.report', {
      crewId, source: 'team-page',
      results: kinds.map(kind => ({ kind, status: 'accept' })),
    }));
  }
}

test('订阅意向只累加不重置；拒绝记成未同意，不把"没拿到值"当成同意', async () => {
  const { world } = await worldWithProvider();
  const { crewId } = await makeCrew(world);

  const first = expectOk(await world.B('subscribe.report', {
    crewId, results: [{ kind: NOTICE_KINDS.CREW_MESSAGE, status: 'accept' }],
  }));
  assert.equal(first.intents.find(i => i.kind === NOTICE_KINDS.CREW_MESSAGE).subscribed, true);
  assert.equal(first.intents.find(i => i.kind === NOTICE_KINDS.CREW_MESSAGE).acceptedCount, 1);

  // 再点一次是累加，不是重置或新增一行
  const second = expectOk(await world.B('subscribe.report', {
    crewId, results: [{ kind: NOTICE_KINDS.CREW_MESSAGE, status: 'accept' }],
  }));
  assert.equal(second.intents.find(i => i.kind === NOTICE_KINDS.CREW_MESSAGE).acceptedCount, 2);
  assert.equal(await world.repo.count(C.SUBSCRIBE_INTENTS, { crewId, userId: 'openid_B' }), 1);

  // reject / ban / 未知值都不算同意
  for (const status of ['reject', 'ban', 'filter', 'weird', undefined]) {
    const r = expectOk(await world.C('subscribe.report', {
      crewId, results: [{ kind: NOTICE_KINDS.MEET_CREATED, status }],
    }));
    assert.equal(r.intents.find(i => i.kind === NOTICE_KINDS.MEET_CREATED).subscribed, false,
      `${String(status)} 不得被记为已订阅`);
  }
});

test('未入队不能上报订阅；未知类型与非法来源被拒绝', async () => {
  const { world } = await worldWithProvider();
  const { crewId } = await makeCrew(world);
  const outsider = await makeWorld({ createSubscribeProvider: () => createFakeSubscribeProvider() });
  const outsiderCrew = await makeCrew(outsider);
  void outsiderCrew;

  expectFail(await world.A('subscribe.report', {
    crewId, results: [{ kind: 'not_a_kind', status: 'accept' }],
  }), 'INVALID_PARAM');
  expectFail(await world.A('subscribe.report', {
    crewId, results: [{ kind: NOTICE_KINDS.CREW_MESSAGE, status: 'accept' }], source: 'hack',
  }), 'INVALID_PARAM');
  expectFail(await world.A('subscribe.report', { crewId, results: [] }), 'INVALID_PARAM');
  // 另一个世界里的 B 不是本队成员
  const other = await makeWorld({ createSubscribeProvider: () => createFakeSubscribeProvider() });
  expectFail(await other.B('subscribe.report', {
    crewId, results: [{ kind: NOTICE_KINDS.CREW_MESSAGE, status: 'accept' }],
  }), 'FORBIDDEN_NOT_MEMBER');
});

test('消息通知只发给已订阅的**其他有效成员**，本人不收自己的提醒', async () => {
  const { world, provider } = await worldWithProvider();
  const { crewId } = await makeCrew(world);
  // 只有 B 订阅了消息提醒
  expectOk(await world.B('subscribe.report', {
    crewId, results: [{ kind: NOTICE_KINDS.CREW_MESSAGE, status: 'accept' }],
  }));

  expectOk(await world.A('chat.send', { crewId, clientMessageId: 'notify-msg-0001', text: '集合啦' }));

  assert.equal(provider.sent.length, 1, '只发一条');
  const sent = provider.sent[0];
  assert.equal(sent.touser, 'openid_B');
  assert.equal(sent.templateId, TEMPLATES[NOTICE_KINDS.CREW_MESSAGE].templateId);
  assert.ok(sent.page.startsWith('pages/map/index?crewId='), '落地页要回到对应队伍');
  assert.equal(sent.data.thing2.value, '集合啦');
  assert.ok(sent.data.time3.value.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/));
  // 昵称还没设置时用兜底，不能把 openid 当成昵称发出去
  assert.equal(sent.data.thing4.value, '队友');
  // 真正发给微信的**内容**里不能出现 openid（touser 字段本身当然要有）
  assert.doesNotMatch(JSON.stringify(sent.data), /openid_/);
  assert.equal(sent.page.includes('openid_'), false, '落地页不能带 openid');
});

test('连发多条只花一次授权（60 秒窗口合并），窗口外的下一条才会再发', async () => {
  const { world, provider } = await worldWithProvider();
  const { crewId } = await makeCrew(world);
  await subscribeAll(world, crewId, [NOTICE_KINDS.CREW_MESSAGE]);

  const base = world.NOW.getTime();
  // 同一窗口内三条（chat.send 有 1 秒间隔限制，所以每条间隔 1 秒）
  for (let i = 0; i < 3; i++) {
    expectOk(await world.A('chat.send', { crewId, clientMessageId: `merge-window-000${i}`, text: `第${i}条` },
      { now: base + i * 1000 }));
  }
  const firstWindowSent = provider.sent.length;
  assert.equal(firstWindowSent, 2, 'B 与 C 各一条：窗口内只发一轮');
  assert.equal(chatDedupeKey(crewId, base), chatDedupeKey(crewId, base + 1000));

  // 跨过窗口后再发，才会产生下一轮
  expectOk(await world.A('chat.send', { crewId, clientMessageId: 'merge-next-0001', text: '下一轮' },
    { now: base + CHAT_MERGE_WINDOW_MS + 1000 }));
  assert.equal(provider.sent.length, firstWindowSent + 2, '新窗口应该再发一轮');
});

test('已读的人不再被提醒；未读的人照常提醒', async () => {
  const { world, provider } = await worldWithProvider();
  const { crewId } = await makeCrew(world);
  await subscribeAll(world, crewId, [NOTICE_KINDS.CREW_MESSAGE]);

  const base = world.NOW.getTime();
  expectOk(await world.A('chat.send', { crewId, clientMessageId: 'read-first-0001', text: '有人吗' }, { now: base }));
  assert.equal(provider.sent.length, 2);

  // B 真的看到了最新一条（显式推进已读游标）
  const read = expectOk(await world.B('chat.markRead', { crewId, seq: 1 }, { now: base + 2000 }));
  assert.equal(read.lastReadSeq, 1);
  assert.equal(read.advanced, true);

  expectOk(await world.C('chat.markRead', { crewId, seq: 1 }, { now: base + 2000 }));
  // 跨窗口后再发一条：两人都已读到 1，却都还没读到 2 → 仍提醒
  expectOk(await world.A('chat.send', { crewId, clientMessageId: 'read-second-002', text: '再看下' },
    { now: base + CHAT_MERGE_WINDOW_MS + 1000 }));
  assert.equal(provider.sent.length, 4, '新消息仍应提醒未读的人');

  expectOk(await world.B('chat.markRead', { crewId, seq: 2 }, { now: base + CHAT_MERGE_WINDOW_MS + 2000 }));
  expectOk(await world.C('chat.markRead', { crewId, seq: 2 }, { now: base + CHAT_MERGE_WINDOW_MS + 2000 }));
  expectOk(await world.A('chat.send', { crewId, clientMessageId: 'read-third-0003', text: '第三条' },
    { now: base + CHAT_MERGE_WINDOW_MS * 2 + 1000 }));
  // 两人都已读到 2，此时第 3 条未读 → 仍会提醒（已读判断按最新 seq）
  assert.equal(provider.sent.length, 6);
});

test('只提醒已读到最新的人之外：全部已读时不花任何次数', async () => {
  const { world, provider } = await worldWithProvider();
  const { crewId } = await makeCrew(world);
  await subscribeAll(world, crewId, [NOTICE_KINDS.CREW_MESSAGE]);

  const base = world.NOW.getTime();
  expectOk(await world.A('chat.send', { crewId, clientMessageId: 'allread-first1', text: '一' }, { now: base }));
  const afterFirst = provider.sent.length;

  // 所有人都读到 1
  for (const who of ['A', 'B', 'C']) {
    expectOk(await world[who]('chat.markRead', { crewId, seq: 1 }, { now: base + 1000 }));
  }
  // 再发一条：seq=2，所有人只读到 1 → 未读，仍提醒
  expectOk(await world.A('chat.send', { crewId, clientMessageId: 'allread-second', text: '二' },
    { now: base + CHAT_MERGE_WINDOW_MS + 1000 }));
  assert.equal(provider.sent.length, afterFirst + 2);

  // 都读到 2 后，再在同一窗口内发送重复调用……先跨窗口
  for (const who of ['A', 'B', 'C']) {
    expectOk(await world[who]('chat.markRead', { crewId, seq: 2 }, { now: base + CHAT_MERGE_WINDOW_MS + 2000 }));
  }
  const before = provider.sent.length;
  // 同一窗口内重复触发不会重发（这就是去重键的作用）
  expectOk(await world.A('chat.send', { crewId, clientMessageId: 'allread-second', text: '二' },
    { now: base + CHAT_MERGE_WINDOW_MS + 3000 }));
  assert.equal(provider.sent.length, before, '同一 clientMessageId 重试不该产生新通知');
});

test('已读游标只增不减，且不超过队伍当前 chatSeq', async () => {
  const { world } = await worldWithProvider();
  const { crewId } = await makeCrew(world);
  expectOk(await world.A('chat.send', { crewId, clientMessageId: 'cursor-first1', text: '一' }));
  expectOk(await world.A('chat.send', { crewId, clientMessageId: 'cursor-second', text: '二' },
    { now: world.NOW.getTime() + 2000 }));

  assert.equal(expectOk(await world.B('chat.markRead', { crewId, seq: 2 })).lastReadSeq, 2);
  // 倒退被拒（不写库、返回旧值）
  const back = expectOk(await world.B('chat.markRead', { crewId, seq: 1 }));
  assert.equal(back.advanced, false);
  assert.equal(back.lastReadSeq, 2);
  // 未来序号被夹到最新
  const future = expectOk(await world.B('chat.markRead', { crewId, seq: 9999 }));
  assert.equal(future.lastReadSeq, 2);
  assert.equal(future.latestSeq, 2);
  // 非成员不能推进别人的游标
  expectFail(await world.A('chat.markRead', { crewId: 'other-crew', seq: 1 }), 'FORBIDDEN_NOT_MEMBER');
});

test('微信返回"未订阅/次数用尽"时把意向标记为 revoked，但记录保留可查', async () => {
  const { world } = await worldWithProvider('unsubscribed');
  const { crewId } = await makeCrew(world);
  expectOk(await world.B('subscribe.report', {
    crewId, results: [{ kind: NOTICE_KINDS.CREW_MESSAGE, status: 'accept' }],
  }));

  expectOk(await world.A('chat.send', { crewId, clientMessageId: 'unsub-first1', text: '在吗' }));

  const intent = await world.repo.get(C.SUBSCRIBE_INTENTS, `${crewId}_openid_B_${NOTICE_KINDS.CREW_MESSAGE}`);
  assert.ok(intent.revokedAt, '微信明确不可达后应标记撤销');
  assert.equal(intent.acceptedCount, 1, '历史计数保留，不删除记录');
  const status = expectOk(await world.B('subscribe.status', { crewId }));
  assert.equal(status.intents.find(i => i.kind === NOTICE_KINDS.CREW_MESSAGE).subscribed, false);
});

test('发送抛异常=未知结果：不自动重试，不让聊天失败，日志记 unknown', async () => {
  const { world, provider } = await worldWithProvider('throws');
  const { crewId } = await makeCrew(world);
  await subscribeAll(world, crewId, [NOTICE_KINDS.CREW_MESSAGE]);

  const sent = expectOk(await world.A('chat.send', { crewId, clientMessageId: 'unknown-first', text: '有人吗' }));
  assert.ok(sent.message.messageId, '通知异常不得让聊天失败');
  assert.equal(await world.repo.count(C.CREW_MESSAGES, { crewId }), 1, '消息必须已落库');
  // 三人里只有发起人不发自己 → 两个收件人各尝试**一次**，异常后不重试
  assert.equal(provider.attempts, 2, '每人只尝试一次，未知结果不自动重试');

  const key = chatDedupeKey(crewId, world.NOW.getTime());
  const log = await world.repo.get(C.NOTICE_LOG, key);
  assert.equal(log.status, 'unknown');
  assert.equal(log.unknown, 2);
  assert.ok(log.attempts.every(a => a.status === 'unknown'));
});

test('provider 未配置时不误报成功，也不影响业务', async () => {
  const { world } = await worldWithProvider('unconfigured');
  const { crewId } = await makeCrew(world);
  await subscribeAll(world, crewId, [NOTICE_KINDS.CREW_MESSAGE]);
  const sent = expectOk(await world.A('chat.send', { crewId, clientMessageId: 'noconfig-first', text: '喂' }));
  assert.ok(sent.message.messageId);
  const log = await world.repo.get(C.NOTICE_LOG, chatDedupeKey(crewId, world.NOW.getTime()));
  assert.equal(log.status, 'failed');
  assert.equal(log.delivered, 0);
});

test('集合创建通知队员；同一集合只通知一次，重复触发不重发', async () => {
  const { world, provider } = await worldWithProvider();
  const { crewId } = await makeCrew(world);
  await subscribeAll(world, crewId, [NOTICE_KINDS.MEET_CREATED]);

  const created = expectOk(await world.A('meet.create', {
    crewId, plannedMeetAt: new Date(world.NOW.getTime() + 3600 * 1000).toISOString(),
    point, placeName: '索菲亚教堂广场',
  }));

  assert.equal(provider.sent.length, 2, '发起人自己不收提醒');
  const sent = provider.sent[0];
  assert.equal(sent.templateId, TEMPLATES[NOTICE_KINDS.MEET_CREATED].templateId);
  assert.equal(sent.data.thing1.value, '索菲亚教堂广场');
  assert.equal(sent.data.thing2.value, '索菲亚教堂广场');
  assert.ok(sent.data.time3.value.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/));
  assert.ok(sent.data.thing5.value.length > 0);
  assert.match(sent.page, /meetId=/);

  // 去重键唯一：同一集合再次触发不会重发
  const { notify } = require('../cloudfunctions/api/lib/subscribe/service');
  const again = await notify({
    repo: world.repo, openid: 'openid_A', now: world.NOW,
    createSubscribeProvider: () => provider,
  }, {
    kind: NOTICE_KINDS.MEET_CREATED, crewId, excludeUserId: 'openid_A',
    dedupeKey: meetDedupeKey(crewId, created.meetTaskId, 'created'),
    values: { activityName: 'x', meetingPlace: 'x', meetingTime: new Date(), remark: 'x' },
  });
  assert.equal(again.skipped, 'ALREADY_SENT');
  assert.equal(provider.sent.length, 2);
});

test('集合状态真的变化才通知；只是改地点/时间不套用状态变更模板', async () => {
  const { world, provider } = await worldWithProvider();
  const { crewId } = await makeCrew(world);
  await subscribeAll(world, crewId, [NOTICE_KINDS.MEET_STATUS_CHANGED]);

  const created = expectOk(await world.A('meet.create', {
    crewId, plannedMeetAt: new Date(world.NOW.getTime() + 3600 * 1000).toISOString(),
    point, placeName: '集合点甲',
  }));
  assert.equal(provider.sent.length, 0, '创建集合不触发状态变更模板');

  // 单人确认时任务状态仍是 proposed —— 此时通知"已确认"是假消息，不该发。
  expectOk(await world.B('meet.confirm', { meetTaskId: created.meetTaskId, decision: 'confirm' },
    { expectedVersion: created.version, now: new Date(world.NOW.getTime() + 60 * 1000) }));
  assert.equal(provider.sent.length, 0, '没人全确认前不发状态变更通知');

  // C 也确认 → 全员确认，任务状态真的变成 confirmed
  expectOk(await world.C('meet.confirm', { meetTaskId: created.meetTaskId, decision: 'confirm' },
    { expectedVersion: created.version, now: new Date(world.NOW.getTime() + 90 * 1000) }));
  assert.equal(provider.sent.length, 2, '状态真的变化才通知其余成员（C 自己不发）');
  const sent = provider.sent[0];
  assert.equal(sent.templateId, TEMPLATES[NOTICE_KINDS.MEET_STATUS_CHANGED].templateId);
  assert.equal(sent.data.thing1.value, '集合点甲');
  assert.ok(sent.data.thing3.value.length > 0, '变更原因不能为空');
  assert.ok(sent.data.time4.value.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/));
  assert.equal(sent.touser, 'openid_A');

  // 同一状态重复触发：C 再点一次确认不会改变 status，也就不会再通知
  const before = provider.sent.length;
  expectOk(await world.C('meet.confirm', { meetTaskId: created.meetTaskId, decision: 'confirm' },
    { expectedVersion: created.version, now: new Date(world.NOW.getTime() + 120 * 1000) }));
  assert.equal(provider.sent.length, before, '同一状态不重复通知');
});

test('有人拒绝会通知其余成员（集合需要重新协商），即使任务状态没变', async () => {
  const { world, provider } = await worldWithProvider();
  const { crewId } = await makeCrew(world);
  await subscribeAll(world, crewId, [NOTICE_KINDS.MEET_STATUS_CHANGED]);

  const created = expectOk(await world.A('meet.create', {
    crewId, plannedMeetAt: new Date(world.NOW.getTime() + 3600 * 1000).toISOString(),
    point, placeName: '集合点乙',
  }));
  expectOk(await world.B('meet.confirm', { meetTaskId: created.meetTaskId, decision: 'decline' },
    { expectedVersion: created.version, now: new Date(world.NOW.getTime() + 60 * 1000) }));

  assert.ok(provider.sent.length > 0, '有人拒绝必须提醒其他人重新协商');
  assert.ok(provider.sent.every(s => s.data.thing3.value.includes('无法参加')));
  assert.ok(provider.sent.every(s => s.touser !== 'openid_B'), '拒绝者本人不提醒自己');
});

test('退队/解散后不再收到推送：收件人只取当前有效成员', async () => {
  const { world, provider } = await worldWithProvider();
  const { crewId } = await makeCrew(world);
  await subscribeAll(world, crewId, [NOTICE_KINDS.CREW_MESSAGE]);

  // C 退出队伍
  expectOk(await world.C('crew.leave', { crewId }));

  const base = world.NOW.getTime();
  expectOk(await world.A('chat.send', { crewId, clientMessageId: 'leftcrew-first', text: '还在吗' }, { now: base }));

  const recipients = provider.sent.map(s => s.touser);
  assert.deepEqual(recipients, ['openid_B'], '退队成员不得收到推送');
  assert.equal(provider.sent.length, 1);
});

test('解散队伍后不再推送', async () => {
  const { world, provider } = await worldWithProvider();
  const { crewId } = await makeCrew(world);
  await subscribeAll(world, crewId, [NOTICE_KINDS.CREW_MESSAGE]);
  expectOk(await world.A('crew.create', { name: '另一队' })); // 不影响本队
  // 队长解散
  const teams = await world.repo.get(C.CREWS, crewId);
  assert.ok(teams);
  expectOk(await world.A('crew.remove', { crewId, userId: 'openid_B' }));
  const base = world.NOW.getTime();
  expectOk(await world.A('chat.send', { crewId, clientMessageId: 'removed-first', text: 'x' }, { now: base }));
  const recipients = provider.sent.map(s => s.touser);
  assert.equal(recipients.includes('openid_B'), false, '被移除成员不得收到推送');
});

test('通知日志可查：投递/未订阅/失败分开记，不把失败混成成功', async () => {
  const { world } = await worldWithProvider('busy');
  const { crewId } = await makeCrew(world);
  await subscribeAll(world, crewId, [NOTICE_KINDS.CREW_MESSAGE]);
  expectOk(await world.A('chat.send', { crewId, clientMessageId: 'logstatus-first', text: 'x' }));
  const log = await world.repo.get(C.NOTICE_LOG, chatDedupeKey(crewId, world.NOW.getTime()));
  assert.equal(log.status, 'failed');
  assert.equal(log.failed, 2);
  assert.equal(log.delivered, 0);
  assert.ok(log.attempts.some(a => a.retryable === true), '系统繁忙要标记为可重试');
});

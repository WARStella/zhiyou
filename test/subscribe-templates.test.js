'use strict';

/**
 * 订阅消息的**模板与字段映射**回归。
 *
 * 这一层最容易出的错不是逻辑，而是**编号写错**：
 * 三套模板的字段编号互不相同（未读提醒从 `thing2` 起，集合备注是 `thing5`），
 * 写错时微信只回 `47003 argument invalid`，不会告诉你哪一项错。
 * 所以这里把用户提供的后台截图编号逐条钉死。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { NOTICE_KINDS, TEMPLATES, MAX_TEXT, formatTime, clampText, buildData, landingPage,
  describeTemplates } = require('../cloudfunctions/api/lib/subscribe/templates');

/** 用户 2026-10-17 提供的小程序后台实际配置，改它等于改契约。 */
const EXPECTED = {
  [NOTICE_KINDS.MEET_CREATED]: {
    templateId: 'SHBt_IV0Btag5vKeaI30eBCL6e3bMqlfqvXIBfDtUxI',
    fields: { activityName: 'thing1', meetingPlace: 'thing2', meetingTime: 'time3', remark: 'thing5' },
  },
  [NOTICE_KINDS.MEET_STATUS_CHANGED]: {
    templateId: 'CwcjXpUkdcn88NQo3tGIns6OJzdr7omkhMvPk8sPl1A',
    fields: { activityName: 'thing1', tip: 'thing2', reason: 'thing3', changedAt: 'time4' },
  },
  [NOTICE_KINDS.CREW_MESSAGE]: {
    templateId: 'Xmvcm79SH5MwSw-XWryUToYot_sR0__eshdXAtBOT_8',
    fields: { content: 'thing2', sentAt: 'time3', senderNickname: 'thing4' },
  },
};

test('三个模板 ID 与字段编号与用户后台配置一致', () => {
  assert.deepEqual(Object.keys(TEMPLATES).sort(), Object.keys(EXPECTED).sort());
  for (const [kind, want] of Object.entries(EXPECTED)) {
    assert.equal(TEMPLATES[kind].templateId, want.templateId, `${kind} 模板 ID 不符`);
    assert.deepEqual(TEMPLATES[kind].fields, want.fields, `${kind} 字段映射不符`);
  }
});

test('三类模板的字段编号确实互不相同 —— 防止按序号顺排的误改', () => {
  const keys = Object.keys(EXPECTED).map(kind => Object.entries(TEMPLATES[kind].fields));
  const all = keys.flat();
  // 未读提醒没有 1 号字段：如果哪天有人"补齐"成 thing1，这里会先红。
  assert.equal(all.some(([field, key]) => field === 'content' && key === 'thing1'), false);
  // 集合备注是 5 号，不是 4 号。
  assert.equal(TEMPLATES[NOTICE_KINDS.MEET_CREATED].fields.remark, 'thing5');
  assert.equal(TEMPLATES[NOTICE_KINDS.CREW_MESSAGE].fields.senderNickname, 'thing4');
});

test('字段齐全时按映射组装成 { thingN: { value } }，时间字段转北京时间', () => {
  const built = buildData(NOTICE_KINDS.MEET_CREATED, {
    activityName: '中央大街集合',
    meetingPlace: '索菲亚教堂广场',
    // 2026-10-17T10:30:00Z = 北京时间 18:30
    meetingTime: Date.UTC(2026, 9, 17, 10, 30),
    remark: '记得带伞',
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.data, {
    thing1: { value: '中央大街集合' },
    thing2: { value: '索菲亚教堂广场' },
    time3: { value: '2026-10-17 18:30' },
    thing5: { value: '记得带伞' },
  });
});

test('缺字段不静默补空串，而是报出缺了哪几个', () => {
  const built = buildData(NOTICE_KINDS.CREW_MESSAGE, { content: '在吗' });
  assert.equal(built.ok, false);
  assert.equal(built.reason, 'MISSING_FIELDS');
  assert.deepEqual(built.missing.sort(), ['senderNickname', 'sentAt']);
  assert.equal(built.data, null);
});

test('未知模板直接拒绝，不猜测字段', () => {
  const built = buildData('not_a_kind', {});
  assert.equal(built.ok, false);
  assert.equal(built.reason, 'UNKNOWN_KIND');
  assert.deepEqual(describeTemplates().map(t => t.kind).sort(), Object.keys(EXPECTED).sort());
});

test('超长内容截断到上限并加省略号，换行压成空格 —— 否则微信会整条拒绝', () => {
  const long = '长'.repeat(MAX_TEXT + 10);
  const clamped = clampText(long);
  assert.equal(Array.from(clamped).length, MAX_TEXT);
  assert.equal(clamped.endsWith('…'), true);
  assert.equal(clampText('第一行\n第二行'), '第一行 第二行');
  assert.equal(clampText('  短  '), '短');
  assert.equal(clampText(undefined), '');

  const built = buildData(NOTICE_KINDS.CREW_MESSAGE, {
    content: long, sentAt: Date.UTC(2026, 9, 17, 1, 0), senderNickname: '欢实的黄鳝',
  });
  assert.equal(built.ok, true);
  assert.equal(Array.from(built.data.thing2.value).length, MAX_TEXT);
});

test('时间格式固定为 YYYY-MM-DD HH:mm，非法值不伪造时间', () => {
  assert.equal(formatTime(Date.UTC(2026, 0, 1, 0, 5)), '2026-01-01 08:05');
  assert.equal(formatTime('2026-10-17T10:30:00.000Z'), '2026-10-17 18:30');
  assert.equal(formatTime('not-a-date'), '');
  assert.equal(formatTime(undefined), '');
});

test('落地页只带非敏感定位线索，且能处理空参数', () => {
  assert.equal(landingPage(NOTICE_KINDS.MEET_CREATED, { crewId: 'c1' }),
    'pages/map/index?crewId=c1');
  assert.equal(landingPage(NOTICE_KINDS.CREW_MESSAGE, null), 'pages/map/index');
  // 中文与特殊字符必须编码，否则路径非法
  assert.equal(landingPage(NOTICE_KINDS.CREW_MESSAGE, { crewId: 'a b' }), 'pages/map/index?crewId=a%20b');
  // 空值不产生 `?key=` 这种残参
  assert.equal(landingPage(NOTICE_KINDS.CREW_MESSAGE, { crewId: 'c1', seq: '' }), 'pages/map/index?crewId=c1');
});

test('发送权限已登记在 config.json —— 漏配时微信会以"没有权限"失败', () => {
  const config = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cloudfunctions', 'api', 'config.json'), 'utf8'));
  assert.ok(config.permissions.openapi.includes('subscribeMessage.send'),
    'api/config.json 的 permissions.openapi 必须包含 subscribeMessage.send');
});

'use strict';

/**
 * 队伍页「订阅提醒」的界面回归。
 *
 * 前端最容易出的两类错，这里各盯一条：
 *   ① **把客户端结果当成发送许可**：用户点了 accept 不等于以后永远能收到；
 *   ② **静默替用户订阅** / 拒绝后仍显示已开启。
 * 所以断言的是"上报了什么"和"界面显示什么"，而不是"点到了某个按钮"。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./page-harness');

const flush = () => new Promise(resolve => setImmediate(resolve));

const TEMPLATE_IDS = {
  meet_created: 'SHBt_IV0Btag5vKeaI30eBCL6e3bMqlfqvXIBfDtUxI',
  meet_status_changed: 'CwcjXpUkdcn88NQo3tGIns6OJzdr7omkhMvPk8sPl1A',
  crew_message: 'Xmvcm79SH5MwSw-XWryUToYot_sR0__eshdXAtBOT_8',
};

function statusResponse(subscribed) {
  return {
    ok: true,
    data: {
      intents: [
        { kind: 'meet_created', label: '活动集合通知', templateId: TEMPLATE_IDS.meet_created,
          subscribed: subscribed.includes('meet_created'), acceptedCount: subscribed.includes('meet_created') ? 1 : 0 },
        { kind: 'meet_status_changed', label: '活动状态变更通知',
          templateId: TEMPLATE_IDS.meet_status_changed, subscribed: false, acceptedCount: 0 },
        { kind: 'crew_message', label: '消息未读提醒', templateId: TEMPLATE_IDS.crew_message,
          subscribed: false, acceptedCount: 0 },
      ],
      note: '已同意 ≠ 一定送达',
    },
  };
}

function pageWith(opts) {
  opts = opts || {};
  const page = loadPage('miniprogram/pages/map/index.js', {
    storage: Object.assign({ 'zhiyou-active-crew': 'crew-test' }, opts.storage || {}),
    api: Object.assign({
      'subscribe.status': statusResponse(opts.subscribed || []),
      'subscribe.report': { ok: true, data: { results: [], intents: [] } },
      'subscribe.revoke': { ok: true, data: { results: [] } },
    }, opts.api || {}),
    wx: Object.assign({
      requestSubscribeMessage: () => {},
    }, opts.wx || {}),
  });
  page.setData({ crewId: 'crew-test' });
  return page;
}

test('打开提醒面板时读服务端状态，模板 ID 来自服务端而不是前端写死', async () => {
  const page = pageWith({ subscribed: ['meet_created'] });
  try {
    page.toggleNotifyPanel();
    await flush();
    assert.equal(page.data.notifyPanelOpen, true);
    const rows = page.data.notifyRows;
    assert.equal(rows.length, 3);
    assert.equal(rows.find(r => r.kind === 'meet_created').subscribed, true);
    assert.equal(rows.find(r => r.kind === 'crew_message').subscribed, false);
    for (const row of rows) assert.equal(row.templateId, TEMPLATE_IDS[row.kind]);
    assert.match(page.data.notifyPolicyNote, /已同意 ≠ 一定送达/);
  } finally { page.restore(); }
});

test('点「开启」用服务端给的模板 ID 调 requestSubscribeMessage，accept 才记为同意', async () => {
  const requests = [];
  const page = pageWith({
    wx: {
      requestSubscribeMessage: (o) => {
        requests.push(o);
        o.success({ [TEMPLATE_IDS.crew_message]: 'accept' });
      },
    },
  });
  try {
    page.toggleNotifyPanel();
    await flush();
    page.requestNotify({ currentTarget: { dataset: { kind: 'crew_message' } } });
    await flush();

    assert.equal(requests.length, 1, '必须真的调用微信接口');
    assert.deepEqual(requests[0].tmplIds, [TEMPLATE_IDS.crew_message],
      '一次只请求用户点的那一类，不替用户批量订阅');

    const report = page.__calls.find(c => c.action === 'subscribe.report');
    assert.ok(report, '必须上报结果');
    assert.deepEqual(report.payload.results, [{ kind: 'crew_message', status: 'accept' }]);
    assert.match(page.data.notifyNote, /已开启/);
    assert.equal(page.data.notifyBusy, false);
  } finally { page.restore(); }
});

test('用户拒绝时上报 reject，界面不显示已开启，也不弹报错', async () => {
  const page = pageWith({
    wx: { requestSubscribeMessage: (o) => o.success({ [TEMPLATE_IDS.crew_message]: 'reject' }) },
  });
  try {
    page.toggleNotifyPanel();
    await flush();
    page.requestNotify({ currentTarget: { dataset: { kind: 'crew_message' } } });
    await flush();
    const report = page.__calls.find(c => c.action === 'subscribe.report');
    assert.deepEqual(report.payload.results, [{ kind: 'crew_message', status: 'reject' }]);
    assert.match(page.data.notifyNote, /没有开启/);
    // 拒绝不是错误：不得调用 subscribe.revoke，也不该留下"已开启"
    assert.equal(page.__calls.some(c => c.action === 'subscribe.revoke'), false);
    assert.equal(page.data.notifyRows.find(r => r.kind === 'crew_message').subscribed, false);
  } finally { page.restore(); }
});

test('接口失败（如 20004 永久拒绝）时不假装成功，如实提示', async () => {
  const page = pageWith({
    wx: { requestSubscribeMessage: (o) => o.fail({ errCode: 20004, errMsg: 'reject' }) },
  });
  try {
    page.toggleNotifyPanel();
    await flush();
    page.requestNotify({ currentTarget: { dataset: { kind: 'meet_created' } } });
    await flush();
    assert.match(page.data.notifyNote, /之前关闭过/);
    const report = page.__calls.find(c => c.action === 'subscribe.report');
    assert.equal(report.payload.results[0].status, 'reject');
  } finally { page.restore(); }
});

test('关闭提醒调用 subscribe.revoke，并回读状态', async () => {
  const page = pageWith({ subscribed: ['meet_created'] });
  try {
    page.toggleNotifyPanel();
    await flush();
    page.revokeNotify({ currentTarget: { dataset: { kind: 'meet_created' } } });
    await flush();
    const revoke = page.__calls.find(c => c.action === 'subscribe.revoke');
    assert.deepEqual(revoke.payload, { crewId: 'crew-test', kind: 'meet_created' });
    assert.equal(page.__calls.filter(c => c.action === 'subscribe.status').length >= 2, true);
    assert.match(page.data.notifyNote, /已关闭/);
  } finally { page.restore(); }
});

test('已读游标只在消息真的显示后推进，同一序号不重复写库', async () => {
  const marks = [];
  const page = loadPage('miniprogram/pages/map/index.js', {
    storage: { 'zhiyou-active-crew': 'crew-test' },
    api: {
      'chat.markRead': (payload) => { marks.push(payload); return { ok: true, data: { lastReadSeq: payload.seq } }; },
    },
  });
  try {
    page.setData({ crewId: 'crew-test' });
    page.chatPreviewVisible = true;
    // 模拟 preview 在"已渲染这一批"后回报的序号
    page.markChatRead(3);
    page.markChatRead(3);
    page.markChatRead(2);
    await flush();
    assert.deepEqual(marks.map(m => m.seq), [3], '同一/更小序号不得重复推进');

    page.markChatRead(5);
    await flush();
    assert.deepEqual(marks.map(m => m.seq), [3, 5], '更大的序号继续推进');
  } finally { page.restore(); }
});

test('通知落在同一队伍：不切换，只刷新（刷新本身会重新鉴权）', async () => {
  const page = pageWith({ api: { 'crew.get': { ok: true, data: { crew: { crewId: 'crew-test' }, members: [] } } } });
  try {
    const hit = page.applyNoticeLanding({ crewId: 'crew-test' });
    assert.equal(hit, true);
    await flush();
    assert.match(page.data.notifyNote, /已从提醒回到队伍/);
    assert.equal(page.__calls.some(c => c.action === 'crew.get'), true, '回队时必须重新鉴权');
    assert.equal(page.__storage['zhiyou-active-crew'], 'crew-test');
  } finally { page.restore(); }
});

test('通知落在别的队伍：先鉴权再切换，切换后按新队伍取数', async () => {
  const page = pageWith({
    api: {
      'crew.get': (payload) => payload.crewId === 'crew-other'
        ? { ok: true, data: { crew: { crewId: 'crew-other' }, members: [] } }
        : { ok: false, error: { code: 'FORBIDDEN_NOT_MEMBER', message: '不是成员' } },
    },
  });
  try {
    page.applyNoticeLanding({ crewId: 'crew-other', meetId: 'meet-1' });
    await flush();
    await flush();
    const verify = page.__calls.find(c => c.action === 'crew.get');
    assert.equal(verify.payload.crewId, 'crew-other', '必须先对目标队伍做鉴权');
    assert.equal(page.__storage['zhiyou-active-crew'], 'crew-other', '鉴权通过后才切换活动队伍');
    assert.equal(page.data.notifyLandingFailed, false);
    assert.match(page.data.notifyNote, /已切换到提醒对应的队伍|已从提醒进入队伍|集合/);
  } finally { page.restore(); }
});

test('目标队伍已不可访问：不切换、不放行内容，并给出返回入口', async () => {
  const page = pageWith({
    api: {
      'crew.get': { ok: false, error: { code: 'FORBIDDEN_NOT_MEMBER', message: '你不是该小队成员，或已退出' } },
    },
  });
  try {
    page.applyNoticeLanding({ crewId: 'crew-gone' });
    await flush();
    assert.equal(page.__storage['zhiyou-active-crew'], 'crew-test', '鉴权失败绝不改写活动队伍');
    assert.equal(page.data.notifyLandingFailed, true);
    assert.match(page.data.notifyNote, /已不可访问/);
    // 失效时给可点的返回入口，而不是把用户困在空页面
    page.openTeamSettings();
    assert.deepEqual(page.__wx.find(c => c.fn === 'switchTab').args, { url: '/pages/profile/index' });
  } finally { page.restore(); }
});

test('集合已结束时不假装定位到集合，如实说明', async () => {
  const page = pageWith({
    api: {
      'crew.get': { ok: true, data: { crew: { crewId: 'crew-other' }, members: [] } },
    },
  });
  try {
    page.setData({ meetTask: null });
    page.confirmNoticeMeetLanding('meet-gone');
    assert.match(page.data.notifyNote, /已结束或已取消/);

    page.setData({ meetTask: { meetTaskId: 'meet-live' } });
    page.confirmNoticeMeetLanding('meet-live');
    assert.match(page.data.notifyNote, /已定位到这次集合/);
  } finally { page.restore(); }
});

test('同一次落地不重复处理，避免打断用户操作', async () => {
  const page = pageWith({ api: { 'crew.get': { ok: true, data: { crew: {}, members: [] } } } });
  try {
    page.applyNoticeLanding({ crewId: 'crew-other' });
    await flush();
    const first = page.__calls.filter(c => c.action === 'crew.get').length;
    page.applyNoticeLanding({ crewId: 'crew-other' });
    await flush();
    assert.equal(page.__calls.filter(c => c.action === 'crew.get').length, first, '同一落地只处理一次');
  } finally { page.restore(); }
});

test('冷启动落地参数走 storage 兜底，且读完即清、超时丢弃', () => {
  const fresh = pageWith({
    storage: {
      'zhiyou-notice-landing': { crewId: 'crew-other', meetId: 'meet-9', at: Date.now() },
    },
  });
  try {
    const landing = fresh.readNoticeLanding();
    assert.equal(landing.crewId, 'crew-other'); assert.equal(landing.meetId, 'meet-9');
    assert.equal(typeof landing.at, 'number', '保留点击事件时间，允许稍后再次点击同队通知');
    assert.equal('zhiyou-notice-landing' in fresh.__storage, false, '读完必须清掉，否则下次自己打开又被带过去');
  } finally { fresh.restore(); }

  const stale = pageWith({
    storage: {
      'zhiyou-notice-landing': { crewId: 'crew-old', meetId: '', at: Date.now() - 10 * 60 * 1000 },
    },
  });
  try {
    assert.equal(stale.readNoticeLanding(), null, '过期锚点不能再执行');
  } finally { stale.restore(); }
});

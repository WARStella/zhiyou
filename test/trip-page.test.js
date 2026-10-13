'use strict';

/**
 * 行程页的数据流测试。
 *
 * 补上前端的空白 —— 后端有 200 项测试，前端此前一项都没有，
 * 于是所有界面问题都得等用户在真机上撞见。
 *
 * **不模拟渲染**，只验证"调了这个方法之后 data 对不对"。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadPage, node } = require('./page-harness');

const PLAN_NODES = [
  node('n0', '哈尔滨工业大学', 'pending', 0),
  node('n1', '哈尔滨冰雪大世界', 'pending', 1),
];

/** 造一个已生成行程的页面 */
function pageWithTrip(over) {
  const page = loadPage('miniprogram/pages/trip/index.js', over);
  page.applyTrip(
    Object.assign(
      {
        tripId: 't1',
        version: 1,
        nodes: PLAN_NODES,
        saved: true,
        summary: { endAt: '2026-10-20T05:00:00.000Z', totalWalkMin: 8, totalStayMin: 90, totalWalkMeters: 620 },
        startPoint: { latitude: 45.75, longitude: 126.6, label: '我的位置' },
        startLeg: { minutes: 12, meters: 900, source: 'survey', toPlaceName: '哈尔滨工业大学' },
        walkTimes: { mapApiCalls: 1, bySource: { survey: 1, upstream: 0, estimated: 0 }, failures: [], note: '' },
      },
      over && over.tripData
    ),
    ''
  );
  return page;
}

// ── 出发段 ────────────────────────────────────────────────

test('生成路线后，时间轴第一站之前必须有出发段', () => {
  /**
   * ⚠️ 用户反馈（2026-10-13）："生成路径后在第一个目标前没有出行方式"。
   *
   * 后端一直有算这段（`startLeg`），界面也画了 —— 但它是一张**独立卡片**，
   * 位置在概览之下、地图之上，**离时间轴很远**，读起来不像"第一站之前那一段"。
   * 而站点之间是画在时间轴里的，两处不一致。
   */
  const page = pageWithTrip();
  assert.ok(page.data.startLeg, '后端给了 startLeg，界面必须留着');
  assert.equal(page.data.startLeg.minutes, 12);
  assert.equal(page.data.startLeg.toName, '哈尔滨工业大学');

  // 时间轴第一项之前要有出发段的位置（由界面按 startLeg 渲染）
  assert.equal(page.data.timeline[0].seq, 1);
});

test('没有起点时不编造出发段 —— 宁可不说，也不能假装人已在门口', () => {
  const page = pageWithTrip({
    tripData: { startPoint: null, startLeg: null },
  });
  assert.equal(page.data.startLeg, null);
});

// ── 记录进度后的刷新 ──────────────────────────────────────

test('点「逛完了」之后，地图上的进度必须跟着变', async () => {
  /**
   * ⚠️ 用户反馈（2026-10-13）："点击逛完了以后在地图上方的当前状态没有更新"。
   *
   * 这条测试盯住整条数据流：
   *   nodeProgress → rawNodes 更新 → rebuildFromNodes → routeMap
   *
   * 任何一环断了，这里都会红。
   */
  const page = pageWithTrip({
    api: {
      'trip.progress': (payload, options) => {
        assert.equal(payload.status, 'done');
        assert.equal(options.expectedVersion, 1, 'expectedVersion 必须走信封层');
        const next = JSON.parse(JSON.stringify(PLAN_NODES));
        next[0].status = 'done';
        return { ok: true, data: { tripId: 't1', version: 2, nodes: next } };
      },
    },
  });

  assert.equal(page.data.routeMap.reachedCount, 0, '初始应当 0');
  assert.equal(page.data.routeMap.totalCount, 2);
  assert.equal(page.data.routeMap.nextName, '哈尔滨工业大学', '一开始下一站就是第一站');

  page.nodeProgress({ currentTarget: { dataset: { nodeid: 'n0', status: 'done' } } });
  await new Promise((r) => setImmediate(r));

  // ① 原始节点更新了
  assert.equal(page.data.rawNodes[0].status, 'done', 'rawNodes 必须更新');
  // ② 时间轴更新了
  assert.equal(page.data.timeline[0].status, 'done');
  assert.equal(page.data.timeline[0].visited, true);
  // ③ 地图与概览上的进度都更新了（用户反馈的就是这一项）
  assert.equal(page.data.routeMap.reachedCount, 1, '「已走过 X / Y 站」必须刷新');
  assert.equal(page.data.routeMap.nextName, '哈尔滨冰雪大世界', '下一站要顺延');
  // ④ 版本推进了
  assert.equal(page.data.trip.version, 2);
});

test('全部走完后，下一站为空并给出"全部走完"', async () => {
  const page = pageWithTrip({
    api: {
      'trip.progress': () => {
        const next = JSON.parse(JSON.stringify(PLAN_NODES));
        next[0].status = 'done';
        next[1].status = 'done';
        return { ok: true, data: { tripId: 't1', version: 2, nodes: next } };
      },
    },
  });

  page.nodeProgress({ currentTarget: { dataset: { nodeid: 'n1', status: 'done' } } });
  await new Promise((r) => setImmediate(r));

  assert.equal(page.data.routeMap.reachedCount, 2);
  assert.equal(page.data.routeMap.nextName, null, '没有下一站了，不能瞎指一个');
});

test('点「到了」也算走到过 —— 不用非等到「逛完了」', async () => {
  const page = pageWithTrip({
    api: {
      'trip.progress': () => {
        const next = JSON.parse(JSON.stringify(PLAN_NODES));
        next[0].status = 'arrived';
        return { ok: true, data: { tripId: 't1', version: 2, nodes: next } };
      },
    },
  });

  page.nodeProgress({ currentTarget: { dataset: { nodeid: 'n0', status: 'arrived' } } });
  await new Promise((r) => setImmediate(r));

  assert.equal(page.data.routeMap.reachedCount, 1);
  assert.equal(page.data.timeline[0].visited, true, '到了就算到过');
});

test('进度接口失败时如实报错，不能悄悄不动', async () => {
  const page = pageWithTrip({
    api: {
      'trip.progress': () => ({
        ok: false,
        error: { code: 'VERSION_CONFLICT', message: '行程已被更新' },
      }),
    },
  });

  page.nodeProgress({ currentTarget: { dataset: { nodeid: 'n0', status: 'done' } } });
  await new Promise((r) => setImmediate(r));

  assert.match(page.data.error, /重新生成/, '版本冲突要给可执行的指引');
  assert.equal(page.data.routeMap.reachedCount, 0, '失败就不能改界面');
});

// ── 出行段的位置 ──────────────────────────────────────────

test('出行段必须挂在"本节点 → 下一节点"上，末节点为 null', () => {
  /**
   * ⚠️ 用户反馈（2026-10-13）："点击逛完了以后中间的出行方式也会显示已走过"。
   *
   * 判据反了：首版用"**本节点**走完了"判断"本节点→下一节点 这段走过了"。
   * 点完 1 号的「逛完了」，你还没走到 2 号 —— 那一段当然没走过。
   * 正确判据是**下一站到了没有**。
   */
  const page = pageWithTrip();

  assert.equal(page.data.timeline[0].legToNext.minutes, 8, '第一项的出行段是它到第二项');
  assert.equal(page.data.timeline[1].legToNext, null, '末节点没有下一段');
  assert.equal(page.data.timeline[0].legToNext.visited, false, '下一站没到，这段就没走过');
});

test('到了下一站，上一段才显示"已走过"', async () => {
  const page = pageWithTrip({
    api: {
      'trip.progress': () => {
        const next = JSON.parse(JSON.stringify(PLAN_NODES));
        next[1].status = 'arrived';
        return { ok: true, data: { tripId: 't1', version: 2, nodes: next } };
      },
    },
  });

  page.nodeProgress({ currentTarget: { dataset: { nodeid: 'n1', status: 'arrived' } } });
  await new Promise((r) => setImmediate(r));

  assert.equal(page.data.timeline[0].legToNext.visited, true, '到了第二站，1→2 这段才算走过');
});

// ── 当前路线（概览与地图之间的顺序链）─────────────────────

test('当前路线链的数据来自 timeline + startLeg，且要能反映进度', async () => {
  /**
   * 用户要求（2026-10-13）："在路线概览和路线地图中间显示当前路线"。
   *
   * 概览给的是数字，地图给的是"在哪"，中间缺一条"按什么顺序走"。
   * 这条链**不新增数据源** —— 直接渲染 timeline 与 startLeg，
   * 所以它天然与时间轴、地图三处一致。
   */
  const page = pageWithTrip({
    api: {
      'trip.progress': () => {
        const next = JSON.parse(JSON.stringify(PLAN_NODES));
        next[0].status = 'done';
        next[1].status = 'arrived';
        return { ok: true, data: { tripId: 't1', version: 2, nodes: next } };
      },
    },
  });

  // 链需要的字段一个都不能少
  for (const t of page.data.timeline) {
    assert.equal(typeof t.seq, 'number', '链上要显示序号');
    assert.equal(typeof t.placeName, 'string');
    assert.equal(typeof t.visited, 'boolean', '链的颜色靠它');
    assert.equal(typeof t.isCurrent, 'boolean', '当前站的橙色靠它');
    assert.equal(typeof t.isLast, 'boolean', '末站后面不加箭头');
  }
  assert.ok(page.data.startLeg.label, '链的起点要用 startLeg.label');
  assert.equal(page.data.timeline[0].visited, false);

  page.nodeProgress({ currentTarget: { dataset: { nodeid: 'n0', status: 'done' } } });
  await new Promise((r) => setImmediate(r));

  assert.equal(page.data.timeline[0].visited, true, '第一站变绿');
  assert.equal(page.data.timeline[1].isCurrent, true, '第二站变当前站');
  assert.equal(page.data.timeline[1].visited, true, '到了也算走过');
});

test('点链上的某一站要能跳到它 —— 跳转方法必须存在', () => {
  const page = pageWithTrip();
  assert.equal(typeof page.jumpToNode, 'function', 'wxml 里绑了 jumpToNode，缺了会静默不响应');

  const scrolls = [];
  global.wx = { pageScrollTo: (a) => scrolls.push(a) };
  page.jumpToNode({ currentTarget: { dataset: { nodeid: 'n1' } } });
  delete global.wx;

  assert.equal(scrolls.length, 1);
  assert.match(scrolls[0].selector, /n1/, '要滚到对应节点');
});

// ── 预选理由 ──────────────────────────────────────────────

test('预选要说明"为什么是它"，搜不到的词也要如实说', () => {
  const page = loadPage('miniprogram/pages/trip/index.js', {});
  page.setData({
    candidates: [
      { placeId: 'p1', name: '哈尔滨工业大学', category: '教育', verified: true },
      { placeId: 'p2', name: '哈工大科技园', category: '景点', verified: true },
    ],
  });

  page.applyAutoSelect(page.data.candidates, {
    placeIds: ['p1'],
    items: [{ placeId: 'p1', name: '哈尔滨工业大学', reason: '你提到的「哈工大」' }],
    note: '按「正常」节奏预选 1 个地点',
    keywordsMissing: ['哈学院'],
  });

  assert.equal(page.data.selected.length, 1);
  assert.equal(
    page.data.selected[0].reason,
    '你提到的「哈工大」',
    '系统替用户选了地方，就必须说清依据'
  );
  assert.match(page.data.note, /没找到.*哈学院/, '搜不到的词不能说成找到了');
});

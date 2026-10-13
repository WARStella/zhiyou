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

// ── 当前路线 = 这一段怎么走 ───────────────────────────────

test('当前路线显示的是**出行方式与距离**，不是"站的顺序"', () => {
  /**
   * 用户澄清（2026-10-13）："当前路线应该是当前的出行方式和距离"。
   *
   * 首版做成了"站点顺序链" —— 那是**计划**；
   * 行走时真正要看的是"**这一段怎么走、多远、多久**"，
   * 也正是导航需要的全部输入。
   */
  const page = pageWithTrip();
  const leg = page.data.currentLeg;

  assert.ok(leg, '还没出发时也应当有当前段（我的位置 → 第 1 站）');
  assert.equal(leg.from, '我的位置');
  assert.equal(leg.to, '哈尔滨工业大学');
  assert.equal(leg.mode, '步行', '出行方式');
  assert.equal(leg.minutes, 12, '时长');
  assert.equal(leg.meters, 900, '距离');
  assert.equal(leg.isStart, true);
  assert.equal(leg.legIndex, 1);
  assert.equal(leg.totalLegs, 2);
});

test('当前段必须带目的地坐标 —— 导航要用', () => {
  const page = pageWithTrip();
  const leg = page.data.currentLeg;
  assert.ok(leg.toLocation, '没有坐标就没法导航');
  assert.equal(typeof leg.toLocation.latitude, 'number');
  assert.equal(typeof leg.toLocation.longitude, 'number');
  assert.ok(leg.toPlaceId, '也要能对应回地点');
});

test('走完一站后，当前段换成"从这一站去下一站"', async () => {
  const page = pageWithTrip({
    api: {
      'trip.progress': () => {
        const next = JSON.parse(JSON.stringify(PLAN_NODES));
        next[0].status = 'done';
        return { ok: true, data: { tripId: 't1', version: 2, nodes: next } };
      },
    },
  });

  assert.equal(page.data.currentLeg.from, '我的位置', '出发前是"我的位置"');

  page.nodeProgress({ currentTarget: { dataset: { nodeid: 'n0', status: 'done' } } });
  await new Promise((r) => setImmediate(r));

  const leg = page.data.currentLeg;
  assert.equal(leg.from, '哈尔滨工业大学', '走完第 1 站后，从这一站算起');
  assert.equal(leg.to, '哈尔滨冰雪大世界');
  assert.equal(leg.minutes, 8, '用这一段的真实数据（第二站的 travelFromPrev*）');
  assert.equal(leg.meters, 620);
  assert.equal(leg.isStart, false);
  assert.equal(leg.legIndex, 2);
});

test('全部走完后当前段为空，不瞎指一段', async () => {
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

  assert.equal(page.data.currentLeg, null, '走完了就没有"当前段"了');
});

test('直线估算出来的段要标出来 —— 它与真实路线能差 7 倍', async () => {
  const estimates = JSON.parse(JSON.stringify(PLAN_NODES));
  estimates[1].travelSource = 'estimated';

  const page = pageWithTrip({ api: {} });
  page.setData({ rawNodes: estimates });
  page.rebuildFromNodes();
  // 还没走过任何站，当前段是出发段；手动走到第 1 站来检查第二段
  estimates[0].status = 'done';
  page.setData({ rawNodes: estimates });
  page.rebuildFromNodes();

  assert.equal(page.data.currentLeg.estimated, true, '估算必须标出来');
});

test('「用微信地图打开」要把目的地交给 wx.openLocation', () => {
  const opened = [];
  const page = pageWithTrip({ wx: { openLocation: (a) => opened.push(a) } });

  page.openInWechatMap();

  assert.equal(opened.length, 1, '应当调用一次');
  assert.equal(opened[0].name, '哈尔滨工业大学');
  assert.equal(typeof opened[0].latitude, 'number');
});

test('没有坐标时提示而不是静默失败', () => {
  const toasts = [];
  const page = pageWithTrip({ wx: { showToast: (a) => toasts.push(a) } });
  page.setData({ currentLeg: { to: '某地', toLocation: null } });

  page.openInWechatMap();

  assert.equal(toasts.length, 1, '要说清为什么打不开');
  assert.match(toasts[0].title, /坐标/);
});

// ── 内置导航 ──────────────────────────────────────────────

test('开始导航：取真实路线，并画在地图上（不是直线示意）', async () => {
  /**
   * 用户问（2026-10-13）："不能内置导航吗"。
   *
   * 能 —— 腾讯的步行路线接口返回 `polyline`（差分压缩）与 `steps`
   * （**中文转向指引原话**），解码规则已用真实录音确认
   * （见 test/polyline.test.js）。
   */
  const page = pageWithTrip({
    api: {
      'trip.legRoute': () => ({
        ok: true,
        data: {
          ok: true,
          placeName: '哈尔滨工业大学',
          legIndex: 1,
          totalLegs: 2,
          distanceMeters: 815,
          durationMinutes: 12,
          from: { latitude: 45.7755, longitude: 126.6172 },
          to: { latitude: 45.781, longitude: 126.6185, name: '哈尔滨工业大学' },
          route: {
            decoded: true,
            pointCount: 3,
            points: [
              { latitude: 45.7755, longitude: 126.6172 },
              { latitude: 45.7782, longitude: 126.6178 },
              { latitude: 45.781, longitude: 126.6185 },
            ],
            steps: [
              { seq: 1, instruction: '从起点朝西北行进62米右转进入上游街', distanceMeters: 62 },
              { seq: 2, instruction: '沿上游街行进110米左转进入中央大街', distanceMeters: 110 },
            ],
          },
        },
      }),
    },
  });

  assert.equal(page.data.navLeg, null, '一开始不在导航状态');

  page.startNavigation();
  await new Promise((r) => setImmediate(r));

  const nav = page.data.navLeg;
  assert.ok(nav, '应当进入导航状态');
  assert.equal(nav.decoded, true);
  assert.equal(nav.steps.length, 2);
  assert.equal(nav.steps[0].instruction, '从起点朝西北行进62米右转进入上游街');

  // 地图上要画**真实路径**，不是两个点之间的直线
  assert.equal(page.data.routeMap.navMode, true, '地图要进入导航模式');
  assert.equal(page.data.routeMap.polyline[0].points.length, 3, '画的是解码后的真实路径');
  assert.match(page.data.routeMap.legend, /真实步行路径/);
});

test('导航失败时如实报错，不画一条假线', async () => {
  const page = pageWithTrip({
    api: {
      'trip.legRoute': () => ({
        ok: true,
        data: { ok: false, reason: 'UPSTREAM_STATUS_121', message: '每日调用量已达上限', hint: '去控制台看配额' },
      }),
    },
  });

  page.startNavigation();
  await new Promise((r) => setImmediate(r));

  assert.equal(page.data.navLeg, null, '失败就不能进导航状态');
  assert.match(page.data.navError, /上限/);
  assert.match(page.data.navHint, /配额/);
  assert.equal(page.data.routeMap.navMode, undefined, '地图留在原来的示意模式');
});

test('上游没给路径点时，画不出线也要说清楚', async () => {
  const page = pageWithTrip({
    api: {
      'trip.legRoute': () => ({
        ok: true,
        data: {
          ok: true,
          placeName: 'X',
          distanceMeters: 100,
          durationMinutes: 2,
          to: { latitude: 45.78, longitude: 126.62 },
          route: { decoded: false, pointCount: 0, points: [], steps: [] },
        },
      }),
    },
  });

  page.startNavigation();
  await new Promise((r) => setImmediate(r));

  assert.equal(page.data.navLeg.decoded, false);
  assert.match(page.data.navError, /不用直线冒充/, '要说清为什么地图上没有线');
});

test('退出导航后地图回到整条路线的示意', async () => {
  const page = pageWithTrip({
    api: {
      'trip.legRoute': () => ({
        ok: true,
        data: {
          ok: true,
          placeName: 'A',
          to: { latitude: 45.78, longitude: 126.62 },
          route: {
            decoded: true,
            pointCount: 2,
            points: [
              { latitude: 45.7755, longitude: 126.6172 },
              { latitude: 45.781, longitude: 126.6185 },
            ],
            steps: [],
          },
        },
      }),
    },
  });

  page.startNavigation();
  await new Promise((r) => setImmediate(r));
  assert.equal(page.data.routeMap.navMode, true);

  page.stopNavigation();
  assert.equal(page.data.navLeg, null);
  assert.equal(page.data.routeMap.navMode, undefined, '要回到示意模式');
});

// ── 预选理由 ──────────────────────────────────────────────

test('预选要说明"为什么是它"，搜不到的词也要如实说', () => {
  const page = loadPage('miniprogram/pages/trip/index.js', {});
  page.setData({
    candidates: [
      { itemId: 'p1', name: '哈尔滨工业大学', category: '教育', verified: true },
      { itemId: 'p2', name: '哈工大科技园', category: '景点', verified: true },
    ],
  });

  page.applyAutoSelect(page.data.candidates, {
    itemIds: ['p1'],
    items: [{ itemId: 'p1', name: '哈尔滨工业大学', reason: '你提到的「哈工大」' }],
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

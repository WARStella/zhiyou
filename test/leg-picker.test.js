'use strict';

/**
 * 逐段出行方式选择（2026-10-14 用户要求）。
 *
 * 用户原话："我希望的是在点击生成路径后会出现界面让用户分别选择每段路径的出行方式"
 * 以及 "并在推荐的出行方式边上打出小小的推荐字样"。
 *
 * ── 两条设计决定（都被下面的测试钉住）──────────────────────
 *
 * ① **候选用"系统自己的推荐"标记，不受用户偏好影响。**
 *    否则用户选了什么就推荐什么，那个"推荐"字样毫无信息量。
 *
 * ② **逐段选择的应用方式是"再规划一次"**，不是改那行文字 ——
 *    换一种方式会改后续每站的到达时间、总步行量与硬约束检查。
 *    但候选耗时已在第一次规划时取到，所以不额外消耗配额。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { legTravelTimes } = require('../cloudfunctions/api/lib/leg-times');
const { loadPage, node } = require('./page-harness');

/** 三种方式都可用的矩阵替身 */
function matrix() {
  const v = {
    walking: { minutes: 94, meters: 7059 },
    bicycling: { minutes: 29, meters: 7200 },
    driving: { minutes: 18, meters: 9000 },
  };
  return {
    async distanceMatrix(from, tos, mode) {
      const x = v[mode];
      return {
        ok: true,
        elements: [
          {
            usable: true,
            distanceMeters: x.meters,
            durationMinutes: x.minutes,
            durationRaw: x.minutes * 60,
            unitCheck: { plausible: true, unit: 'seconds' },
          },
        ],
      };
    },
  };
}

const FROM = { latitude: 45.7756, longitude: 126.6175 };
const TO = { _id: 'p_x', name: 'X', location: { latitude: 45.8029, longitude: 126.5353 } };

async function oneLeg(opts) {
  return legTravelTimes({ fromPoint: FROM, toPlace: TO, providers: { map: matrix(), transit: null }, opts: opts || {} });
}

// ── 候选项与"推荐"标记 ─────────────────────────────────────

test('每段都给出**完整的候选清单**，而不只是选中的那个', async () => {
  const r = await oneLeg();
  const modes = r.options.map((o) => o.mode).sort();
  assert.deepEqual(modes, ['bicycling', 'driving', 'walking'], '用户要能挑，所以候选都要给');
});

test('"推荐"是**系统自己的判断**（最快），不受用户偏好影响', async () => {
  /**
   * ⚠️ 这是"推荐"字样有意义的前提。
   *
   * 若按用户偏好算推荐，那么用户选步行 → 步行被标"推荐" →
   * 然后系统又说"你选的就是推荐" → 这个标签什么都没告诉他。
   */
  const auto = await oneLeg();
  assert.equal(auto.recommendedMode, 'driving', '不选时推荐最快的');

  const picked = await oneLeg({ preferredMode: 'walking' });
  assert.equal(picked.choice.chosen.mode, 'walking', '听用户的');
  assert.equal(picked.recommendedMode, 'driving', '但"推荐"仍应指向最快的 —— 这才是信息');

  const walkOpt = picked.options.find((o) => o.mode === 'walking');
  const driveOpt = picked.options.find((o) => o.mode === 'driving');
  assert.equal(walkOpt.isRecommended, false, '用户选的不是系统推荐');
  assert.equal(driveOpt.isRecommended, true);
});

test('候选项带耗时与公交换乘细节 —— 用户要能据以比较', async () => {
  const r = await oneLeg();
  for (const o of r.options) {
    assert.equal(typeof o.minutes, 'number', `${o.mode} 要有耗时`);
    assert.ok(o.modeLabel, `${o.mode} 要有人看得懂的名字`);
  }
});

test('取不到的方式**仍然列出**，并说明为什么不能选', async () => {
  /**
   * ⚠️ 用户看到"什么都没有"和看到"公交：××原因"是两回事 ——
   * 后者他知道该去做什么。
   *
   * 断言放宽到"能行动的原因"而不是死抠某一句：注入与不注入 provider
   * 会给出不同的原因（"服务未接入" / "未配置 AMAP_KEY"），
   * 两者都具体、都可行动。**钉死其中一句会让另一个环境下的正确行为失败。**
   */
  const r = await oneLeg({ transitCity: '0451' });
  assert.ok(r.unavailable.length > 0, '公交没接入时要留下痕迹');
  const transit = r.unavailable.find((u) => u.mode === 'transit');
  assert.ok(transit, '公交要在不可用清单里');
  assert.match(transit.reason, /AMAP_KEY|未接入|未配置/, '原因要具体到能行动');
});

// ── 逐段覆盖 ───────────────────────────────────────────────

test('逐段指定的方式优先于全局偏好', async () => {
  const r = await oneLeg({ preferredMode: 'driving', legModes: { p_x: 'walking' } });
  assert.equal(r.choice.chosen.mode, 'walking', '逐段 > 全局');
});

test('逐段指定的方式不可用时，给最快的并说清原因', async () => {
  /** 只提供驾车，「这一程要步行」就走不通 */
  const onlyDriving = {
    async distanceMatrix(from, tos, mode) {
      if (mode !== 'driving') {
        return { ok: true, elements: [{ usable: false, failureReason: 'NO_ROAD_NEARBY', distanceMeters: null, durationMinutes: null }] };
      }
      return {
        ok: true,
        elements: [{ usable: true, distanceMeters: 9000, durationMinutes: 18, durationRaw: 1080, unitCheck: { plausible: true, unit: 'seconds' } }],
      };
    },
  };
  const r = await legTravelTimes({
    fromPoint: FROM,
    toPlace: TO,
    providers: { map: onlyDriving, transit: null },
    opts: { legModes: { p_x: 'walking' } },
  });

  assert.equal(r.choice.chosen.mode, 'driving');
  assert.equal(r.choice.matchedPreference, false);
  assert.match(r.choice.reason, /你想用步行/, '要说清他要的是什么');
  assert.match(r.choice.reason, /已改为驾车/, '也要说清给了什么');
});

test('认不出的逐段值一律忽略，不让规划失败', async () => {
  const r = await oneLeg({ legModes: { p_x: 'teleport' } });
  assert.equal(r.choice.chosen.mode, 'driving', '退回最快优先');
  /** auto 也一样 —— 它是"没表态"，不算指定 */
  const r2 = await oneLeg({ legModes: { p_x: 'auto' } });
  assert.equal(r2.choice.chosen.mode, 'driving');
});

// ── 页面层 ─────────────────────────────────────────────────

/** 造一个已生成行程的页面，并带上 legOptions */
function pageWithLegOptions(legOptions, over) {
  const page = loadPage('miniprogram/pages/trip/index.js', over || {});
  page.applyTrip(
    {
      tripId: 't1',
      version: 1,
      nodes: [node('n0', '哈工大', 'pending', 0), node('n1', '冰雪大世界', 'pending', 1)],
      saved: true,
      summary: { endAt: '2026-10-20T05:00:00.000Z', totalWalkMin: 8, totalStayMin: 90, totalWalkMeters: 620 },
      startPoint: { latitude: 45.75, longitude: 126.6, label: '我的位置' },
      startLeg: { minutes: 12, meters: 900, source: 'survey', mode: 'walking', toPlaceName: '哈工大' },
      walkTimes: { mapApiCalls: 1, bySource: { survey: 1 }, failures: [], note: '' },
      legOptions: legOptions,
    },
    ''
  )
  return page
}

const LEG_OPTIONS = [
  {
    toPlaceId: 'p_n0',
    toPlaceName: '哈工大',
    isFirstLeg: true,
    chosenMode: 'driving',
    recommendedMode: 'driving',
    options: [
      { mode: 'walking', minutes: 94, isRecommended: false },
      { mode: 'bicycling', minutes: 29, isRecommended: false },
      { mode: 'driving', minutes: 18, isRecommended: true },
    ],
    unavailable: [],
  },
  {
    toPlaceId: 'p_n1',
    toPlaceName: '冰雪大世界',
    fromPlaceName: '哈工大',
    chosenMode: 'transit',
    recommendedMode: 'transit',
    options: [
      { mode: 'transit', minutes: 42, isRecommended: true, transit: { lineNames: ['地铁2号线'], entranceName: '1号口', exitName: '3号口' } },
      { mode: 'driving', minutes: 20, isRecommended: false },
    ],
    unavailable: [{ mode: 'walking', modeLabel: '步行', reason: '直线约 17225 米，超过步行上限 3000 米' }],
  },
]

test('页面把 legOptions 整理成逐段选择器，并保留"推荐"标记', () => {
  const page = pageWithLegOptions(LEG_OPTIONS);
  const picker = page.data.legPicker;

  assert.equal(picker.length, 2, '两段');
  assert.equal(picker[0].fromName, '我的位置', '第一段的起点是"我的位置"');
  assert.equal(picker[1].fromName, '哈工大', '第二段从上一站出发');
  assert.equal(picker[0].selected, 'driving', '保持当前生效的方式');
  assert.equal(picker[0].selectedLabel, '驾车');

  const rec = picker[0].options.filter((o) => o.recommended);
  assert.equal(rec.length, 1, '恰好一个被标为推荐');
  assert.equal(rec[0].mode, 'driving');
});

test('公交候选带上换乘细节 —— 用户要能据以比较', () => {
  const page = pageWithLegOptions(LEG_OPTIONS);
  const transit = page.data.legPicker[1].options.find((o) => o.mode === 'transit');
  assert.match(transit.transitText, /地铁2号线/);
  assert.equal(transit.transitText, '地铁2号线 票价未知');
});

test('取不到的方式跟着那一段走 —— 用户能看懂"为什么不能选步行"', () => {
  const page = pageWithLegOptions(LEG_OPTIONS);
  assert.equal(page.data.legPicker[1].unavailable.length, 1);
  assert.match(page.data.legPicker[1].unavailable[0].reason, /超过步行上限/);
});

test('点选只改本地状态，**不发请求** —— 边选边重排会让界面一直跳', () => {
  const page = pageWithLegOptions(LEG_OPTIONS);
  const before = page.__calls.length;

  page.onLegModeTap({ currentTarget: { dataset: { placeid: 'p_n0', mode: 'walking' } } });

  assert.equal(page.data.legModes.p_n0, 'walking', '要记住选择');
  assert.equal(page.__calls.length, before, '不该发任何请求');
  const row = page.data.legPicker.find((r) => r.toPlaceId === 'p_n0');
  assert.equal(row.selected, 'walking');
  assert.equal(row.selectedLabel, '步行');
  /** 选中态要就地更新，否则用户看不到自己点了什么 */
  assert.equal(row.options.find((o) => o.mode === 'walking').isCurrent, true);
  assert.equal(row.options.find((o) => o.mode === 'driving').isCurrent, false);
});

test('"推荐"标记不因用户点选而改变 —— 它是系统的判断', () => {
  const page = pageWithLegOptions(LEG_OPTIONS);
  page.onLegModeTap({ currentTarget: { dataset: { placeid: 'p_n0', mode: 'walking' } } });

  const row = page.data.legPicker.find((r) => r.toPlaceId === 'p_n0');
  assert.equal(row.options.find((o) => o.mode === 'driving').recommended, true, '推荐仍在驾车');
  assert.equal(row.options.find((o) => o.mode === 'walking').recommended, false);
});

test('恢复推荐：清掉所有逐段选择，回到系统挑的', () => {
  const page = pageWithLegOptions(LEG_OPTIONS);
  page.onLegModeTap({ currentTarget: { dataset: { placeid: 'p_n0', mode: 'walking' } } });
  assert.equal(page.data.legModes.p_n0, 'walking');

  page.resetLegModes();

  assert.deepEqual(page.data.legModes, {}, '清空逐段选择');
  assert.equal(page.data.legPicker[0].selected, 'driving', '回到系统挑的');
});

test('没有 legOptions 时选择器为空，不报错', () => {
  const page = pageWithLegOptions([]);
  assert.deepEqual(page.data.legPicker, []);
  /**
   * ⚠️ 关键：**卡片不能因此消失**。
   *
   * 原来模板写的是 `wx:if="{{legPicker.length}}"` —— 为空时整块静默隐藏，
   * 用户点完生成路线看不到任何东西，也分不清"没有可选的方式"与
   * "功能没生效（比如云函数没重新部署）"。
   *
   * 用户实测报的正是这个："我点击生成路线时还是没有让我选择出行方式啊"。
   */
  assert.equal(page.data.legOptionsCount, 0, '要能区分"没返回字段"与"返回了但每段没候选"');
});

test('**换了目的地**就重新弹出方式选择器 —— 这正是用户报的现象', () => {
  /**
   * ⚠️ 这条断言**改过三次方向**，每一次都是用户的真实要求：
   *
   *   ① "点击生成路径后会出现界面让用户分别选择每段路径的出行方式"
   *      → 于是每次生成都展开
   *   ② "其它卡面均折叠，页面移到地图卡面居中"
   *      → 于是改回收起（地图才是生成后的视觉焦点）
   *   ③ "搜完哈工大再**重新选择路径选冰雪大世界**后还是骑行，
   *      **没有让我选择出行方式**"
   *      → 于是改成"**换了地点才弹**"
   *
   * ①与②看着矛盾，③指出了调和它们的判据：**地点集合变了没有**。
   *   · 换了目的地 → 出行方式的答案完全不同（骑车去哈工大合适，
   *     骑车去 14 公里外的冰雪大世界就不合适了）→ **必须重新问**；
   *   · 同一批地点内部重排（记录进度、多停一会儿）→ 保持原选择，
   *     否则每次都弹开，用户刚调好的方式还会被顶掉。
   */
  const page = pageWithLegOptions(LEG_OPTIONS);
  assert.equal(page.data.legPickerOpen, true, '第一次生成就该问（地点是新的）');
  assert.equal(page.data.legPicker.length, 2, '两段都要有候选');

  /** 用户看过就收起 */
  page.toggleLegPicker();
  assert.equal(page.data.legPickerOpen, false);

  /** 同一批地点再生成一次（比如记录了一次到达）→ **不该**再弹 */
  page.applyTrip(
    {
      tripId: 't1',
      version: 2,
      nodes: [node('n0', '哈工大', 'arrived', 0), node('n1', '冰雪大世界', 'pending', 1)],
      saved: true,
      summary: { endAt: '2026-10-20T05:00:00.000Z', totalWalkMin: 8, totalStayMin: 90 },
      startPoint: { latitude: 45.75, longitude: 126.6 },
      startLeg: { minutes: 12, meters: 900, mode: 'walking', toPlaceName: '哈工大' },
      legOptions: LEG_OPTIONS,
    },
    ''
  );
  assert.equal(page.data.legPickerOpen, false, '同一批地点内部重排不该重新弹开');

  /** **换成别的地方** → 必须重新弹 */
  page.applyTrip(
    {
      tripId: 't2',
      version: 3,
      nodes: [node('n9', '冰雪大世界', 'pending', 0)],
      saved: true,
      summary: { endAt: '2026-10-20T05:00:00.000Z', totalWalkMin: 8, totalStayMin: 90 },
      startPoint: { latitude: 45.75, longitude: 126.6 },
      startLeg: { minutes: 12, meters: 900, mode: 'walking', toPlaceName: '冰雪大世界' },
      legOptions: LEG_OPTIONS,
    },
    ''
  );
  assert.equal(page.data.legPickerOpen, true, '换了目的地必须重新问出行方式');
});

test('地点顺序变了不算"换了地方" —— 那只是优化路线', () => {
  /**
   * ⚠️ 指纹**排序后再拼**。不排序的话，调整站序会被当成"换了目的地"，
   * 于是每次优化都弹一次面板。
   */
  const page = pageWithLegOptions(LEG_OPTIONS);
  page.toggleLegPicker();

  page.applyTrip(
    {
      tripId: 't1',
      version: 2,
      /** 同样的两个地方，**顺序对调** */
      nodes: [node('n1', '冰雪大世界', 'pending', 0), node('n0', '哈工大', 'pending', 1)],
      saved: true,
      summary: { endAt: '2026-10-20T05:00:00.000Z', totalWalkMin: 8, totalStayMin: 90 },
      startPoint: { latitude: 45.75, longitude: 126.6 },
      startLeg: { minutes: 12, meters: 900, mode: 'walking', toPlaceName: '冰雪大世界' },
      legOptions: LEG_OPTIONS,
    },
    ''
  );
  assert.equal(page.data.legPickerOpen, false, '只是调序，不该重新弹');
});

test('收起的入口仍然可用：toggle 能展开', () => {
  const page = pageWithLegOptions(LEG_OPTIONS);
  page.toggleLegPicker();
  assert.equal(page.data.legPickerOpen, false, '第一次点收起');

  page.toggleLegPicker();
  assert.equal(page.data.legPickerOpen, true, '再点要能展开');
});
test('生成路线后附带可选的出行方式数量 —— 卡片据此决定说什么', () => {
  const withOptions = pageWithLegOptions(LEG_OPTIONS);
  assert.equal(withOptions.data.legOptionsCount, 2);
});

test('选完点应用时调整原行程并等待确认，保留已到达记录', async () => {
  const page = pageWithLegOptions(LEG_OPTIONS, { api: { 'trip.adjust': { ok: true, data: { proposalId: 'proposal', baseVersion: 1, candidates: [] } } } });
  try {
    page.setData({ rawNodes: page.data.rawNodes.map((n, i) => i === 0 ? { ...n, status: 'done' } : n) });
    page.onLegModeTap({ currentTarget: { dataset: { placeid: 'p_n1', mode: 'driving' } } });
    await page.applyLegModes();
    const call = page.__calls.at(-1);
    assert.equal(call.action, 'trip.adjust');
    assert.equal(call.payload.tripId, 't1');
    assert.equal(call.payload.autoApply, 'never');
    assert.equal(call.options.expectedVersion, 1);
    assert.deepEqual(call.payload.trigger.payload.operations, [{ type: 'change_travel_mode', payload: { nodeId: 'n1', mode: 'driving' } }]);
    assert.equal(page.data.rawNodes[0].status, 'done');
    assert.equal(page.data.trip.version, 1);
    assert.equal(page.data.legPickerOpen, false);
  } finally { page.restore(); }
});

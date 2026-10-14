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
  assert.match(transit.transitText, /1号口进 3号口出/);
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

test('生成路线后选择器**默认收起** —— 地图才是生成后的视觉焦点', () => {
  /**
   * ⚠️ 这条断言**改过方向**（2026-10-14），两次都是用户要求：
   *
   *   先："点击生成路径后**出现界面**" → 于是自动展开
   *   后："**其它卡面均折叠**，页面移到地图卡面居中" → 于是改回收起
   *
   * 后者更对：生成路线之后用户最想看的是"这条路在地图上长什么样"，
   * 一张展开的长卡片会把地图顶到屏幕外。
   *
   * ⚠️ 收起**不等于删掉**：卡片本身仍在，点一下就能展开。所以
   * `legPicker` 的数据必须照常生成（下面那条断言守着这一点）。
   */
  const page = pageWithLegOptions(LEG_OPTIONS);
  assert.equal(page.data.legPickerOpen, false, '默认收起，把版面让给地图');
  assert.equal(page.data.legPicker.length, 2, '数据要照常生成 —— 收起只是不显示');
});

test('收起的入口仍然可用：toggle 能展开', () => {
  const page = pageWithLegOptions(LEG_OPTIONS);
  assert.equal(page.data.legPickerOpen, false);

  page.toggleLegPicker();
  assert.equal(page.data.legPickerOpen, true, '点一下要能展开');
  page.toggleLegPicker();
  assert.equal(page.data.legPickerOpen, false);
});

test('后续生成也不自动展开 —— 每次重排都把面板弹开会碍事', () => {
  const page = pageWithLegOptions(LEG_OPTIONS);
  page.toggleLegPicker();
  assert.equal(page.data.legPickerOpen, true);
  /** 用户手动展开后，再生成一次（比如改了某段的方式点了「应用」） */
  page.applyTrip(
    {
      tripId: 't1',
      version: 2,
      nodes: [node('n0', '哈工大', 'pending', 0)],
      saved: true,
      summary: { endAt: '2026-10-20T05:00:00.000Z', totalWalkMin: 8, totalStayMin: 90 },
      startPoint: { latitude: 45.75, longitude: 126.6 },
      startLeg: { minutes: 12, meters: 900, mode: 'walking', toPlaceName: '哈工大' },
      legOptions: LEG_OPTIONS,
    },
    ''
  );
  assert.equal(page.data.legPickerOpen, false, '生成后回到收起状态');
});

test('生成路线后附带可选的出行方式数量 —— 卡片据此决定说什么', () => {
  const withOptions = pageWithLegOptions(LEG_OPTIONS);
  assert.equal(withOptions.data.legOptionsCount, 2);
});

test('选完点「应用」才重新规划，且逐段选择真的发出去了', async () => {
  const page = pageWithLegOptions(LEG_OPTIONS);
  /**
   * ⚠️ `createTrip` 读的是 `selected[].itemId`（不是 `placeId`）——
   * 它拿这个做提前返回的判据。我第一版夹具写成 `placeId`，
   * 于是 `createTrip` 直接 return，测试看到的是"没发请求"。
   */
  page.setData({ selected: [{ itemId: 'p_n0', name: '哈工大', location: { latitude: 45.77, longitude: 126.61 } }] });
  page.onLegModeTap({ currentTarget: { dataset: { placeid: 'p_n0', mode: 'walking' } } });
  const before = page.__calls.length;

  page.applyLegModes();
  /**
   * ⚠️ **必须等**：`createTrip` 先 `tryLocate()`（异步），
   * 请求在它的 `.then()` 里才发出去。不等的话断言的是"还没发"，
   * 而那不是被测代码的问题。
   */
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(page.__calls.length > before, '要发一次 trip.plan');
  assert.equal(page.data.legPickerOpen, false, '应用后收起面板');

  const call = page.__calls[page.__calls.length - 1];
  assert.equal(call.action, 'trip.plan');
  assert.deepEqual(call.payload.legModes, { p_n0: 'walking' }, '逐段选择必须真的发出去');
});

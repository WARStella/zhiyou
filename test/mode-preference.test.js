'use strict';

/**
 * 用户自选出行方式（2026-10-14 用户要求："给出用户选项，让用户自己选择"）。
 *
 * ── 这一层最要紧的设计决定：偏好 ≠ 强制 ────────────────────
 *
 *   · 用户选了步行、而目标 12 公里走不过去时，**不能什么都不给**
 *     —— 那等于让他自己去想办法；
 *   · 也不能**闷着换一种** —— 那等于偷偷替他改主意；
 *   · 正确做法：给可行的方案，并**说清"你想走但走不了，因为……"**。
 *
 * 与"不猜天气"是同一条纪律：不擅自替用户做决定，
 * 但也不假装他要的那个方式可行。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const modeChoice = require('../cloudfunctions/api/lib/mode-choice');
const { legTravelTimes } = require('../cloudfunctions/api/lib/leg-times');
const { loadPage } = require('./page-harness');

const { chooseMode, MODE_OPTIONS, PREFERRED_MODE } = modeChoice;

/** 三种方式都可用，驾车最快 */
const CANDS = [
  { mode: 'walking', minutes: 94, meters: 7059 },
  { mode: 'bicycling', minutes: 29, meters: 7200 },
  { mode: 'driving', minutes: 18, meters: 9000 },
];

// ── 纯选择逻辑 ─────────────────────────────────────────────

test('没选（auto）时仍然是"最快优先" —— 与接入之前的行为一致', () => {
  const r = chooseMode(CANDS, {});
  assert.equal(r.chosen.mode, 'driving');
  assert.equal(r.preferredMode, null, '没选时 preferredMode 为 null');
  assert.equal(r.matchedPreference, null, '没选时不需要"是否匹配"这个概念');
  assert.match(r.reason, /驾车最快/);
});

test('选了可用方式就**用它**，哪怕它不是最快的', () => {
  /**
   * ⚠️ 这条是"用户自己选择"的核心：用户说"我想走过去"，
   * 那是他的选择，系统不该拿"开车更快"反驳他。
   */
  const r = chooseMode(CANDS, { preferredMode: 'walking' });

  assert.equal(r.chosen.mode, 'walking', '必须听用户的，哪怕驾车快得多');
  assert.equal(r.matchedPreference, true);
  assert.equal(r.preferredMode, 'walking');
  /** 但要说清它与最快方案的差别 —— 用户可能想知道自己多花了多久 */
  assert.match(r.reason, /按你选的步行/);
  assert.match(r.reason, /多 76 分钟/, '要如实说清代价');
});

test('选的方式恰好也是最快的，理由里要说明', () => {
  const r = chooseMode(CANDS, { preferredMode: 'driving' });
  assert.equal(r.chosen.mode, 'driving');
  assert.equal(r.matchedPreference, true);
  assert.match(r.reason, /同时也是最快/);
});

test('理由里的分钟数**不许出现浮点尾巴** —— 用户截图报过「多 53.400000000000006 分钟」', () => {
  /**
   * 实测（用户截图）：骑行 72.7 分钟与驾车 19.3 分钟相减，
   * 拼出来的是「多 **53.400000000000006** 分钟」。
   * 浮点减法在老实的十进制下就是这个结果。
   *
   * ⚠️ 修法是**只在拼文案时格式化**，`minutes` 本身保持浮点 ——
   *    排序、比较与 `extra` 的计算都依赖精度；
   *    在源头取整会变成"先各自取整再相减"，误差会累积。
   */
  const r = chooseMode(
    [
      { mode: 'bicycling', minutes: 72.7, meters: 14194 },
      { mode: 'driving', minutes: 19.3, meters: 14194 },
    ],
    { preferredMode: 'bicycling' }
  );

  assert.equal(r.chosen.mode, 'bicycling');
  assert.ok(!/\d\.\d{3,}/.test(r.reason), `理由里不该有浮点尾巴：${r.reason}`);
  assert.match(r.reason, /多 53\.4 分钟/, `应当取一位小数：${r.reason}`);
});

test('整数分钟不显示多余的小数点', () => {
  const r = chooseMode(
    [
      { mode: 'bicycling', minutes: 60, meters: 1000 },
      { mode: 'walking', minutes: 20, meters: 1000 },
    ],
    { preferredMode: 'bicycling' }
  );
  assert.ok(!/60\.0/.test(r.reason), `60 就说 60，不说 60.0：${r.reason}`);
  assert.match(r.reason, /60 分钟/);
});

test('选了**不可用**的方式：给可行的，并说清为什么没按他选的来', () => {
  /**
   * ⚠️ 这段文案是这一层最重要的输出，三件事缺一件用户就会困惑：
   *   ① 你想用的那个不可用；② **为什么**；③ 所以给你哪个。
   */
  const r = chooseMode(CANDS, { preferredMode: 'transit' });

  assert.equal(r.chosen.mode, 'driving', '不能什么都不给 —— 那等于让他自己想办法');
  assert.equal(r.matchedPreference, false, '必须如实标记"没按你选的来"');
  assert.equal(r.preferredMode, 'transit');
  assert.match(r.reason, /你想用公交/, '① 说清他想用什么');
  assert.match(r.reason, /已改为驾车/, '③ 说清给了什么');
  assert.ok(r.reason.length > 12, '② 中间必须有原因，不能只有前后两句');
});

test('原因来自实际的排除记录，不是套话', () => {
  const r = chooseMode(
    [
      { mode: 'driving', minutes: 18, meters: 9000 },
      { mode: 'walking', ok: false, reason: '直线约 17225 米，超过步行上限 3000 米' },
    ],
    { preferredMode: 'walking' }
  );

  assert.equal(r.matchedPreference, false);
  assert.match(r.reason, /超过步行上限 3000 米/, '要把真实原因带出来');
  assert.equal(r.chosen.mode, 'driving');
});

test('选的方式一个候选都没有时也要给理由，不能空着', () => {
  const r = chooseMode([{ mode: 'driving', minutes: 18 }], { preferredMode: 'bicycling' });
  assert.equal(r.matchedPreference, false);
  assert.match(r.reason, /你想用骑行/);
  assert.ok(r.reason.includes('已改为'), '仍要说清给了什么');
});

test('偏好优先级高于雨雪天的 safety —— 用户的选择在前', () => {
  /**
   * 顺序：① 用户选的可用就给它；② 不可用再谈雨雪；③ 都没选才按 fastest。
   * 用户明确说了要骑，系统不该因为"可能下雪"就擅自改成别的
   * —— 那又是替他做决定。
   */
  const r = chooseMode(CANDS, { preferredMode: 'bicycling', preference: 'safety', weather: '雨雪' });
  assert.equal(r.chosen.mode, 'bicycling', '用户明确选的要优先');
  assert.equal(r.matchedPreference, true);
});

// ── 选项表本身 ─────────────────────────────────────────────

test('选项表含 auto、四种方式与地铁优先，且值域自洽', () => {
  assert.equal(MODE_OPTIONS.length, 6);
  assert.equal(MODE_OPTIONS[0].value, 'auto');
  for (const o of MODE_OPTIONS) {
    assert.ok(PREFERRED_MODE_AUTO_CHECK(o.value), `选项值 ${o.value} 必须被 isPreferredMode 接受`);
    assert.ok(o.label, '每个选项都要有给人看的名字');
  }
});

function PREFERRED_MODE_AUTO_CHECK(v) {
  return modeChoice.isPreferredMode(v);
}

test('isPreferredMode：空值算"自动"，乱七八糟的值不接受', () => {
  assert.equal(modeChoice.isPreferredMode(undefined), true, '没传 = 自动');
  assert.equal(modeChoice.isPreferredMode(''), true);
  assert.equal(modeChoice.isPreferredMode('auto'), true);
  assert.equal(modeChoice.isPreferredMode('walking'), true);
  assert.equal(modeChoice.isPreferredMode('teleport'), false, '没见过的值必须被拒');
  assert.equal(modeChoice.isPreferredMode(123), false);
});

test('前后端的选项表必须一致 —— 两处漂移后排查很费劲', () => {
  /**
   * ⚠️ 小程序页面不方便直接 require 云函数代码，所以前端有一份拷贝。
   * 拷贝就会漂移，所以用断言守住：**值必须一致**（label 允许措辞不同，
   * 但值不一致会直接导致"界面选了、后端不认"）。
   */
  const page = loadPage('miniprogram/pages/trip/index.js', {});
  const frontValues = page.data.modeOptions.map((o) => o.value).sort();
  const backValues = MODE_OPTIONS.map((o) => o.value).sort();

  assert.deepEqual(frontValues, backValues, '前端选项值必须与后端 MODE_OPTIONS 完全一致');
});

test('页面的默认值是 auto，且 hint 与它对应', () => {
  const page = loadPage('miniprogram/pages/trip/index.js', {});
  assert.equal(page.data.preferredMode, 'auto');
  assert.equal(page.data.modeIndex, 0);
  assert.match(page.data.modeHint, /最快/);
});

// ── 与 leg-times 的接线 ────────────────────────────────────

test('leg-times 把 preferredMode 真的透传给选择逻辑', async () => {
  /**
   * ⚠️ 漏透传的话，"用户自选出行方式"会**静默失效**（悄悄退回最快优先），
   * 而且不报错。所以单独守一条。
   */
  const matrix = {
    async distanceMatrix(from, tos, mode) {
      const v = { walking: { minutes: 94, meters: 7059 }, bicycling: { minutes: 29, meters: 7200 }, driving: { minutes: 18, meters: 9000 } }[mode];
      return {
        ok: true,
        elements: [
          { usable: true, distanceMeters: v.meters, durationMinutes: v.minutes, durationRaw: v.minutes * 60, unitCheck: { plausible: true, unit: 'seconds' } },
        ],
      };
    },
  };

  const r = await legTravelTimes({
    fromPoint: { latitude: 45.7756, longitude: 126.6175 },
    toPlace: { _id: 'p_x', name: 'X', location: { latitude: 45.8029, longitude: 126.5353 } },
    providers: { map: matrix, transit: null },
    opts: { preferredMode: 'walking' },
  });

  assert.equal(r.choice.chosen.mode, 'walking', '用户选了步行就该给步行');
  assert.equal(r.choice.chosen.provider, 'tencent-matrix');
});

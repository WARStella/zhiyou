'use strict';

/**
 * 距离矩阵探针 —— 单位与 mode 的实测。
 *
 * ── 这个探针为什么必须存在 ────────────────────────────────
 *
 * `lib/map/tencent.js` 的距离矩阵里，`duration` 的单位一直标注着
 * "真实行为由 `map.matrixProbe` 实测确认"，而它**从没做过**。
 *
 * 2026-10-14 用户实测看到「步行 24.7 分钟 14426 米」= **35 km/h 的步行**。
 * 我只能靠算术倒推才知道原始值是 1482（24.7 × 60）。
 *
 * **算术倒推能猜到结论，但猜不出原因。** 所以要真去问上游，
 * 并把三种方式**并排**拿回来 —— 单看一种方式分不清
 * "单位错了"还是"mode 被忽略了"。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { probe } = require('../cloudfunctions/api/actions/matrix-probe');

/** 造一个 provider 替身：按 mode 返回指定的单元格 */
function stubProvider(byMode) {
  return {
    keyStatus: () => ({ configured: true, masked: 'MAP****KEY', trimmed: false }),
    async distanceMatrix(from, tos, mode) {
      const cell = byMode[mode];
      if (!cell) {
        return {
          ok: true,
          requestUrl: 'https://apis.map.qq.com/ws/distance/v1/matrix?mode=' + mode,
          elements: [{ usable: false, failureReason: 'NO_CELL', durationRaw: null, distanceMeters: null, unitCheck: null }],
        };
      }
      return {
        ok: true,
        requestUrl: 'https://apis.map.qq.com/ws/distance/v1/matrix?mode=' + mode,
        elements: [cell],
      };
    },
  };
}

/** 造一个单元格，unitCheck 与真实 provider 同形状 */
function cell(distance, duration, mode) {
  const RANGE = { walking: [40, 120], bicycling: [150, 400], driving: [200, 1200] };
  const [lo, hi] = RANGE[mode];
  const asSec = distance / (duration / 60);
  const asMin = distance / duration;
  const inR = (v) => v >= lo && v <= hi;
  let unit = 'assumed-seconds';
  let divisor = 60;
  let plausible = false;
  let note = '';
  if (inR(asSec) && !inR(asMin)) {
    unit = 'seconds';
    note = '按秒合理';
    plausible = true;
  } else if (inR(asMin) && !inR(asSec)) {
    unit = 'minutes';
    divisor = 1;
    note = '按分钟合理';
    plausible = true;
  } else {
    note = '两种都不合理';
  }
  return {
    usable: true,
    failureReason: null,
    distanceMeters: distance,
    durationRaw: duration,
    durationMinutes: Math.round((duration / divisor) * 10) / 10,
    unitCheck: { unit, divisor, impliedSpeedMPerMin: Math.round(asSec), plausible, note },
    rawStatus: 0,
  };
}

function ctx(provider) {
  return { env: 'dev', payload: {}, createMapProvider: () => provider };
}

test('三种方式的耗时明显不同 → 判为 mode 被尊重、单位是秒', async () => {
  const r = await probe(
    ctx(
      stubProvider({
        walking: cell(7059, 5647, 'walking'), // 5647 秒 ≈ 94 分，75 米/分
        bicycling: cell(7200, 1730, 'bicycling'),
        driving: cell(9000, 900, 'driving'),
      })
    )
  );

  assert.equal(r.ok, true, '三种都合理就该 OK');
  assert.equal(r.data.verdict, 'OK');
  assert.equal(r.data.modeRespected, true);
  assert.equal(r.data.unitVerdict, 'seconds');
  assert.equal(r.data.mapApiCalls, 3, '三种方式各问一次');
  assert.equal(r.data.results.length, 3);
});

test('回归：三种方式拿到**几乎相同**的耗时 → 判为 mode 被忽略', async () => {
  /**
   * ⚠️ 这条钉住 2026-10-14 用户实测的那个问题。
   *
   * 界面上出现「步行 24.7 分钟 14426 米」= 35 km/h 的步行。
   * 单看这一组数，很容易判成"单位错了，该改成分钟"；
   * **但按分钟解释同样是 35 km/h，也荒谬。**
   *
   * 只有把三种方式并排看才明白：**上游对步行返回了驾车的时间**。
   * 所以这个探针的形态就是"三组并排"，而不是单问一种。
   */
  const sameRaw = { walking: cell(14426, 1122, 'walking'), bicycling: cell(14426, 1122, 'bicycling'), driving: cell(14426, 1122, 'driving') };
  const r = await probe(ctx(stubProvider(sameRaw)));

  assert.equal(r.data.modeRespected, false, '三组耗时相同 → mode 没被尊重');
  assert.equal(r.data.verdict, 'MODE_IGNORED');
  /** ⚠️ 外层信封恒为 ok: true，业务结果在 data 里 */
  assert.equal(r.data.ok, false);
  assert.match(r.data.hint, /没有按 mode 区分/, '要给出可行办法');
  /** 提示里要提到替代方案，而不是只说"有问题" */
  assert.match(r.data.hint, /direction\/v1\/walking|各自的路线接口/);
});

test('判为分钟时明确说"当前代码除以 60 是错的"', async () => {
  /**
   * ⚠️ fixture 必须**三种方式同一套单位**。
   *
   * 我第一版把步行写成"按分钟才合理"、骑行写成"按秒才合理" ——
   * 探针如实判成 `mixed`。**那是夹具自相矛盾，不是探针的错**
   * （真上游不可能对不同方式用不同单位）。
   */
  const raw = {
    walking: cell(7059, 5647, 'walking'), // 5647 秒 ≈ 94 分 → 75 米/分 ✅
    bicycling: cell(7200, 1730, 'bicycling'), // 1730 秒 ≈ 29 分 → 250 米/分 ✅
    driving: cell(9000, 1100, 'driving'), // 1100 秒 ≈ 18 分 → 490 米/分 ✅
  };
  /**
   * 把原始值**整体乘以 60**，模拟"上游给的是分钟"。
   * 这样三种方式同时变成"只有按分钟解释合理"，才是自洽的。
   */
  const allMinutes = {};
  for (const k of Object.keys(raw)) {
    allMinutes[k] = cell(raw[k].distanceMeters, Math.round(raw[k].durationRaw / 60), k);
  }

  const r = await probe(ctx(stubProvider(allMinutes)));

  assert.equal(r.data.unitVerdict, 'minutes');
  assert.equal(r.data.verdict, 'UNIT_IS_MINUTES');
  assert.ok(r.data.steps.some((s) => s.step === 'duration-unit' && /除以 60 是错的/.test(s.detail)));
  assert.match(r.data.hint, /除数从 60 改成 1/);
});

test('Key 没配时不发请求（省配额），并且说清怎么配', async () => {
  let called = 0;
  const provider = {
    keyStatus: () => ({ configured: false }),
    async distanceMatrix() {
      called += 1;
      return { ok: true, elements: [] };
    },
  };
  const r = await probe(ctx(provider));

  assert.equal(r.data.verdict, 'KEY_MISSING');
  assert.equal(called, 0, 'Key 没配就不该发请求');
  assert.match(r.data.steps[0].detail, /MAP_KEY/);
});

test('三种方式都取不到数据时判 UPSTREAM_FAILED，而不是假装成功', async () => {
  const r = await probe(ctx(stubProvider({})));
  assert.equal(r.data.verdict, 'UPSTREAM_FAILED');
  /**
   * ⚠️ 断言 `data.ok` 而不是 `r.ok` —— `resp.ok()` 只是外层信封
   * （请求成功送达客户端），业务成败在 `data` 里。我第一版断言错了对象。
   */
  assert.equal(r.data.ok, false);
  assert.equal(r.ok, true, '外层信封表示"请求送达了"，与业务成败无关');
});

test('原始值必须带回来 —— 这是本次探针存在的全部理由', async () => {
  const r = await probe(
    ctx(stubProvider({ walking: cell(14426, 1122, 'walking'), driving: cell(14426, 1122, 'driving') }))
  );
  const walk = r.data.results.find((x) => x.mode === 'walking');

  /**
   * ⚠️ 用户那次实测里，我只能**倒推**才知道 durationRaw 是 1482。
   * 这个探针之后，原始值直接给出来。
   */
  assert.equal(walk.distanceMeters, 14426, '上游原始 distance');
  assert.equal(walk.durationRaw, 1122, '上游原始 duration —— 不再靠倒推');
  assert.equal(typeof walk.impliedSpeedMPerMin, 'number', '隐含速度要算出来');
  assert.ok(walk.unitCheck, '单位自检结果要带上');
  assert.equal(walk.endpoint.includes('matrix'), true, '端点要如实带出');
});

test('与公交探针的实测交叉核对 —— 跨接口比对更能说明问题', async () => {
  const r = await probe(
    ctx(
      stubProvider({
        walking: cell(7059, 5647, 'walking'),
        driving: cell(9000, 900, 'driving'),
      })
    )
  );

  assert.ok(r.data.crossCheck, '有步行数据时应当给出交叉核对');
  assert.equal(r.data.crossCheck.transitProbeReference.subwayMinutes, 69.5);
  assert.equal(r.data.crossCheck.transitProbeReference.walkingMetersInThatRoute, 3442);
  assert.match(r.data.crossCheck.note, /公交探针/);
});

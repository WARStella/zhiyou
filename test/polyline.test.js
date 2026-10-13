'use strict';

/**
 * polyline 解码测试。
 *
 * **一律用真实录音**，不用自己编的数组 ——
 * 编的数据只能证明"我的解码器和我的编码器配套"，
 * 证明不了"我解对了腾讯说的话"。这条教训今天已经吃过两次。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { decodePolyline, decodeRoute, isCompressed } = require('../cloudfunctions/api/lib/map/polyline');

const REC = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures/upstream/direction-walking-central-avenue.json'),
    'utf8'
  )
);
const ROUTE = REC.body.result.routes[0];

test('真实录音：polyline 解出来的末点必须落在目的地', () => {
  /**
   * **这是整条解码逻辑的判据。**
   *
   * 这次请求是「中央大街 → 防洪纪念塔」，防洪纪念塔的坐标是
   * `45.7810, 126.6185`（种子数据里就有）。
   * 如果解码对了，路径的**最后一个点**必然落在那里。
   *
   * 解错了（比如单位不是 1e-6、或者增量不是累加），
   * 末点会跑到几公里甚至几千公里外 —— 这条断言会立刻抓住。
   */
  const pts = decodePolyline(ROUTE.polyline);

  assert.ok(pts.length > 10, `应当解出足够多的点，实际 ${pts.length}`);
  assert.equal(ROUTE.polyline.length, 120, '录音里是 120 个数（README 说 polyline 完整）');

  const last = pts[pts.length - 1];
  const DEST = { latitude: 45.781, longitude: 126.6185 }; // 防洪纪念塔

  // 允许几百米的偏差（上游给的是门口附近的点），但不能差出量级
  const dLat = Math.abs(last.latitude - DEST.latitude);
  const dLng = Math.abs(last.longitude - DEST.longitude);
  assert.ok(
    dLat < 0.002 && dLng < 0.002,
    `末点应当落在防洪纪念塔附近，实际 ${last.latitude}, ${last.longitude}`
  );

  // 起点同样要落在出发地附近（中央大街 45.7756, 126.6175）
  const first = pts[0];
  assert.ok(
    Math.abs(first.latitude - 45.7756) < 0.002 && Math.abs(first.longitude - 126.6175) < 0.002,
    `首点应当落在中央大街附近，实际 ${first.latitude}, ${first.longitude}`
  );
});

test('真实录音：相邻点不能有跳变（跳变说明单位猜错了）', () => {
  const pts = decodePolyline(ROUTE.polyline);
  for (let i = 1; i < pts.length; i++) {
    const d = Math.abs(pts[i].latitude - pts[i - 1].latitude) +
      Math.abs(pts[i].longitude - pts[i - 1].longitude);
    assert.ok(d < 0.01, `第 ${i} 个点相对前一点跳了 ${d}，单位或累加方式不对`);
  }
});

test('真实录音：全程总距离与上游给的 distance 大致吻合', () => {
  /**
   * 独立校验：把解码后的折线长度加总，应当接近上游声明的 815 米。
   * 这是**与"末点落在目的地"完全不同的一条证据** ——
   * 只有两处都对，才能说解码真的对了。
   */
  const pts = decodePolyline(ROUTE.polyline);
  let meters = 0;
  for (let i = 1; i < pts.length; i++) {
    const dLat = (pts[i].latitude - pts[i - 1].latitude) * 111320;
    const dLng =
      (pts[i].longitude - pts[i - 1].longitude) *
      111320 *
      Math.cos((pts[i].latitude * Math.PI) / 180);
    meters += Math.sqrt(dLat * dLat + dLng * dLng);
  }
  // 录音里的 polyline 覆盖的是**部分**步骤（steps 被截断到 4/8），
  // 所以只能要求"不超过总距离、且占了相当比例"
  assert.ok(meters > 200, `解码后的折线长度 ${Math.round(meters)} 米，太短了`);
  assert.ok(
    meters <= ROUTE.distance * 1.15,
    `解码后 ${Math.round(meters)} 米超过了上游声明的 ${ROUTE.distance} 米`
  );
});

test('真实录音：分步指引的原话要一字不改地保留', () => {
  const r = decodeRoute(ROUTE);
  assert.equal(r.steps.length, 4, '录音里保留了 4 条 step');

  assert.equal(r.steps[0].instruction, '从起点朝西北行进62米右转进入上游街');
  assert.equal(r.steps[0].actDesc, '右转');
  assert.equal(r.steps[0].dirDesc, '西北');
  assert.equal(r.steps[0].distanceMeters, 62);
  assert.equal(r.steps[1].instruction, '沿上游街行进110米左转进入中央大街');

  /**
   * ⚠️ 指令**只能来自上游**。自己拼一句"请右转"看着像回事，
   * 但错一个路口用户就多走一公里 —— 导航文案不能自己编。
   */
  for (const s of r.steps) {
    assert.ok(s.instruction, `第 ${s.seq} 步没有指令原文`);
  }
});

test('真实录音：每一步都能对应到路径上的一段点', () => {
  const r = decodeRoute(ROUTE);
  assert.ok(r.points.length > 0);

  for (const s of r.steps) {
    assert.ok(s.fromIndex <= s.toIndex, `第 ${s.seq} 步的下标反了`);
    assert.ok(s.toIndex < r.points.length, `第 ${s.seq} 步的下标越界`);
    assert.equal(
      s.points.length,
      s.toIndex - s.fromIndex + 1,
      `第 ${s.seq} 步的点数与下标区间不一致`
    );
  }

  // 前四步应当覆盖路径的前半段（录音里后四步被截断了）
  assert.ok(r.steps[3].toIndex < r.points.length, '最后一步不该吃掉整条路径');
});

test('分步的点数与距离应当大致成比例（用来佐证 polyline_idx 是数组下标）', () => {
  const r = decodeRoute(ROUTE);
  const ratios = r.steps.map((s) => s.distanceMeters / Math.max(1, s.points.length));
  for (const x of ratios) {
    assert.ok(x > 3 && x < 60, `每点对应的距离 ${x.toFixed(1)} 米不像同一量级`);
  }
});

// ── 边界与容错 ────────────────────────────────────────────

test('非法输入返回空数组，不抛异常', () => {
  for (const bad of [null, undefined, [], [1], 'x', {}, [200, 300, 1, 2]]) {
    assert.deepEqual(decodePolyline(bad), [], `输入 ${JSON.stringify(bad)} 应当返回空`);
  }
});

test('已经是点数组时直接规整，不重复解码', () => {
  const pts = decodePolyline([
    { latitude: 45.1, longitude: 126.1 },
    { latitude: 45.2, longitude: 126.2 },
  ]);
  assert.equal(pts.length, 2);
  assert.equal(pts[1].latitude, 45.2);

  const arr = decodePolyline([
    [45.1, 126.1],
    [45.2, 126.2],
  ]);
  assert.equal(arr.length, 2);
});

test('上游被截断时不能崩 —— 下标越界要夹住', () => {
  // 只有 6 个数（3 个点），但 step 声称覆盖到下标 75
  const truncated = {
    distance: 100,
    duration: 2,
    polyline: [45.7755, 126.6172, 100, 100, 100, 100],
    steps: [{ instruction: '走', distance: 100, polyline_idx: [0, 75] }],
  };
  const r = decodeRoute(truncated);
  assert.equal(r.points.length, 3);
  assert.equal(r.steps[0].toIndex, 2, '越界的下标要夹到最后一个点');
  assert.ok(r.steps[0].points.length <= 3);
});

test('解码失败要能说清是"没数据"而不是"解不开"', () => {
  assert.equal(decodeRoute({ polyline: [] }).decoded, false);
  assert.equal(decodeRoute({ polyline: [] }).pointCount, 0);
  assert.equal(decodeRoute({ polyline: [45.7755, 126.6172] }).decoded, true, '一个点也算解出来了');
});

test('isCompressed：能区分差分格式与点数组', () => {
  assert.equal(isCompressed([45.7755, 126.6172, 100, -50]), true);
  assert.equal(isCompressed([45.7755, 126.6172, 1.5, -0.5]), false, '非整数增量不是这个格式');
  assert.equal(isCompressed([200, 300, 1, 2]), false, '首点不是合法经纬度');
});

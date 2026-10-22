'use strict';

/**
 * 步行缓存体检 —— 找出"会被当月步行读、但隐含速度不可能"的记录。
 *
 * ── 这个工具为什么存在 ────────────────────────────────────
 *
 * 2026-10-14 用户看到「步行 24.7 分钟 14426 米」= **584 米/分**（驾车速度）。
 * 距离矩阵探针随后证明矩阵本身没问题（步行 66 / 骑行 194 / 驾车 627 米/分），
 * 所以问题在**缓存**：
 *
 * 我加 `mode` 字段**之前**写进去的驾车/骑行耗时没有 `mode`，
 * 而兼容规则是"没有 mode 就当成步行" → **驾车时间被当月步行读**。
 *
 * 影响两层，**第二层看不见所以更要紧**：
 *   ① 界面显示荒谬的步行时间
 *   ② `maxWalkMinutes` 硬约束失效 —— 用户说"少走点路"，
 *      系统把开车时间算成走路，于是判断"没超上限"
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { walkCacheCheck, MAX_PLAUSIBLE_WALK_M_PER_MIN, impliedSpeed } = require('../cloudfunctions/api/actions/walk-cache-check');
const C = require('../cloudfunctions/api/lib/repo/collections');

/** 造一个只有一个地点的假 repo */
function stubRepo(places) {
  return {
    async find() {
      return places;
    },
  };
}

const FAR = { latitude: 45.7756, longitude: 126.6175 };
/** 与 FAR 直线约 7 公里 */
const NEAR = { latitude: 45.8029, longitude: 126.5353 };

function ctx(places) {
  return { env: 'dev', repo: stubRepo(places), payload: {} };
}

test('缺 mode 的驾车耗时被标为可疑 —— 它会被当月"步行"读', async () => {
  /**
   * 真实形态：12618 米的路，记录写着 24.7 分钟（驾车耗时），
   * 而**没有 mode 字段** → 兼容规则当步行 → 隐含速度 584 米/分。
   */
  const places = [
    { _id: 'p_a', name: '我的位置', location: FAR, walkableTo: [{ placeId: 'p_b', walkMin: 24.7, walkMeters: 14426 }] },
    { _id: 'p_b', name: '很远的地方', location: NEAR, walkableTo: [] },
  ];
  const r = await walkCacheCheck(ctx(places));
  const d = r.data;

  assert.equal(d.suspiciousCount, 1, '这条必须被找出来');
  const s = d.suspicious[0];
  assert.equal(s.missingMode, true, '要指出它**缺 mode**');
  assert.equal(s.mode, null);
  assert.ok(s.impliedSpeedMPerMin > MAX_PLAUSIBLE_WALK_M_PER_MIN, '隐含速度超过步行上限');
  assert.match(s.reason, /不是步行数据/);
  /** 时速比"米/分"更好理解 */
  assert.ok(s.impliedSpeedKmh > 7.2);
});

test('真正的步行记录不该被误报', async () => {
  /** 7 公里走 94 分钟 → 75 米/分，是正常步速 */
  const places = [
    { _id: 'p_a', name: 'A', location: FAR, walkableTo: [{ placeId: 'p_b', walkMin: 94, walkMeters: 7059 }] },
    { _id: 'p_b', name: 'B', location: NEAR, walkableTo: [] },
  ];
  const r = await walkCacheCheck(ctx(places));
  assert.equal(r.data.suspiciousCount, 0, '75 米/分是正常步行，不该报');
});

test('带 mode:driving 的记录**不算可疑** —— 它本来就不该被当步行读', async () => {
  /**
   * ⚠️ 这个区分很要紧。带 `mode` 的记录由 `findLegRecord` 按方式取，
   * 驾车就是驾车。只有**缺 mode 的**（或明确 walking 的）才会被当月步行。
   * 把带 mode 的也算进来会淹没真正的问题。
   */
  const places = [
    { _id: 'p_a', name: 'A', location: FAR, walkableTo: [{ placeId: 'p_b', walkMin: 19.2, walkMeters: 12036, mode: 'driving' }] },
    { _id: 'p_b', name: 'B', location: NEAR, walkableTo: [] },
  ];
  const r = await walkCacheCheck(ctx(places));
  assert.equal(r.data.suspiciousCount, 0, '驾车记录速度快是正常的');
  assert.equal(r.data.summary.withMode, 1);
});

test('明确标了 walking 但速度不可能 → 仍要报（写的时候就写错了数据）', async () => {
  const places = [
    { _id: 'p_a', name: 'A', location: FAR, walkableTo: [{ placeId: 'p_b', walkMin: 20, walkMeters: 12000, mode: 'walking' }] },
    { _id: 'p_b', name: 'B', location: NEAR, walkableTo: [] },
  ];
  const r = await walkCacheCheck(ctx(places));
  assert.equal(r.data.suspiciousCount, 1);
  assert.equal(r.data.suspicious[0].missingMode, false, '这条不缺 mode，是数值本身错');
});

test('目标地点不在扫描范围时跳过，不猜', async () => {
  const places = [
    { _id: 'p_a', name: 'A', location: FAR, walkableTo: [{ placeId: 'p_missing', walkMin: 1 }] },
  ];
  const r = await walkCacheCheck(ctx(places));
  assert.equal(r.data.suspiciousCount, 0, '算不出直线距离就不下结论');
  assert.equal(r.data.summary.measurable, 0);
});

test('结果里必须说清"影响两层"，尤其那层看不见的', async () => {
  const places = [
    { _id: 'p_a', name: 'A', location: FAR, walkableTo: [{ placeId: 'p_b', walkMin: 24.7, walkMeters: 14426 }] },
    { _id: 'p_b', name: 'B', location: NEAR, walkableTo: [] },
  ];
  const r = await walkCacheCheck(ctx(places));

  assert.match(r.data.impact, /maxWalkMinutes/, '要说清硬约束会失效');
  assert.match(r.data.impact, /看不见/, '要点明第二层更难发现');
  /**
   * ⚠️ 必须**不自动删**：删数据不可逆，而且"看起来不可能"未必等于"错"
   * ——两点极近时直线距离很小、实际却要绕一大圈。
   */
  assert.match(r.data.suggestion, /不会自动删/);
  assert.match(r.data.suggestion, /绕一大圈/, '要把"为什么不能自动删"说清');
});

test('没有可疑记录时给出明确的"干净"结论', async () => {
  const r = await walkCacheCheck(ctx([]));
  assert.equal(r.data.suspiciousCount, 0);
  assert.match(r.data.verdict, /没有隐含速度不合理/);
  assert.equal(r.data.impact, null);
});

test('非 dev 环境拒绝执行', async () => {
  await assert.rejects(
    () => walkCacheCheck({ env: 'prod', repo: stubRepo([]), payload: {} }),
    /仅限 dev/
  );
});

test('impliedSpeed 的边界：分钟数为 0 或负数时返回 null', () => {
  assert.equal(impliedSpeed(1000, 0), null);
  assert.equal(impliedSpeed(1000, -5), null);
  assert.equal(impliedSpeed(null, 10), null);
  assert.equal(impliedSpeed(1000, 10), 100);
});

'use strict';

/**
 * 步行缓存体检 —— 找出 `walkableTo` 里**隐含速度不可能**的记录。
 *
 * ── 为什么要查这个 ────────────────────────────────────────
 *
 * 2026-10-14 用户实测看到「步行 24.7 分钟 14426 米」，即 **584 米/分**
 * ——那是**驾车**速度，真按步行算 14.4 公里要走 3.7 小时。
 *
 * 距离矩阵探针已证明矩阵本身没问题（步行 66 / 骑行 194 / 驾车 627 米/分，
 * 三种方式区分正确）。所以问题在**缓存**：
 *
 * 我加 `mode` 字段**之前**，`walkableTo` 里已经写进了驾车/骑行的耗时
 * （`persistLegTimes` 首版不写 mode）。而那些老记录没有 `mode`，
 * 而兼容规则是**"没有 mode 就当成步行"**：
 *
 *     findWalkRecord() → 读到一条驾车耗时，当作步行时间返回，
 *                       来源还标成 survey（踏勘实测）
 *
 * 后果有两层，第二层更严重：
 *   ① 界面显示"步行 24.7 分钟"（荒谬但看得见）
 *   ② `maxWalkMinutes` 硬约束**失效**（看不见）—— 用户说"少走点路"，
 *      系统把开车时间算成走路，于是判断"没超上限"
 *
 * ── 判据 ──────────────────────────────────────────────────
 *
 * 用**直线距离**反推隐含速度，因为它是唯一独立于上游的数据：
 * 不依赖任何接口返回值，所以不会把"上游错了"和"缓存脏了"混在一起。
 *
 * ⚠️ 这只是体检，**不自动删**。删数据是不可逆的，而且
 * "看起来不可能"未必等于"错"（例如两个地点极近时直线距离很小、
 * 而实际要绕一大圈）。所以只列出可疑项 + 建议，由人决定。
 */

const resp = require('../lib/resp');
const { CODES, assert } = require('../lib/errors');
const C = require('../lib/repo/collections');
const geo = require('../lib/geo');

/**
 * 步行的合理速度上限（米/分钟）。
 *
 * 取 120 而不是平均步速 75：要的是"**不可能是步行**"这个判据，
 * 不是"是否典型"。120 米/分 ≈ 7.2 km/h，已是快走的极限，
 * 正常游览不可能持续超过它。
 */
const MAX_PLAUSIBLE_WALK_M_PER_MIN = 120;

/** 隐含速度 = 直线距离 / 分钟数。直线距离是唯一不依赖上游的独立量。 */
function impliedSpeed(straightMeters, minutes) {
  if (typeof straightMeters !== 'number' || !(minutes > 0)) return null;
  return straightMeters / minutes;
}

async function walkCacheCheck(ctx) {
  const { env, repo } = ctx;
  const p = ctx.payload || {};

  // 读全库地点做体检 —— 只读操作，但仍限 dev（与其它 ops 同惯例）
  assert(env === 'dev', CODES.FORBIDDEN_ENV, `当前环境为 ${env}，缓存体检仅限 dev`);

  const limit = p.limit || 500;
  const places = await repo.find(C.PLACES, {}, { limit });

  const suspicious = [];
  const summary = {
    placesScanned: places.length,
    recordsTotal: 0,
    /** 带 mode 的（新写入） */
    withMode: 0,
    /** 不带 mode 的（历史记录，**一律被当成步行**） */
    withoutMode: 0,
    /** 能算出隐含速度的 */
    measurable: 0,
  };

  for (const place of places) {
    const list = Array.isArray(place.walkableTo) ? place.walkableTo : [];
    if (!list.length) continue;

    for (const rec of list) {
      if (!rec || rec.placeId === undefined) continue;
      summary.recordsTotal += 1;
      if (rec.mode) summary.withMode += 1;
      else summary.withoutMode += 1;

      const target = places.find((x) => x._id === rec.placeId);
      /** 目标地点不在本次扫描范围（或已删）时无法算直线距离 —— 跳过，不猜 */
      if (!target || !target.location || !place.location) continue;

      const walkMin = rec.walkMin !== undefined ? rec.walkMin : rec.minutes;
      const straight = geo.haversineMeters(place.location, target.location);
      const speed = impliedSpeed(straight, walkMin);
      if (speed === null) continue;
      summary.measurable += 1;

      /**
       * 只有**会被当成步行读**的记录才算可疑：
       *   · 没有 mode          → 兼容规则当步行
       *   · mode === 'walking' → 明确是步行
       * 带 `mode: 'driving'` 的记录**本来就不该被当步行读**，
       * 速度快是正常的，不算可疑。
       */
      const readAsWalking = !rec.mode || rec.mode === geo.TRAVEL_MODE.WALKING;
      if (!readAsWalking) continue;
      if (speed <= MAX_PLAUSIBLE_WALK_M_PER_MIN) continue;

      suspicious.push({
        fromPlaceId: place._id,
        fromName: place.name || null,
        toPlaceId: rec.placeId,
        toName: target.name || null,
        /** 缺 mode 才是真问题；带 walking 的说明写的时候就用错了数据 */
        mode: rec.mode || null,
        missingMode: !rec.mode,
        walkMin: walkMin,
        walkMeters: rec.walkMeters !== undefined ? rec.walkMeters : null,
        source: rec.source || null,
        straightMeters: Math.round(straight),
        impliedSpeedMPerMin: Math.round(speed),
        /** 换算成时速，人对这个更有概念 */
        impliedSpeedKmh: Math.round((speed * 60) / 100) / 10,
        reason:
          `隐含速度 ${Math.round(speed)} 米/分（${Math.round((speed * 60) / 100) / 10} km/h）` +
          `超过步行上限 ${MAX_PLAUSIBLE_WALK_M_PER_MIN} 米/分 —— 这条不是步行数据`,
      });
    }
  }

  /**
   * 修法与影响面 —— 说清"接下来该做什么"，
   * 而不是只报一堆数字让人自己猜。
   */
  const affectedConstraint = suspicious.length > 0;

  return resp.ok({
    kind: 'walkCacheCheck',
    summary,
    maxPlausibleWalkMPerMin: MAX_PLAUSIBLE_WALK_M_PER_MIN,
    suspiciousCount: suspicious.length,
    /** 只回前 50 条 —— 结果太长反而看不清 */
    suspicious: suspicious.slice(0, 50),
    truncated: suspicious.length > 50,
    verdict: !suspicious.length
      ? `扫了 ${summary.placesScanned} 个地点、${summary.recordsTotal} 条记录，没有隐含速度不合理的步行记录`
      : `发现 ${suspicious.length} 条记录会被当月**步行**读、但隐含速度超过步行上限` +
        (summary.withoutMode
          ? `（其中 ${suspicious.filter((s) => s.missingMode).length} 条**缺 mode 字段**，` +
            '是"多方式接入"之前写进去的驾车/骑行耗时）'
          : ''),
    impact: affectedConstraint
      ? '影响两层：① 界面会显示荒谬的步行时间；② **maxWalkMinutes 硬约束会失效** —— ' +
        '把开车时间算成走路，于是"少走点路"永远不会触发。第二层看不见，所以更要紧。'
      : null,
    suggestion: affectedConstraint
      ? '这些记录**不会自动删**（删数据不可逆，且"看起来不可能"未必等于"错"：' +
        '两点极近时直线距离很小、实际却要绕一大圈）。建议：先在界面上确认那几段，' +
        '再按 placeId + toPlaceId 精确清除，或等它们被新的正确记录覆盖。'
      : null,
    note:
      '判据用**直线距离**反推隐含速度 —— 它是唯一独立于上游的数据，' +
      '所以不会把"上游错了"和"缓存脏了"混在一起。',
  });
}

module.exports = { walkCacheCheck, MAX_PLAUSIBLE_WALK_M_PER_MIN, impliedSpeed };

'use strict';

const resp = require('../lib/resp');
const { CODES, require_fields, fail } = require('../lib/errors');
const { placeEligibility, canBeMeetingPoint } = require('../lib/authz');
const C = require('../lib/repo/collections');

/**
 * 地点查询。
 *
 * **准入按用途分两级**（2026-10-13 修正，见 lib/authz.js）：
 *   · `tripNodeAllowed`    —— 有名称与坐标即可，外部检索回来的 POI 也能用；
 *   · `meetingPointAllowed`—— 还要求实地核验（§7.1 可达性、辨识度、停留条件）。
 *
 * 界面拿这两个字段判断"这个地点能做什么"，而不是一个含糊的 `usable`。
 */

async function list(ctx) {
  const { repo } = ctx;
  const p = ctx.payload || {};

  const rows = await repo.find(
    C.PLACES,
    p.category ? { category: p.category } : {},
    { limit: 100 }
  );

  // verifiedOnly 现在明确指"可作集合点"，避免语义漂移
  const filtered = p.verifiedOnly ? rows.filter((pl) => canBeMeetingPoint(pl)) : rows;

  const places = filtered.map((pl) => {
    const elig = placeEligibility(pl);
    return {
      placeId: pl._id,
      name: pl.name,
      category: pl.category,
      location: pl.location,
      entranceLocation: pl.entranceLocation || null,
      visitDurationMin: pl.visitDurationMin,
      // ── 准入（按用途分级，不要再用单一 usable）──
      tripNodeAllowed: elig.tripNode,
      meetingPointAllowed: elig.meetingPoint,
      // ── 可信度标注：未核验必须让界面看得见，不能假装可信 ──
      verified: elig.verified,
      verifiedAt: pl.verifiedAt || null,
      confidence: elig.confidence,
      dataSource: elig.dataSource,
      tags: pl.tags || [],
    };
  });

  return resp.ok({
    places,
    total: places.length,
    /** 便于界面直接给出统计，而不用自己遍历 */
    counts: {
      tripNodeAllowed: places.filter((x) => x.tripNodeAllowed).length,
      meetingPointAllowed: places.filter((x) => x.meetingPointAllowed).length,
    },
  });
}

async function detail(ctx) {
  const { repo } = ctx;
  require_fields(ctx.payload, ['placeId']);

  const place = await repo.get(C.PLACES, ctx.payload.placeId);
  if (!place) throw fail(CODES.NOT_FOUND, '地点不存在');

  const elig = placeEligibility(place);

  return resp.ok({
    place,
    eligibility: elig,
    // 兼容旧字段名
    usable: elig.meetingPoint,
    // 踏勘实测的步行时间，规划器会优先使用它而非直线估算
    walkableTo: place.walkableTo || [],
  });
}

module.exports = { list, detail };

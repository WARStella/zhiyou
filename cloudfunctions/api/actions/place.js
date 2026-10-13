'use strict';

const resp = require('../lib/resp');
const { CODES, require_fields, fail } = require('../lib/errors');
const { isPlaceUsable } = require('../lib/authz');
const C = require('../lib/repo/collections');

async function list(ctx) {
  const { repo } = ctx;
  const p = ctx.payload || {};

  const rows = await repo.find(
    C.PLACES,
    p.category ? { category: p.category } : {},
    { limit: 100 }
  );

  const places = rows
    .filter((pl) => (p.verifiedOnly ? isPlaceUsable(pl) : true))
    .map((pl) => ({
      placeId: pl._id,
      name: pl.name,
      category: pl.category,
      location: pl.location,
      entranceLocation: pl.entranceLocation || null,
      visitDurationMin: pl.visitDurationMin,
      usable: isPlaceUsable(pl), // 未核验地点必须让界面看得见，不能假装可用
      verifiedAt: pl.verifiedAt || null,
      confidence: pl.confidence || null,
      tags: pl.tags || [],
    }));

  return resp.ok({ places, total: places.length });
}

async function detail(ctx) {
  const { repo } = ctx;
  require_fields(ctx.payload, ['placeId']);

  const place = await repo.get(C.PLACES, ctx.payload.placeId);
  if (!place) throw fail(CODES.NOT_FOUND, '地点不存在');

  return resp.ok({
    place,
    usable: isPlaceUsable(place),
    // 踏勘实测的步行时间，规划器会优先使用它而非直线估算
    walkableTo: place.walkableTo || [],
  });
}

module.exports = { list, detail };

'use strict';

/**
 * 地理计算。全库统一 GCJ-02（docs/01 §4），本模块不做坐标系转换，
 * 只负责距离与步行时间推算。
 */

const EARTH_R = 6371008.8;

/** 兼容 {latitude, longitude} / {lat, lng} / 云数据库 GeoPoint */
function coord(p) {
  if (!p) return null;
  const lat = p.latitude !== undefined ? p.latitude : p.lat;
  const lng = p.longitude !== undefined ? p.longitude : p.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  return { latitude: lat, longitude: lng };
}

const toRad = (d) => (d * Math.PI) / 180;

/** 直线距离（米）。 */
function haversineMeters(a, b) {
  const A = coord(a);
  const B = coord(b);
  if (!A || !B) return null;
  const dLat = toRad(B.latitude - A.latitude);
  const dLng = toRad(B.longitude - A.longitude);
  const lat1 = toRad(A.latitude);
  const lat2 = toRad(B.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

/**
 * 步行绕行系数。直线距离不等于步行距离：园区内有围墙、水体和单行路径。
 * 1.3 是保守估值，**踏勘实测后应以 place.walkableTo 的实测值覆盖**。
 * 任何 estimated 结果在界面上都必须可与实测区分（见 walkMinutes 的 source 字段）。
 */
const DETOUR_FACTOR = 1.3;

/** 超过这个直线距离就不认为可以步行前往，用于排除明显不合理的集合候选点。 */
const MAX_WALK_METERS = 3000;

/**
 * 步行时间的三个来源 —— **必须可区分**。
 *
 * 2026-10-13 修正：首版只有前两种，且规划器**从不调用地图接口** ——
 * 于是全天调通的步行路线接口在规划里一次都没被用到，"根据路况"名不副实。
 * 实测对照：中央大街 → 防洪纪念塔 直线 605 米 / 实际步行 815 米；
 * 而"起点旁 10 米"直线 10 米 / 实际步行 76 米 —— **短距离下直线估算完全不可靠**。
 */
const WALK_SOURCE = {
  /** 踏勘实测（`walkableTo` 里 source 缺省时的历史含义），最可信且零成本 */
  SURVEY: 'survey',
  /** 地图步行路线接口返回的真实路线 */
  UPSTREAM: 'upstream',
  /** 直线估算 —— **仅当地图接口不可用时**，界面必须标出这一来源 */
  ESTIMATED: 'estimated',
};

/** 查一条已记录的步行时间（双向）。 */
function findWalkRecord(holder, targetId) {
  if (!holder || !Array.isArray(holder.walkableTo)) return null;
  const hit = holder.walkableTo.find((w) => w && w.placeId === targetId);
  return hit && typeof hit.walkMin === 'number' ? hit : null;
}

/**
 * 把一条步行时间写进地点记录（纯函数，返回新的 `walkableTo` 数组）。
 *
 * `source` **必须显式给出** —— 由地图接口取回的时间若被记成踏勘实测，
 * 后续所有判断都会高估自己数据的可信度。
 */
function withWalkRecord(place, targetId, rec) {
  const list = (place && Array.isArray(place.walkableTo) ? place.walkableTo : []).filter(
    (w) => w && w.placeId !== targetId
  );
  list.push({
    placeId: targetId,
    walkMin: rec.walkMin,
    walkMeters: rec.walkMeters != null ? rec.walkMeters : null,
    source: rec.source || WALK_SOURCE.SURVEY,
    verifiedAt: rec.verifiedAt || null,
    measuredAt: rec.measuredAt || null,
  });
  return list;
}

/**
 * 这一段是否需要去上游取？两个方向都没有可用记录时才需要。
 * 用于让调用方只对**真正缺失**的路段发请求，不浪费地图配额。
 */
function needsWalkFetch(fromPlace, toPlace) {
  if (!fromPlace || !toPlace) return false;
  if (findWalkRecord(fromPlace, toPlace._id)) return false;
  if (findWalkRecord(toPlace, fromPlace._id)) return false;
  return true;
}

/**
 * 计算一段步行。来源按可信度递减：踏勘实测 → 地图接口 → 直线估算。
 * @returns {{minutes:number, meters:number, source:string, verifiedAt?:Date}}
 */
function walkMinutes(fromPlace, toPlace, params) {
  const speed = (params && params.walkSpeedMPerMin) || 75; // 75 m/min ≈ 4.5 km/h
  if (!fromPlace || !toPlace) return null;

  // 1) 已有记录（踏勘实测或此前由接口取回），双向查找
  const fwd = findWalkRecord(fromPlace, toPlace._id);
  if (fwd) {
    return {
      minutes: fwd.walkMin,
      meters: fwd.walkMeters != null ? fwd.walkMeters : null,
      // 缺省视为踏勘实测：`walkableTo` 本来就是为踏勘数据设计的字段
      source: fwd.source || WALK_SOURCE.SURVEY,
      verifiedAt: fwd.verifiedAt || null,
    };
  }
  const back = findWalkRecord(toPlace, fromPlace._id);
  if (back) {
    return {
      minutes: back.walkMin,
      meters: back.walkMeters != null ? back.walkMeters : null,
      source: back.source || WALK_SOURCE.SURVEY,
      verifiedAt: back.verifiedAt || null,
    };
  }

  // 2) 回落：直线距离 × 绕行系数 ÷ 步速。**读不到路线时的最后手段。**
  const straight = haversineMeters(fromPlace.location, toPlace.location);
  if (straight == null) return null;
  const meters = Math.round(straight * DETOUR_FACTOR);
  return { minutes: Math.max(1, Math.ceil(meters / speed)), meters, source: WALK_SOURCE.ESTIMATED };
}

const coordOf = (place, useEntrance) =>
  place && (useEntrance && place.entranceLocation ? place.entranceLocation : place.location);

module.exports = {
  coord,
  coordOf,
  haversineMeters,
  walkMinutes,
  findWalkRecord,
  withWalkRecord,
  needsWalkFetch,
  DETOUR_FACTOR,
  MAX_WALK_METERS,
  WALK_SOURCE,
};

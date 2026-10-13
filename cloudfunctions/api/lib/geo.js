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
 * 计算一段步行。
 * @returns {{minutes:number, meters:number, source:'measured'|'estimated', verifiedAt?:Date}}
 */
function walkMinutes(fromPlace, toPlace, params) {
  const speed = (params && params.walkSpeedMPerMin) || 75; // 75 m/min ≈ 4.5 km/h
  if (!fromPlace || !toPlace) return null;

  // 1) 优先用踏勘实测缓存（双向查找）
  const fwd = (fromPlace.walkableTo || []).find((w) => w.placeId === toPlace._id);
  if (fwd && typeof fwd.walkMin === 'number') {
    return {
      minutes: fwd.walkMin,
      meters: fwd.walkMeters != null ? fwd.walkMeters : null,
      source: 'measured',
      verifiedAt: fwd.verifiedAt || null,
    };
  }
  const back = (toPlace.walkableTo || []).find((w) => w.placeId === fromPlace._id);
  if (back && typeof back.walkMin === 'number') {
    return {
      minutes: back.walkMin,
      meters: back.walkMeters != null ? back.walkMeters : null,
      source: 'measured',
      verifiedAt: back.verifiedAt || null,
    };
  }

  // 2) 回落：直线距离 × 绕行系数 ÷ 步速
  const straight = haversineMeters(fromPlace.location, toPlace.location);
  if (straight == null) return null;
  const meters = Math.round(straight * DETOUR_FACTOR);
  return { minutes: Math.max(1, Math.ceil(meters / speed)), meters, source: 'estimated' };
}

const coordOf = (place, useEntrance) =>
  place && (useEntrance && place.entranceLocation ? place.entranceLocation : place.location);

module.exports = {
  coord,
  coordOf,
  haversineMeters,
  walkMinutes,
  DETOUR_FACTOR,
  MAX_WALK_METERS,
};

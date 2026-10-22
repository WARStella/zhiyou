'use strict';

/**
 * 地理计算。全库统一 GCJ-02（docs/项目计划书.md#data-model §4），本模块不做坐标系转换，
 * 只负责距离与步行时间推算。
 */

const EARTH_R = 6371008.8;

/** 兼容 {latitude, longitude} / {lat, lng} / 云数据库 GeoPoint */
function coord(p) {
  if (!p) return null;
  const lat = p.latitude !== undefined ? p.latitude : p.lat;
  const lng = p.longitude !== undefined ? p.longitude : p.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
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

/**
 * 查一条已记录的**步行**时间（双向）。
 *
 * ⚠️ 必须按方式过滤（2026-10-14 修）：`walkableTo` 现在同时装多种方式
 * （见下面的 `TRAVEL_MODE`），不带过滤会把**骑行/驾车**的记录当成步行读。
 *
 * 后果不是"慢一点"，而是**硬约束失效**：
 *   中央大街 → 防洪纪念塔  步行 11 分 / 骑行 2 分
 * 把骑行的 2 分当成步行，`maxWalkMinutes`（用户说"少走点路"）就永远不会触发。
 *
 * 兼容规则：**没有 `mode` 字段的记录一律视为步行** —— 那是历史形态
 * （踏勘数据与早先由接口取回的），零迁移成本。
 */
function findWalkRecord(holder, targetId) {
  if (!holder || !Array.isArray(holder.walkableTo)) return null;
  const hit = holder.walkableTo.find(
    (w) => w && w.placeId === targetId && (w.mode === undefined || w.mode === null || w.mode === TRAVEL_MODE.WALKING)
  );
  return hit && typeof hit.walkMin === 'number' ? hit : null;
}

/**
 * ── 多种出行方式（2026-10-14）─────────────────────────────
 *
 * 用户要求"显示真实出行方式 + 规划时多种方式对比着挑"。
 *
 * 设计决定：**继续用同一个 `walkableTo` 数组装所有方式**，
 * 靠可选的 `mode` 字段区分，而不是新开一个 `travelTo`。
 *
 * 理由（三条，都是为了不破坏既有语义）：
 *   ① `walkableTo` 的历史含义就是"从一个地方到另一个地方要多久"
 *      —— 走多久只是其中一种。改名会让已有的踏勘数据、测试与文档全部要动。
 *   ② **缺省 `mode` 视为 `'walking'`** —— 这样所有已录入的记录
 *      （踏勘数据、之前由接口取回的）自动仍然被解释为步行，零迁移成本。
 *   ③ 与 `WALK_SOURCE` 那三个来源（survey/upstream/estimated）正交：
 *      来源说的是"这个数多可信"，方式说的是"这是怎么走出来的"。两者都要能表达。
 */
const TRAVEL_MODE = {
  WALKING: 'walking',
  BICYCLING: 'bicycling',
  DRIVING: 'driving',
  TRANSIT: 'transit',
  SUBWAY: 'subway',
};

/** 缺省方式 —— 历史记录的 `mode` 字段为空时按它解释 */
const DEFAULT_TRAVEL_MODE = TRAVEL_MODE.WALKING;

/** 取一条记录的归一化形态，顺便把缺省 mode 补上（**只读，不改原记录**） */
function normalizeLegRecord(rec) {
  if (!rec) return null;
  const minutes = rec.walkMin !== undefined ? rec.walkMin : rec.minutes;
  if (typeof minutes !== 'number') return null;
  return {
    minutes,
    meters: rec.walkMeters != null ? rec.walkMeters : rec.meters != null ? rec.meters : null,
    mode: rec.mode || DEFAULT_TRAVEL_MODE,
    source: rec.source || WALK_SOURCE.SURVEY,
    verifiedAt: rec.verifiedAt || null,
    transit: rec.transit || null,
  };
}

/**
 * 查一条 **指定方式** 的出行记录（双向）。
 *
 * ⚠️ 与 `findWalkRecord` 的区别：那个不带方式过滤，是历史接口；
 * 这个按方式取，取不到就返回 null（**不回落**）—— 回落交给调用方决定，
 * 因为"骑行没有就步行顶"这种判断属于业务，不属于查表。
 */
function findLegRecord(holder, targetId, mode) {
  const wanted = mode || DEFAULT_TRAVEL_MODE;
  if (!holder || !Array.isArray(holder.walkableTo)) return null;
  const hit = holder.walkableTo.find(
    (w) => w && w.placeId === targetId && (w.mode || DEFAULT_TRAVEL_MODE) === wanted
  );
  return normalizeLegRecord(hit);
}

/**
 * 这一段是否**缺**指定方式的记录 —— 调用方据此只对真正缺失的段发请求。
 * 与 `needsWalkFetch` 同一个用途，但带方式。
 */
function needsLegFetch(fromPlace, toPlace, mode) {
  if (!fromPlace || !toPlace) return false;
  if (findLegRecord(fromPlace, toPlace._id, mode)) return false;
  if (findLegRecord(toPlace, fromPlace._id, mode)) return false;
  return true;
}

/**
 * 把一条指定方式的记录写进地点（纯函数，返回新的数组）。
 *
 * ⚠️ 字段名沿用 `walkMin` / `walkMeters`，**不另起 `minutes` / `meters`**。
 * 同一个数组里混两种字段名是最糟的结果：读的地方要兼容两套，
 * 而漏一处就会得到一个"看起来有值、实际读不到"的记录（且不报错）。
 * `mode` 才是这个函数带来的新东西。
 */
function withLegRecord(place, targetId, rec) {
  const mode = rec.mode || DEFAULT_TRAVEL_MODE;
  const list = (place && Array.isArray(place.walkableTo) ? place.walkableTo : []).filter(
    (w) => !(w && w.placeId === targetId && (w.mode || DEFAULT_TRAVEL_MODE) === mode)
  );
  list.push({
    placeId: targetId,
    walkMin: rec.minutes,
    walkMeters: rec.meters != null ? rec.meters : null,
    mode,
    source: rec.source || WALK_SOURCE.UPSTREAM,
    verifiedAt: rec.verifiedAt || null,
    measuredAt: rec.measuredAt || null,
    transit: rec.transit || null,
  });
  return list;
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

/**
 * 从**一个临时坐标**（如用户当前位置）到某地点的步行时间。
 *
 * 与 `walkMinutes` 的区别：起点是移动的，**不进 `walkableTo` 缓存** ——
 * 缓存是"地点↔地点"的，存一个每次都可能不同的位置没有意义。
 * 所以这里只提供估算；真实值由调用方先从地图接口取回再传入。
 */
function walkMinutesFromPoint(fromPoint, toPlace, params) {
  const speed = (params && params.walkSpeedMPerMin) || 75;
  const straight = haversineMeters(fromPoint, toPlace && toPlace.location);
  if (straight == null) return null;
  const meters = Math.round(straight * DETOUR_FACTOR);
  return {
    minutes: Math.max(1, Math.ceil(meters / speed)),
    meters,
    source: WALK_SOURCE.ESTIMATED,
  };
}

const coordOf = (place, useEntrance) =>
  place && (useEntrance && place.entranceLocation ? place.entranceLocation : place.location);

module.exports = {
  coord,
  coordOf,
  haversineMeters,
  walkMinutes,
  walkMinutesFromPoint,
  findWalkRecord,
  withWalkRecord,
  needsWalkFetch,
  DETOUR_FACTOR,
  MAX_WALK_METERS,
  WALK_SOURCE,
  // 多种出行方式（2026-10-14）
  TRAVEL_MODE,
  DEFAULT_TRAVEL_MODE,
  findLegRecord,
  withLegRecord,
  needsLegFetch,
  normalizeLegRecord,
};

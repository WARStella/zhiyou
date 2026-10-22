'use strict';

/**
 * 照片 provider 的共用部分。
 *
 * 两个 provider（`amap` / `fake`）与后续可能的第三家都要用同一套：
 * 坐标解析、照片字段提取、距离判定、"为什么没有照片"的解释。
 *
 * 放在这里而不是各自实现，是因为**距离守卫的阈值和含义必须只有一处定义** ——
 * 两处实现会漂移，而漂移的后果是"这道守卫在某些路径上其实没生效"，
 * 正是这个项目在版本校验上已经吃过一次的亏。
 */

const EARTH_R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;

function approxMeters(a, b) {
  if (!a || !b) return null;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

/** 高德把坐标写成 "lng,lat" 字符串 */
function parseLocation(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',');
  if (parts.length !== 2) return null;
  const lng = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { latitude: lat, longitude: lng };
}

/**
 * 照片与目标点位的**最大可信距离**（米）。
 *
 * 这条守卫的存在理由：**一张错误的照片比没有照片更糟**。
 * 没有照片时用户知道"我没看到图"；有照片时他会按图去找，
 * 而集合点找错地方的代价是整队人等在原地。
 *
 * 300 米对应"同一条街、同一个广场范围"这个量级。
 * 超过它不代表照片一定错，但**该点位与照片的关系已经无法核实**，
 * 因此一律标 `trusted: false`，由界面决定是否展示（默认不展示）。
 */
const MAX_TRUSTED_DISTANCE_M = 300;

/**
 * 判定一张照片能不能被信任为"这个点位的照片"。
 *
 * 返回的每一档都有明确含义，界面与答辩都直接引用它，不再各自解释：
 *
 *   `distance-verified`  照片所属 POI 距该点位 ≤ 300 米 —— 位置对得上
 *   `too-far`            距该点位 > 300 米 —— 很可能是另一个地方
 *   `distance-unknown`   上游没给坐标，无法判定 —— **不等于可信**
 *   `name-mismatch`      上游返回的名字与预期明显不符
 */
function judgeTrust(input) {
  const target = input.targetLocation || null;
  const poiLocation = input.poiLocation || null;
  const expectedName = input.expectedName ? String(input.expectedName).trim() : null;
  const poiName = input.poiName ? String(input.poiName).trim() : null;

  if (expectedName && poiName && !nameMatches(expectedName, poiName)) {
    return { trusted: false, basis: 'name-mismatch', distanceMeters: null, detail: `上游返回「${poiName}」，与「${expectedName}」不符` };
  }

  if (!target || !poiLocation) {
    return {
      trusted: false,
      basis: 'distance-unknown',
      distanceMeters: null,
      detail: '上游没有返回坐标，无法确认这张照片属于该点位（**无法确认不等于可信**）',
    };
  }

  const meters = Math.round(approxMeters(target, poiLocation));
  if (meters > MAX_TRUSTED_DISTANCE_M) {
    return {
      trusted: false,
      basis: 'too-far',
      distanceMeters: meters,
      detail: `照片所属地点距该点位约 ${meters} 米，超出可信范围（${MAX_TRUSTED_DISTANCE_M} 米）`,
    };
  }

  return {
    trusted: true,
    basis: 'distance-verified',
    distanceMeters: meters,
    detail: `照片所属地点距该点位约 ${meters} 米，位置对得上`,
  };
}

/**
 * 名字是否算"对得上"。
 *
 * 刻意**宽松**：上游的名字常带后缀（「哈尔滨工业大学」vs「哈工大」、
 * 「防洪纪念塔（中央大街）」vs「防洪纪念塔」）。
 * 这道检查的目的只是拦"完全不同的地方"，不是做严格匹配 ——
 * 严格匹配会误杀大量正确结果，而位置守卫已经能拦住真正危险的情况。
 */
function nameMatches(expected, actual) {
  const a = normalizeName(expected);
  const b = normalizeName(actual);
  if (!a || !b) return true;
  return a.includes(b) || b.includes(a);
}

/** 去掉括号后缀、空白与常见行政前缀，便于宽松比较 */
function normalizeName(name) {
  return String(name)
    .replace(/[（(].*?[）)]/g, '')
    .replace(/\s+/g, '')
    .replace(/^(哈尔滨市?|黑龙江省?)/, '')
    .toLowerCase();
}

/**
 * 取出 photos 数组。
 *
 * 字段名按高德文档：`photos: [{title, url}]`。
 * 但**文档与实际不总一致**（本项目在腾讯 `id`/`_id` 上已经吃过一次），
 * 所以两种常见写法都接受，并把实际命中的那个记进 `parsedVia` ——
 * 与 `lib/map/tencent.js` 同一条纪律：不靠记忆定死，由原始返回核对。
 */
function extractPhotos(poi) {
  const raw = poi.photos !== undefined ? poi.photos : poi.photo;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item) continue;
    const url = item.url || item.photo_url || null;
    if (!url) continue;
    out.push({ url, title: item.title || null });
  }
  return out;
}

/** 命中哪个字段名 —— 用于在真实返回与文档不一致时留下证据 */
function photosFieldVia(poi) {
  if (Array.isArray(poi.photos)) return 'pois[].photos';
  if (Array.isArray(poi.photo)) return 'pois[].photo';
  return null;
}

function pickNearest(pois, center) {
  let best = null;
  for (const poi of pois) {
    const loc = parseLocation(poi.location);
    if (!loc) continue;
    const distance =
      typeof poi.distance === 'number' && Number.isFinite(poi.distance)
        ? poi.distance
        : approxMeters(center, loc);
    const candidate = Object.assign({}, poi, { __distance: Math.round(distance || 0), __location: loc });
    if (!best || candidate.__distance < best.__distance) best = candidate;
  }
  return best;
}

/**
 * 把"为什么没有照片"说清楚。
 *
 * 这几种空的原因完全不同，混成一句"暂无照片"会让排查无从下手（§11.3「失败原因可定位」）。
 * 尤其 `POI_HAS_NO_PHOTO` —— 那不是故障，是上游这个点位确实没有照片。
 */
function explainEmpty(ctx) {
  if (ctx.reason === 'AMAP_KEY_NOT_CONFIGURED') return 'PROVIDER_NOT_CONFIGURED';
  if (!ctx.ok) return 'UPSTREAM_FAILED';
  if (!ctx.poiCount) return 'NO_POI_MATCHED';
  if (!ctx.photos.length) return 'POI_HAS_NO_PHOTO';
  return null;
}

module.exports = {
  approxMeters,
  parseLocation,
  judgeTrust,
  nameMatches,
  normalizeName,
  extractPhotos,
  photosFieldVia,
  pickNearest,
  explainEmpty,
  MAX_TRUSTED_DISTANCE_M,
};

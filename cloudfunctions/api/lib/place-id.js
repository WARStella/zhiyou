'use strict';

/**
 * 地点的**稳定标识**。
 *
 * ── 为什么需要它（2026-10-13）────────────────────────────
 *
 * 用户决定：**检索到的地点不再入库**，全从腾讯地图实时搜。
 * 于是候选没有数据库 `_id` —— 但下游处处需要一个"这个东西是谁"的键：
 *
 *   · `autoPick` / `bestMatch` 靠它去重、去匹配必去项；
 *   · `trip.plan` 用它当 `placesById` 的键；
 *   · `nodes[].placeId` 用它；
 *   · 踏勘实测的步行时间（`walkableTo`）按它索引。
 *
 * **必须是稳定的**：同一批地点两次规划要得到同一个键，否则
 * `placeId` 每次都变，`walkableTo` 永远对不上、行程也无法复现。
 *
 * ── 三种来源，优先级从高到低 ──────────────────────────────
 *
 *   ① `placeId`  —— 已入库（**踏勘核验过**）的地点，用它自己的 id；
 *   ② `poiId`    —— 腾讯给的 POI 主键，稳定且全局唯一；
 *   ③ 名字 + 千分位坐标 —— 前两者都没有时兜底，仍然稳定。
 *
 * ⚠️ ③ 的坐标取**三位小数**（约 100 米）：太精确会让"同一个地点因
 * 上游返回的坐标有一点点抖动"变成两个不同的键；太粗又会把相邻两家店
 * 合成一个。三位是实测下来够用的粒度。
 */

/** 生成稳定键；信息不足时返回 null（调用方必须显式处理，不能当空串用） */
function stablePlaceId(item) {
  if (!item) return null;
  if (item.placeId) return item.placeId;
  if (item.poiId) return `poi_${item.poiId}`;

  const loc = item.location || {};
  const name = item.name || item.title;
  if (!name) return null;
  if (typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') return null;

  return `x_${String(name).trim()}_${loc.latitude.toFixed(3)}_${loc.longitude.toFixed(3)}`;
}

/** 这个键是不是"内存里合成的"（没入库）；用于决定能不能往它身上写缓存 */
function isSyntheticId(id) {
  return typeof id === 'string' && (id.startsWith('poi_') || id.startsWith('x_'));
}

module.exports = { stablePlaceId, isSyntheticId };

'use strict';

/**
 * 时间线推算 —— §6.3：
 *   预计完成时间 = 当前时间 + 剩余交通时间 + 停留时间 + 必要的集合及衔接时间
 *
 * 本模块是纯函数：不读数据库、不看当前时间（除传入的 startAt），因此可被完整单测。
 */

const { addMin, diffMin } = require('../lib/time');
const geo = require('../lib/geo');

/**
 * @param {object} p
 * @param {Date}   p.startAt      出发时刻
 * @param {Array}  p.items        [{nodeId?, placeId, stayMin?}]，stayMin 省略则用地点默认值
 * @param {object} p.placesById   placeId -> place
 * @param {object} p.params       {walkSpeedMPerMin, stayMinDefault, meetBufferMin}
 * @returns {{legs:Array, endAt:Date, totalWalkMin:number, totalWalkMeters:number, totalStayMin:number, meetBufferMin:number}}
 */
function buildTimeline(p) {
  const params = p.params || {};
  const stayDefault = params.stayMinDefault || 30;
  const meetBufferMin = params.meetBufferMin || 0;

  const legs = [];
  let cursor = new Date(p.startAt);
  let totalWalkMin = 0;
  let totalWalkMeters = 0;
  let totalStayMin = 0;
  let prevPlace = null;

  (p.items || []).forEach((item, idx) => {
    const place = p.placesById[item.placeId];
    if (!place) return; // 调用方应已校验；此处跳过而非编造数据

    let travelMin = 0;
    let travelMeters = 0;
    let travelSource = 'none';
    if (prevPlace) {
      const w = geo.walkMinutes(prevPlace, place, params);
      if (w) {
        travelMin = w.minutes;
        travelMeters = w.meters || 0;
        travelSource = w.source;
      }
    }

    const stayMin =
      typeof item.stayMin === 'number'
        ? item.stayMin
        : place.visitDurationMin && typeof place.visitDurationMin.default === 'number'
          ? place.visitDurationMin.default
          : stayDefault;

    const arriveAt = addMin(cursor, travelMin);
    const leaveAt = addMin(arriveAt, stayMin);

    legs.push({
      nodeId: item.nodeId || null,
      seq: idx,
      placeId: place._id,
      placeName: place.name,
      travelFromPrevMin: travelMin,
      travelFromPrevMeters: travelMeters,
      travelSource,
      plannedArriveAt: arriveAt,
      plannedStayMin: stayMin,
      plannedLeaveAt: leaveAt,
    });

    totalWalkMin += travelMin;
    totalWalkMeters += travelMeters;
    totalStayMin += stayMin;
    cursor = leaveAt;
    prevPlace = place;
  });

  // 集合及衔接缓冲：只在末尾加一次，避免每个节点都膨胀
  const endAt = addMin(cursor, meetBufferMin);

  return {
    legs,
    endAt,
    totalWalkMin,
    totalWalkMeters,
    totalStayMin,
    meetBufferMin,
  };
}

/** 把时间线转成 trips.nodes 结构。 */
function toNodes(legs, source) {
  return legs.map((l) => ({
    nodeId: l.nodeId || `n_${l.seq}_${l.placeId}`,
    placeId: l.placeId,
    placeName: l.placeName,
    seq: l.seq,
    plannedArriveAt: l.plannedArriveAt,
    plannedLeaveAt: l.plannedLeaveAt,
    plannedStayMin: l.plannedStayMin,
    travelFromPrevMin: l.travelFromPrevMin,
    travelFromPrevMeters: l.travelFromPrevMeters,
    status: 'pending',
    actualArriveAt: null,
    actualLeaveAt: null,
    source: source || 'plan',
  }));
}

/** 加总步行分钟。用于 maxWalkMinutes 硬约束检查。 */
const walkMinutesOf = (legs) => legs.reduce((s, l) => s + (l.travelFromPrevMin || 0), 0);

/** 剩余路段（从某节点开始的后续安排）。首版每次只重点处理未来 1–3 个节点（§十）。 */
function remainingFrom(legs, nodeId) {
  const i = legs.findIndex((l) => l.nodeId === nodeId);
  return i < 0 ? legs.slice() : legs.slice(i);
}

/** 两时刻之间的分钟差，用于计算集合延迟对后续的影响。 */
const delayMin = (actual, planned) => Math.max(0, Math.round(diffMin(actual, planned)));

module.exports = { buildTimeline, toNodes, walkMinutesOf, remainingFrom, delayMin };

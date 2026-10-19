'use strict';

/**
 * 集合协同 —— §7.1 集合方式、§7.2 状态、§7.3 三时间。
 *
 * 本文件里最容易被写错、也最要命的一条：
 *   **全员到齐（②）不等于团队出发（③）。**
 *   到齐之后团队可能还要休息、整理物品、买东西。若把 ② 当作离开时间写进线路，
 *   系统会系统性低估延误，误差沿后续节点一路放大。
 *   因此 ② 只写 allArrivedAt 并给出"预计"安排；只有 ③ 才触发后续可行性更新。
 *
 * 本模块是纯函数，可完整单测。
 */

const authz = require('../lib/authz');

const time = require('../lib/time');
const geo = require('../lib/geo');
/** 实际地点应在成员平均中心周围 1 公里内，不限制成员到地点的距离。 */
const MEET_SEARCH_RADIUS_METERS = 1000;
const timelineMod = require('./timeline');
const { checkFeasibility } = require('./feasibility');

const MEET_STATUS = {
  PROPOSED: 'proposed',
  CONFIRMED: 'confirmed',
  ACTIVE: 'active',
  ARRIVED_ALL: 'arrived_all',
  DEPARTED: 'departed',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

const TRANSITIONS = {
  proposed: ['confirmed', 'cancelled'],
  confirmed: ['active', 'cancelled'],
  active: ['arrived_all', 'cancelled'],
  arrived_all: ['departed', 'cancelled'],
  departed: ['completed'],
  completed: [],
  cancelled: [],
};

const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const e = new Error(`集合状态不允许从 ${from} 变为 ${to}`);
    e.code = 'INVALID_PARAM';
    e.expected = true;
    throw e;
  }
}

/** 参与人退出本次集合（§7.2：不参与者可以退出本次集合）。 */
const activeParticipants = (task) =>
  (task.participants || []).filter((p) => p.status !== 'declined');

/**
 * 有效确认数。
 * **只有 confirmedVersion 恰好等于当前 version 的确认才算数** ——
 * 这条实现了"更换地点或时间后生成新版本，旧确认不能直接用于新版本"（§7.2）。
 */
const effectiveConfirmed = (task) =>
  (task.participants || []).filter(
    (p) => p.status === 'confirmed' && p.confirmedVersion === task.version
  );

const staleConfirmations = (task) =>
  (task.participants || []).filter(
    (p) => p.status === 'confirmed' && p.confirmedVersion !== task.version
  );

const allConfirmed = (task) => {
  const need = activeParticipants(task);
  return need.length > 0 && effectiveConfirmed(task).length === need.length;
};

const arrivedCount = (task) => (task.participants || []).filter((p) => p.status === 'arrived').length;

/**
 * 成员确认或拒绝。
 * @returns {{patch:object, invalidated:boolean, reason?:string}}
 */
function applyConfirm(task, userId, decision, now, expectedVersion) {
  if (expectedVersion !== undefined && expectedVersion !== task.version) {
    return {
      patch: null,
      invalidated: true,
      reason: `确认基于版本 ${expectedVersion}，当前已是版本 ${task.version}，需要重新确认`,
    };
  }
  const participants = (task.participants || []).map((p) => {
    if (p.userId !== userId) return p;
    if (p.status === 'declined' && decision === 'confirm') {
      // 退出后又回来：允许，但必须重新确认当前版本
      return Object.assign({}, p, {
        status: 'confirmed',
        confirmedVersion: task.version,
        confirmedAt: now,
        declinedAt: null,
      });
    }
    if (decision === 'confirm') {
      return Object.assign({}, p, {
        status: 'confirmed',
        confirmedVersion: task.version,
        confirmedAt: now,
      });
    }
    return Object.assign({}, p, {
      status: 'declined',
      confirmedVersion: null,
      declinedAt: now,
    });
  });

  const next = Object.assign({}, task, { participants });
  const patch = { participants };

  if (allConfirmed(next) && task.status === MEET_STATUS.PROPOSED) {
    patch.status = MEET_STATUS.CONFIRMED;
    patch.confirmedAt = now;
  }
  // 有人拒绝时回到 proposed 重新协商，不把沉默当同意（§8.1）
  if (decision === 'decline' && task.status === MEET_STATUS.CONFIRMED) {
    patch.status = MEET_STATUS.PROPOSED;
  }

  return { patch, invalidated: false };
}

/**
 * 成员标记已到达。最后一人到达时写 **② allArrivedAt**。
 * 注意：此处**绝不**更新对应行程节点，也不改路线（§7.3 联动规则第一条）。
 */
function applyArrive(task, userId, now) {
  const participants = (task.participants || []).map((p) =>
    p.userId === userId && p.status !== 'arrived'
      ? Object.assign({}, p, { status: 'arrived', arrivedAt: now })
      : p
  );

  const need = participants.filter((p) => p.status !== 'declined');
  const allHere = need.length > 0 && need.every((p) => p.status === 'arrived');

  const patch = { participants };
  if (allHere) {
    patch.status = MEET_STATUS.ARRIVED_ALL;
    patch.allArrivedAt = now; // ② 实际全员到齐时间
  } else if (task.status === MEET_STATUS.CONFIRMED) {
    patch.status = MEET_STATUS.ACTIVE;
  }
  return { patch, allArrived: allHere };
}

/**
 * 发起人点击"前往下一站"。写 **③ departedAt**，此刻才是更新后续行程可行性的时机。
 *
 * @returns {{patch:object, departedAt:Date}}
 */
function applyDepart(task, now, expectedVersion) {
  if (expectedVersion !== undefined && expectedVersion !== task.version) {
    return {
      patch: null,
      error: {
        code: 'VERSION_CONFLICT',
        message: '集合任务已被更新，请刷新后重试',
        details: { currentVersion: task.version },
      },
    };
  }
  if (task.status !== MEET_STATUS.ARRIVED_ALL) {
    return {
      patch: null,
      error: {
        code: 'INVALID_PARAM',
        message: '尚未全员到齐，不能标记出发',
        details: { status: task.status, arrived: arrivedCount(task) },
      },
    };
  }
  return {
    patch: {
      status: MEET_STATUS.DEPARTED,
      departedAt: now, // ③ 实际开始前往下一站时间
    },
    departedAt: now,
  };
}

/**
 * 出发后评估对后续行程的影响（§7.3 联动规则第二、三条）。
 * 只在 ③ 之后调用；不在 ② 时调用，也不因位置更新调用。
 */
function evaluateDepartImpact(p) {
  const { task, trip, placesById, params, constraints, departedAt } = p;
  if (!trip) return { affectsTrip: false, delayMin: 0, shouldReevaluate: false };

  const delayMin = Math.max(0, Math.round(time.diffMin(departedAt, task.plannedMeetAt)));

  const nodes = (trip.nodes || []).slice().sort((a, b) => a.seq - b.seq);
  const anchorId = task.linkToTrip && task.linkToTrip.affectsNodeId;
  let startIdx = anchorId ? nodes.findIndex((n) => n.nodeId === anchorId) : 0;
  if (startIdx < 0) {
    startIdx = nodes.findIndex((n) => new Date(n.plannedArriveAt) >= new Date(task.plannedMeetAt));
  }
  if (startIdx < 0) startIdx = nodes.length;

  const remaining = nodes.slice(startIdx).filter((n) => n.status !== 'done');
  if (!remaining.length) {
    return { affectsTrip: false, delayMin, shouldReevaluate: false, restartAt: departedAt };
  }

  const tl = timelineMod.buildTimeline({
    startAt: departedAt, // 从实际出发时刻重算，而不是从计划时刻
    items: remaining.map((n) => ({ nodeId: n.nodeId, placeId: n.placeId, stayMin: n.plannedStayMin })),
    placesById,
    params,
  });
  const res = checkFeasibility({ timeline: tl, constraints, placesById });

  return {
    affectsTrip: true,
    delayMin,
    restartAt: departedAt,
    remainingTimeline: tl,
    feasibility: res,
    // 只有确实不可行了才提出调整候选，且是一次性提出（§7.3 第三条）
    shouldReevaluate: !res.feasible,
    conflicts: res.conflicts,
  };
}

/**
 * 集合点推荐（§7.1）。
 *
 * 按所有成员坐标的算术平均值取中心，候选按离中心的直线距离排序。
 * 无可用地点时，调用方可开启 fallbackToCenter，直接采用中心坐标。
 * 中心不是已核验的入口，也不保证多人严格等距；各成员步行时间仅为估算。
 *
 * @param {object} p
 * @param {Array}  p.members       [{userId, point, reportedAt, source, locationId}]
 * @param {Array}  p.candidatePlaces 候选集合点
 * @param {object} p.params
 * @param {Date}   p.deadline      最晚到达时间（可空）
 * @param {object} p.ctx           含 now，用于计算位置时效
 * @returns {{candidates:Array, excluded:Array}}
 */
function recommendMeetPoints(p) {
  const params = p.params || {};
  const speed = params.walkSpeedMPerMin || 75;
  const excluded = [];
  const candidates = [];
  const members = p.members || [];
  const points = members.map(m => geo.coord(m.point));
  const locationIssues = [];
  members.forEach((m, i) => {
    if (m.sharingOff) {
      locationIssues.push({ userId: m.userId, reason: 'LOCATION_SHARING_OFF', message: '有成员关闭了位置共享，请开启并共享一次当前位置' });
    } else if (!points[i]) {
      locationIssues.push({ userId: m.userId, reason: 'MEMBER_NO_LOCATION', message: '有成员没有可用位置，请先获取并共享一次当前位置' });
    } else {
      const fresh = time.freshness(m.reportedAt, p.ctx);
      if (m.reportedAt == null || !Number.isFinite(fresh.ageSeconds) || fresh.stale) {
        locationIssues.push({ userId: m.userId, reason: 'LOCATION_STALE', message: '有成员的位置已过期，请重新获取并共享一次当前位置', ageSeconds: fresh.ageSeconds });
      }
    }
  });
  if (!members.length) locationIssues.push({ reason: 'NO_LOCATION_AVAILABLE', message: '没有可用的成员位置，请先共享当前位置' });
  const center = locationIssues.length ? null : {
    latitude: points.reduce((sum, point) => sum + point.latitude, 0) / points.length,
    longitude: points.reduce((sum, point) => sum + point.longitude, 0) / points.length,
  };

  function consider(place, isCenter) {
    // 集合点无需实地核验，按名称、坐标及显式可用状态判断。
    if (!authz.canBeMeetingPoint(place)) {
      excluded.push({
        placeId: place._id,
        /** 界面要把排除原因挂在地点上；缺了 name 就只能显示一串 id（10/14 修） */
        placeName: place.name,
        reason: 'PLACE_NOT_MEETING_POINT',
        message: '该地点资料不完整、可信度较低或已标记为不适合集合，请选择其他地点',
      });
      return;
    }

    if (locationIssues.length) return;
    const point = geo.coord(geo.coordOf(place, true));
    if (!point) {
      excluded.push({ placeId: place._id, placeName: place.name, reason: 'PLACE_NOT_MEETING_POINT', message: '集合点入口坐标无效，请选择其他地点' });
      return;
    }
    const centerDistance = geo.haversineMeters(center, point);
    if (centerDistance > MEET_SEARCH_RADIUS_METERS + 1e-6) {
      excluded.push({ placeId: place._id, placeName: place.name,
        reason: 'OUTSIDE_CENTER_RADIUS', centerDistanceMeters: Math.round(centerDistance),
        message: '该地点距成员平均中心超过 1 公里，已排除' });
      return;
    }

    const estimates = [];
    let blocked = null;

    for (const m of members) {
      const straight = geo.haversineMeters(m.point, point);
      if (straight == null) {
        blocked = { reason: 'MEMBER_NO_LOCATION', message: '位置或地点坐标缺失', userId: m.userId };
        break;
      }
      const meters = Math.round(straight * geo.DETOUR_FACTOR);
      const walkMin = Math.max(1, Math.ceil(meters / speed));
      estimates.push({
        userId: m.userId,
        walkMin,
        walkMeters: meters,
        fromSource: m.source || null,
        fromReportedAt: m.reportedAt || null,
        fromLocationId: m.locationId || null,
      });
    }

    if (blocked) {
      excluded.push({ placeId: place._id, placeName: place.name, ...blocked });
      return;
    }
    if (!estimates.length) {
      excluded.push({ placeId: place._id, placeName: place.name, reason: 'NO_PARTICIPANTS', message: '没有参与成员' });
      return;
    }

    const maxWalkMin = Math.max(...estimates.map((e) => e.walkMin));
    const sumWalkMin = estimates.reduce((s, e) => s + e.walkMin, 0);
    const avgWalkMin = Math.round((sumWalkMin / estimates.length) * 10) / 10;
    const spreadMin = maxWalkMin - Math.min(...estimates.map((e) => e.walkMin));

    if (p.deadline) {
      const latestArrive = time.addMin(p.ctx && p.ctx.now ? p.ctx.now : new Date(), maxWalkMin);
      if (new Date(latestArrive) > new Date(p.deadline)) {
        excluded.push({
          placeId: place._id,
          placeName: place.name,
          reason: 'DEADLINE_EXCEEDED',
          message: `最远成员需 ${maxWalkMin} 分钟，赶不上约定的最晚到达时间`,
          maxWalkMin,
        });
        return;
      }
    }

    candidates.push({
      placeId: place._id,
      placeName: place.name,
      category: place.category,
      point,
      entrancePoint: geo.coord(place.entranceLocation),
      candidateSource: isCenter ? 'geometric-center' : (place.candidateSource || 'library'),
      centerDistanceMeters: Math.round(centerDistance),
      maxWalkMin,
      avgWalkMin,
      spreadMin,
      estimates,
      distanceSource: 'estimated',
      score: centerDistance,
    });
  }

  for (const place of p.candidatePlaces || []) consider(place, false);
  excluded.push(...locationIssues);
  if (center && !candidates.length && p.fallbackToCenter) {
    consider({ _id: null, name: '成员位置几何中心', location: center, category: 'meeting' }, true);
  }
  candidates.sort((a, b) => a.score - b.score || String(a.placeId).localeCompare(String(b.placeId)));
  const failure = locationIssues[0] || excluded[excluded.length - 1];
  return { candidates, excluded, center, searchRadiusMeters: MEET_SEARCH_RADIUS_METERS,
    reason: candidates.length ? null : (failure && failure.reason) || 'NO_CANDIDATES',
    message: candidates.length ? null : (failure && failure.message) || '没有可用的集合点',
  };
}

module.exports = {
  MEET_SEARCH_RADIUS_METERS,
  MEET_STATUS,
  TRANSITIONS,
  canTransition,
  activeParticipants,
  effectiveConfirmed,
  staleConfirmations,
  allConfirmed,
  arrivedCount,
  applyConfirm,
  applyArrive,
  applyDepart,
  evaluateDepartImpact,
  recommendMeetPoints,
};

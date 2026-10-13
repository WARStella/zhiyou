'use strict';

/**
 * 可行性检查 —— §6.3 处理顺序的 ①「满足新的硬约束」。
 *
 * 关键分工（不要混）：
 *   conflicts  → 硬约束被违反 ⇒ feasible = false。**必须返回给用户，不得静默忽略**。
 *   quality    → 基本游览质量下降（如停留被压到下限以下）⇒ 仍然可行，
 *                但该节点**不计入"有效保留"**。对应 §6.3：
 *                「不得为了少改计划而把停留压缩到无意义」。
 *   warnings   → 未知条件与数据缺口，提示但不阻断。
 *
 * 本模块是纯函数，可完整单测。
 */

const { diffMin } = require('../lib/time');
const constraint = require('./constraint');
const authz = require('../lib/authz');

/**
 * @param {object} p
 * @param {object} p.timeline     buildTimeline 的结果
 * @param {Array}  p.constraints  约束数组（原始或已规范化）
 * @param {object} p.placesById
 * @returns {{feasible:boolean, conflicts:Array, quality:object, warnings:Array}}
 */
function checkFeasibility(p) {
  const t = p.timeline;
  const placesById = p.placesById || {};
  const constraints = constraint.normalize(p.constraints);
  const conflicts = [];
  const warnings = [];

  // ── 0. 多人硬约束互相冲突：直接上报，不自行取舍（§6.2）
  conflicts.push(...constraint.detectConflicts(constraints));

  // ── 1. 数据缺口不得被当成 0 处理（否则就是"悄悄执行错误安排"）
  t.legs.forEach((leg, i) => {
    if (i > 0 && leg.travelFromPrevMin === 0) {
      conflicts.push({
        code: 'INSUFFICIENT_DATA',
        message: `无法计算前往「${leg.placeName}」的步行时间，缺少可用的路线数据`,
        nodeId: leg.nodeId,
        placeId: leg.placeId,
        hardConstraintKey: null,
      });
    }
  });
  Object.values(placesById).forEach((pl) => {
    if (!authz.isPlaceUsable(pl)) {
      warnings.push({
        code: 'PLACE_UNVERIFIED',
        message: `「${pl.name}」尚未完成实地核验`,
        placeId: pl._id,
      });
    }
  });

  // ── 2. 结束时间硬约束
  const endAt = constraint.hardValue(constraints, 'endAt', 'min');
  let endAtExceededMin = 0;
  if (endAt) {
    endAtExceededMin = Math.round(diffMin(t.endAt, new Date(endAt)));
    if (endAtExceededMin > 0) {
      conflicts.push({
        code: 'END_TIME_EXCEEDED',
        message: `按当前安排预计比要求的结束时间晚 ${endAtExceededMin} 分钟`,
        exceededMin: endAtExceededMin,
        requiredEndAt: endAt,
        computedEndAt: t.endAt,
        hardConstraintKey: 'endAt',
      });
    }
  }

  // ── 3. 必去地点
  const present = new Set(t.legs.map((l) => l.placeId));
  const mustVisit = constraint.hardList(constraints, 'mustVisit');
  const missingMust = mustVisit.filter((id) => !present.has(id));
  if (missingMust.length) {
    conflicts.push({
      code: 'MUST_VISIT_MISSING',
      message: `必去地点未包含在方案中：${missingMust
        .map((id) => (placesById[id] && placesById[id].name) || id)
        .join('、')}`,
      placeIds: missingMust,
      hardConstraintKey: 'mustVisit',
    });
  }

  // ── 4. 排除地点
  const avoid = constraint.hardList(constraints, 'avoid');
  const included = avoid.filter((id) => present.has(id));
  if (included.length) {
    conflicts.push({
      code: 'AVOID_PLACE_INCLUDED',
      message: `方案中包含被要求排除的地点：${included
        .map((id) => (placesById[id] && placesById[id].name) || id)
        .join('、')}`,
      placeIds: included,
      hardConstraintKey: 'avoid',
    });
  }

  // ── 5. 步行上限
  const maxWalkMinutes = constraint.hardValue(constraints, 'maxWalkMinutes');
  if (maxWalkMinutes != null && t.totalWalkMin > maxWalkMinutes) {
    conflicts.push({
      code: 'WALK_LIMIT_EXCEEDED',
      message: `总步行约 ${t.totalWalkMin} 分钟，超出上限 ${maxWalkMinutes} 分钟`,
      required: maxWalkMinutes,
      actual: t.totalWalkMin,
      hardConstraintKey: 'maxWalkMinutes',
    });
  }
  const maxWalkMeters = constraint.hardValue(constraints, 'maxWalkMeters');
  if (maxWalkMeters != null && t.totalWalkMeters > maxWalkMeters) {
    conflicts.push({
      code: 'WALK_LIMIT_EXCEEDED',
      message: `总步行约 ${t.totalWalkMeters} 米，超出上限 ${maxWalkMeters} 米`,
      required: maxWalkMeters,
      actual: t.totalWalkMeters,
      hardConstraintKey: 'maxWalkMeters',
    });
  }

  // ── 6. 基本游览质量：停留不得低于地点下限
  const minStayViolations = [];
  t.legs.forEach((l) => {
    const pl = placesById[l.placeId];
    const requiredMin = pl && pl.visitDurationMin ? pl.visitDurationMin.min : null;
    if (requiredMin != null && l.plannedStayMin < requiredMin) {
      minStayViolations.push({
        nodeId: l.nodeId,
        placeId: l.placeId,
        placeName: l.placeName,
        plannedStayMin: l.plannedStayMin,
        requiredMin,
      });
    }
  });

  // ── 7. 未知条件：提示但不阻断
  constraint.unknown(constraints).forEach((c) => {
    warnings.push({
      code: 'CONSTRAINT_UNKNOWN',
      message: `「${c.key}」的表述不够明确，未参与可行性判断，需要确认`,
      key: c.key,
      sourceMemberIds: c.sourceMemberIds,
    });
  });
  constraint.soft(constraints).forEach((c) => {
    warnings.push({
      code: 'SOFT_PREFERENCE',
      message: `软偏好「${c.key}」已尽量满足，不保证`,
      key: c.key,
    });
  });

  // ── 8. 有效保留 = 在方案中 且 停留未低于下限
  const violatedIds = new Set(minStayViolations.map((v) => v.placeId));
  const effectivePreserved = t.legs.filter((l) => !violatedIds.has(l.placeId));
  const preservedMustVisitCount = mustVisit.filter(
    (id) => present.has(id) && !violatedIds.has(id)
  ).length;

  return {
    feasible: conflicts.length === 0,
    conflicts,
    warnings,
    quality: {
      totalStayMin: t.totalStayMin,
      totalWalkMin: t.totalWalkMin,
      minStayViolations,
      effectivePreservedCount: effectivePreserved.length,
      preservedMustVisitCount,
      // 是否满足 §6.3「不得把停留压缩到无意义」
      meetsBasicQuality: minStayViolations.length === 0,
    },
  };
}

module.exports = { checkFeasibility };

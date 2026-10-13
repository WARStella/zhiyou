'use strict';

/**
 * 候选路线生成 —— §6.3 处理顺序与 §6.4 动态调整原则。
 *
 * 处理顺序写死在此，避免歧义：
 *   ① 满足新的硬约束 → ② 保证基本游览质量 → ③ 比较偏好满足、步行负担与修改幅度。
 *
 * 两种策略（10/28 验收要求："少改原计划"／"按当前需求重新优化"，去重与可行性筛选）：
 *   minimal_change  先缩短、后删除，尽量保住原节点 → 对应"优先保留原计划的动态调整"
 *   reoptimize      直接删除靠后的非必去节点，再尝试重新插入 → 更激进，但可能少走路
 *
 * 首版范围（§6.3）：只在**有限候选**（原计划的局部替换与顺延）中比较，不做全局最优搜索。
 * 文档、界面与答辩均不使用"全局最小"表述。
 *
 * 本模块是纯函数：不读数据库、不看系统时间（startAt 由调用方传入），可完整单测。
 */

const timelineMod = require('./timeline');
const { checkFeasibility } = require('./feasibility');
const constraintMod = require('./constraint');

const ALGO_VERSION = 'planner-0.1.0';

/** 缩短停留时的步长（分钟）。步长越小越平滑，但循环次数越多。 */
const TRIM_STEP_MIN = 5;
/** 修复循环上限，防止病态输入导致死循环。 */
const MAX_REPAIR_ITER = 40;

const toItems = (nodes) =>
  (nodes || [])
    .slice()
    .sort((a, b) => (a.seq || 0) - (b.seq || 0))
    .map((n) => ({
      nodeId: n.nodeId,
      placeId: n.placeId,
      stayMin: n.plannedStayMin,
      status: n.status,
    }));

const signature = (items) => items.map((i) => `${i.placeId}:${i.stayMin}`).join('|');

const minStayOf = (place, params) =>
  (place && place.visitDurationMin && place.visitDurationMin.min) ||
  (params && params.stayMinDefault) ||
  10;

/** 把触发条件施加到节点列表上，返回新的 items 与本次施加的说明。 */
function applyTrigger(items, trigger, placesById) {
  const out = items.map((i) => Object.assign({}, i));
  const notes = [];
  const t = trigger || {};
  const payload = t.payload || {};

  switch (t.type) {
    case 'extend_stay':
    case 'shorten_stay': {
      const target = out.find((i) => i.nodeId === payload.nodeId);
      if (!target) {
        notes.push({ code: 'NODE_NOT_FOUND', message: '要修改的节点不在当前行程中' });
        break;
      }
      const rawDelta = Number(payload.deltaMin) || 0;
      const delta = t.type === 'extend_stay' ? Math.abs(rawDelta) : -Math.abs(rawDelta);
      target.stayMin = Math.max(0, target.stayMin + delta);
      notes.push({
        code: t.type === 'extend_stay' ? 'STAY_EXTENDED' : 'STAY_SHORTENED',
        message: `「${(placesById[target.placeId] || {}).name || target.placeId}」停留${
          delta > 0 ? '延长' : '缩短'
        } ${Math.abs(delta)} 分钟`,
        nodeId: target.nodeId,
        deltaMin: delta,
      });
      break;
    }

    case 'skip_node': {
      const idx = out.findIndex((i) => i.nodeId === payload.nodeId);
      if (idx < 0) {
        notes.push({ code: 'NODE_NOT_FOUND', message: '要跳过的节点不在当前行程中' });
        break;
      }
      const removed = out.splice(idx, 1)[0];
      notes.push({
        code: 'NODE_SKIPPED',
        message: `已跳过「${(placesById[removed.placeId] || {}).name || removed.placeId}」`,
        nodeId: removed.nodeId,
        placeId: removed.placeId,
      });
      break;
    }

    case 'replace_node': {
      const target = out.find((i) => i.nodeId === payload.nodeId);
      if (!target || !payload.newPlaceId) {
        notes.push({ code: 'NODE_NOT_FOUND', message: '要替换的节点或目标地点缺失' });
        break;
      }
      target.placeId = payload.newPlaceId;
      target.stayMin = undefined; // 用新地点的默认停留
      notes.push({
        code: 'NODE_REPLACED',
        message: `已替换为「${(placesById[payload.newPlaceId] || {}).name || payload.newPlaceId}」`,
        nodeId: target.nodeId,
        placeId: payload.newPlaceId,
      });
      break;
    }

    case 'manual_progress': {
      // 实际进度偏离计划：已完成节点不再重算，起点改为"现在"
      if (payload.nodeId) {
        const idx = out.findIndex((i) => i.nodeId === payload.nodeId);
        if (idx >= 0 && payload.status === 'done') {
          out.splice(0, idx + 1);
          notes.push({ code: 'PROGRESS_APPLIED', message: '已按实际进度跳过已完成节点' });
        }
      }
      break;
    }

    // change_end_time 不修改节点，只改约束（在 buildConstraints 中处理）
    case 'change_end_time':
    default:
      break;
  }

  return { items: out, notes };
}

/** 合并基础约束与本次触发对约束的修改。 */
function buildConstraints(baseConstraints, trigger) {
  const list = (baseConstraints || []).map((c) => Object.assign({}, c));
  const t = trigger || {};
  if (t.type === 'change_end_time' && t.payload && t.payload.endAt) {
    const existing = list.find((c) => c.key === 'endAt' && c.hardness === 'hard');
    if (existing) existing.value = t.payload.endAt;
    else
      list.push({
        key: 'endAt',
        value: t.payload.endAt,
        hardness: 'hard',
        confirmedAt: new Date(),
        sourceMemberIds: t.payload.sourceMemberIds || [],
      });
  }
  return list;
}

/** 在给定时间线下的可行性与质量评估。 */
function evaluate(items, ctx) {
  const tl = timelineMod.buildTimeline({
    startAt: ctx.startAt,
    items,
    placesById: ctx.placesById,
    params: ctx.params,
  });
  const res = checkFeasibility({
    timeline: tl,
    constraints: ctx.constraints,
    placesById: ctx.placesById,
  });
  return { timeline: tl, feasibility: res };
}

/**
 * minimal_change：以满足新硬约束为底线，**先缩短、后删除**，尽量保住原节点。
 * §6.3 的顺序 ①→② 就体现在这个循环里：能靠缩短解决就不删节点，
 * 且缩短不得低于地点停留下限（否则该节点不算"有效保留"，由 feasibility.quality 标记）。
 */
function repairMinimalChange(items, ctx, notes) {
  let cur = items.map((i) => Object.assign({}, i));
  let evaluation = evaluate(cur, ctx);
  let iter = 0;

  while (!evaluation.feasibility.feasible && iter++ < MAX_REPAIR_ITER) {
    const mustVisit = new Set(constraintMod.hardList(ctx.constraints, 'mustVisit'));

    // ① 从最后一个非必去节点开始，逐步缩短（保住节点，优先于删除）
    let repaired = false;
    for (let i = cur.length - 1; i >= 0; i--) {
      const place = ctx.placesById[cur[i].placeId];
      if (mustVisit.has(cur[i].placeId)) continue;
      if (cur[i].stayMin - TRIM_STEP_MIN >= minStayOf(place, ctx.params)) {
        cur[i].stayMin -= TRIM_STEP_MIN;
        notes.push({
          code: 'STAY_TRIMMED',
          message: `为满足时间要求，把「${place ? place.name : cur[i].placeId}」停留压缩 ${TRIM_STEP_MIN} 分钟`,
          nodeId: cur[i].nodeId,
          deltaMin: -TRIM_STEP_MIN,
        });
        repaired = true;
        break; // 一次只改一处，重新完整评估，避免累积误差
      }
    }
    if (repaired) {
      evaluation = evaluate(cur, ctx);
      continue;
    }

    // ② 缩短已到下限，才删除最后一个非必去节点
    let dropped = false;
    for (let i = cur.length - 1; i >= 0; i--) {
      if (mustVisit.has(cur[i].placeId)) continue;
      const removed = cur.splice(i, 1)[0];
      const place = ctx.placesById[removed.placeId];
      notes.push({
        code: 'NODE_DROPPED',
        message: `原计划保留不住「${place ? place.name : removed.placeId}」，已移出方案`,
        nodeId: removed.nodeId,
        placeId: removed.placeId,
      });
      dropped = true;
      break;
    }
    if (!dropped) break; // 只剩必去节点仍不可行 → 如实报告冲突
    evaluation = evaluate(cur, ctx);
  }

  return { items: cur, evaluation };
}

/**
 * reoptimize：直接删掉靠后的非必去节点直到可行（不先压缩停留，因此质量更好、但改动更大），
 * 然后在时间还有余量时，把被删掉的地点按原顺序尝试重新插入。
 *
 * TODO(10/28)：加入按偏好与步行负担的局部重排；今天是首版，只做"删除 + 回插"。
 */
function repairReoptimize(items, ctx, notes) {
  let cur = items.map((i) => Object.assign({}, i));
  let evaluation = evaluate(cur, ctx);
  const dropped = [];
  const mustVisit = new Set(constraintMod.hardList(ctx.constraints, 'mustVisit'));
  let iter = 0;

  while (!evaluation.feasibility.feasible && iter++ < MAX_REPAIR_ITER) {
    let removedAny = false;
    for (let i = cur.length - 1; i >= 0; i--) {
      if (mustVisit.has(cur[i].placeId)) continue;
      dropped.unshift(cur.splice(i, 1)[0]);
      const place = ctx.placesById[dropped[0].placeId];
      notes.push({
        code: 'NODE_DROPPED',
        message: `按当前需求重新优化后不安排「${place ? place.name : dropped[0].placeId}」`,
        nodeId: dropped[0].nodeId,
        placeId: dropped[0].placeId,
      });
      removedAny = true;
      break;
    }
    if (!removedAny) break;
    evaluation = evaluate(cur, ctx);
  }

  // 回插：还有时间余量就把删掉的地点放回去
  for (const d of dropped) {
    const trial = cur.concat([d]).sort((a, b) => {
      const pa = ctx.orderOf[a.placeId] != null ? ctx.orderOf[a.placeId] : 999;
      const pb = ctx.orderOf[b.placeId] != null ? ctx.orderOf[b.placeId] : 999;
      return pa - pb;
    });
    const trialEval = evaluate(trial, ctx);
    if (trialEval.feasibility.feasible) {
      cur = trial;
      evaluation = trialEval;
      notes.push({
        code: 'NODE_RESTORED',
        message: `时间仍有余量，「${
          (ctx.placesById[d.placeId] || {}).name || d.placeId
        }」已放回方案`,
        nodeId: d.nodeId,
        placeId: d.placeId,
      });
    }
  }

  return { items: cur, evaluation };
}

/** 计算相对原计划的改动幅度（§5.2 展示规则、§6.5 "改了什么"）。 */
function computeImpact(baseItems, candItems, baseEval, candEval) {
  const baseByNode = new Map(baseItems.map((i) => [i.nodeId, i]));
  const candByNode = new Map(candItems.map((i) => [i.nodeId, i]));

  const removedNodeIds = baseItems.filter((i) => !candByNode.has(i.nodeId)).map((i) => i.nodeId);
  const addedNodeIds = candItems.filter((i) => !baseByNode.has(i.nodeId)).map((i) => i.nodeId);
  const shortenedNodeIds = candItems
    .filter((i) => baseByNode.has(i.nodeId) && i.stayMin < baseByNode.get(i.nodeId).stayMin)
    .map((i) => i.nodeId);
  const extendedNodeIds = candItems
    .filter((i) => baseByNode.has(i.nodeId) && i.stayMin > baseByNode.get(i.nodeId).stayMin)
    .map((i) => i.nodeId);

  return {
    removedNodeIds,
    addedNodeIds,
    shortenedNodeIds,
    extendedNodeIds,
    preservedNodeCount: candItems.length - addedNodeIds.length,
    preservedMustVisitCount: candEval.feasibility.quality.preservedMustVisitCount,
    changedEndAt: candEval.timeline.endAt,
    endShiftMin: Math.round(
      ((candEval.timeline.endAt - baseEval.timeline.endAt) / 60000) * 10
    ) / 10,
    addedWalkMin: candEval.timeline.totalWalkMin - baseEval.timeline.totalWalkMin,
    effectivePreservedCount: candEval.feasibility.quality.effectivePreservedCount,
  };
}

/**
 * 生成候选。
 *
 * @param {object} p
 * @param {Array}  p.baseNodes   原行程的节点（trips.nodes）
 * @param {object} p.trigger     {type, payload}
 * @param {Array}  p.constraints 当前生效约束
 * @param {object} p.placesById
 * @param {object} p.params      规划参数（含 algoVersion）
 * @param {Date}   p.startAt     重算起点
 * @returns {{candidates:Array, feasibleCount:number, excludedReasons:Array, algoVersion:string}}
 */
function generateCandidates(p) {
  const baseItems = toItems(p.baseNodes);
  const ctxBase = {
    startAt: p.startAt,
    placesById: p.placesById,
    params: p.params || {},
    constraints: buildConstraints(p.constraints, p.trigger),
    orderOf: baseItems.reduce((acc, i, idx) => {
      acc[i.placeId] = idx;
      return acc;
    }, {}),
  };

  const baseEval = evaluate(baseItems, ctxBase);

  const strategies = [
    { strategy: 'minimal_change', repair: repairMinimalChange, label: '少改原计划' },
    { strategy: 'reoptimize', repair: repairReoptimize, label: '按当前需求重新优化' },
  ];

  const raw = [];
  for (const s of strategies) {
    const applied = applyTrigger(baseItems, p.trigger, p.placesById);
    const notes = applied.notes.slice();
    const { items, evaluation } = s.repair(applied.items, ctxBase, notes);

    // 必去地点被触发器直接跳过时，如实报冲突，不静默忽略（10/22 验收）
    const mustVisit = constraintMod.hardList(ctxBase.constraints, 'mustVisit');
    const present = new Set(items.map((i) => i.placeId));
    const missing = mustVisit.filter((id) => !present.has(id));
    const conflicts = evaluation.feasibility.conflicts.slice();
    if (missing.length && !conflicts.some((c) => c.code === 'MUST_VISIT_MISSING')) {
      conflicts.push({
        code: 'MUST_VISIT_MISSING',
        message: `必去地点被移出方案：${missing
          .map((id) => (p.placesById[id] || {}).name || id)
          .join('、')}`,
        placeIds: missing,
        hardConstraintKey: 'mustVisit',
      });
    }

    const feasible = conflicts.length === 0 && items.length > 0;

    // 空行程不是方案：把所有节点都删光的候选即使满足时间要求也没有意义
    if (items.length === 0 && baseItems.length > 0) {
      conflicts.push({
        code: 'NO_ARRANGEMENT_LEFT',
        message: '在给定时间要求下已经没有可以安排的节点',
        hardConstraintKey: 'endAt',
      });
    }
    raw.push({
      candidateId: `c_${s.strategy}`,
      strategy: s.strategy,
      strategyLabel: s.label,
      feasible,
      conflicts,
      warnings: evaluation.feasibility.warnings,
      notes,
      nodes: timelineMod.toNodes(evaluation.timeline.legs, 'plan'),
      timeline: evaluation.timeline,
      quality: evaluation.feasibility.quality,
      impact: computeImpact(baseItems, items, baseEval, evaluation),
      _items: items,
    });
  }

  // 去重：节点与停留完全一致的候选合并展示（§5.2）
  const seen = new Map();
  const candidates = [];
  const excludedReasons = [];
  raw.sort((a, b) => Number(b.feasible) - Number(a.feasible)); // 可行的排前面
  for (const c of raw) {
    const sig = signature(c._items);
    if (seen.has(sig)) {
      excludedReasons.push({
        candidateId: c.candidateId,
        reason: 'DUPLICATE',
        message: `与「${seen.get(sig)}」方案相同，已合并展示`,
      });
      continue;
    }
    seen.set(sig, c.strategyLabel);
    delete c._items;
    candidates.push(c);
  }

  return {
    candidates,
    feasibleCount: candidates.filter((c) => c.feasible).length,
    excludedReasons,
    algoVersion: (p.params && p.params.algoVersion) || ALGO_VERSION,
  };
}

module.exports = {
  generateCandidates,
  ALGO_VERSION,
  TRIM_STEP_MIN,
  _internal: { toItems, applyTrigger, buildConstraints, evaluate, computeImpact, signature },
};

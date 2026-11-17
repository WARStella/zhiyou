'use strict';

/**
 * 约束规范化与冲突检测 —— 落地 §6.2 约束分类。
 *
 * 三条不可违背的规则：
 *   1. hardness 为 'unknown' 的约束**不得**被当作硬约束使用。
 *      「有点累」不能自动转换成具体步行上限；「尽量少走」不能当作绝对禁止步行。
 *   2. 只有 hardness === 'hard' 且已确认（confirmedAt 非空）的约束参与可行性判定。
 *   3. 多人硬约束互相冲突时，**返回冲突说明，不自行取舍**。
 */

const HARDNESS = { HARD: 'hard', SOFT: 'soft', UNKNOWN: 'unknown' };

const KNOWN_KEYS = [
  'endAt',
  'startAt',
  'mustVisit',
  'avoid',
  'maxWalkMinutes',
  'maxWalkMeters',
  'minStay',
];

/** 规范化单条约束。不认识的 key 一律降到 unknown，不参与判定。 */
function normalizeOne(c) {
  const key = c && c.key;
  const hardness = KNOWN_KEYS.includes(key)
    ? c.hardness || HARDNESS.UNKNOWN
    : HARDNESS.UNKNOWN;
  return {
    key,
    value: c ? c.value : null,
    hardness,
    sourceMemberIds: (c && c.sourceMemberIds) || [],
    confirmedAt: (c && c.confirmedAt) || null,
    confirmedBy: (c && c.confirmedBy) || null,
  };
}

const normalize = (list) => (list || []).map(normalizeOne);

/** 参与可行性判定的硬约束：必须 hardness=hard 且已确认。 */
const activeHard = (list) =>
  normalize(list).filter((c) => c.hardness === HARDNESS.HARD && c.confirmedAt != null);

const soft = (list) => normalize(list).filter((c) => c.hardness === HARDNESS.SOFT);

const unknown = (list) => normalize(list).filter((c) => c.hardness === HARDNESS.UNKNOWN);

/**
 * 检测多人硬约束冲突（§6.2 末句）。
 * 目前覆盖两类可判定的冲突：结束时间互相矛盾、必去与排除指向同一地点。
 * 返回的冲突由调用方原样交给团队，**不做自动取舍**。
 */
function detectConflicts(constraints) {
  const hard = activeHard(constraints);
  const conflicts = [];

  const endAts = hard.filter((c) => c.key === 'endAt');
  if (endAts.length > 1) {
    const values = endAts.map((c) => new Date(c.value).getTime());
    if (Math.max(...values) - Math.min(...values) > 0) {
      conflicts.push({
        code: 'HARD_CONSTRAINT_CONFLICT',
        message: '成员的结束时间要求不一致，需要团队确认',
        key: 'endAt',
        sourceMemberIds: endAts.flatMap((c) => c.sourceMemberIds),
        values: endAts.map((c) => ({ value: c.value, members: c.sourceMemberIds })),
      });
    }
  }

  const must = hard.filter((c) => c.key === 'mustVisit').flatMap((c) => c.value || []);
  const avoid = hard.filter((c) => c.key === 'avoid').flatMap((c) => c.value || []);
  const both = must.filter((id) => avoid.includes(id));
  if (both.length) {
    conflicts.push({
      code: 'HARD_CONSTRAINT_CONFLICT',
      message: '同一地点被同时要求"必去"和"排除"',
      key: 'mustVisit/avoid',
      placeIds: both,
      sourceMemberIds: hard
        .filter((c) => c.key === 'mustVisit' || c.key === 'avoid')
        .flatMap((c) => c.sourceMemberIds),
    });
  }

  return conflicts;
}

/** 取某 key 的硬约束值；多条时取最严格的一条（对时间取最早）。 */
function hardValue(constraints, key, pick) {
  const list = activeHard(constraints).filter((c) => c.key === key);
  if (!list.length) return null;
  const values = list.map((c) => c.value);
  if (pick === 'min') return values.reduce((a, b) => (new Date(a) < new Date(b) ? a : b));
  if (pick === 'max') return values.reduce((a, b) => (new Date(a) > new Date(b) ? a : b));
  return values[0];
}

const hardList = (constraints, key) =>
  activeHard(constraints)
    .filter((c) => c.key === key)
    .flatMap((c) => (Array.isArray(c.value) ? c.value : [c.value]));

module.exports = {
  HARDNESS,
  KNOWN_KEYS,
  normalize,
  normalizeOne,
  activeHard,
  soft,
  unknown,
  detectConflicts,
  hardValue,
  hardList,
};

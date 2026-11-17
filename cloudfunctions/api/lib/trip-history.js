'use strict';

/** 历史事实不可被候选重算覆盖；集合预检的候选可能已经带历史，合并时去重。 */
function preserveHistory(original, proposed) {
  const previous = new Map((original || []).map(n => [n.nodeId, n]));
  const history = (original || []).filter(n => n.status === 'done' || n.status === 'skipped')
    .slice().sort((a, b) => a.seq - b.seq);
  const historyIds = new Set(history.map(n => n.nodeId));
  const remaining = (proposed || []).filter(n => !historyIds.has(n.nodeId)).map(n => {
    const old = previous.get(n.nodeId);
    return old && old.status === 'arrived'
      ? Object.assign({}, n, { status: old.status, actualArriveAt: old.actualArriveAt, actualLeaveAt: old.actualLeaveAt })
      : n;
  });
  return history.concat(remaining).map((n, seq) => Object.assign({}, n, { seq }));
}

module.exports = { preserveHistory };

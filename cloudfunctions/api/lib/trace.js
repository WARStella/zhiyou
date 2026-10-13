'use strict';

/**
 * 事件日志工具：供领域代码记录非 api 级别的事件（状态变更、上游调用）。
 */

const C = require('./repo/collections');

async function logEvent(repo, p) {
  return repo.insert(C.EVENTS, {
    ts: p.ts || new Date(),
    type: p.type || 'state_change',
    action: p.action || null,
    userId: p.userId || null,
    crewId: p.crewId || null,
    tripId: p.tripId || null,
    meetTaskId: p.meetTaskId || null,
    requestId: p.requestId || null,
    result: p.result || 'ok',
    errCode: p.errCode || null,
    durationMs: p.durationMs == null ? 0 : p.durationMs,
    mapApiCalls: p.mapApiCalls || 0,
    algoVersion: p.algoVersion || null,
    detail: p.detail || null,
  });
}

/** 决策记录 —— trace.export 的数据源（§9、11/4 验收）。 */
async function logDecision(repo, p) {
  return repo.insert(C.DECISIONS, {
    ts: p.ts || new Date(),
    kind: p.kind,
    tripId: p.tripId || null,
    meetTaskId: p.meetTaskId || null,
    crewId: p.crewId || null,
    inputDigest: p.inputDigest || {},
    candidates: p.candidates || [],
    selectedCandidateId: p.selectedCandidateId || null,
    excludedReasons: p.excludedReasons || [],
    algoVersion: p.algoVersion,
    params: p.params || {},
    durationMs: p.durationMs == null ? 0 : p.durationMs,
    mapApiCalls: p.mapApiCalls || 0,
    costEstimate: p.costEstimate || null,
    result: p.result || 'ok',
  });
}

module.exports = { logEvent, logDecision };

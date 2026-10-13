'use strict';

/**
 * 时间工具。
 *
 * 铁律（docs/01_数据模型_v1.md §2.9、§2.10）：
 *  - 服务端时间是权威。客户端的 clientAt 只用于诊断时钟偏差。
 *  - 三个集合时间（plannedMeetAt / allArrivedAt / departedAt）绝不互相推断。
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 位置过期阈值（秒）。§8.2 要求界面显示实际时效，此处为服务端权威阈值。 */
const STALE_THRESHOLD_SEC = 120;

/**
 * 取"当前时刻"。
 * 必须同时接受 number 与 Date —— 早期版本只判断 typeof === 'number'，
 * 传入 Date 时会**静默退回真实系统时间**，导致时效计算全部算错却看不出来。
 * 这类"悄悄算错"必须从设计上排除，因此这里统一归一化并显式校验。
 */
const nowMs = (ctx) => {
  if (!ctx || ctx.now == null) return Date.now();
  const ms = ctx.now instanceof Date ? ctx.now.getTime() : Number(ctx.now);
  if (!Number.isFinite(ms)) {
    throw new Error(`ctx.now 不是可用时间：${String(ctx.now)}`);
  }
  return ms;
};

const addMin = (date, minutes) => new Date(new Date(date).getTime() + minutes * MIN);

const diffMin = (later, earlier) =>
  (new Date(later).getTime() - new Date(earlier).getTime()) / MIN;

const diffSec = (later, earlier) =>
  (new Date(later).getTime() - new Date(earlier).getTime()) / 1000;

const toISO = (d) => new Date(d).toISOString();

/** 判断时刻是否已过期（秒）。不落库，读取时计算 —— 见数据模型 §2.9。 */
function freshness(reportedAt, ctx, thresholdSec) {
  const ageSeconds = Math.max(0, Math.round(diffSec(nowMs(ctx), reportedAt)));
  const limit = thresholdSec === undefined ? STALE_THRESHOLD_SEC : thresholdSec;
  return { ageSeconds, stale: ageSeconds > limit, thresholdSec: limit };
}

/** 两个时刻相差的分钟数，向上取整（用于路线时间），最小 1 分钟。 */
const ceilMin = (later, earlier) => Math.max(1, Math.ceil(diffMin(later, earlier)));

module.exports = {
  MIN,
  HOUR,
  DAY,
  STALE_THRESHOLD_SEC,
  nowMs,
  addMin,
  diffMin,
  diffSec,
  toISO,
  freshness,
  ceilMin,
};

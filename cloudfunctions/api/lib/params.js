'use strict';

/**
 * 规划参数默认值与冻结标记。
 *
 * §11.2 / 11/2 验收要求"冻结规划参数"，11/5 要求"固定测试集"。
 * 因此：**任何参数改动都必须同时提升 algoVersion**，并把变化写进 events。
 * 参数一旦用于正式实测，就不得静默修改（见计划书第四周纪律）。
 */

const ALGO_VERSION = 'planner-0.1.0';

const DEFAULT_PARAMS = Object.freeze({
  /** 步行速度（米/分钟）。75 ≈ 4.5 km/h，含游览步速余量。 */
  walkSpeedMPerMin: 75,
  /** 节点默认停留（分钟），地点未定义 visitDurationMin.default 时使用。 */
  stayMinDefault: 30,
  /** 集合与衔接缓冲（分钟），§6.3「必要的集合及衔接时间」。 */
  meetBufferMin: 5,
  /** 位置过期阈值（秒），与 lib/time.js 保持一致。 */
  staleThresholdSec: 120,
  /** 规划算法版本 —— 冻结锚点。 */
  algoVersion: ALGO_VERSION,
});

/** 合并调用方传入的参数，并拒绝未知键（避免拼写错误静默生效）。 */
function resolveParams(input) {
  const out = Object.assign({}, DEFAULT_PARAMS, input || {});
  if (input) {
    const unknown = Object.keys(input).filter((k) => !(k in DEFAULT_PARAMS));
    if (unknown.length) {
      const e = new Error(`未知的规划参数：${unknown.join(', ')}`);
      e.code = 'INVALID_PARAM';
      e.expected = true;
      throw e;
    }
  }
  return out;
}

module.exports = { DEFAULT_PARAMS, ALGO_VERSION, resolveParams };

'use strict';

/**
 * 错误码 —— 唯一事实来源是 docs/01_数据模型_v1.md §3。
 * 新增错误码必须同时改文档，否则 11/12「异常测试记录」会与代码不一致。
 */

const CODES = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  FORBIDDEN_NOT_MEMBER: 'FORBIDDEN_NOT_MEMBER',
  FORBIDDEN_ENV: 'FORBIDDEN_ENV',
  /**
   * 运维/探针类 action 的黑白名单守卫（2026-10-15）。
   *
   * 与 `FORBIDDEN_ENV` 分开，因为**两者的处置完全不同**：
   * 环境不对要去改部署配置；白名单不对要去加 openid。
   * 混成一个码，排查时就得先猜是哪一种。
   */
  FORBIDDEN_NOT_ADMIN: 'FORBIDDEN_NOT_ADMIN',
  LOCATION_SHARING_OFF: 'LOCATION_SHARING_OFF',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  IDEMPOTENT_REPLAY: 'IDEMPOTENT_REPLAY',
  INFEASIBLE_HARD_CONSTRAINT: 'INFEASIBLE_HARD_CONSTRAINT',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
  UPSTREAM_MAP_FAILED: 'UPSTREAM_MAP_FAILED',
  INVALID_PARAM: 'INVALID_PARAM',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INTERNAL: 'INTERNAL',
};

/**
 * 业务异常。message 面向用户可直接展示。
 */
class AppError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.details = details || null;
    this.expected = true; // 预期内错误：不打印完整堆栈
  }
}

const fail = (code, message, details) => new AppError(code, message, details);

const isAppError = (e) => e instanceof AppError || (e && e.name === 'AppError');

/**
 * 断言工具：参数校验失败一律 INVALID_PARAM，不落库。
 */
function assert(cond, code, message, details) {
  if (!cond) throw new AppError(code, message, details);
}

const require_fields = (obj, fields) => {
  const missing = fields.filter((f) => obj == null || obj[f] === undefined || obj[f] === null);
  assert(missing.length === 0, CODES.INVALID_PARAM, `缺少必填参数：${missing.join(', ')}`, {
    missing,
  });
};

module.exports = { CODES, AppError, fail, isAppError, assert, require_fields };

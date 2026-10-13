'use strict';

/**
 * 统一响应封装 —— 见 docs/02_接口清单_v0.md §1。
 *
 * 云函数不抛异常给客户端：所有异常在入口转为本结构。
 * 客户端只判断 ok 字段。
 */

function ok(data, meta) {
  return {
    ok: true,
    data: data === undefined ? null : data,
    meta: Object.assign({ replayed: false }, meta || {}),
  };
}

function err(error, meta) {
  const e = error || {};
  return {
    ok: false,
    error: {
      code: e.code || 'INTERNAL',
      message: e.message || '服务异常',
      details: e.details || null,
    },
    meta: Object.assign({ replayed: false }, meta || {}),
  };
}

module.exports = { ok, err };

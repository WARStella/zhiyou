'use strict';

/**
 * 统一调用入口 —— 云函数 index.js 与本地测试共用同一条路径。
 *
 * 这样做的好处：**本地测试跑的代码与线上完全一致**，不存在"测试通过、线上失败"。
 * 这也是仓储层可替换之外，第二个让"没有 AppID 也能开发"成立的设计。
 *
 * 调用顺序（顺序本身是设计的一部分）：
 *   1. 校验 action 存在
 *   2. 校验身份（openid）
 *   3. 幂等包装
 *   4. 执行业务
 *   5. 记录事件日志（成功与失败都记）
 *   6. 异常一律转为统一响应结构，不抛给客户端
 */

const { CODES, isAppError } = require('./errors');
const resp = require('./resp');
const { withIdempotency } = require('./idem');
const C = require('./repo/collections');
const actions = require('../actions');

/**
 * 把非预期错误整理成可定位的结构。
 *
 * **仅用于开发环境**：包含堆栈与上游 errCode，足以定位到具体一行。
 * 生产环境一律只回"服务异常"，不泄露内部结构。
 *
 * 为什么要有它（2026-10-13 实际需要）：
 *   云开发控制台的日志页当时看不到 console.error 输出，
 *   而线上已经返回 INTERNAL —— 排查陷入僵局。
 *   让**接口自己携带诊断信息**，比依赖另一个可能不可用的界面可靠。
 *   这也正面服务 10/31 验收：失败原因必须可定位，不能只记"接口错误"。
 */
function describeError(e, stage) {
  if (!e) return { stage, raw: String(e) };
  return {
    stage, // 出错阶段：start / idempotency / handler
    name: e.name || null,
    message: e.message || null,
    errCode: e.errCode === undefined ? null : e.errCode, // 云开发 SDK 的错误码
    errMsg: e.errMsg || null,
    stackTop: String(e.stack || '')
      .split('\n')
      .slice(0, 8), // 只取头部，避免响应过大
  };
}

/**
 * @param {object} event {action, requestId, expectedVersion, payload}
 * @param {object} ctx   {repo, openid, now, env}
 */
async function invoke(event, ctx) {
  const started = Date.now();
  const action = event && event.action;
  const requestId = event && event.requestId;
  const serverTime = new Date(ctx.now ? ctx.now : Date.now()).toISOString();
  const baseMeta = { requestId: requestId || null, serverTime };
  const isDev = (ctx.env || 'dev') === 'dev';

  const handler = actions[action];
  if (!handler) {
    return resp.err({ code: CODES.NOT_IMPLEMENTED, message: `未知的接口：${action || '(空)'}` }, baseMeta);
  }

  if (!ctx.openid) {
    return resp.err({ code: CODES.AUTH_REQUIRED, message: '未获取到微信身份，请重新进入小程序' }, baseMeta);
  }

  const callCtx = {
    repo: ctx.repo,
    openid: ctx.openid,
    now: ctx.now,
    env: ctx.env || 'dev',
    requestId: requestId || null,
    expectedVersion: event.expectedVersion,
    payload: event.payload || {},
    action,
    /**
     * 外部服务工厂由调用方注入 —— 云函数入口不传（动作层回落到真实实现），
     * 测试注入替身。
     *
     * ⚠️ **这里是白名单，新增注入点必须同时改这里**。
     * 漏改的后果很隐蔽：动作层拿到 `undefined` 后回落到真实实现，
     * 于是测试发真实 HTTP 或报一个看似无关的错误 —— 而不是"注入没生效"。
     * 所以注入点放在入口这一处，产品代码里不留任何测试钩子。
     */
    createMapProvider: ctx.createMapProvider || null,
  };

  // 记录执行到了哪一步：定位"错误发生在幂等包装里还是业务里"往往是最关键的一步
  let stage = 'start';

  let response;
  try {
    stage = 'idempotency';
    const runHandler = () => {
      stage = 'handler';
      return handler(callCtx);
    };

    const r = await withIdempotency(
      ctx.repo,
      { requestId, userId: ctx.openid, action, now: ctx.now },
      runHandler
    );
    response = r.response;
    if (r.replayed) {
      response = Object.assign({}, response, {
        meta: Object.assign({}, response.meta, { replayed: true, serverTime }),
      });
    }
  } catch (e) {
    const known = isAppError(e);
    const diagnosis = describeError(e, stage);

    if (!known) {
      // 非预期错误必须留证据 —— 日志与响应两条路都写，任何一条可用都够定位
      console.error('[api] 非预期错误', action, stage, JSON.stringify(diagnosis));
    }

    const appErr = known
      ? e
      : {
          code: CODES.INTERNAL,
          message: isDev
            ? `服务异常（${stage}）：${(e && e.message) || String(e)}`
            : '服务异常，请稍后重试',
          details: isDev ? diagnosis : null,
        };

    response = resp.err(appErr, baseMeta);
  }

  const durationMs = Date.now() - started;
  response.meta = Object.assign({}, response.meta, { durationMs });

  // 事件日志：成功与失败都记，且带上耗时与错误码
  try {
    await ctx.repo.insert(C.EVENTS, {
      ts: new Date(ctx.now ? ctx.now : Date.now()),
      type: 'api_call',
      action,
      userId: ctx.openid,
      requestId: requestId || null,
      result: response.ok ? 'ok' : 'error',
      errCode: response.ok ? null : response.error.code,
      durationMs,
      mapApiCalls: (response.meta && response.meta.mapApiCalls) || 0,
      detail: response.ok
        ? null
        : { message: response.error.message, details: response.error.details },
    });
  } catch (logErr) {
    // 日志失败不得影响主流程，但必须可见
    console.error('[api] 事件日志写入失败', logErr && logErr.message);
  }

  return response;
}

module.exports = { invoke };

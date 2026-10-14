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
 * **外部服务的注入点清单 —— 单一事实来源。**
 *
 * 为什么把它提成常量（2026-10-14）：
 * 加照片服务时踩了这条注释自己早就警告过的坑 —— 动作层写了
 * `ctx.createPhotoService ? ... : 真实实现`，而白名单没加这一项，
 * 于是测试注入的替身被静默丢掉，动作层回落到真实高德 provider，
 * 报出来的却是 `AMAP_KEY_NOT_CONFIGURED`。
 *
 * 那个错误信息把人引向"Key 没配"，而真因是"注入没生效" ——
 * 正是这条注释说的"看似无关的错误"。
 *
 * 提成常量之后，`test/injection-points.test.js` 会断言它，
 * 漏改会变成一条明确的失败，而不是一个需要靠猜的诊断。
 */
const SERVICE_INJECTIONS = ['createMapProvider', 'createPhotoService', 'createTransitProvider'];

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
     * 外部服务工厂由调用方注入。**每个注入点都必须显式传值**（用不到就传 `null`），
     * 缺一个就在下面抛错 —— 因为"没传"与"传了 null"在动作层看起来一样，
     * 但前者是配置错误，后者是明确选择。
     *
     * 所以注入点只放在入口这一处，产品代码里不留任何测试钩子。
     */
    createMapProvider: ctx.createMapProvider || null,
    /** 照片服务（lib/photo）—— 同 createMapProvider */
    createPhotoService: ctx.createPhotoService || null,
    /**
     * 公交（含地铁）路线服务（lib/transit）。
     * 与腾讯分开：距离矩阵**明确没有公交**（见 lib/map/matrix-modes.js），
     * 公交走高德的 transit/integrated。
     */
    createTransitProvider: ctx.createTransitProvider || null,
  };

  // 记录执行到了哪一步：定位"错误发生在幂等包装里还是业务里"往往是最关键的一步
  let stage = 'start';

  let response;
  try {
    /**
     * 断言**入口**为每一个注入点提供了值（可以是 `null`，但必须显式给）。
     *
     * ⚠️ 别把这条检查写成"callCtx 里有没有这个键" —— callCtx 是上面那段代码自己写的，
     * 那样断言恒为真，等于没写（2026-10-14 第一版就是这么错的）。
     * 要检查的是 `ctx`（调用方传进来的那个）。
     *
     * 为什么必须显式：一处注入点没提供时，动作层会**静默回落到真实实现**，
     * 表现为一个看似无关的错误（当初是 AMAP_KEY_NOT_CONFIGURED），
     * 或者更糟 —— 测试悄悄去连了真实上游、烧掉月配额。
     *
     * 放在 try 内（而不是函数开头）：`invoke` 的设计是**异常一律转成响应结构**，
     * 不抛给客户端。守卫也不该是例外，否则调用方要处理两种失败形态。
     */
    stage = 'injection';
    const missingInjections = SERVICE_INJECTIONS.filter((key) => !(key in ctx));
    if (missingInjections.length) {
      throw new Error(
        `注入点未提供：${missingInjections.join(', ')}。` +
          `调用方必须为每个注入点显式传值（用不到就传 null）。` +
          `未提供时动作层会静默回落到真实实现，那是必须避免的（见本文件顶部注释）`
      );
    }

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

module.exports = { invoke, SERVICE_INJECTIONS };

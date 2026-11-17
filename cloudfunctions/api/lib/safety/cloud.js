'use strict';

/**
 * 内容安全的**云调用层** —— 微信官方内容安全接口。
 *
 * ── 为什么走云调用，而不是自己拿 access_token 发 HTTP ──────────────
 *
 * 与订阅消息（`lib/subscribe/provider.js`）同一条理由：云调用由云开发代持
 * AppSecret 与 access_token。密钥不进代码、不进环境变量、不经过客户端。
 * 另一条同样重要：权限写在 `api/config.json` 的 `permissions.openapi` 里，
 * **漏配时的失败信息是"没有权限"，而不是"内容有问题"** —— 这两类错误
 * 如果混在一起，会把"部署没配好"误诊成"用户在发违规内容"。
 *
 * ── 这一层只做一件事 ────────────────────────────────────────
 *
 * 把一次接口调用翻译成**可判定**的 `{ok, level, label, errCode, reason}`。
 * 缓存、失败策略、用户提示都在 `index.js`，不在这里 ——
 * 否则"什么算拦截"会被埋进 transport 细节里。
 *
 * ── 一个必须说清的边界 ──────────────────────────────────────
 *
 * `msgSecCheck` 判的是**平台内容合规**（涉政、涉黄、涉暴、辱骂等），
 * 它的词库不由本项目维护。本项目的本地规则（`lexicon.js`）判的是
 * **业务规则**（联系方式、导流、威胁）。两层判断的对象不同，
 * 所以两层都要有，不能互相替代。
 */

const TIMEOUT = Symbol('timeout');

/** 把 `msgSecCheck` 的两种返回形态归一成一档 */
function normalizeText(res) {
  if (!res) return { ok: false, reason: 'empty_response', level: null, label: null, errCode: null, errMsg: null };
  const errCode = res.errCode === undefined ? null : res.errCode;
  /**
   * 旧版（v1）把结果写在 errCode 里：87014 = 内容含有违法违规内容。
   * 新版（v2）把结果写在 `result.suggest` 里，errCode 仍为 0。
   * 两种都要认 —— 不同基础库版本返回的形状确实不一样。
   */
  if (errCode === 87014) return { ok: true, level: 'risky', label: 'wx.risky', errCode, errMsg: res.errMsg || null, source: 'v1' };
  if (errCode !== null && errCode !== 0) {
    return { ok: false, reason: 'err_code', level: null, label: null, errCode, errMsg: res.errMsg || null };
  }
  const suggest = res.result && res.result.suggest;
  if (suggest === 'pass' || suggest === 'review' || suggest === 'risky') {
    return { ok: true, level: suggest, label: res.result.label === undefined ? null : `wx.${res.result.label}`, errCode, errMsg: res.errMsg || null, source: 'v2' };
  }
  /** 只有 errCode 0、没有 result：**不能当作 pass** —— 没见过这种形状，按未知处理 */
  return { ok: false, reason: 'unrecognized_shape', level: null, label: null, errCode, errMsg: res.errMsg || null };
}

function normalizeImage(res) {
  if (!res) return { ok: false, reason: 'empty_response', level: null, errCode: null, errMsg: null };
  const errCode = res.errCode === undefined ? null : res.errCode;
  if (errCode === 0) return { ok: true, level: 'pass', errCode, errMsg: null };
  if (errCode === 87014) return { ok: true, level: 'risky', errCode, errMsg: res.errMsg || null };
  return { ok: false, reason: 'err_code', level: null, errCode, errMsg: res.errMsg || null };
}

/**
 * 给一次云调用加超时。
 *
 * ⚠️ 超时不等于失败：请求可能已经到了微信并**产生了计费**，只是结果没回来。
 * 所以这里返回 `{ok:false, reason:'timeout'}`，由上层按 `SAFETY_FAIL_MODE`
 * 决定放行还是拒绝 —— 不在这里替业务做决定。
 */
async function withTimeout(fn, timeoutMs) {
  let timer = null;
  // 先接住 promise 的失败，避免超时胜出后留下未处理的 rejection（云函数里会打 error 日志）
  const task = Promise.resolve().then(fn).catch((e) => ({ __error: e }));
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @param {object} cloud `wx-server-sdk` 实例（可注入，测试不需要云环境）
 */
function createCloudSafetyProvider(cloud, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || 1500;
  const api = (cloud && cloud.openapi && cloud.openapi.security) || null;
  const msgSecCheck = api && typeof api.msgSecCheck === 'function' ? (args) => api.msgSecCheck(args) : null;
  const imgSecCheck = api && typeof api.imgSecCheck === 'function' ? (args) => api.imgSecCheck(args) : null;

  return {
    name: 'wx-cloud-security',
    /** 文本检测可用（`msgSecCheck` 存在） */
    textAvailable: Boolean(msgSecCheck),
    /** 图片检测可用（`imgSecCheck` 存在） */
    imageAvailable: Boolean(imgSecCheck),
    available: Boolean(msgSecCheck || imgSecCheck),

    /**
     * 文本检测。
     *
     * `version: 2` + `openid` + `scene` 是 v2 的必填组合：
     * v2 会按场景与用户做差异判定，只传 `content` 在新版本上会报参数错误。
     */
    async checkText({ content, openid, scene, title, nickname }) {
      if (!msgSecCheck) return { ok: false, reason: 'provider_unavailable', level: null };
      const result = await withTimeout(() => msgSecCheck({
        content: String(content == null ? '' : content),
        version: 2,
        scene,
        openid,
        title,
        nickname,
        signature: opts.signature,
      }), timeoutMs);
      if (result === TIMEOUT) return { ok: false, reason: 'timeout', level: null };
      if (result && result.__error) {
        return { ok: false, reason: 'threw', level: null, errCode: result.__error.errCode || null };
      }
      return normalizeText(result);
    },

    /**
     * 图片检测（同步版 `imgSecCheck`）。
     *
     * ⚠️ 微信把图片检测的主推方案改成了异步的 `mediaCheckAsync`：
     * 它要求一个公网可达的回调地址来接收结果，本项目没有部署消息推送服务，
     * 所以这里用同步接口做**即时把关**。两者的差别如实记在 README：
     * 同步接口只判涉黄类风险，覆盖面小于异步接口；异步回调是后续项。
     */
    async checkImage({ buffer, contentType }) {
      if (!imgSecCheck) return { ok: false, reason: 'provider_unavailable', level: null };
      if (!buffer || !buffer.length) return { ok: false, reason: 'empty_media', level: null };
      const result = await withTimeout(() => imgSecCheck({
        media: { contentType: contentType || 'image/jpeg', value: buffer },
      }), timeoutMs);
      if (result === TIMEOUT) return { ok: false, reason: 'timeout', level: null };
      if (result && result.__error) {
        return { ok: false, reason: 'threw', level: null, errCode: result.__error.errCode || null };
      }
      return normalizeImage(result);
    },
  };
}

/**
 * 默认 provider：**懒加载** `wx-server-sdk`。
 *
 * 为什么懒加载：本地测试与脚本根本不装这个包。顶层 require 会让
 * `lib/safety` 在测试里直接 import 失败，于是"内容安全"这一整块
 * 只能靠集成测试验证 —— 而它恰恰是最需要单元测试的部分。
 *
 * 失败结果也缓存：进程内只尝试一次，避免每次调用都去踩一遍不存在的模块。
 */
let defaultCache;
function defaultProvider() {
  if (defaultCache !== undefined) return defaultCache.value;
  let value = null;
  try {
    // eslint-disable-next-line global-require
    value = createCloudSafetyProvider(require('wx-server-sdk'));
  } catch (_) {
    value = null; // 没有云环境（本地/CI）：交给上层按 fail mode 处理
  }
  defaultCache = { value };
  return value;
}

/** 测试用：清掉默认 provider 的缓存 */
function resetDefaultProvider() {
  defaultCache = undefined;
}

module.exports = {
  createCloudSafetyProvider,
  defaultProvider,
  resetDefaultProvider,
  normalizeText,
  normalizeImage,
};

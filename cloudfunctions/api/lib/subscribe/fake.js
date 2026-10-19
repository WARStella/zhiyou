'use strict';

/**
 * 订阅发送的**测试替身**。
 *
 * 为什么必须有它（不只是"测试方便"）：
 *
 * 真实发送会**消耗用户的订阅次数**——每个模板的可用次数有限，
 * 用用户自己的授权次数去做自动化回归，等于把用户的额度当测试耗材。
 * 交接文档也写明"不使用用户授权次数做未经需要的探针"。
 *
 * 所以本地所有回归都注入这个 provider，它可以精确复现：
 * 正常送达、用户未订阅/次数用尽、字段非法、系统繁忙、调用抛异常（未知结果）。
 */

function createFakeSubscribeProvider(opts) {
  opts = opts || {};
  /** 'ok' | 'unsubscribed' | 'invalid' | 'busy' | 'throws' */
  const mode = opts.mode || 'ok';
  const sent = [];
  let attempts = 0;

  return {
    name: 'fake',
    configured() { return mode !== 'unconfigured'; },
    sent,
    get attempts() { return attempts; },

    async send(payload) {
      attempts += 1;
      if (mode === 'unconfigured') {
        return { ok: false, delivered: false, reason: 'PROVIDER_NOT_CONFIGURED',
          retryable: false, reachable: null, errCode: null, errMsg: null };
      }
      if (mode === 'throws') {
        // 模拟"请求发出去了但不知道结果"——上层必须把它当未知结果，不得自动重试。
        throw Object.assign(new Error('socket hang up'), { errCode: -1, errMsg: 'socket hang up' });
      }
      if (mode === 'unsubscribed') {
        return { ok: false, delivered: false, reason: 'USER_UNSUBSCRIBED', retryable: false,
          reachable: false, errCode: 43101, errMsg: 'user refuse to accept the msg' };
      }
      if (mode === 'invalid') {
        return { ok: false, delivered: false, reason: 'INVALID_ARGUMENT', retryable: false,
          reachable: null, errCode: 47003, errMsg: 'argument invalid' };
      }
      if (mode === 'busy') {
        return { ok: false, delivered: false, reason: 'SYSTEM_BUSY', retryable: true,
          reachable: null, errCode: -1, errMsg: 'system error' };
      }
      /**
       * 记录**组装成微信请求**之后的样子（`touser` 等），
       * 而不是 service 传进来的中间结构 —— 否则测试断言的是假象。
       */
      sent.push({
        touser: payload.openid,
        templateId: payload.templateId,
        page: payload.page,
        data: payload.data,
        miniprogramState: payload.miniprogramState || null,
      });
      return { ok: true, delivered: true, reason: null, retryable: false, reachable: true,
        errCode: 0, errMsg: null };
    },
  };
}

module.exports = { createFakeSubscribeProvider };

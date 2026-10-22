'use strict';

/**
 * 订阅消息的真实发送实现 —— **云调用（`cloud.openapi`）**。
 *
 * ── 为什么走云调用，而不是自己拿 access_token 发 HTTP ──────
 *
 * 云调用由云开发代持 AppSecret 与 access_token：密钥不进代码、不进环境变量、
 * 也不经过客户端。交接文档第 3 节第 1 条明确要求"不向客户端下发 AppSecret 或访问令牌"。
 * 另一条同样重要：云调用的权限写在 `api/config.json` 的 `permissions.openapi` 里，
 * **漏配时失败信息是"没有权限"而不是"参数错误"**，两类错误不会混在一起。
 *
 * ── 这个 provider 只做一件事 ────────────────────────────
 *
 * 发一条，把微信的结果翻译成**可判定**的 `{ ok, delivered, reason, errCode }`。
 * 重试、去重、额度与收件人筛选都在 `service.js`，不在这里 ——
 * 否则"哪些错误值得重试"会被埋进 transport 细节里。
 */

/**
 * 微信侧常见错误码 → 是否需要重试 / 是否属于"用户不可达"。
 *
 * ⚠️ 这张表按**公开文档的常见口径**整理，没有在本环境逐条实测；
 * 含义不确定的错误码一律按"不重试、记录原文"处理 —— 宁可少发一条、
 * 把 errCode 留给人看，也不要对着未知错误反复重试，把用户额度烧掉。
 */
const ERR = {
  /** 用户从未订阅、或订阅次数已用尽。**不是故障**，不要再试。 */
  43101: { retry: false, reachable: false, label: 'USER_UNSUBSCRIBED' },
  /** 模板参数不合法（字段编号/长度/格式）。这是我们自己的 bug，重试无用。 */
  47003: { retry: false, reachable: null, label: 'INVALID_ARGUMENT' },
  /** 模板不存在或未启用。 */
  40037: { retry: false, reachable: null, label: 'INVALID_TEMPLATE_ID' },
  /** 调用频率超限。 */
  45009: { retry: true, reachable: null, label: 'RATE_LIMITED' },
  /** 系统繁忙。 */
  '-1': { retry: true, reachable: null, label: 'SYSTEM_BUSY' },
};

function translate(errCode, errMsg) {
  const known = ERR[String(errCode)];
  return {
    code: errCode === undefined ? null : errCode,
    label: known ? known.label : 'UNKNOWN',
    retryable: known ? known.retry === true : false,
    /** true = 用户明确不可达（可据此停止后续提醒）；null = 未知 */
    reachable: known ? known.reachable : null,
    message: errMsg || null,
  };
}

/**
 * @param {object} cloud    `wx-server-sdk` 实例（可注入，测试无需云环境）
 * @param {object} [opts]
 * @param {Function} [opts.send] 直接覆盖发送函数 —— 仅用于本地测试
 */
function createCloudSubscribeProvider(cloud, opts) {
  opts = opts || {};
  const sendRaw = opts.send || (cloud && cloud.openapi && cloud.openapi.subscribeMessage
    ? (payload) => cloud.openapi.subscribeMessage.send(payload)
    : null);

  return {
    name: 'cloud-openapi',
    /** 配置是否齐全。**只表示"看起来配好了"，不代表微信真的允许发送。** */
    configured() {
      return Boolean(sendRaw);
    },

    /**
     * 发一条订阅消息。
     *
     * 返回值刻意区分三件事，因为它们后续处置完全不同：
     *   · `ok`        —— 这次调用是否成功送达
     *   · `retryable` —— 稍后重试是否有意义（系统繁忙 vs 字段写错）
     *   · `reachable` —— 用户是否还有订阅次数（决定要不要继续为这个人排队）
     */
    async send({ openid, templateId, page, data, miniprogramState }) {
      if (!sendRaw) {
        return { ok: false, delivered: false, reason: 'PROVIDER_NOT_CONFIGURED',
          retryable: false, reachable: null, errCode: null, errMsg: null };
      }
      if (!openid || !templateId || !data) {
        return { ok: false, delivered: false, reason: 'INVALID_ARGUMENT',
          retryable: false, reachable: null, errCode: null, errMsg: '缺少 openid/templateId/data' };
      }
      try {
        const res = await sendRaw({
          touser: openid,
          templateId,
          page,
          data,
          miniprogramState: miniprogramState || undefined,
          lang: 'zh_CN',
        });
        /**
         * 云调用的返回形态随 SDK 版本不同：成功时是 `{ errCode: 0 }`，
         * 也可能直接是 `{}`（无 errCode 即成功）。两者都当成功处理，
         * 但**只有显式 errCode 非 0 才算失败** —— 不把"字段缺失"当成失败。
         */
        const errCode = res && res.errCode;
        if (errCode === undefined || errCode === 0) {
          return { ok: true, delivered: true, reason: null, retryable: false,
            reachable: true, errCode: errCode === undefined ? null : 0, errMsg: null };
        }
        const info = translate(errCode, res.errMsg);
        return { ok: false, delivered: false, reason: info.label, retryable: info.retryable,
          reachable: info.reachable, errCode: info.code, errMsg: info.message };
      } catch (e) {
        /**
         * 抛异常时（网络、云开发内部错误）**无法确定消息有没有发出去** ——
         * 这正是交接文档第 3 节第 6 条说的"未知结果"。标记 `unknown: true`，
         * 上层据此**不自动重试**（避免同一句话发两条），只记录待人工判断。
         */
        const info = translate(e && (e.errCode || e.code), e && (e.errMsg || e.message));
        return { ok: false, delivered: false, reason: info.label === 'UNKNOWN' ? 'SEND_THREW' : info.label,
          retryable: false, reachable: info.reachable, unknown: true,
          errCode: info.code, errMsg: info.message || String(e && e.message || e) };
      }
    },
  };
}

module.exports = { createCloudSubscribeProvider, ERR, translate };

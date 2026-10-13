'use strict';

/**
 * 零依赖 HTTP 客户端。
 *
 * 为什么不用 axios/node-fetch：
 *   云函数部署走「云端安装依赖」，每多一个依赖就多一处可能装失败的地方。
 *   Node 16 自带 `https`，够用。
 *
 * **可注入**：`opts.transport` 允许测试注入假实现，
 * 否则地图接口的解析逻辑就只能靠"真连一次"来验证 —— 而外部接口不该出现在单元测试里。
 */

const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 8000;

class HttpError extends Error {
  constructor(message, info, code) {
    super(message);
    this.name = 'HttpError';
    // 默认与 docs/01 §3 错误码对齐；调用方可覆盖（如大模型上游用 AI_UPSTREAM_FAILED）
    this.code = code || 'UPSTREAM_MAP_FAILED';
    this.details = info || null;
    this.expected = true;
  }
}

/**
 * 真实传输。支持 GET 与 POST（带请求头与请求体）。
 *
 * 为什么需要 POST：大模型的 chat/completions 是 POST + JSON body。
 * 但地图接口只需要 GET —— 所以这里做成通用的，两边共用一份超时与错误处理。
 */
function defaultTransport(url, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const method = (opts.method || 'GET').toUpperCase();
  const errorCode = opts.errorCode;
  const payload = opts.body != null ? String(opts.body) : null;

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    let target;
    try {
      target = new URL(url);
    } catch (e) {
      return done(reject, new HttpError(`URL 非法：${url}`, { url }, errorCode));
    }

    const headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    if (payload != null) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(
      {
        hostname: target.hostname,
        path: target.pathname + target.search,
        method,
        timeout: timeoutMs,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          /**
           * 非 2xx 一律按传输失败处理 —— **保持地图接口原有的严格语义**。
           * 上游把业务错误放在 HTTP 200 的 body 里（地图接口就是 status: 104）
           * 是另一回事，那种情况这里不会拦，交给调用方判断。
           */
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return done(
              reject,
              new HttpError(
                `上游返回 HTTP ${res.statusCode}`,
                { httpStatus: res.statusCode, bodyHead: body.slice(0, 300) },
                errorCode
              )
            );
          }
          try {
            done(resolve, { json: JSON.parse(body), httpStatus: res.statusCode, rawBody: body });
          } catch (e) {
            done(
              reject,
              new HttpError(
                '上游返回的不是合法 JSON',
                { httpStatus: res.statusCode, bodyHead: body.slice(0, 300) },
                errorCode
              )
            );
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      done(
        reject,
        new HttpError(`上游请求超时（${timeoutMs}ms）`, { url: redact(url), timeoutMs }, errorCode)
      );
    });
    req.on('error', (e) => {
      done(reject, new HttpError(`上游请求失败：${e.message}`, { url: redact(url) }, errorCode));
    });

    if (payload != null) req.write(payload);
    req.end();
  });
}

/**
 * 脱敏：把 `key=` 参数替换成掩码。
 * **密钥绝不能出现在响应、日志、截图里** —— 这是计划书 11/12 的验收项。
 */
function redact(url) {
  return String(url).replace(/([?&](?:key|secret|token)=)[^&]*/gi, '$1***REDACTED***');
}

/** 生成掩码形式的 key，用于确认"配没配"而不泄露值。 */
function maskSecret(secret) {
  if (!secret) return null;
  const s = String(secret);
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}${'*'.repeat(Math.max(4, s.length - 8))}${s.slice(-4)}`;
}

module.exports = { getJson: defaultTransport, defaultTransport, HttpError, redact, maskSecret };

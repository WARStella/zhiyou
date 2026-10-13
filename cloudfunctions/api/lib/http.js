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
  constructor(message, info) {
    super(message);
    this.name = 'HttpError';
    this.code = 'UPSTREAM_MAP_FAILED'; // 与 docs/01 §3 错误码对齐
    this.details = info || null;
    this.expected = true;
  }
}

/** 真实传输：GET 一个 JSON 接口。 */
function defaultTransport(url, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

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
      return done(reject, new HttpError(`URL 非法：${url}`, { url }));
    }

    const req = https.request(
      {
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: 'GET',
        timeout: timeoutMs,
        headers: { Accept: 'application/json' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return done(
              reject,
              new HttpError(`上游返回 HTTP ${res.statusCode}`, {
                httpStatus: res.statusCode,
                bodyHead: body.slice(0, 300),
              })
            );
          }
          try {
            done(resolve, { json: JSON.parse(body), httpStatus: res.statusCode, rawBody: body });
          } catch (e) {
            done(
              reject,
              new HttpError('上游返回的不是合法 JSON', {
                httpStatus: res.statusCode,
                bodyHead: body.slice(0, 300),
              })
            );
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      done(reject, new HttpError(`上游请求超时（${timeoutMs}ms）`, { url: redact(url), timeoutMs }));
    });
    req.on('error', (e) => {
      done(reject, new HttpError(`上游请求失败：${e.message}`, { url: redact(url) }));
    });

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

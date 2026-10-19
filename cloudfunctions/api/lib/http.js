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
/** 二进制响应的默认体积上限（4MB）。照片走这条路径，需要一个明确的刹车。 */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

class HttpError extends Error {
  constructor(message, info, code) {
    super(message);
    this.name = 'HttpError';
    // 默认与 docs/项目计划书.md#data-model §3 错误码对齐；调用方可覆盖（如大模型上游用 AI_UPSTREAM_FAILED）
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
 *
 * 为什么需要 `opts.binary`（2026-10-14 新增）：**照片不是 JSON**。
 * 没有这个开关时，图片响应会在 JSON.parse 处失败并抛"上游返回的不是合法 JSON" ——
 * 那是一条会把人引向"接口挂了"的错误诊断，而实际只是我们把二进制当文本读了。
 */
function defaultTransport(url, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const method = (opts.method || 'GET').toUpperCase();
  const errorCode = opts.errorCode;
  const payload = opts.body != null ? String(opts.body) : null;
  const binary = opts.binary === true;
  /** 照片体积上限 —— 一张 4MB 的图不该把云函数的内存和时间预算吃掉 */
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;

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

    const headers = Object.assign(
      binary ? { Accept: 'image/*' } : { Accept: 'application/json' },
      opts.headers || {}
    );
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
        let size = 0;
        let aborted = false;

        res.on('data', (c) => {
          if (aborted) return;
          size += c.length;
          if (size > maxBytes) {
            // 超限立刻断开：继续收下去只是把内存和时间烧掉
            aborted = true;
            req.destroy();
            return done(
              reject,
              new HttpError(`上游响应超过体积上限（${maxBytes} 字节）`, { url: redact(url), maxBytes }, errorCode)
            );
          }
          chunks.push(c);
        });

        res.on('end', () => {
          if (aborted) return;
          const buf = Buffer.concat(chunks);

          if (res.statusCode < 200 || res.statusCode >= 300) {
            return done(
              reject,
              new HttpError(
                `上游返回 HTTP ${res.statusCode}`,
                { httpStatus: res.statusCode, bodyHead: buf.toString('utf8').slice(0, 300) },
                errorCode
              )
            );
          }

          if (binary) {
            /**
             * 二进制分支**不做 JSON 解析**，但把 content-type 带出来 ——
             * 调用方据此判断"这真的是图片吗"，而不是相信 URL 的后缀。
             */
            return done(resolve, {
              buffer: buf,
              byteLength: buf.length,
              contentType: res.headers['content-type'] || null,
              httpStatus: res.statusCode,
            });
          }

          const body = buf.toString('utf8');
          /**
           * 非 2xx 一律按传输失败处理 —— **保持地图接口原有的严格语义**。
           * 上游把业务错误放在 HTTP 200 的 body 里（地图接口就是 status: 104）
           * 是另一回事，那种情况这里不会拦，交给调用方判断。
           */
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

module.exports = {
  getJson: defaultTransport,
  defaultTransport,
  HttpError,
  redact,
  maskSecret,
  DEFAULT_MAX_BYTES,
};

'use strict';

/**
 * 回放传输层 —— 用**真实上游返回的录音**驱动**真实的解析代码**。
 *
 * ── 为什么需要它（2026-10-13）────────────────────────────
 *
 * `fake.js` 的数据是我自己写的。它能测"排序函数对不对"，
 * 但**测不了"我把真实返回解析对了吗"** —— 而后者才是最容易错的地方：
 * `duration` 单位就错过一次（815 米返回 12，我按秒解析，
 * 把每段步行时间算成了实际的 1/60，而且**不报错**）。
 *
 * 录音不一样：它是上游**真的说过的话**。用它跑测试，等于把当时的真实情况
 * 固化下来，任何时候都能重放 —— 而且重放的是**真实解析代码**，
 * 不是另一个我写的模拟器。
 *
 * ── 设计：替换传输层，而不是再写一个 provider ──────────────
 *
 *   真 实：tencent.js ──▶ https ──▶ 腾讯
 *   回放：  tencent.js ──▶ 本文件 ──▶ 录音文件
 *
 * 这样 `tencent.js` 一行业都不用改就被测到了。
 * 如果写成"另一个 provider"，测的就是那个 provider，没有意义。
 *
 * 录音由调用方注入（测试从 `test/fixtures/upstream/` 读），
 * 所以本文件不依赖任何测试目录。
 */

/** 按 URL 判断这次调用是哪一类接口 */
function kindOfUrl(url) {
  const u = String(url || '');
  if (u.indexOf('/ws/direction/v1/walking') >= 0) return 'direction-walking';
  if (u.indexOf('/ws/place/v1/search') >= 0) return 'place-search';
  if (u.indexOf('/ws/geocoder/v1') >= 0) return 'geocoder';
  return 'unknown';
}

/** 从 URL 里取查询参数（回放要按参数挑对应的录音） */
function queryOf(url) {
  const out = {};
  const q = String(url || '').split('?')[1];
  if (!q) return out;
  for (const pair of q.split('&')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    out[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
  }
  return out;
}

/**
 * @param {object} opts
 *   · `recordings` 录音数组，每条形如
 *     `{ name, kind, request?: {keyword?}, httpStatus?, body }`
 *   · `strict` 找不到对应录音时是否抛错（默认 true —— 静默返回空会让测试假绿）
 */
function createReplayTransport(opts) {
  opts = opts || {};
  const recordings = opts.recordings || [];
  const strict = opts.strict !== false;
  /** 记下每次回放用了哪条录音，便于断言"确实走到了回放" */
  const played = [];

  const transport = async function replayTransport(url) {
    const kind = kindOfUrl(url);
    const q = queryOf(url);

    const hit = recordings.find((r) => {
      if (r.kind !== kind) return false;
      if (r.request && r.request.keyword != null && q.keyword !== r.request.keyword) return false;
      if (r.request && r.request.from != null && q.from !== r.request.from) return false;
      if (r.request && r.request.to != null && q.to !== r.request.to) return false;
      return true;
    });

    if (!hit) {
      if (strict) {
        throw new Error(
          `没有对应的录音：kind=${kind} keyword=${q.keyword || '(无)'} ` +
            `from=${q.from || '(无)'} to=${q.to || '(无)'}`
        );
      }
      return { json: {}, httpStatus: 200, rawBody: '{}' };
    }

    played.push(hit.name || kind);
    const body = hit.body;
    return {
      json: body,
      httpStatus: hit.httpStatus || 200,
      rawBody: typeof body === 'string' ? body : JSON.stringify(body),
    };
  };

  transport.played = played;
  transport.recordings = recordings;
  return transport;
}

module.exports = { createReplayTransport, kindOfUrl, queryOf };

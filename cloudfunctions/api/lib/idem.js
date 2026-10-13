'use strict';

/**
 * 幂等 —— 对应 11/11「重复请求」与「超时」异常用例。
 *
 * 行为（docs/01 §2.11）：
 *   同一 requestId 二次到达 → 直接返回首次结果，附 replayed: true，**不重复执行**。
 *   首次执行失败 → 不缓存失败响应，允许重试（否则一次网络抖动就永久锁死该操作）。
 *   首次执行"卡死"（is_in_progress 超时未收敛）→ 允许重试，不永久阻塞（11/11 超时用例）。
 *
 * 并发下的正确性依赖 operations.requestId 的**唯一索引**：两个请求同时插入时，
 * 后到的会失败，随后读到 done 记录并返回首次结果。
 * ⚠️ 因此 10/15 必须在云开发控制台为 operations.requestId 建唯一索引，否则本模块失效。
 *
 * ── 2026-10-13 踩坑记录（重要）──────────────────────────────
 * 首版把响应快照存成**嵌套对象**，并在插入时初始化为 `null`：
 *
 *   responseDigest: null                       // insert
 *   repo.update(..., { responseDigest: resp }) // update
 *
 * 云数据库因此报：
 *   -502001 Cannot create field 'data' in element {responseDigest: null}
 *
 * 原因是云数据库对对象字段采用**合并语义**，向 null 合并会去创建子路径。
 * 内存仓储没有这个概念，所以本地测试全绿、线上必挂。
 *
 * 修法：**快照一律存 JSON 字符串**。字符串没有嵌套路径，从根上避开该语义。
 * 详见 docs/01_数据模型_v1.md §2.11。
 */

const { CODES, fail } = require('./errors');
const C = require('./repo/collections');

const TTL_MS = 24 * 60 * 60 * 1000; // 幂等记录保留 24 小时，足够覆盖任何重试窗口
const STALE_IN_PROGRESS_MS = 5 * 60 * 1000; // 超过 5 分钟仍未收敛，视为卡死

function safeParse(json, requestId) {
  try {
    return JSON.parse(json);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: CODES.INTERNAL,
        message: '幂等记录解析失败，请以最新状态为准',
        details: null,
      },
      meta: { requestId: requestId || null, replayed: true, parseFailed: true },
    };
  }
}

/**
 * @param {object} repo
 * @param {object} meta {requestId, userId, action, now}
 * @param {Function} fn 真正执行的函数，返回响应对象
 * @returns {{replayed:boolean, response:object}}
 */
async function withIdempotency(repo, meta, fn) {
  const { requestId, userId, action, now } = meta;
  const nowMs = now ? new Date(now).getTime() : Date.now();

  // 未提供 requestId 时不启用幂等（保留给初始化等运维接口）
  if (!requestId) return { replayed: false, response: await fn() };

  const existing = await repo.findOne(C.OPERATIONS, { requestId });

  if (existing) {
    // requestId is client supplied: never replay another identity or action's result.
    if (existing.userId !== userId || existing.action !== action) {
      throw fail(CODES.INVALID_PARAM, '请求编号已被使用，请生成新的 requestId');
    }
    if (existing.status === 'done') {
      // 兼容早期把快照存成对象的记录（那些记录因写入失败，实际不存在，仅作防御）
      const stored = existing.responseJson;
      if (typeof stored === 'string' && stored) {
        return { replayed: true, response: safeParse(stored, requestId) };
      }
      if (existing.responseDigest && typeof existing.responseDigest === 'object') {
        return { replayed: true, response: existing.responseDigest };
      }
    }

    if (existing.status === 'in_progress') {
      const startedAt = existing.createdAt ? new Date(existing.createdAt).getTime() : 0;
      const ageMs = nowMs - startedAt;
      if (ageMs < STALE_IN_PROGRESS_MS) {
        throw fail(CODES.RATE_LIMITED, '相同请求正在处理中，请稍后重试', { requestId, ageMs });
      }
      // 已卡死 → 放行重试，不永久阻塞（对应 11/11「超时」用例）
    }

    // status === 'failed' 或已卡死：删除旧记录后重试
    await repo.remove(C.OPERATIONS, existing._id);
  }

  const op = await repo.insert(C.OPERATIONS, {
    requestId,
    userId: userId || null,
    action,
    status: 'in_progress',
    // 空字符串而不是 null：避免任何"向 null 合并对象"的可能
    responseJson: '',
    createdAt: now || new Date(),
    finishedAt: null,
    expiresAt: new Date(nowMs + TTL_MS),
  });

  try {
    const response = await fn();

    // ⚠️ 存字符串，不存对象。云函数返回值本身也会经 JSON 序列化跨网络，
    // 因此重放返回与首次返回在客户端看来完全一致（Date 都会变成 ISO 字符串）。
    await repo.update(C.OPERATIONS, op._id, {
      status: 'done',
      responseJson: JSON.stringify(response),
      finishedAt: now || new Date(),
    });

    return { replayed: false, response };
  } catch (e) {
    // 失败不缓存响应 —— 允许客户端修正后重试
    await repo.update(C.OPERATIONS, op._id, {
      status: 'failed',
      finishedAt: now || new Date(),
      errorCode: (e && e.code) || 'INTERNAL',
    });
    throw e;
  }
}

module.exports = { withIdempotency, TTL_MS, STALE_IN_PROGRESS_MS };

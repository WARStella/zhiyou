'use strict';

/**
 * 云数据库仓储实现。
 *
 * 注意：云函数内 wx-server-sdk 使用的是 admin 身份，**会绕过数据库安全规则**。
 * 因此 docs/项目计划书.md#data-model §0 决定 1 的"非成员不得读取队伍位置"必须由 lib/authz.js 显式实现，
 * 绝不能寄希望于安全规则。
 *
 * 生产环境**不应**被 require（本地测试用 memory 实现）。这里对 wx-server-sdk 做懒加载。
 *
 * ── 一条重要纪律 ──────────────────────────────────────────────
 * **集合不存在 = 空结果，不是错误。**
 * 云数据库对不存在的集合执行 count()/get() 会抛 -502005。
 * 但"数据库还是空的"是首次部署的正常初始状态，业务层不该关心。
 * 归一化在这里完成；memory 实现天然满足该语义，因此两边行为一致。
 */

const { assertStructuredQuery } = require('./query');
const { cloudTransactionRepo } = require('./transaction');
const { fail, CODES } = require('../errors');

/**
 * 集合不存在的错误码与文案（不同版本措辞不一，用正则匹配而非精确匹配）。
 *
 * ⚠️ 匹配第三方错误文案是**脆弱**的：必须同时看错误码与多种措辞，
 * 并且每次遇到新措辞就补进来。教训来自 2026-10-13：
 * 「已存在」的判定只写了 `already exist`，而云开发实际返回的是
 * `[ResourceUnavailable.ResourceExist] Table exist.` —— 于是 14 个集合里
 * 有 2 个被误报为"创建失败"。
 */
const COLLECTION_MISSING_CODES = [-502005];
const COLLECTION_MISSING_RE =
  /collection not exists|collection does not exist|database collection not exists|db or table not exist|集合不存在|集合未创建/i;

/** 集合已存在：看 ResourceExist 标记 + 多种措辞，不一味依赖某一句话。 */
const COLLECTION_EXISTS_RE =
  /resourceexist|table exist|table already exist|collection already exist|already exist|已存在/i;

function isCollectionMissing(e) {
  if (!e) return false;
  if (COLLECTION_MISSING_CODES.includes(e.errCode)) return true;
  return COLLECTION_MISSING_RE.test(String(e.errMsg || e.message || ''));
}

function isCollectionExists(e) {
  if (!e) return false;
  const text = String(e.errMsg || e.message || '');
  if (/ResourceNotFound/i.test(text)) return false; // 明确不存在时不得误判为已存在
  return COLLECTION_EXISTS_RE.test(text);
}

function createCloudRepo(opts) {
  opts = opts || {};
  const cloud = require('wx-server-sdk');
  if (!cloud.__zy_inited) {
    cloud.init({ env: opts.env || cloud.DYNAMIC_CURRENT_ENV });
    cloud.__zy_inited = true;
  }
  const db = cloud.database();
  const _ = db.command;

  const col = (c) => db.collection(c);
  /**
   * 把 memory 风格的 query 转成云数据库 where 条件。
   *
   * ⚠️ 只支持**结构化查询对象**。传函数谓词会**直接抛错**而不是静默匹配全部 ——
   * 「本地能跑、线上算错且不报错」是最难查的一类缺陷，宁可早失败。
   */
  function toWhere(query) {
    assertStructuredQuery(query);
    if (!query) return {};

    const out = {};
    for (const [k, v] of Object.entries(query)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && v.__op) {
        const map = {
          gte: _.gte,
          gt: _.gt,
          lte: _.lte,
          lt: _.lt,
          neq: _.neq,
          in: _.in,
          exists: _.exists,
        };
        out[k] = map[v.__op](v.value);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  return {
    __kind: 'cloud',

    async runTransaction(fn, collections) {
      const run = async () => {
        let result;
        await db.runTransaction(async native => {
          result = await fn(cloudTransactionRepo(native, _));
          return result;
        });
        return result; // 不依赖 SDK 是直接返回值还是包装在 result 中。
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return await run(); }
        catch (e) {
          if (e.code === 'DATABASE_TRANSACTION_CONFLICT') throw fail(CODES.VERSION_CONFLICT, '数据正在更新，请重试');
          if (!isCollectionMissing(e) || attempt > 0) throw e;
          for (const collection of collections || []) {
            const result = await this.ensureCollection(collection);
            if (result.error) throw new Error(result.error);
          }
        }
      }
    },

    /**
     * 显式创建集合。
     *
     * ⚠️ **不能假设 `add()` 会自动建集合。** 2026-10-13 实测证实：
     * 向不存在的集合 `add()` 会抛 `-502005 database collection not exists`。
     * 因此集合必须先被创建（本方法，或在控制台手工新建）。
     *
     * @returns {{created:boolean, existed:boolean, error:string|null}}
     *   `error` 非空表示建集合失败 —— **必须上报，不得吞掉**。
     *   早期版本把失败静默成 false，导致"集合为什么没建成"无从查起。
     */
    async ensureCollection(coll) {
      try {
        await db.createCollection(coll);
        return { created: true, existed: false, error: null };
      } catch (e) {
        if (isCollectionExists(e)) {
          return { created: false, existed: true, error: null };
        }
        const msg = String(e.errMsg || e.message || e);
        console.warn('[repo] createCollection 失败', coll, msg);
        return { created: false, existed: false, error: msg };
      }
    },

    async insert(coll, doc) {
      const now = new Date();
      const row = Object.assign({ createdAt: now, updatedAt: now }, doc);
      try {
        const res = await col(coll).add({ data: row });
        return Object.assign({ _id: res._id }, row);
      } catch (e) {
        if (!isCollectionMissing(e)) throw e;

        // 集合不存在 → 建一次再重试；建不了就**如实报出建集合失败的原因**
        const ens = await this.ensureCollection(coll);
        if (ens.error) {
          const err = new Error(
            `集合 ${coll} 不存在，且自动创建失败：${ens.error}。` +
              `请在云开发控制台「数据库」中手工新建该集合，或先调用 ops.initDb。`
          );
          err.errCode = e.errCode;
          err.cause = ens.error;
          throw err;
        }
        const res = await col(coll).add({ data: row });
        return Object.assign({ _id: res._id }, row);
      }
    },

    async get(coll, id) {
      try {
        const res = await col(coll).doc(id).get();
        return res.data || null;
      } catch (e) {
        if (isCollectionMissing(e)) return null;
        if (e && (e.errCode === -1 || /not exist/i.test(e.errMsg || ''))) return null;
        throw e;
      }
    },

    async find(coll, query, o) {
      o = o || {};
      try {
        let q = col(coll).where(toWhere(query));
        if (o.sort) {
          for (const [k, dir] of Object.entries(o.sort)) {
            q = q.orderBy(k, dir === 1 ? 'asc' : 'desc');
          }
        }
        if (o.skip) q = q.skip(o.skip);
        q = q.limit(Math.min(o.limit || 100, 100));
        const res = await q.get();
        return res.data || [];
      } catch (e) {
        if (isCollectionMissing(e)) return [];
        throw e;
      }
    },

    async findOne(coll, query, o) {
      const rows = await this.find(coll, query, Object.assign({ limit: 1 }, o || {}));
      return rows[0] || null;
    },

    async count(coll, query) {
      try {
        const res = await col(coll).where(toWhere(query)).count();
        return res.total || 0;
      } catch (e) {
        if (isCollectionMissing(e)) return 0;
        throw e;
      }
    },

    async update(coll, id, patch) {
      try {
        const res = await col(coll)
          .doc(id)
          .update({ data: Object.assign({}, patch, { updatedAt: new Date() }) });
        const updated = (res.stats && res.stats.updated) || 0;
        const doc = updated ? await this.get(coll, id) : null;
        return { updated, doc };
      } catch (e) {
        if (isCollectionMissing(e)) return { updated: 0, doc: null };
        throw e;
      }
    },

    /**
     * 乐观锁：只有版本号还对得上才写入。
     * updated === 0 表示已被他人推进 —— 调用方必须转成 VERSION_CONFLICT，不得重试覆盖。
     */
    async updateIf(coll, id, conditions, patch) {
      const res = await col(coll).where(toWhere(Object.assign({}, conditions, { _id: id })))
        .update({ data: Object.assign({}, patch, { updatedAt: new Date() }) });
      return { updated: (res.stats && res.stats.updated) || 0 };
    },

    async updateCas(coll, id, expectedVersion, patch) {
      try {
        const res = await col(coll)
          .where({ _id: id, version: expectedVersion })
          .update({
            data: Object.assign({}, patch, { version: _.inc(1), updatedAt: new Date() }),
          });
        const updated = (res.stats && res.stats.updated) || 0;
        return { updated, doc: updated ? await this.get(coll, id) : null };
      } catch (e) {
        if (isCollectionMissing(e)) return { updated: 0, doc: null };
        throw e;
      }
    },

    async remove(coll, id) {
      try {
        const res = await col(coll).doc(id).remove();
        return { removed: (res.stats && res.stats.removed) || 0 };
      } catch (e) {
        if (isCollectionMissing(e)) return { removed: 0 };
        throw e;
      }
    },
  };
}

module.exports = { createCloudRepo, isCollectionMissing, isCollectionExists };

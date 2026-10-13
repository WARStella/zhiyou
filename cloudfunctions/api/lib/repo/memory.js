'use strict';

/**
 * 内存仓储实现 —— 仅用于本地测试与算法调试，绝不在云函数生产环境使用。
 *
 * 它刻意精确模拟云数据库的两个行为，否则本地测试通过、线上失败：
 *   1. updateCas 版本不匹配时 updated === 0 且不写入
 *   2. update 只做浅合并，不做深合并（与云数据库 update 语义一致）
 */

let idSeq = 0;
const nextId = (prefix) => `${prefix}_${Date.now().toString(36)}_${(++idSeq).toString(36)}`;

const {
  UNIQUE_INDEXES,
  uniqueKeyComplete,
  uniqueKeyOf,
} = require('./indexes');

/**
 * 模拟云端的唯一索引约束。
 *
 * 为什么内存实现也要做这件事：
 *   如果内存不拦重复，本地测试就验证不了"幂等""防重复入队"这些依赖唯一索引的设计，
 *   线上靠索引兜底、本地靠运气通过 —— 又是"本地对、线上错"。
 *
 * 抛出的错误形状对齐云数据库：errCode -502001，消息含 `duplicate key`。
 */
function assertUnique(store, coll, doc, excludeId) {
  const groups = UNIQUE_INDEXES[coll];
  if (!groups) return;
  // 注意：store 是**该集合的文档 Map**（键为 _id），不是按集合名索引的外层 Map。
  // 早期版本写了 `store.has(coll)` 作为守卫，永远为 false，
  // 导致整个唯一校验静默不执行 —— 恰好是本功能要检测的那种"静默失效"。
  // 调用方用 bag(coll) 传入，集合 Map 必然已存在，无需再判断。

  for (const fields of groups) {
    if (!uniqueKeyComplete(doc, fields)) continue; // 组合键不完整 → 不校验（稀疏语义）
    const dup = [...store.values()].find(
      (d) => d._id !== excludeId && fields.every((f) => d[f] === doc[f])
    );
    if (dup) {
      const e = new Error(
        `duplicate key error: ${coll} 的唯一索引 (${fields.join(', ')}) 已存在 ${uniqueKeyOf(
          doc,
          fields
        )}`
      );
      e.errCode = -502001;
      e.isDuplicateKey = true;
      throw e;
    }
  }
}

/** 匹配：支持等值对象与谓词函数。数组字段用引用相等判断（与云数据库一致）。 */
function matches(doc, query) {
  if (!query) return true;
  if (typeof query === 'function') return query(doc);
  return Object.keys(query).every((k) => {
    const q = query[k];
    if (q && typeof q === 'object' && !Array.isArray(q) && q.__op) {
      const v = doc[k];
      switch (q.__op) {
        case 'gte':
          return v >= q.value;
        case 'gt':
          return v > q.value;
        case 'lte':
          return v <= q.value;
        case 'lt':
          return v < q.value;
        case 'neq':
          // 与 null 比较时对齐 MongoDB 的 $ne:null 语义：
          // 同时排除「字段缺失」与「值为 null」两种情况。
          // 云数据库与该语义必须一致，否则又会出现"本地对、线上错"。
          if (q.value === null) return v !== null && v !== undefined;
          return v !== q.value;
        case 'in':
          return q.value.includes(v);
        case 'exists':
          // 对齐 MongoDB 的 $exists：只看**字段是否存在**，不看值是否为 null。
          // （早期版本写成 `v !== undefined && v !== null`，把 null 当成"不存在"，
          //   与云实现的 _.exists() 不一致 —— 又是"本地对、线上错"。测试抓到了它。）
          return q.value
            ? Object.prototype.hasOwnProperty.call(doc, k)
            : !Object.prototype.hasOwnProperty.call(doc, k);
        default:
          return false;
      }
    }
    return doc[k] === q;
  });
}

function sortDocs(docs, sort) {
  if (!sort) return docs;
  const keys = Object.keys(sort);
  return docs.slice().sort((a, b) => {
    for (const k of keys) {
      const dir = sort[k];
      const av = a[k];
      const bv = b[k];
      if (av === bv) continue;
      if (av === undefined || av === null) return 1;
      if (bv === undefined || bv === null) return -1;
      return av > bv ? dir : -dir;
    }
    return 0;
  });
}

function createMemoryRepo(opts) {
  opts = opts || {};
  const clock = typeof opts.now === 'number' ? () => opts.now : () => Date.now();
  const store = new Map();

  const bag = (coll) => {
    if (!store.has(coll)) store.set(coll, new Map());
    return store.get(coll);
  };

  const clone = (d) => (d == null ? d : JSON.parse(JSON.stringify(d)));

  const repo = {
    __kind: 'memory',

    /**
     * 内存实现没有"集合"这一层概念，集合按需出现。
     * 保留此方法与云实现对齐接口 —— memory 天然满足"集合不存在 = 空结果"的语义，
     * 因此它**不能**作为"云侧也不需要建集合"的依据（2026-10-13 实测：云侧会报 -502005）。
     */
    async ensureCollection(coll) {
      bag(coll);
      return { created: true, existed: false, error: null };
    },

    async insert(coll, doc) {
      const now = new Date(clock());
      const row = Object.assign(
        { createdAt: now, updatedAt: now },
        clone(doc)
      );
      if (!row._id) row._id = nextId(coll);
      assertUnique(bag(coll), coll, row, null); // 与云端唯一索引同语义
      bag(coll).set(row._id, row);
      return clone(row);
    },

    async get(coll, id) {
      return clone(bag(coll).get(id) || null);
    },

    async find(coll, query, o) {
      o = o || {};
      let rows = [...bag(coll).values()].filter((d) => matches(d, query));
      rows = sortDocs(rows, o.sort);
      if (o.skip) rows = rows.slice(o.skip);
      if (o.limit) rows = rows.slice(0, o.limit);
      return rows.map(clone);
    },

    async findOne(coll, query, o) {
      const rows = await repo.find(coll, query, Object.assign({ limit: 1 }, o || {}));
      return rows[0] || null;
    },

    async count(coll, query) {
      return [...bag(coll).values()].filter((d) => matches(d, query)).length;
    },

    async update(coll, id, patch) {
      const cur = bag(coll).get(id);
      if (!cur) return { updated: 0, doc: null };
      const nextDoc = Object.assign({}, cur, clone(patch), { updatedAt: new Date(clock()) });
      assertUnique(bag(coll), coll, nextDoc, id); // 更新同样受唯一约束限制（云上亦然）
      bag(coll).set(id, nextDoc);
      return { updated: 1, doc: clone(nextDoc) };
    },

    /**
     * 乐观锁更新 —— 与云数据库 where({_id, version}).update() 等价。
     * 版本不匹配返回 updated: 0，且绝不写入。
     */
    async updateCas(coll, id, expectedVersion, patch) {
      const cur = bag(coll).get(id);
      if (!cur || cur.version !== expectedVersion) return { updated: 0, doc: clone(cur || null) };
      const nextDoc = Object.assign({}, cur, clone(patch), {
        version: expectedVersion + 1,
        updatedAt: new Date(clock()),
      });
      assertUnique(bag(coll), coll, nextDoc, id);
      bag(coll).set(id, nextDoc);
      return { updated: 1, doc: clone(nextDoc) };
    },

    async remove(coll, id) {
      const removed = bag(coll).delete(id);
      return { removed: removed ? 1 : 0 };
    },

    /** 测试辅助：直接灌入文档，跳过版本与时间戳逻辑。 */
    async __seed(coll, docs) {
      for (const d of docs) bag(coll).set(d._id, clone(d));
    },

    /** 测试辅助：清空。 */
    async __clear() {
      store.clear();
    },
  };

  return repo;
}

module.exports = { createMemoryRepo, matches };

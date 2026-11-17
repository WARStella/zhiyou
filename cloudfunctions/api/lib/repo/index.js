'use strict';

/**
 * 仓储层工厂 —— 这是本项目"没有 AppID 也能开发"的关键。
 *
 *   memory 实现：纯内存，零依赖，供本地单元测试与算法调试（node --test 秒级跑完）
 *   cloud  实现：wx-server-sdk + 云数据库，供云函数运行时
 *
 * 领域逻辑（domain/）只依赖本接口，不感知存储。因此规划算法可以在本地被完整测试，
 * 这是 11/5「固定测试集参考答案」和 11/8「性能与成本记录」的前提。
 *
 * 接口约定（新增实现必须满足）：
 *   insert(coll, doc)                          -> doc（补 _id / createdAt / updatedAt）
 *   get(coll, id)                              -> doc | null
 *   find(coll, query, {sort, limit, skip})     -> doc[]
 *   findOne(coll, query, opts)                 -> doc | null
 *   count(coll, query)                         -> number
 *   update(coll, id, patch)                    -> { updated, doc }
 *   updateCas(coll, id, expectedVersion, patch)-> { updated, doc }  乐观锁，updated===0 表示版本冲突
 *   remove(coll, id)                           -> { removed }
 *   runTransaction(fn, collections?)           -> fn 的返回值；tx 仅提供 get/insert/update
 *
 * 约定：
 *   - 所有实现都必须让 updateCas 在版本不匹配时返回 updated: 0，且 **不写入**。
 *     这是 docs/项目计划书.md#data-model §0 决定 2 的唯一落地方式，禁止在业务代码里用"读-改-写"绕过它。
 */

const { createMemoryRepo } = require('./memory');

const IMPL = {
  memory: createMemoryRepo,
  cloud: (opts) => require('./cloud').createCloudRepo(opts),
};

let cached = null;
let cachedKind = null;
let cachedOpts = null;

/**
 * @param {'memory'|'cloud'} kind
 * @param {object} [opts] memory: {now, seed} | cloud: {env}
 */
function getRepo(kind, opts) {
  const k = kind || process.env.ZY_REPO;
  if (!k) throw new Error('必须显式选择仓储：云端 getRepo("cloud")；本地测试 getRepo("memory")。禁止静默使用内存库');
  if (cached && cachedKind === k && JSON.stringify(cachedOpts) === JSON.stringify(opts || null)) {
    return cached;
  }
  const factory = IMPL[k];
  if (!factory) throw new Error(`未知的仓储实现：${k}`);
  cached = factory(opts || {});
  cachedKind = k;
  cachedOpts = opts || null;
  return cached;
}

/** 测试用：清空缓存，避免用例之间互相污染。 */
function resetRepoCache() {
  cached = null;
  cachedKind = null;
  cachedOpts = null;
}

module.exports = { getRepo, resetRepoCache, COLLECTIONS: require('./collections') };

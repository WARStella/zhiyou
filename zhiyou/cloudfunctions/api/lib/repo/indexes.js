'use strict';

/**
 * 唯一索引登记表 —— **两个实现共同的约束事实来源**。
 *
 * 云上必须**手工**创建这些索引（云开发无法通过 SDK 建索引），
 * 创建位置：云开发控制台 → 数据库 → 选集合 → 索引管理。
 *
 * 内存实现依据本表模拟唯一约束，否则会出现：
 *   本地测试全绿（因为内存不拦重复），线上靠索引兜底 —— 语义又不一致。
 *   `ops.verifyIndexes` 会**实测**云上索引是否真的生效（写重复数据看是否被拒）。
 *
 * ⚠️ 修改本表必须同时更新：
 *   1. docs/项目计划书.md#data-model 的索引清单
 *   2. ops.initDb 返回的 manualIndexes 手工清单
 *   3. 云开发控制台里实际的索引
 */

/** collection -> 唯一键字段组（每组构成一个组合唯一索引） */
const UNIQUE_INDEXES = {
  /**
   * `shortId` 与 `openid` 各自唯一（2026-10-14 加）。
   *
   * `shortId` 是给人看/给人念的 6 位编号（见 `lib/short-id.js`）。
   * 它必须唯一，否则两个用户会拿到同一个号，
   * 而"编号撞了要改一个"意味着**已经发出去的号会指向别人** —— 比没有编号更糟。
   *
   * ⚠️ 内存实现会模拟这一条，所以本地测试能抓到碰撞；
   * 云上仍需**手工**建索引（见本文件头的说明）。
   */
  users: [['openid'], ['shortId']],
  crews: [['inviteCode']],
  crew_members: [['crewId', 'userId']],
  operations: [['requestId']],
  trip_versions: [['tripId', 'version']],
  /**
   * 订阅意向与通知去重（2026-10-17 加）。
   *
   * `subscribe_intents`：一次订阅只应有一条，重复点击要累加而不是新增行。
   * `notice_log`：`dedupeKey` 是**业务事件唯一键**。这一条是"同一句话不发两条通知"
   *   的物理保证 —— 只用 `_id` 不够：云数据库的 `add()` 会自动生成 `_id`，
   *   传进去的值不参与唯一性判断，并发下两条都能写进去。
   */
  subscribe_intents: [['crewId', 'userId', 'kind']],
  notice_log: [['dedupeKey']],
};

/** 云端手工索引清单（与上表一一对应，供 ops.initDb 返回） */
const MANUAL_UNIQUE_INDEXES = Object.entries(UNIQUE_INDEXES).flatMap(([collection, groups]) =>
  groups.map((fields) => ({ collection, fields, unique: true }))
);

/** 某集合上是否配了唯一索引 */
const hasUniqueIndex = (collection) => Boolean(UNIQUE_INDEXES[collection]);

/**
 * 唯键值是否完整。缺字段的组合键不做唯一校验 ——
 * 与 MongoDB 稀疏唯一索引的行为一致（多份"缺字段"的文档不会互相冲突）。
 */
function uniqueKeyComplete(doc, fields) {
  return fields.every((f) => doc[f] !== undefined && doc[f] !== null);
}

const uniqueKeyOf = (doc, fields) => fields.map((f) => `${f}=${doc[f]}`).join('|');

module.exports = {
  UNIQUE_INDEXES,
  MANUAL_UNIQUE_INDEXES,
  hasUniqueIndex,
  uniqueKeyComplete,
  uniqueKeyOf,
};

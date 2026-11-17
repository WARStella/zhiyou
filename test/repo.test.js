'use strict';

/**
 * 仓储层行为测试。
 *
 * 这一组测试的存在理由（2026-10-13）：
 *   线上 `ops.health` 返回 INTERNAL，原因有两个 ——
 *     ① 集合不存在时仓储层直接抛错（空库是正常初始状态）
 *     ② 使用了云数据库无法表达的函数谓词（本地对、线上错，且不报错）
 *   这两类缺陷共同点是：**本地测试全绿，线上才暴露**。
 *   所以约束必须被测试固定住，而不是只写在注释里。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryRepo } = require('../cloudfunctions/api/lib/repo/memory');
const { isCollectionMissing, isCollectionExists } = require('../cloudfunctions/api/lib/repo/cloud');
const { assertStructuredQuery, OP_NAMES } = require('../cloudfunctions/api/lib/repo/query');

// ── 约束：不允许函数谓词 ──────────────────────────────────

test('仓储查询：函数谓词必须被拒绝', () => {
  assert.throws(
    () => assertStructuredQuery((doc) => doc.verifiedAt),
    /函数谓词/,
    '函数谓词在云数据库无法表达，必须在入口就拒绝'
  );
});

test('仓储查询：未知操作符必须被拒绝，并列出可用操作符', () => {
  assert.throws(
    () => assertStructuredQuery({ a: { __op: 'regex', value: 'x' } }),
    /不支持的查询操作符/
  );
});

test('仓储查询：合法的结构化查询与空查询都通过', () => {
  assert.doesNotThrow(() => assertStructuredQuery(null));
  assert.doesNotThrow(() => assertStructuredQuery({}));
  assert.doesNotThrow(() => assertStructuredQuery({ crewId: 'c1', status: 'active' }));
  assert.doesNotThrow(() =>
    assertStructuredQuery({ verifiedAt: { __op: 'neq', value: null } })
  );
  for (const op of OP_NAMES) {
    assert.doesNotThrow(() => assertStructuredQuery({ f: { __op: op, value: 1 } }), `操作符 ${op}`);
  }
});

// ── 集合不存在 = 空结果 ───────────────────────────────────

test('集合不存在：识别错误码与多种报错文案', () => {
  assert.equal(isCollectionMissing({ errCode: -502005 }), true);
  assert.equal(
    isCollectionMissing({ errMsg: 'database collection not exists' }),
    true
  );
  assert.equal(isCollectionMissing({ errMsg: 'collection does not exist' }), true);
  assert.equal(isCollectionMissing({ errMsg: '集合不存在' }), true);

  // 云上真实原文（2026-10-13，自检往 _selftest 写入时）
  const realMissing =
    'collection.add:fail -502005 database collection not exists. [ResourceNotFound] ' +
    'Db or Table not exist: _selftest. Please check your request, but if the problem cannot ' +
    'be solved, contact us. 更多错误信息请访问：' +
    'https://docs.cloudbase.net/error-code/basic/DATABASE_COLLECTION_NOT_EXIST';
  assert.equal(isCollectionMissing({ errCode: -502005, errMsg: realMissing }), true);
  assert.equal(isCollectionExists({ errCode: -502005, errMsg: realMissing }), false);
});

test('集合已存在：识别云上真实文案「Table exist」，且不与「不存在」混淆', () => {
  // 云上真实原文（2026-10-13，ops.initDb 对 operations / events 重复建表时）
  // 首版判定只写了 `already exist`，漏掉了 `Table exist`，导致 2 个集合被误报为创建失败。
  const realExists =
    'createCollection:fail -501001 resource system error. [ResourceUnavailable.ResourceExist] ' +
    'Table exist. Please check your request, but if the problem cannot be solved, contact us. ' +
    '更多错误信息请访问：https://docs.cloudbase.net/error-code/basic/DATABASE_COLLECTION_ALREADY_EXIST';

  assert.equal(isCollectionExists({ errCode: -501001, errMsg: realExists }), true);
  assert.equal(isCollectionMissing({ errCode: -501001, errMsg: realExists }), false);

  // 其它常见措辞
  assert.equal(isCollectionExists({ errMsg: 'collection already exist' }), true);
  assert.equal(isCollectionExists({ errMsg: '表已存在' }), true);

  // 绝不把"不存在"误判为"已存在"
  assert.equal(isCollectionExists({ errMsg: '[ResourceNotFound] Db or Table not exist: x' }), false);
  assert.equal(isCollectionExists({ errCode: -601034, errMsg: '没有权限' }), false);
  assert.equal(isCollectionExists(null), false);
});

test('集合不存在：不得把其它错误误判为空结果', () => {
  // 这些必须继续抛错，否则会掩盖真实故障
  assert.equal(isCollectionMissing({ errCode: -601034, errMsg: '没有权限' }), false);
  assert.equal(isCollectionMissing({ errCode: -501000, errMsg: 'FunctionName not found' }), false);
  assert.equal(isCollectionMissing(new Error('timeout')), false);
  assert.equal(isCollectionMissing(null), false);
  assert.equal(isCollectionMissing(undefined), false);
});

test('空仓储：未创建任何集合时，读取操作返回空而非抛错', async () => {
  const repo = createMemoryRepo({ now: Date.parse('2026-10-13T04:00:00Z') });

  assert.equal(await repo.count('not_created_yet', {}), 0);
  assert.deepEqual(await repo.find('not_created_yet', {}), []);
  assert.equal(await repo.findOne('not_created_yet', {}), null);
  assert.equal(await repo.get('not_created_yet', 'x'), null);
});

test('两个实现都必须提供 ensureCollection（接口对齐）', async () => {
  const memory = createMemoryRepo();
  assert.equal(typeof memory.ensureCollection, 'function');

  const r = await memory.ensureCollection('whatever');
  assert.equal(r.created, true);
  assert.equal(r.existed, false);
  assert.equal(r.error, null, '失败原因必须通过 error 上报，不得吞掉');

  // 云实现的存在性检查（不实例化，只确认导出）
  const mod = require('../cloudfunctions/api/lib/repo/cloud');
  assert.equal(typeof mod.createCloudRepo, 'function');
  assert.equal(typeof mod.isCollectionMissing, 'function');
});

// ── 查询语义：两个实现必须一致 ────────────────────────────

test('neq null：同时排除「字段缺失」与「值为 null」', async () => {
  const repo = createMemoryRepo();
  await repo.__seed('places', [
    { _id: 'a', verifiedAt: new Date('2026-10-16'), confidence: 'high' },
    { _id: 'b', verifiedAt: null, confidence: 'low' },
    { _id: 'c', confidence: 'high' }, // 字段缺失
  ]);

  const rows = await repo.find('places', { verifiedAt: { __op: 'neq', value: null } });
  assert.deepEqual(rows.map((r) => r._id), ['a'], '只有真正核验过的地点才算已核验');
});

test('exists：区分「字段存在」与「字段为 null」（与 MongoDB $exists 一致）', async () => {
  const repo = createMemoryRepo();
  await repo.__seed('t', [{ _id: 'a', f: 1 }, { _id: 'b', f: null }, { _id: 'c' }]);

  const exists = await repo.find('t', { f: { __op: 'exists', value: true } });
  assert.deepEqual(exists.map((r) => r._id).sort(), ['a', 'b'], 'exists 不判断值是否为 null');

  const missing = await repo.find('t', { f: { __op: 'exists', value: false } });
  assert.deepEqual(missing.map((r) => r._id), ['c']);
});

test('已核验地点的组合查询：结果与 ops.health 的期望一致', async () => {
  const repo = createMemoryRepo();
  await repo.__seed('places', [
    { _id: 'a', verifiedAt: new Date('2026-10-16'), confidence: 'high' },
    { _id: 'b', verifiedAt: new Date('2026-10-16'), confidence: 'medium' },
    { _id: 'c', verifiedAt: null, confidence: 'low' },
    { _id: 'd', verifiedAt: new Date('2026-10-16'), confidence: 'low' },
    { _id: 'e', confidence: 'high' },
  ]);

  const n = await repo.count('places', {
    verifiedAt: { __op: 'neq', value: null },
    confidence: { __op: 'neq', value: 'low' },
  });
  assert.equal(n, 2, '只有 a、b 满足"已核验且非低可信度"');
});

test('排序与限制：find 支持 sort 与 limit', async () => {
  const repo = createMemoryRepo();
  await repo.__seed('loc', [
    { _id: '1', userId: 'u', reportedAt: new Date('2026-10-13T01:00:00Z') },
    { _id: '2', userId: 'u', reportedAt: new Date('2026-10-13T03:00:00Z') },
    { _id: '3', userId: 'u', reportedAt: new Date('2026-10-13T02:00:00Z') },
  ]);

  const latest = await repo.findOne('loc', { userId: 'u' }, { sort: { reportedAt: -1 }, limit: 1 });
  assert.equal(latest._id, '2', '应按 reportedAt 倒序取最新');
});

// ── 唯一约束（内存实现必须模拟云端） ──────────────────────

test('内存仓储：唯一索引必须真的拦住重复写入', async () => {
  const repo = createMemoryRepo();

  await repo.insert('users', { openid: 'dup', nickname: 'a' });

  // 同 openid 第二次插入必须被拒，形状对齐云数据库
  await assert.rejects(
    () => repo.insert('users', { openid: 'dup', nickname: 'b' }),
    (e) => {
      assert.equal(e.errCode, -502001);
      assert.equal(e.isDuplicateKey, true);
      assert.match(e.message, /duplicate key error/);
      return true;
    }
  );

  // 不同 openid 正常
  await assert.doesNotReject(() => repo.insert('users', { openid: 'other' }));

  // 组合唯一索引
  await repo.insert('crew_members', { crewId: 'c1', userId: 'u1' });
  await assert.rejects(
    () => repo.insert('crew_members', { crewId: 'c1', userId: 'u1' }),
    /duplicate key error/
  );
  // 只重合一半不算冲突
  await assert.doesNotReject(() => repo.insert('crew_members', { crewId: 'c1', userId: 'u2' }));
  await assert.doesNotReject(() => repo.insert('crew_members', { crewId: 'c2', userId: 'u1' }));

  // 缺字段不参与唯一校验（稀疏语义）：多份缺 openid 的文档可以共存
  await assert.doesNotReject(() => repo.insert('users', { nickname: 'x' }));
  await assert.doesNotReject(() => repo.insert('users', { nickname: 'y' }));

  // 更新时同样受限
  const u = await repo.findOne('users', { openid: 'other' });
  await assert.rejects(() => repo.update('users', u._id, { openid: 'dup' }), /duplicate key error/);

  // 未登记唯一索引的集合不受影响
  await assert.doesNotReject(() => repo.insert('events', { a: 1 }));
  await assert.doesNotReject(() => repo.insert('events', { a: 1 }));
});

test('内存仓储：删除后同一唯一键可以再次使用', async () => {
  const repo = createMemoryRepo();
  const a = await repo.insert('operations', { requestId: 'r1', status: 'done' });
  await assert.rejects(() => repo.insert('operations', { requestId: 'r1' }), /duplicate key/);

  await repo.remove('operations', a._id);
  await assert.doesNotReject(() => repo.insert('operations', { requestId: 'r1' }));
});

// ── 乐观锁 ────────────────────────────────────────────────

test('updateCas：版本不匹配时不写入，且不改变原文档', async () => {
  const repo = createMemoryRepo();
  const doc = await repo.insert('trips', { version: 1, nodes: [] });

  const stale = await repo.updateCas('trips', doc._id, 0, { nodes: ['x'] });
  assert.equal(stale.updated, 0, '版本不匹配必须返回 updated: 0');

  const after = await repo.get('trips', doc._id);
  assert.equal(after.version, 1, '版本不得变化');
  assert.deepEqual(after.nodes, [], '内容不得被写入');

  const good = await repo.updateCas('trips', doc._id, 1, { nodes: ['x'] });
  assert.equal(good.updated, 1);
  assert.equal(good.doc.version, 2, '成功后版本 +1');
});

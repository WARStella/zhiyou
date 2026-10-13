'use strict';

const resp = require('../lib/resp');
const { CODES, fail, assert } = require('../lib/errors');
const { resolveParams, ALGO_VERSION } = require('../lib/params');
const C = require('../lib/repo/collections');
const { MANUAL_UNIQUE_INDEXES } = require('../lib/repo/indexes');

const seedPlaces = require('../seed/places.seed.json');

/** 首次调用自动建档；之后只更新 lastSeenAt。 */
async function login(ctx) {
  const { repo, openid } = ctx;
  const now = ctx.now ? new Date(ctx.now) : new Date();

  let user = await repo.findOne(C.USERS, { openid });
  let isNew = false;
  if (!user) {
    user = await repo.insert(C.USERS, {
      openid,
      createdAt: now,
      lastSeenAt: now,
    });
    isNew = true;
  } else {
    await repo.update(C.USERS, user._id, { lastSeenAt: now });
  }

  return resp.ok(
    { userId: user._id, openid, isNew },
    { serverTime: now.toISOString() }
  );
}

/**
 * 联调自检：一次调用看清环境、依赖与数据状态。
 * 10/13 的"工程能启动"验收就靠它 —— 云开发环境下应能直接跑通。
 */
async function health(ctx) {
  const { repo, env } = ctx;
  const now = new Date(ctx.now ? ctx.now : Date.now());

  // ⚠️ 必须使用**结构化查询**，不能用函数谓词：
  // 云数据库无法表达函数谓词，若用谓词，本地内存仓储能跑通而线上会算错 —— 且不报错。
  // 「已核验」= verifiedAt 非空 且 confidence 不为 low（见 docs/01 §2.2）。
  // 这里用 neq: null 而不是 exists: true，因为 exists 会把 verifiedAt 为 null 的地点也算进来。
  const [placeCount, verifiedPlaceCount, userCount, crewCount] = await Promise.all([
    repo.count(C.PLACES, {}),
    repo.count(C.PLACES, {
      verifiedAt: { __op: 'neq', value: null },
      confidence: { __op: 'neq', value: 'low' },
    }),
    repo.count(C.USERS, {}),
    repo.count(C.CREWS, {}),
  ]);

  return resp.ok(
    {
      kind: 'health',
      ok: true,
      env,
      serverTime: now.toISOString(),
      algoVersion: ALGO_VERSION,
      params: resolveParams(),
      repo: repo.__kind,
      data: {
        places: placeCount,
        verifiedPlaces: verifiedPlaceCount,
        users: userCount,
        crews: crewCount,
      },
      // 明确列出依赖状态，避免"看起来能跑其实缺数据"
      deps: {
        mapService: '未接入（10/14 验证）',
        llm: '由 C 负责，B 不依赖其可用性',
        locationApi: '待确认权限（见 10/13 行动清单）',
      },
    },
    { serverTime: now.toISOString() }
  );
}

/**
 * 初始化集合与种子地点。
 * **仅允许在 dev 环境执行**，且必须显式 confirm。
 *
 * 云数据库的集合在首次写入时自动创建，因此这里的工作是：
 *   1. 灌入地点种子（全部标记为未核验，见 seed/places.seed.json）
 *   2. 返回需要在控制台手工创建的索引清单（云开发无法通过 SDK 建索引）
 */
async function initDb(ctx) {
  const { repo, env } = ctx;
  const p = ctx.payload || {};

  assert(env === 'dev', CODES.FORBIDDEN_ENV, `当前环境为 ${env}，禁止执行初始化`);
  assert(p.confirm === true, CODES.INVALID_PARAM, '需要显式传入 confirm: true');

  // 先把 14 个集合全部显式创建出来。
  // ⚠️ 实测结论（2026-10-13）：向不存在的集合 add() **不会**自动建集合，会抛 -502005。
  // 所以这一步不是"优化"，而是后续一切写入的前提。
  // 同时云开发控制台只能在**已存在的集合**上建索引，因此集合必须先落地。
  const created = [];
  const existed = [];
  const createErrors = [];
  for (const name of Object.values(C)) {
    const r = await repo.ensureCollection(name);
    if (r.created) created.push(name);
    else if (r.existed) existed.push(name);
    // 建集合失败必须上报，不得吞掉 —— 否则"为什么没建成"无从查起
    if (r.error) createErrors.push({ collection: name, error: r.error });
  }

  let inserted = 0;
  if (p.seed !== false) {
    for (const place of seedPlaces) {
      const exists = await repo.findOne(C.PLACES, { name: place.name });
      if (!exists) {
        await repo.insert(C.PLACES, place);
        inserted += 1;
      }
    }
  }

  const ok = createErrors.length === 0;

  if (!ok) {
    // 建集合失败时给出可执行的替代路径，而不是只报一个错误码
    return resp.err(
      {
        code: CODES.INTERNAL,
        message: `有 ${createErrors.length} 个集合创建失败，请改用手工创建`,
        details: {
          createErrors,
          manualFallback:
            '云开发控制台 →「数据库」→「新建集合」，逐个创建下列集合名：' +
            Object.values(C).join('、'),
        },
      },
      {}
    );
  }

  return resp.ok({
    kind: 'initDb',
    collectionsEnsured: Object.values(C).length,
    collectionsCreated: created,
    collectionsExisted: existed,
    seededPlaces: inserted,
    totalPlaces: await repo.count(C.PLACES, {}),
    note:
      '种子地点全部为未核验占位数据（verifiedAt 为空），不会进入规划。' +
      '请于 10/16 踏勘后由 C 录入真实核验信息。',
    // 手工索引清单由 lib/repo/indexes.js 的登记表生成 —— 不在这里重复硬编码，
    // 避免"代码里改了索引、清单里没改"的漂移。
    manualIndexes: MANUAL_UNIQUE_INDEXES.concat([
      { collection: C.PLACES, fields: 'name', unique: false },
      { collection: C.PLACES, fields: 'category', unique: false },
      { collection: C.CREW_MEMBERS, fields: 'crewId + status', unique: false },
      { collection: C.LOCATIONS, fields: 'userId + reportedAt(desc)', unique: false },
      { collection: C.LOCATIONS, fields: 'crewId + reportedAt(desc)', unique: false },
      { collection: C.LOCATIONS, fields: 'expiresAt', unique: false },
      { collection: C.EVENTS, fields: 'ts(desc)', unique: false },
      { collection: C.DECISIONS, fields: 'kind + ts(desc)', unique: false },
    ]).map((i) => ({
      collection: i.collection,
      fields: Array.isArray(i.fields) ? i.fields.join(' + ') : i.fields,
      unique: i.unique,
    })),
    verifyHint: '建完索引后调用 ops.verifyIndexes 实测它们是否真的生效（不要只看控制台）',
  });
}

/**
 * 数据库写入能力自检。
 *
 * 为什么需要它（2026-10-13）：
 *   我们在云数据库上踩到 -502001「Cannot create field 'data' in element {responseDigest: null}」——
 *   对象字段是**合并语义**，向 null 合并会失败。而内存仓储没有这个概念，本地全绿、线上必挂。
 *
 *   本项目的核心数据结构（trips.nodes、meet_tasks.participants）都是**对象数组**，
 *   如果某类写入形态在云上不可用，整个数据模型都要改。
 *   这件事不能再靠推理 —— 必须测量，而且要在写业务之前测。
 *
 * 输出可直接作为 11/11「异常测试」的记录材料。
 */
async function selfTest(ctx) {
  const { repo, env } = ctx;
  assert(env === 'dev', CODES.FORBIDDEN_ENV, `当前环境为 ${env}，自检仅限 dev`);

  // 集合名不带前导下划线：命名规则可能有限制，不引入无谓变量
  const COLL = 'selftest';
  const results = [];
  let docId = null;
  let blocked = false;

  /**
   * 前置步骤失败后，后续步骤标记为 skipped 而不是继续执行。
   *
   * 2026-10-13 的教训：首版没有这个保护，第①步（集合不存在）失败后，
   * docId 为 null，后面五步全部报 "docId必须为字符串或数字" ——
   * **五条噪音盖住了一条真因**。
   */
  const run = async (name, fn) => {
    if (blocked) {
      results.push({
        name,
        ok: null,
        skipped: true,
        reason: '前置步骤未通过，跳过（避免级联报错掩盖真实原因）',
      });
      return;
    }
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail === undefined ? null : detail });
    } catch (e) {
      results.push({
        name,
        ok: false,
        errCode: e && e.errCode !== undefined ? e.errCode : null,
        errMsg: (e && (e.errMsg || e.message)) || String(e),
      });
    }
  };

  // ① 建集合：必须第一步，且把创建失败的原因**原样**报出来（早期版本把它吞了）
  await run('① 确保集合存在', async () => {
    const r = await repo.ensureCollection(COLL);
    if (r.error) throw new Error(`createCollection 失败：${r.error}`);
    return r;
  });

  // ② 真实读一次，确认集合真的可用（建成功 ≠ 立即可读写）
  await run('② 探测集合可读', async () => {
    const rows = await repo.find(COLL, { tag: 'probe' });
    return { count: rows.length };
  });

  // ③ 清理上一次探针，避免反复自检堆积
  await run('③ 清理上一次的探针文档', async () => {
    const stale = await repo.findOne(COLL, { tag: 'probe' });
    if (!stale) return { removed: 0 };
    const r = await repo.remove(COLL, stale._id);
    return { removed: r.removed };
  });

  await run('④ 插入：嵌套对象 + 对象数组', async () => {
    const d = await repo.insert(COLL, {
      tag: 'probe',
      version: 1,
      scalar: 1,
      nested: { a: 1, deep: { b: 2 } },
      nodes: [
        { nodeId: 'n1', stayMin: 30 },
        { nodeId: 'n2', stayMin: 20 },
      ],
      nullable: null,
    });
    docId = d._id;
    return { _id: d._id };
  });

  // 后续每一步都依赖 docId；插入失败则全部跳过
  if (!docId) blocked = true;

  await run('⑤ 更新：向已有对象字段写嵌套对象', async () => {
    await repo.update(COLL, docId, { nested: { a: 9, deep: { b: 8, c: 7 } } });
    const d = await repo.get(COLL, docId);
    return { nested: d.nested };
  });

  await run('⑥ 更新：向 null 字段写对象（2026-10-13 故障形态）', async () => {
    await repo.update(COLL, docId, { nullable: { ok: true, data: { x: 1 } } });
    const d = await repo.get(COLL, docId);
    return { nullable: d.nullable };
  });

  await run('⑦ 更新：整体替换对象数组（trips.nodes 形态）', async () => {
    await repo.update(COLL, docId, { nodes: [{ nodeId: 'n3', stayMin: 5 }] });
    const d = await repo.get(COLL, docId);
    return { nodes: d.nodes };
  });

  await run('⑧ 更新：整体替换对象数组（meet_tasks.participants 形态）', async () => {
    await repo.update(COLL, docId, {
      participants: [
        { userId: 'u1', status: 'confirmed', confirmedVersion: 1 },
        { userId: 'u2', status: 'invited', confirmedVersion: null },
      ],
    });
    const d = await repo.get(COLL, docId);
    return { participantCount: d.participants ? d.participants.length : null };
  });

  // ⑨ 乐观锁：这条机制支撑"旧版本确认不能使新方案生效"，必须真的可用
  await run('⑨ 乐观锁 updateCas：版本不匹配不写入', async () => {
    const stale = await repo.updateCas(COLL, docId, 0, { marker: 'should-not-write' });
    const after = await repo.get(COLL, docId);
    const good = await repo.updateCas(COLL, docId, after.version, { marker: 'written' });
    return {
      staleUpdated: stale.updated,
      versionAfterStale: after.version,
      goodUpdated: good.updated,
      newVersion: good.doc ? good.doc.version : null,
    };
  });

  const failed = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.skipped);

  // 「向 null 字段写对象」是**已知限制**，不是缺陷：云数据库对对象字段是合并语义，
  // 向 null 合并必失败。代码已在 lib/idem.js 与 actions/meet.js 中规避该形态。
  // 把它计入"失败"会让结论读起来像"有东西坏了"，掩盖真正需要注意的项。
  const KNOWN_LIMITATION = /向 null 字段写对象/;
  const knownLimitations = failed.filter((r) => KNOWN_LIMITATION.test(r.name));
  const critical = failed.filter((r) => !KNOWN_LIMITATION.test(r.name));

  return resp.ok({
    kind: 'selfTest',
    collection: COLL,
    docId,
    results,
    passed: results.filter((r) => r.ok === true).length,
    total: results.length,
    failedCount: failed.length,
    criticalFailureCount: critical.length,
    skippedCount: skipped.length,
    knownLimitations: knownLimitations.map((k) => ({
      name: k.name,
      errCode: k.errCode,
      note: '代码已规避该形态（见 docs/01 §0 决定 4）',
    })),
    verdict:
      critical.length === 0
        ? '本项目使用的所有写入形态均可用'
        : '存在不可用的写入形态，见 ok:false 中未列入 knownLimitations 的条目 —— 数据模型需按结论调整',
    note: '仅写入 selftest 集合，不触碰业务数据。可作为 11/11 异常测试记录。',
  });
}

/**
 * 唯一索引**实测**校验。
 *
 * 为什么是"撞它"而不是"看它"：
 *   **索引存在 ≠ 索引生效。** 字段写错、保存没成功、建到了别的集合上，
 *   在控制台里看起来都像"已经有索引了"。
 *   而**一个没生效的唯一索引比没有索引更危险** —— 它让人以为幂等与防重复入队已有保障。
 *
 * 做法：故意写入同键的重复数据，观察第二次是否被拒。
 * 无论成败，**测试数据都会被清理**（并在返回里报告是否清干净）。
 */
async function verifyIndexes(ctx) {
  const { repo, env } = ctx;
  assert(env === 'dev', CODES.FORBIDDEN_ENV, `当前环境为 ${env}，索引校验仅限 dev`);

  const TAG = 'idxcheck';
  const created = [];
  const results = [];

  const checkUnique = async ({ name, collection, fields, build }) => {
    let first = null;
    try {
      first = await repo.insert(collection, build('first'));
      created.push({ collection, id: first._id });
    } catch (e) {
      results.push({
        name,
        collection,
        fields,
        ok: false,
        duplicateRejected: false,
        verdict: '第一条测试数据就写入失败，无法判定索引状态',
        errMsg: (e && (e.errMsg || e.message)) || String(e),
      });
      return;
    }

    let rejected = false;
    let errCode = null;
    let errMsg = null;
    let acceptedId = null;

    try {
      const second = await repo.insert(collection, build('second'));
      acceptedId = second._id;
      created.push({ collection, id: second._id });
    } catch (e) {
      rejected = true;
      errCode = e && e.errCode !== undefined ? e.errCode : null;
      errMsg = (e && (e.errMsg || e.message)) || String(e);
    }

    results.push({
      name,
      collection,
      fields,
      ok: rejected,
      duplicateRejected: rejected,
      verdict: rejected
        ? '唯一约束已生效（同键第二次写入被拒）'
        : '重复写入被接受 —— 该唯一索引未生效，或索引字段与代码不一致',
      errCode,
      errMsg,
      acceptedDocId: acceptedId,
    });
  };

  try {
    await checkUnique({
      name: 'users.openid 唯一',
      collection: C.USERS,
      fields: ['openid'],
      build: (marker) => ({ openid: `${TAG}_dup`, tag: TAG, marker, lastSeenAt: new Date() }),
    });

    await checkUnique({
      name: 'operations.requestId 唯一',
      collection: C.OPERATIONS,
      fields: ['requestId'],
      build: (marker) => ({
        requestId: `${TAG}_dup`,
        tag: TAG,
        marker,
        userId: TAG,
        action: 'ops.verifyIndexes',
        status: 'done',
        responseJson: '',
        createdAt: new Date(),
        finishedAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
      }),
    });

    await checkUnique({
      name: 'crew_members.crewId+userId 组合唯一',
      collection: C.CREW_MEMBERS,
      fields: ['crewId', 'userId'],
      build: (marker) => ({
        crewId: `${TAG}_crew`,
        userId: `${TAG}_user`,
        tag: TAG,
        marker,
        role: 'member',
        status: 'active',
        locationSharing: true,
        joinedAt: new Date(),
      }),
    });
  } finally {
    // 无论成败都必须清理：这些是测试数据，不得留在业务集合里
    for (const item of created) {
      try {
        await repo.remove(item.collection, item.id);
      } catch (e) {
        console.warn('[verifyIndexes] 清理失败', item.collection, item.id);
      }
    }
  }

  // 清理后必须为 0；不为 0 说明有残留，必须让使用者看见
  const leftover =
    (await repo.count(C.USERS, { tag: TAG })) +
    (await repo.count(C.OPERATIONS, { tag: TAG })) +
    (await repo.count(C.CREW_MEMBERS, { tag: TAG }));

  const failed = results.filter((r) => !r.ok);

  return resp.ok({
    kind: 'verifyIndexes',
    results,
    passed: results.filter((r) => r.ok).length,
    total: results.length,
    cleanedCount: created.length,
    leftover,
    verdict:
      failed.length === 0
        ? '三个唯一索引均已实测生效'
        : '有唯一索引未生效 —— 见 ok:false 条目；未生效的唯一索引比没有更危险',
    fixHint: failed.map(
      (f) =>
        `云开发控制台 → 数据库 → ${f.collection} → 索引管理 → 新建「唯一」索引：${f.fields.join(
          ' + '
        )}`
    ),
    note: '测试数据已清理（leftover 应为 0）。本结果可作为 11/11 异常测试与 11/2 冻结核查的记录。',
  });
}

module.exports = { login, health, initDb, selfTest, verifyIndexes };

'use strict';

const resp = require('../lib/resp');
const { CODES, fail, assert } = require('../lib/errors');
const { resolveParams, ALGO_VERSION } = require('../lib/params');
const C = require('../lib/repo/collections');
const { dependencyStatus } = require('../lib/config-health');
const { MANUAL_UNIQUE_INDEXES } = require('../lib/repo/indexes');
/** `ops.walkStats` 要在报告里对照"现在产品用的那个常数" */
const geo = require('../lib/geo');
/**
 * 分桶与中位数**收口到 `lib/walk-eval.js`**（2026-10-15）。
 *
 * ⚠️ 原先这里有一份自己的副本，而新写的评测器还需要同一份 ——
 * **两处定义必然漂移**，漂移的表现是"报告说 A、评测说 B"，且两边都不报错。
 * 本项目在"认地名"上已经吃过一次两套规则的亏（哈工大：一个认、一个不认），
 * 所以在加第二处之前先合并成一处。
 */
const { DISTANCE_BUCKETS, median } = require('../lib/walk-eval');
/** 6 位用户短号（2026-10-14）—— 见 lib/short-id.js 的设计说明 */
const shortIdMod = require('../lib/short-id');

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
 * ── 个人资料（2026-10-14 用户要求）──────────────────────────
 *
 * 用户原话："我的界面还需包含用户id与头像，用户名，默认出行方式等"
 *
 * 所以 `users` 从"只有 openid 的登录记录"扩成一个真正的资料档案。
 * 三个字段都是**可选**的 —— 没填就显示兜底文案，而不是报错：
 * 新用户第一次进「我的」时这三个字段全是空的。
 */

/** 昵称长度上限。与界面上的 `maxlength` 保持一致，两处都要挡 */
const NICKNAME_MAX = 20;

/**
 * 默认出行方式的可选值 —— **与 `lib/mode-choice.js` 的 MODE_OPTIONS 同源**。
 *
 * 刻意 require 过来而不是再抄一份：抄一份就会漂移，
 * 而漂移的症状是"界面能选、后端不认"，很费劲才查得出来。
 */
const modeChoice = require('../lib/mode-choice');

/** 把用户记录整理成界面要的形状（**不泄露 openid 以外的敏感字段**） */
function profileOf(user) {
  if (!user) return null;
  return {
    userId: user._id,
    /**
     * 6 位短号 —— 给人看、给人念的那个（2026-10-14 用户要求）。
     *
     * `userId` 是 28 位随机串，念不出来、截图里还折两行；
     * 而它的真实用途只有"组队排障、对照日志"。
     * 见 `lib/short-id.js` 里"为什么不是 6 位纯数字"的推算。
     *
     * ⚠️ 老用户可能还没有这个字段 —— 由 `ensureShortId` 补发。
     *    为 null 说明**补发失败**（极端情况），界面要能如实显示而不是空白。
     */
    shortId: user.shortId || null,
    /** 昵称未设置时为 null —— 界面显示兜底文案（如"未命名"），不要编一个 */
    nickname: user.nickname || null,
    /** 云存储 fileID；界面用 wx.cloud.getTempFileURL 换成可显示的临时地址 */
    avatarFileId: user.avatarFileId || null,
    /**
     * 默认出行方式。`auto` = 按最快自动挑。
     *
     * ⚠️ 未设置时回 `auto` 而不是 null —— 它是**有默认语义**的，
     * 与昵称（true null = 没填）不同。
     */
    defaultTravelMode: user.defaultTravelMode || modeChoice.PREFERRED_MODE.AUTO,
    createdAt: user.createdAt || null,
    lastSeenAt: user.lastSeenAt || null,
  };
}

/**
 * 读出所有已用的短号（顺序发号要用它算下一个）。
 *
 * ⚠️ 只取 `shortId` 一个字段，不拉整条记录 —— 用户表里有昵称、头像、
 * openid 这些不该为了发号而读的东西。
 */
async function listUsedShortIds(repo) {
  const rows = await repo.find(C.USERS, {}, { limit: 20000 });
  return (rows || []).map((r) => r && r.shortId).filter(Boolean);
}

/**
 * 分配一个顺序短号，并**靠唯一索引兜底**处理并发碰撞。
 *
 * 做法：从已有编号取最大值 +1，写进用户记录；
 * 若唯一索引拒绝（并发下别人抢先用了同一个号），重新读最大值再试。
 *
 * ⚠️ 唯一索引是**数据库级**的约束，比业务层自己加锁可靠 ——
 * 而进程之间本来就没有共享内存可锁（云函数是多实例的）。
 *
 * @returns {Promise<{shortId: string|null, user: object}>}
 *   `shortId` 为 null 表示没发出来（连撞多次或超过上限），
 *   此时**照常返回用户记录** —— 让用户连资料页都打不开更糟。
 */
async function assignShortId(repo, user) {
  const shortId = await shortIdMod.allocateShortId({
    listExisting: () => listUsedShortIds(repo),
    /**
     * 抢占这个号：直接写进用户记录，让唯一索引裁决。
     * 被拒（重号）时返回 false，让 `allocateShortId` 重算。
     */
    tryReserve: async (candidate) => {
      try {
        await repo.update(C.USERS, user._id, { shortId: candidate });
        return true;
      } catch (e) {
        /**
         * ⚠️ 这里**吞掉异常是正确的**，但要分清吞的是哪种：
         *   · 唯一索引冲突 = 预期内的并发，重试即可；
         *   · 其它错误（网络、权限）也会走到这里，重试几次后
         *     `allocateShortId` 返回 null，界面如实显示"暂未分配"。
         * 两者都不该让资料页打不开。
         */
        return false;
      }
    },
  });

  return { shortId, user: shortId ? Object.assign({}, user, { shortId }) : user };
}

/**
 * 保证用户有一个短号 —— 没有就分配一个。
 *
 * ⚠️ 这是**为已有用户准备的路**：短号是 2026-10-14 才加的字段，
 * 在那之前建的用户记录里没有它。不能要求他们"重新注册"。
 */
async function ensureShortId(repo, user) {
  if (!user || user.shortId) return user;
  const r = await assignShortId(repo, user);
  return r.user;
}

/** 读自己的资料。找不到记录时**先建一条**（与 login 同一个兜底） */
async function getProfile(ctx) {
  const { repo, openid } = ctx;
  const now = ctx.now ? new Date(ctx.now) : new Date();

  let user = await repo.findOne(C.USERS, { openid });
  if (!user) {
    /**
     * ⚠️ **先插记录、再发号**，而不是"先算出号、再连着记录一起插"。
     *
     * 理由：发号要靠 `repo.update(用户id, ...)` 让唯一索引裁决，
     * 而那条路需要 `user._id`。两条路（新建 / 补发）用**同一个**
     * `assignShortId`，就不会出现"只改了其中一处"的问题。
     *
     * 顺序号的第一位用户于是拿到 `000001` —— 因为算最大值时
     * 这条记录的 `shortId` 还是空的，不参与计算。
     */
    user = await repo.insert(C.USERS, { openid, createdAt: now, lastSeenAt: now });
  }
  /** 没有短号就发一个（新用户与老用户走同一条路） */
  user = await ensureShortId(repo, user);

  return resp.ok({
    profile: profileOf(user),
    /** 界面要用它渲染出行方式选项，避免前后端两份表漂移 */
    travelModeOptions: modeChoice.MODE_OPTIONS,
  });
}

/**
 * 改自己的资料。**按字段部分更新** —— 只传昵称不会把头像清掉。
 *
 * @param {object} ctx.payload
 *   `nickname`           昵称，空串表示清空
 *   `avatarFileId`       头像的云存储 fileID，空串表示清空
 *   `defaultTravelMode`  默认出行方式，须在 MODE_OPTIONS 的值域内
 */
async function updateProfile(ctx) {
  const { repo, openid } = ctx;
  const p = ctx.payload || {};
  const now = ctx.now ? new Date(ctx.now) : new Date();

  const user = await repo.findOne(C.USERS, { openid });
  if (!user) throw fail(CODES.NOT_FOUND, '用户记录不存在，请先调用 user.login 或 user.getProfile');

  const patch = {};

  if (p.nickname !== undefined) {
    /**
     * ⚠️ 昵称要**去掉首尾空白**再判空：用户输了一串空格时，
     * 存下来会让界面显示成"有名字但看不见"，比直接当没填更糟。
     */
    const nickname = String(p.nickname == null ? '' : p.nickname).trim();
    if (nickname.length > NICKNAME_MAX) {
      throw fail(CODES.INVALID_PARAM, `昵称最多 ${NICKNAME_MAX} 个字`);
    }
    patch.nickname = nickname || null;
  }

  if (p.avatarFileId !== undefined) {
    const fileId = String(p.avatarFileId == null ? '' : p.avatarFileId).trim();
    patch.avatarFileId = fileId || null;
  }

  if (p.defaultTravelMode !== undefined) {
    const mode = String(p.defaultTravelMode == null ? '' : p.defaultTravelMode);
    if (!modeChoice.isPreferredMode(mode)) {
      throw fail(
        CODES.INVALID_PARAM,
        `不认识的出行方式「${mode}」。可选：${modeChoice.MODE_OPTIONS.map((o) => o.value).join(' / ')}`
      );
    }
    patch.defaultTravelMode = mode;
  }

  if (!Object.keys(patch).length) {
    /** 什么都没传不是错误，但要说清"没有可更新的字段"，别让调用方以为改成功了 */
    return resp.ok({ profile: profileOf(user), updated: [], note: '没有需要更新的字段' });
  }

  await repo.update(C.USERS, user._id, patch);

  /**
   * 回读一次再返回 —— **不能拿 `patch` 当作结果**：
   * 它只有本次改的字段，界面拿它渲染会把没改的字段变成空白。
   */
  const fresh = await repo.findOne(C.USERS, { openid });
  return resp.ok({ profile: profileOf(fresh), updated: Object.keys(patch), at: now.toISOString() });
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
  // 「已核验」= verifiedAt 非空 且 confidence 不为 low（见 docs/项目计划书.md#data-model §2.2）。
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
      deps: dependencyStatus(),
    },
    { serverTime: now.toISOString() }
  );
}

/**
 * 初始化集合。
 * **仅允许在 dev 环境执行**，且必须显式 confirm。
 *
 * ── 2026-10-13：**不再灌入占位地点** ──────────────────────
 *
 * 原先会灌 6 条"占位"地点（名字带「（占位）」、`dataSource` 为
 * `PLACEHOLDER_待10/16踏勘核实`）。它们带来的问题比价值大：
 *
 *   · **看起来像真数据** —— 界面、检索、规划里都当真地点在用，
 *     而用户从名字上看不出坐标是编的；
 *   · 会被当成"**已知地点**"喂给需求解析器（`pickKnownPlaceNames`），
 *     于是「我想去中央大街」会命中一个**坐标是猜的**地点；
 *   · 干扰踏勘判断：容易以为"库里已经有这些地方了"。
 *
 * 现在地点的来源只有两个，**都是真的**：
 *   ① `place.search` 检索回来的上游 POI；
 *   ② 10/16 踏勘后录入的核验信息。
 * **库一开始就是空的，这是正确状态，不是缺陷。**
 */
async function initDb(ctx) {
  const { repo, env } = ctx;
  const p = ctx.payload || {};

  assert(env === 'dev', CODES.FORBIDDEN_ENV, `当前环境为 ${env}，禁止执行初始化`);
  assert(p.confirm === true, CODES.INVALID_PARAM, '需要显式传入 confirm: true');

  // 先把集合登记表中的全部集合显式创建出来。
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
    totalPlaces: await repo.count(C.PLACES, {}),
    note:
      '集合已就绪，**不含任何地点数据**。地点来自两处，都是真的：' +
      '① 行程页检索回来的上游 POI；② 10/16 踏勘后录入的核验信息。',
    // 手工索引清单由 lib/repo/indexes.js 的登记表生成 —— 不在这里重复硬编码，
    // 避免"代码里改了索引、清单里没改"的漂移。
    manualIndexes: MANUAL_UNIQUE_INDEXES.concat([
      { collection: C.PLACES, fields: 'name', unique: false },
      { collection: C.PLACES, fields: 'category', unique: false },
      { collection: C.CREW_MEMBERS, fields: 'crewId + status', unique: false },
      { collection: C.CREW_MESSAGES, fields: 'crewId + seq(desc)', unique: false },
      { collection: C.GUIDE_SESSIONS, fields: 'expiresAt', unique: false },
      { collection: C.LOCATIONS, fields: 'userId + reportedAt(desc)', unique: false },
      { collection: C.LOCATIONS, fields: 'crewId + reportedAt(desc)', unique: false },
      { collection: C.LOCATIONS, fields: 'expiresAt', unique: false },
      { collection: C.EVENTS, fields: 'ts(desc)', unique: false },
      { collection: C.EVENTS, fields: 'action + userId + type + ts(desc)', unique: false },
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
      note: '代码已规避该形态（见 docs/项目计划书.md#data-model §0 决定 4）',
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

/**
 * 步行估算的**校准报告**（2026-10-13 新增）。
 *
 * ── 它解决的什么 ──────────────────────────────────────────
 *
 * `geo.js` 用一个**常数** `DETOUR_FACTOR = 1.3` 把直线距离换算成步行距离。
 * 而实测它并不是常数：
 *
 *     直线 605 米 → 实际 815 米   倍率 1.35
 *     直线  10 米 → 实际  76 米   倍率 7.6     ← 差了 7 倍
 *
 * 每次调地图接口都会往 `walk_samples` 记一条「直线 vs 实际」。
 * 这个接口按**距离区间**汇总它们，回答两个问题：
 *
 *   ① 我们的估算到底差多少？（现状评估）
 *   ② 每个区间该用什么系数？（**比常数 1.3 立刻更准**）
 *
 * ── 与后续模型的关系 ────────────────────────────────────
 *
 * 这里是**描述统计**，不是模型 —— 但它产出的正是模型的输入与基线。
 * 任何回归模型都必须先打败"分段常数"这个基线，否则不值得上。
 * **先有基线，再谈模型。**
 */
/**
 * `ops.exportWalkSamples` —— 把步行样本导出成**可离线评测**的一批行（仅 dev）。
 *
 * ── 为什么必须有一个导出接口 ─────────────────────────────
 *
 * 评测器（`lib/walk-eval.js`）是**纯函数**：不联网、不读库、不调模型 ——
 * 这是它能被测试、能被复现的前提（与"评分器不调模型"同一条理由）。
 * 而样本躺在云数据库里。没有导出这一步，"评测"就只能对着**编的数据**跑，
 * 那正是本项目反复记下的教训：
 *
 *   > **用自己编的数据测自己写的规则，等于没测。**
 *
 * ── 为什么这个集合可以导出，而 `locations` 不行 ───────────
 *
 * `walk_samples` **不含 openid、不含坐标**（见 `actions/trip.js` 的写入处，
 * 那里逐字段列了它记什么），只有地点名与几何量 —— 它是**数据**，不是**轨迹**。
 * `locations` 是精确位置，属于隐私设计里"短期保留"的那一类，
 * **绝不能**用同样方式导出。
 *
 * 导出时**显式挑字段**，不写 `...doc`：
 * 以后有人往样本里加一个字段（比如按用户维度的统计），
 * 新字段不会被**自动**带出数据库。白名单要改就得有人来改这一行。
 */
async function exportWalkSamples(ctx) {
  const { repo, env } = ctx;
  assert(env === 'dev', CODES.FORBIDDEN_ENV, `当前环境为 ${env}，样本导出仅限 dev`);

  /**
   * ⚠️ **分批是必需的，不是优化**：云函数返回体有大小上限，
   * 几千条样本一次全带回去会**截断或直接失败** ——
   * 而一个"少了一半样本"的导出，会让评测结果看起来更差（或更好），
   * 且**没有任何报错**。所以这里显式给 `limit` 并回报 `truncated`。
   */
  const p = ctx.payload || {};
  const limit = Math.min(Math.max(Number(p.limit) || 1000, 1), 5000);
  const all = await repo.find(C.WALK_SAMPLES, {}, { limit });
  const total = await repo.count(C.WALK_SAMPLES, {});
  const rows = all.map((s) => ({
    _id: s._id,
    // ── 情境（分类特征）──
    mode: s.mode,
    weather: s.weather,
    timeBucket: s.timeBucket,
    weekday: s.weekday,
    // ── 几何量（标签与特征）──
    straightMeters: s.straightMeters,
    actualMeters: s.actualMeters,
    detourRatio: s.detourRatio,
    // ── 时间：预测是特征，真实用时才是标签 ──
    predictedMinutes: s.predictedMinutes,
    actualMinutes: s.actualMinutes,
    // ── 可追溯到哪一段 ──
    fromName: s.fromName,
    toName: s.toName,
    fromId: s.fromId,
    toId: s.toId,
    sampledAt: s.sampledAt,
    labeledAt: s.labeledAt,
  }));

  return resp.ok({
    kind: 'walkSamplesExport',
    /** 导出格式版本 —— 字段变了就提它，否则离线分析拿到的列会对不上 */
    schemaVersion: 1,
    /** **实际的样本行**。评测器直接吃这个数组（见 scripts/walk-eval.js 的 loadRows） */
    samples: rows,
    count: rows.length,
    /** 库里的总数 —— 与 count 不同就说明这次是被 limit 截断的 */
    totalInDb: total,
    truncated: total > rows.length,
    limit,
    /**
     * 这两个数**必须一起给出**：只报 count 的话，
     * "库里 0 条"与"导出坏了"看起来一模一样。
     */
    withActualMinutes: rows.filter((r) => typeof r.actualMinutes === 'number' && r.actualMinutes > 0).length,
    exportedAt: new Date().toISOString(),
    /** 离线评测器的入口 —— 报告里直接写出怎么用，省得下次再找 */
    howTo: 'node scripts/walk-eval.js --samples <导出的 json>',
    note:
      '本集合不含 openid 与坐标，因此可导出用于离线评测。' +
      '**不要**用同样方式导出 locations —— 那是精确轨迹。' +
      (total > rows.length ? `⚠️ 本次只导出了 ${rows.length}/${total} 条，评测前请先确认是否要分批导全。` : ''),
  });
}

async function walkStats(ctx) {
  const { repo } = ctx;
  const CONST_FACTOR = geo.DETOUR_FACTOR;

  const samples = await repo.find(C.WALK_SAMPLES, {}, { limit: 5000 });
  const usable = samples.filter(
    (s) => typeof s.straightMeters === 'number' && typeof s.actualMeters === 'number' && s.straightMeters > 0
  );

  const buckets = DISTANCE_BUCKETS.map((b) => {
    const inBucket = usable.filter((s) => s.straightMeters >= b.min && s.straightMeters < b.max);
    const ratios = inBucket.map((s) => s.actualMeters / s.straightMeters);
    const med = median(ratios);
    /**
     * 用这个区间该用的系数去预测，会差多少？
     * 报**中位绝对百分比误差**（MAPE）—— 它直观：25% 就是"平均差四分之一"。
     */
    let mape = null;
    if (ratios.length) {
      const errs = inBucket.map((s, i) => Math.abs(ratios[i] - med) / ratios[i]);
      mape = Number((median(errs) * 100).toFixed(1));
    }
    return {
      label: b.label,
      count: inBucket.length,
      /** 这条区间数据不够时**不给建议系数** —— 别用 3 条样本定一个系数 */
      suggestedFactor: inBucket.length >= 5 ? med : null,
      medianRatio: med,
      minRatio: ratios.length ? Number(Math.min(...ratios).toFixed(2)) : null,
      maxRatio: ratios.length ? Number(Math.max(...ratios).toFixed(2)) : null,
      /** 用「区间建议系数」预测时，相对误差的中位数（%） */
      mapePercent: mape,
      /** 样本不足 5 条时如实标注，别让人以为这个数可信 */
      insufficient: inBucket.length < 5,
    };
  });

  const allRatios = usable.map((s) => s.actualMeters / s.straightMeters);
  const overallMedian = median(allRatios);

  return resp.ok({
    kind: 'walkStats',
    totalSamples: samples.length,
    usableSamples: usable.length,
    /** 当前产品用的常数 —— 报告要能看出"它在哪些区间高估/低估" */
    currentConstant: CONST_FACTOR,
    overallMedianRatio: overallMedian,
    buckets,
    /** 一句话结论，界面可直接展示 */
    verdict:
      usable.length < 20
        ? `样本只有 ${usable.length} 条，还不足以判断 —— 继续积累（每次规划都会自动记录）`
        : `全距中位倍率 ${overallMedian}（当前用常数 ${CONST_FACTOR}）；` +
          `各区间差异见 buckets —— **区间系数比单常数更准**，模型必须打败它才有价值`,
    note:
      '这是**描述统计**，不是模型。任何回归模型都要先打败"分段常数"这个基线，' +
      '否则不值得把它导出成 JSON 塞进小程序。',
  });
}

module.exports = {
  login,
  health,
  initDb,
  selfTest,
  verifyIndexes,
  walkStats,
  exportWalkSamples,
  /** 个人资料（2026-10-14） */
  getProfile,
  updateProfile,
  /** 供其它 action 复用同一套字段整理逻辑 */
  profileOf,
  NICKNAME_MAX,
};

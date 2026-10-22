'use strict';

/**
 * 用户编号 —— 6 位**顺序**数字（000001、000002、……）。
 *
 * ── 需求变过两次，记在这里免得以后有人"优化"回去 ────────────
 *
 * 用户先问："就不能把用户id变短一点吗，比如6位数字这种"
 * 我担心碰撞，做成了 31 字符 × 6 位的**随机**编码，并写了理由。
 * 用户随后明确："编号按照数据库中编号生成六位序号"
 *
 * **顺序号确实更好**：它把碰撞问题从根上去掉 ——
 * 随机号靠概率躲碰撞，顺序号靠**唯一索引 + 冲突重试**保证不重。
 * 用户比我更早看到这一点。
 *
 * ── 顺序号的两个代价（必须写清，不能装作没有）───────────────
 *
 *   ① **能看出用户规模**：拿到 000042 就知道大约有 42 个用户。
 *   ② **可枚举**：顺序号容易被猜。
 *
 * 所以有一条纪律：**编号绝不参与鉴权**，权限一律走 `openid` / `userId`。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sid = require('../cloudfunctions/api/lib/short-id');
const { UNIQUE_INDEXES } = require('../cloudfunctions/api/lib/repo/indexes');
const { makeWorld, C, expectOk } = require('./helpers');

// ── 格式与序号 ─────────────────────────────────────────────

test('编号是 6 位数字，且从 000001 开始（不是 000000）', () => {
  assert.equal(sid.SHORT_ID_LENGTH, 6);
  assert.equal(sid.formatSequence(1), '000001');
  assert.equal(sid.formatSequence(42), '000042');
  assert.equal(sid.formatSequence(999999), '999999');

  /** 000000 不是合法编号 —— 序号从 1 起 */
  assert.equal(sid.isShortId('000000'), false, '000000 应当非法');
  assert.equal(sid.isShortId('000001'), true);
});

test('形状校验只认 6 位数字 —— 上一版的字母编号不再合法', () => {
  assert.equal(sid.isShortId('000042'), true);
  assert.equal(sid.isShortId('ABCDEF'), false, '字母编号是上一版方案，已废弃');
  assert.equal(sid.isShortId('00042'), false, '5 位不合法');
  assert.equal(sid.isShortId('0000042'), false, '7 位不合法');
  assert.equal(sid.isShortId(42), false, '数字类型不行 —— 会丢掉前导零的语义');
});

test('下一个序号取**最大值 + 1**，不是"总数 + 1"', () => {
  /**
   * ⚠️ 这条守着一个具体的事故：
   *
   * 用户记录若被删除（清理测试数据、`crew.remove`），
   * 按"总数 + 1"算会**把已经发出去的号再发一次** —— 那就是重号，
   * 而重号意味着已经发给同伴的编号指向了另一个人。
   *
   * 例：已有 000001、000003（000002 被删）→ 总数 2 → 会发 000003，
   *     与已有的 000003 撞。按最大值算是 4，正确。
   */
  assert.equal(sid.nextSequence(['000001', '000003']), 4, '中间有空洞时要用最大值 +1');
  assert.equal(sid.nextSequence([]), 1, '空表从 1 开始');
  assert.equal(sid.nextSequence(['000010', '000002']), 11);
});

test('算序号时忽略脏数据，不让一条坏记录卡住发号', () => {
  assert.equal(sid.nextSequence(['abc', null, undefined, '12345', '000002']), 3);
  assert.equal(sid.nextSequence(['000000']), 1, '000000 非法，视为没有');
});

test('念号、抄号时的全角输入要能归一化', () => {
  /** 中文输入法下很常见：用户照着抄，打出来是全角 */
  assert.equal(sid.normalizeShortId('００００４２'), '000042');
  assert.equal(sid.normalizeShortId(' 000042 '), '000042');
  assert.equal(sid.normalizeShortId(null), '');
});

// ── 分配与并发 ─────────────────────────────────────────────

test('分配时会用"抢占"来挡住并发碰撞', async () => {
  /**
   * ⚠️ 并发是顺序发号的**唯一**风险：两个人同时读到同一个最大值。
   * 靠数据库级唯一索引裁决（`tryReserve` 返回 false 表示被别人抢了）。
   */
  const reserved = [];
  const taken = new Set();
  const id = await sid.allocateShortId({
    listExisting: async () => Array.from(taken),
    tryReserve: async (candidate) => {
      reserved.push(candidate);
      /** 第一次故意失败，模拟被别人抢先 */
      if (reserved.length === 1) {
        taken.add(candidate);
        return false;
      }
      taken.add(candidate);
      return true;
    },
  });

  assert.equal(reserved.length, 2, '撞了一次就该重试');
  assert.equal(id, '000002', '重试时读到了新的最大值，发下一个号');
  assert.equal(taken.has(id), true);
});

test('连撞多次后**返回 null**，不硬塞一个重复值', async () => {
  let attempts = 0;
  const id = await sid.allocateShortId({
    listExisting: async () => [],
    tryReserve: async () => {
      attempts += 1;
      return false; // 永远抢不到
    },
  });

  assert.equal(id, null);
  assert.equal(attempts, sid.MAX_ATTEMPTS, `最多试 ${sid.MAX_ATTEMPTS} 次`);
});

test('超过 999999 时返回 null，不静默发一个 7 位号', async () => {
  /**
   * ⚠️ 长度变了会让所有按"6 位"写的校验与界面假设失效。
   * 那是个需要人做决定的时刻，不该由代码悄悄替你决定。
   */
  const id = await sid.allocateShortId({ listExisting: async () => ['999999'] });
  assert.equal(id, null);
  assert.equal(sid.MAX_SEQUENCE, 999999);
});

test('`shortId` 必须登记为唯一索引 —— 顺序发号全靠它兜底', async () => {
  /**
   * ⚠️ 这一条守的是"本地与线上语义一致"：
   * 云上索引要手工建，而内存实现依据 `UNIQUE_INDEXES` 模拟。
   * 不登记的话本地测试全绿、线上却可能发出重号。
   */
  const groups = UNIQUE_INDEXES.users.map((g) => g.join('+'));
  assert.ok(groups.includes('shortId'), `users 的唯一索引要含 shortId，实际：${groups.join(' / ')}`);
  assert.ok(groups.includes('openid'), 'openid 的唯一性不能被顶掉');
});

// ── 与用户资料接线 ─────────────────────────────────────────

test('第一个用户拿到 000001', async () => {
  const w = await makeWorld();
  const p = expectOk(await w.A('user.getProfile', {})).profile;
  assert.equal(p.shortId, '000001', `实际拿到 ${p.shortId}`);

  /** 真落库了，不是只在返回值里 */
  const stored = await w.repo.findOne(C.USERS, { openid: 'openid_A' });
  assert.equal(stored.shortId, '000001');
});

test('三个用户按顺序拿到 000001 / 000002 / 000003', async () => {
  const w = await makeWorld();
  const a = expectOk(await w.A('user.getProfile', {})).profile.shortId;
  const b = expectOk(await w.B('user.getProfile', {})).profile.shortId;
  const c = expectOk(await w.C('user.getProfile', {})).profile.shortId;

  assert.deepEqual([a, b, c], ['000001', '000002', '000003']);
});

test('**已有用户**（编号是后加的字段）会被补发，不用重新注册', async () => {
  const w = await makeWorld();
  /** 手工造一条"老记录"：有 openid、没 shortId */
  await w.repo.insert(C.USERS, { openid: 'openid_OLD', createdAt: new Date(), lastSeenAt: new Date() });

  const p = expectOk(await w.A('user.getProfile', {})).profile;
  assert.equal(p.shortId, '000001', '老记录没有编号，从 000001 发起');

  const stored = await w.repo.findOne(C.USERS, { openid: 'openid_A' });
  assert.equal(stored.shortId, '000001', '补发的号要落库');
});

test('补发时接着已有的最大值往后发，不重号', async () => {
  const w = await makeWorld();
  /** 造两条已有编号的记录（模拟更早的用户） */
  await w.repo.insert(C.USERS, { openid: 'openid_X', shortId: '000007', createdAt: new Date(), lastSeenAt: new Date() });
  await w.repo.insert(C.USERS, { openid: 'openid_Y', shortId: '000003', createdAt: new Date(), lastSeenAt: new Date() });

  const p = expectOk(await w.A('user.getProfile', {})).profile;
  assert.equal(p.shortId, '000008', '应当是 7 + 1');
});

test('同一个用户的编号**不会变** —— 变了等于发给同伴的号失效', async () => {
  const w = await makeWorld();
  const first = expectOk(await w.A('user.getProfile', {})).profile.shortId;
  const second = expectOk(await w.A('user.getProfile', {})).profile.shortId;
  const third = expectOk(await w.A('user.getProfile', {})).profile.shortId;

  assert.equal(second, first);
  assert.equal(third, first);
});

test('编号唯一：同一批用户里不会出现重号', async () => {
  const w = await makeWorld();
  const ids = [];
  for (const client of [w.A, w.B, w.C]) {
    /** eslint-disable-next-line no-await-in-loop */
    ids.push(expectOk(await client('user.getProfile', {})).profile.shortId);
  }
  assert.equal(new Set(ids).size, ids.length, `出现重号：${ids.join(' / ')}`);
});

test('并发补发时靠唯一索引兜底 —— 结果里不能有重号', async () => {
  /**
   * ⚠️ 这条模拟真实的并发：三个人**同时**读资料。
   * 内存实现会按 `UNIQUE_INDEXES` 拦重复写入，
   * 所以 `tryReserve` 会失败并重试 —— 最终三个号互不相同。
   */
  const w = await makeWorld();
  const results = await Promise.all([
    w.A('user.getProfile', {}),
    w.B('user.getProfile', {}),
    w.C('user.getProfile', {}),
  ]);

  const ids = results.map((r) => r.data.profile.shortId);
  assert.equal(ids.filter(Boolean).length, 3, `三个都该拿到号：${ids.join(' / ')}`);
  assert.equal(new Set(ids).size, 3, `并发下出现重号：${ids.join(' / ')}`);
});

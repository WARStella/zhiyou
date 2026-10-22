'use strict';

/**
 * 用户编号 —— 6 位**顺序**数字（000001、000002、……）。
 *
 * ── 需求怎么变的（2026-10-14）────────────────────────────
 *
 * 用户先问："就不能把用户id变短一点吗，比如6位数字这种"
 * 我担心碰撞，做成了 31 字符 × 6 位的**随机**编码，并说明理由。
 * 用户随后明确："编号按照数据库中编号生成六位序号"
 *
 * **顺序号确实更好**，而且它把碰撞问题从根上去掉了：
 * 随机号靠概率躲碰撞，顺序号靠**唯一索引 + 冲突重试**保证不重。
 * 用户比我更早看到这一点。
 *
 * ── 为什么顺序号不靠"计数器文档"（试过才知道）──────────────
 *
 * `repo` 只有 `updateIf` / `updateCas`，**没有原子自增**（`_.inc` 只用在
 * 内部版本号上）。用 CAS 自己造一个计数器是可行的，但要在业务层处理
 * "读-比对-写"的循环，而它和"用户表本身"的一致性还得再保证一层。
 *
 * 更简单也更难错的做法：**从已有编号里取最大值 + 1**，
 * 靠 `users.shortId` 的**唯一索引**挡住并发碰撞，撞了就重算。
 * 索引是数据库级的，比业务层的锁可靠。
 *
 * ── 代价，写清楚 ────────────────────────────────────────
 *
 * ① **能看出用户规模**：有人拿到 000042 就知道大约有 42 个用户。
 *    这个项目是课程作业/演示性质，这个信息不敏感；商业产品要慎用。
 * ② **可枚举**：顺序号容易被猜。所以——
 *    **编号绝不参与鉴权**，权限一律走 `openid` / `userId`。
 * ③ 上限 999999。真到那个规模本该换发号方案（分段/加位），
 *    这里**显式返回 null**，不静默发一个 7 位号。
 */

/** 编号长度（含前导零） */
const SHORT_ID_LENGTH = 6;

/** 顺序号上限 —— 超过就发不出来了 */
const MAX_SEQUENCE = 999999;

/**
 * 冲突重试上限。
 *
 * 顺序发号的碰撞只发生在**并发的那一瞬间**（两个人同时读到同一个最大值）。
 * 每次重试都会重新读最大值，所以第二次几乎必然成功。
 * 给 8 次是余量，不是估算。
 */
const MAX_ATTEMPTS = 8;

/** 把序号格式化成 6 位（补前导零） */
function formatSequence(n) {
  return String(n).padStart(SHORT_ID_LENGTH, '0');
}

/**
 * 形状校验：**6 位纯数字**。
 *
 * ⚠️ 只认数字，不认字母 —— 与"按数据库序号生成"这个决定一致。
 *    上一版是字母数字混排，改过来之后若还接受字母，
 *    会把历史值当成合法编号，而它们不符合"顺序"这个语义。
 */
function isShortId(v) {
  if (typeof v !== 'string') return false;
  if (!/^\d{6}$/.test(v)) return false;
  return Number(v) >= 1;
}

/** 解析成序号；不是合法编号时返回 null */
function parseShortId(v) {
  if (!isShortId(v)) return null;
  return Number(v);
}

/**
 * 从一组已有编号里算出下一个序号。
 *
 * ⚠️ 用**最大值 + 1** 而不是 `总数 + 1`：
 * 用户记录若被删除（`crew.remove`、清理测试数据），
 * 按总数算会**把已经发出去的号再发一次** —— 那就是重号。
 *
 * @param {string[]} existing 已有编号（允许含脏数据，会被忽略）
 * @returns {number} 下一个序号（1 起）
 */
function nextSequence(existing) {
  let max = 0;
  for (const v of existing || []) {
    const n = parseShortId(v);
    if (n !== null && n > max) max = n;
  }
  return max + 1;
}

/**
 * 分配一个未被占用的顺序编号。
 *
 * @param {object} p
 * @param {Function} p.listExisting `async () => string[]` —— 读出所有已有编号
 * @param {Function} [p.tryReserve] `async (shortId) => boolean` ——
 *        可选：抢占这个号（如写入并捕获唯一索引冲突）。返回 false 表示被占了。
 *        不传则只用 `listExisting` 的结果（单测用）。
 * @returns {Promise<string|null>} 用尽尝试时返回 null
 */
async function allocateShortId(p) {
  const listExisting = (p && p.listExisting) || (async () => []);
  const tryReserve = p && p.tryReserve;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    /** 每次都重新读 —— 冲突重试的意义就在这里 */
    /** eslint-disable-next-line no-await-in-loop */
    const existing = await listExisting();
    const seq = nextSequence(existing);

    /**
     * ⚠️ 超过上限时**返回 null，不静默发一个 7 位号**：
     * 长度变了会让所有按"6 位"写的校验与界面假设失效，
     * 那是个需要人做决定的时刻，不该由代码悄悄替你决定。
     */
    if (seq > MAX_SEQUENCE) return null;

    const candidate = formatSequence(seq);
    if (!tryReserve) return candidate;

    /** eslint-disable-next-line no-await-in-loop */
    const ok = await tryReserve(candidate);
    if (ok) return candidate;
    /** 被别人抢先了 —— 下一轮会读到更大的最大值 */
  }
  return null;
}

/**
 * 归一化用户输入。
 *
 * ⚠️ 纯数字编号**不该去掉中间的字符** —— 用户可能就是照着念的。
 * 只做去空白与全角转半角这类无损处理。
 */
function normalizeShortId(v) {
  return String(v == null ? '' : v)
    .trim()
    /** 全角数字 → 半角（中文输入法下很常见） */
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s-]/g, '');
}

module.exports = {
  SHORT_ID_LENGTH,
  MAX_SEQUENCE,
  MAX_ATTEMPTS,
  formatSequence,
  isShortId,
  parseShortId,
  nextSequence,
  allocateShortId,
  normalizeShortId,
};

'use strict';

/**
 * **运维与探针类 action 的准入守卫** —— 纯函数，判定与拒绝理由都在这里。
 *
 * ── 为什么必须要有它（2026-10-15）──────────────────────────
 *
 * 这些 action 原本只靠一句 `env === 'dev'` 把关，而**环境判定本身是宽松的**：
 *
 *     cloudfunctions/api/index.js:
 *     env = process.env.ZY_ENV || (环境名含 'prod' ? 'prod' : 'dev')
 *
 * 也就是说，**只要环境变量没配成 prod，任何人都能调**：
 *
 *   · `ops.initDb`            —— 建集合
 *   · `ops.exportWalkSamples` —— 导出步行样本（含地点名）
 *   · `place.survey`          —— **写入地点的核验等级**
 *   · `map.probe` / `ai.probe` / `photo.probe` / `matrix.probe` / `transit.probe`
 *   · `ops.selfTest` / `ops.verifyIndexes` / `ops.walkCacheCheck` / `ops.cleanupPlaceholderPlaces`
 *
 * 在只有开发者自己用的时候，这不构成问题。但**体验版一发给测试者**，
 * 这些入口就对所有体验成员开放了。其中两条特别要紧：
 *
 *   ① `place.survey` 写的是**核验等级** —— 而踏勘取消之后（计划书 v7.1 §1.3），
 *      "哪些地点算核验过"是**唯一剩下的可信度防线**；
 *   ② §11.3 的权限一类明确要求留「非成员访问被拒」的证据 ——
 *      连 ops 入口都不设防，这条证据拿不出来。
 *
 * ── 两条设计决定 ─────────────────────────────────────────
 *
 * **① 放在分发层，不放在每个 action 里。**
 *    逐条加校验迟早会漏（新加一个 ops action 就会裸露），
 *    而这里是一道**统一的闸门**：名单内的 action 一律先过守卫。
 *    有测试扫源码交叉核对，防止"名单漏了新 action"。
 *
 * **② 白名单没配 = 全部拒绝（fail closed），并把自己 openid 回给调用方。**
 *    "没配就当没限制"是最糟的默认值 —— 它会让守卫在真正需要它的那一刻
 *    （刚部署、还没配变量）恰好失效。而拒绝时必须能自举：
 *    错误信息里带回**调用者自己的 openid**，他复制到 `ZY_ADMIN_OPENIDS` 即可。
 *    openid 是调用者自己的标识，回给他不泄露任何别人的信息。
 */

const { CODES } = require('./errors');

/**
 * 需要管理员身份的 action —— **唯一名单**。
 *
 * 收录口径：**任何自身要求 `env === 'dev'` 的 action**，加上 `ops.` 前缀的全部。
 * `test/ops-guard.test.js` 会扫 `actions/*.js` 的源码交叉核对这份名单，
 * 漏掉一个就会红 —— 而不是等到线上被人调走。
 */
const ADMIN_ACTIONS = [
  // ops.* 前缀的全部（含未来新增的）
  'ops.',
  // 探针（名字以 actions/index.js 的注册表为准）
  'map.probe',
  'map.matrixProbe',
  'ai.probe',
  'photo.probe',
  'transit.probe',
  // 仅 dev 的写入类
  'place.survey',
  'place.fetchPhotos',
];

/** 环境变量名 —— 逗号分隔的 openid 白名单 */
const ADMIN_ENV = 'ZY_ADMIN_OPENIDS';

/** 解析白名单：支持逗号、分号、空白分隔；去空、去重 */
function parseAdminOpenids(raw) {
  if (raw == null) return [];
  return [
    ...new Set(
      String(raw)
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
}

/** 这个 action 是否属于受保护范围 */
function isAdminAction(action) {
  if (!action) return false;
  return ADMIN_ACTIONS.some((rule) => (rule.endsWith('.') ? action.startsWith(rule) : action === rule));
}

/**
 * 判定一次调用能不能进。
 *
 * @returns `{ allowed, code, message, details }` —— 拒绝时**必须**给出
 *          "怎么改"的可执行指引（本项目的既有规矩：失败要能自我修复）。
 */
function checkAdminAccess(input) {
  const o = input || {};
  const action = o.action;
  if (!isAdminAction(action)) return { allowed: true };

  /**
   * 环境判定**保留**为第一道闸门（纵深防御）：
   * 生产环境这些 action 一律不可用，与各 action 内部的断言一致。
   */
  if ((o.env || 'dev') !== 'dev') {
    return {
      allowed: false,
      code: CODES.FORBIDDEN_ENV,
      message: `当前环境为 ${o.env}，${action} 仅限 dev`,
      details: null,
    };
  }

  const list = Array.isArray(o.adminOpenids) ? o.adminOpenids : [];
  const openid = o.openid || '';

  if (!list.length) {
    return {
      allowed: false,
      code: CODES.FORBIDDEN_NOT_ADMIN,
      message:
        `${action} 需要管理员白名单，而环境变量 ${ADMIN_ENV} 尚未配置 —— ` +
        `未配置时**一律拒绝**（而不是放开）`,
      details: {
        yourOpenid: openid,
        hint:
          `云开发控制台 → 云函数 → api → 配置 → 环境变量 → 新增 ${ADMIN_ENV}，` +
          `值为你的 openid（多个用逗号分隔）。上面的 yourOpenid 就是可以填进去的值。`,
      },
    };
  }

  if (!list.includes(openid)) {
    return {
      allowed: false,
      code: CODES.FORBIDDEN_NOT_ADMIN,
      message: `${action} 仅限管理员调用`,
      details: {
        yourOpenid: openid,
        hint: `如需授权，把你的 openid 加进云函数环境变量 ${ADMIN_ENV}`,
      },
    };
  }

  return { allowed: true };
}

/** 从环境变量取白名单（入口用；测试可直接传数组，不必碰 process.env） */
function adminOpenidsFromEnv(env) {
  const src = env && typeof env === 'object' ? env : process.env;
  return parseAdminOpenids(src && src[ADMIN_ENV]);
}

module.exports = {
  ADMIN_ACTIONS,
  ADMIN_ENV,
  parseAdminOpenids,
  isAdminAction,
  checkAdminAccess,
  adminOpenidsFromEnv,
};

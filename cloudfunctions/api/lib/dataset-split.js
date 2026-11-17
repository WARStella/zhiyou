'use strict';

/**
 * **分组切分** —— 开发集／冻结集的划分工具。纯函数，不读文件、不联网。
 *
 * ── 为什么不能按"每条记录"切（2026-10-15 修正的真实缺陷）────────
 *
 * 原先 `walk-eval.js` 按每条样本的 `_id` 哈希切分。而**同一路线会被反复调用**：
 * 一次规划 5 段、十次规划就有十条同一路线的记录。按记录切分时，
 * 这些**近乎相同的样本会同时落进开发集与冻结集** ——
 *
 *   → 冻结集里"见过"的东西，模型在开发集里已经调过参数了；
 *   → 分数偏乐观，而且**看起来一切正常**。
 *
 * 同样的道理适用于 AI 样例：同一场景的**改写句**、同一段**多轮对话**，
 * 必须整体落在同一侧，否则等于"训练时见过近似答案"。
 *
 * ── 修法：先分组，再按**组**切 ─────────────────────────────
 *
 *   ① 每条记录算出一个 `groupId`（路线组 / 场景组）；
 *   ② 按 `hash(seed + groupId)` 决定整组去哪一侧；
 *   ③ 组内**不允许**跨侧 —— 有断言守着，且**分析函数会再验一次**。
 *
 * ── 三个"看起来等价、其实不同"的细节 ─────────────────────
 *
 * **① 反向是同一组。** A→B 与 B→A 走的是同一条路（距离几乎相同），
 *    所以组键把两端**排序**后再拼 —— 否则同一条路会被当成两条独立路线，
 *    切分时又漏掉一半的泄漏。
 *
 * **② 重复请求不是新样本。** 同一条路线调十次得到十条记录，
 *    它们**必须同组**（组键只由两端决定），并且统计时要能看出
 *    "独立路线 N 条、重复记录 M 条" —— 重复可以留作稳定性记录，
 *    但**不能当作新的独立样本**去抬高样本量（它不会提高信息量）。
 *
 * **③ 兜底键沿用 `lib/place-id.js`** 的三位小数粒度（约 100 米）。
 *    不另写一套"近似"规则 —— 两套规则必然漂移，这是本项目的旧伤。
 */

const { stablePlaceId } = require('./place-id');

/** 侧名 —— 只两个值，别处引用它，避免各处写裸字符串 */
const SIDE = { DEV: 'dev', FROZEN: 'frozen' };

/**
 * 稳定哈希（FNV-1a 32 位）。
 *
 * 用它而不是 `Math.random()` 或时间戳：**切分必须可复现**。
 * 换一次随机划分，"这一版比上一版好"里就混进了切分噪声，而没人看得出来。
 */
function hash32(str) {
  let h = 0x811c9dc5;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * 路线组键：**排序后的两端稳定键**。
 *
 * 传入的样本可以是：
 *   · 新格式：`{ routeGroupId }` —— 已经算好了就直接用（写入口算一次，读入口不再重算）；
 *   · 旧格式：`{ fromId, toId }` 或 `{ fromName, toName }` —— 这里现算，兼容历史数据。
 *
 * 返回 null 表示"算不出组"——调用方**必须显式处理**，不能当成空串塞进一个组里
 * （那会把所有算不出的样本合成一个巨大的组）。
 */
function routeGroupKey(sample) {
  if (!sample) return null;
  if (sample.routeGroupId) return sample.routeGroupId;

  const a = routeEndpointKey(sample, 'from');
  const b = routeEndpointKey(sample, 'to');
  if (!a || !b) return null;
  /** 排序 → A→B 与 B→A 同组 */
  return [a, b].sort().join('|');
}

/** 一端的稳定键：优先用样本里已有的 id，退回 `stablePlaceId` 的规则 */
function routeEndpointKey(sample, which) {
  const idField = which === 'from' ? 'fromId' : 'toId';
  if (sample[idField]) return String(sample[idField]);

  const nameField = which === 'from' ? 'fromName' : 'toName';
  const named = sample[nameField];
  return named ? `name_${String(named).trim()}` : null;
}

/**
 * 由两个端点对象算路线组键 —— **写入口用它**，与读入口 `routeGroupKey` 同一套规则。
 *
 * 端点是 `trip.plan` 里的 `leg.from` / `leg.to`（带 `_id`、`poiId`、`name`、`location`）。
 *
 * ⚠️ 优先级必须与读入口**逐字对齐**（`routeEndpointKey` 用的是 `fromId`）：
 * 样本里存的 `fromId` 就是 `leg.from._id`，所以这里也是 `_id` 优先。
 * 若这里改用 `stablePlaceId` 直接算，无 `poiId` 的地点会走"名字 + 三位小数"那条路，
 * 得到**与读入口不同的键** —— 那等于又造了第三套规则。
 */
function routeEndpointKeyOfEndpoint(p) {
  if (!p) return null;
  if (p._id) return String(p._id);
  if (p.fromId) return String(p.fromId); // 已经是伪样本形状时也能用
  return stablePlaceId(p);
}

function routeGroupKeyOfEndpoints(from, to) {
  const a = routeEndpointKeyOfEndpoint(from);
  const b = routeEndpointKeyOfEndpoint(to);
  if (!a || !b) return null;
  return [a, b].sort().join('|');
}

/** AI 样例的组键：同一场景的改写句与多轮对话共用一个 `scenarioGroupId` */
function intentGroupKey(item) {
  if (!item) return null;
  return item.scenarioGroupId || item.caseId || null;
}

/**
 * 按组切分。
 *
 * @param {Array} items 记录
 * @param {Object} opts `{ ratio, seed, keyFn }`；`keyFn` 默认按"路线组"算
 * @returns `{ dev, frozen, groups, ungrouped, stats }`
 *
 * ⚠️ **算不出组键的记录进 `ungrouped`，不进任何一侧。**
 * 把它们随便塞进某一侧，等于让一个"身份不明"的东西参与评分；
 * 这一步宁可少样本，也要说清楚少了多少。
 */
function splitByGroup(items, opts) {
  const o = opts || {};
  const ratio = typeof o.ratio === 'number' ? o.ratio : 0.3;
  const seed = o.seed == null ? 'zy-split-2026' : o.seed;
  const keyFn = typeof o.keyFn === 'function' ? o.keyFn : routeGroupKey;

  const list = Array.isArray(items) ? items : [];
  const bucketOfGroup = new Map(); // groupId -> SIDE
  const groups = new Map(); // groupId -> { groupId, side, items: n }
  const dev = [];
  const frozen = [];
  const ungrouped = [];

  for (const it of list) {
    const gid = keyFn(it);
    if (!gid) {
      ungrouped.push(it);
      continue;
    }
    if (!bucketOfGroup.has(gid)) {
      const side =
        hash32(`${seed}|${gid}`) % 1000 < Math.round(ratio * 1000) ? SIDE.FROZEN : SIDE.DEV;
      bucketOfGroup.set(gid, side);
      groups.set(gid, { groupId: gid, side, items: 0 });
    }
    const side = bucketOfGroup.get(gid);
    groups.get(gid).items++;
    (side === SIDE.FROZEN ? frozen : dev).push(it);
  }

  const groupList = [...groups.values()].sort((a, b) => (a.groupId < b.groupId ? -1 : 1));
  const devGroups = groupList.filter((g) => g.side === SIDE.DEV).length;
  const frozenGroups = groupList.filter((g) => g.side === SIDE.FROZEN).length;

  return {
    dev,
    frozen,
    ungrouped,
    groups: groupList,
    ratio,
    seed,
    stats: {
      total: list.length,
      /**
       * ⚠️ 字段名刻意写全 `...Records` / `...Groups`。
       *
       * 初版叫 `dev` / `frozen`（记录数）与 `devGroups` / `frozenGroups`（组数），
       * 而 `split.dev` 又是**数组** —— 同一个词在同一个返回值里表示三样东西，
       * 读的人必然弄错（写完当天就被自己的测试抓到一次）。
       * **名字要让人没法误解，而不是让人小心。**
       */
      devRecords: dev.length,
      frozenRecords: frozen.length,
      ungrouped: ungrouped.length,
      devGroups,
      frozenGroups,
      totalGroups: groupList.length,
      /** 组内多于一条 → 说明这批数据里有"改写句/重复请求"，切分必须按组才有意义 */
      multiItemGroups: groupList.filter((g) => g.items > 1).length,
      maxGroupSize: groupList.reduce((m, g) => Math.max(m, g.items), 0),
    },
  };
}

/**
 * 组完整性断言 —— **在出分数之前再验一次**。
 *
 * 为什么要有它：泄漏不会报错，只会让分数变好。
 * 所以不能只依赖"切分函数写对了"，还要有一个**独立的检查**
 * （用另一条路径读同一批数据，确认没有组跨侧）。
 *
 * @returns `{ ok, violations[] }`；`violations` 里每一项是一个跨侧的组
 */
function assertGroupIntegrity(sides, keyFn) {
  const fn = typeof keyFn === 'function' ? keyFn : routeGroupKey;
  const seen = new Map();
  const violations = [];
  for (const [side, items] of Object.entries(sides || {})) {
    for (const it of items || []) {
      const gid = fn(it);
      if (!gid) continue;
      if (seen.has(gid) && seen.get(gid) !== side) {
        violations.push({ groupId: gid, sides: [seen.get(gid), side] });
      } else {
        seen.set(gid, side);
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * 按组统计覆盖度 —— **独立路线数与记录数要分开报**。
 *
 * "重复请求可以留作稳定性记录，但不能当作新的独立路线"：
 * 300 条记录只覆盖 12 条路线时，样本量的真实含义是 12，不是 300。
 */
function coverageByGroup(items, opts) {
  const o = opts || {};
  const keyFn = typeof o.keyFn === 'function' ? o.keyFn : routeGroupKey;
  const list = Array.isArray(items) ? items : [];
  const groups = new Map();
  let ungrouped = 0;
  for (const it of list) {
    const gid = keyFn(it);
    if (!gid) {
      ungrouped++;
      continue;
    }
    groups.set(gid, (groups.get(gid) || 0) + 1);
  }
  const sizes = [...groups.values()];
  return {
    records: list.length,
    distinctGroups: groups.size,
    ungrouped,
    repeatedRecords: sizes.reduce((n, x) => n + (x - 1), 0),
    maxRepeats: sizes.length ? Math.max(...sizes) : 0,
  };
}

module.exports = {
  SIDE,
  hash32,
  routeGroupKey,
  routeEndpointKey,
  routeEndpointKeyOfEndpoint,
  routeGroupKeyOfEndpoints,
  intentGroupKey,
  splitByGroup,
  assertGroupIntegrity,
  coverageByGroup,
};

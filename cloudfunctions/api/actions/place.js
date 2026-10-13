'use strict';

const resp = require('../lib/resp');
const { CODES, require_fields, fail } = require('../lib/errors');
const { placeEligibility, canBeMeetingPoint } = require('../lib/authz');
const { createMapProvider } = require('../lib/map');
const { haversineMeters } = require('../lib/geo');
const { isVisitableCategory, isVisitablePlace, LODGING_NAME_RE } = require('../lib/ai/rulebased');
const { logEvent } = require('../lib/trace');
const C = require('../lib/repo/collections');

/**
 * 地点查询与检索。
 *
 * **准入按用途分两级**（2026-10-13 修正，见 lib/authz.js）：
 *   · `tripNodeAllowed`    —— 有名称与坐标即可，外部检索回来的 POI 也能用；
 *   · `meetingPointAllowed`—— 还要求实地核验（§7.1 可达性、辨识度、停留条件）。
 *
 * 界面拿这两个字段判断"这个地点能做什么"，而不是一个含糊的 `usable`。
 */

/** 哈尔滨市中心，检索兜底中心点（种子数据所在区域） */
const DEFAULT_CENTER = { latitude: 45.7756, longitude: 126.6175 };

/**
 * 默认检索城市 —— 本项目**单城**（哈尔滨）。多城时改为从参数或地点库推断。
 *
 * ⚠️ 这个常量的存在是因为踩过一个坑（2026-10-13）：
 * 用户说「我想去冰雪大世界」，而真正的冰雪大世界在松北区、离他十几公里，
 * 被 `nearby(center, 5000)` 的半径**排除在外** ——
 * 于是系统在附近找了个同名的「穿越冰雪大世界(哈尔滨印象城C座店)」（一个 VR 游戏店）。
 *
 * **"找那个地方"和"找附近的地方"是两种检索**，不能用同一个半径糊过去。
 */
const DEFAULT_REGION = '哈尔滨';

/**
 * 外部检索回来的地点默认停留时长。
 *
 * ⚠️ **这是估值，不是踏勘结论**。规划器需要它才能算时间线，但任何基于它的
 * 时间安排都必须让用户看得见"这个时长还没核验过"。
 * 踏勘后由 C 用实测值覆盖，并去掉 `visitDurationSource: 'default-untuned'`。
 */
const DEFAULT_VISIT_DURATION = { min: 15, default: 45, max: 90 };

// ─────────────────────────────────────────────────────────
// 查询
// ─────────────────────────────────────────────────────────

async function list(ctx) {
  const { repo } = ctx;
  const p = ctx.payload || {};

  const rows = await repo.find(
    C.PLACES,
    p.category ? { category: p.category } : {},
    { limit: 100 }
  );

  // verifiedOnly 现在明确指"可作集合点"，避免语义漂移
  const filtered = p.verifiedOnly ? rows.filter((pl) => canBeMeetingPoint(pl)) : rows;

  const places = filtered.map((pl) => {
    const elig = placeEligibility(pl);
    return {
      placeId: pl._id,
      name: pl.name,
      category: pl.category,
      location: pl.location,
      entranceLocation: pl.entranceLocation || null,
      visitDurationMin: pl.visitDurationMin,
      // ── 准入（按用途分级，不要再用单一 usable）──
      tripNodeAllowed: elig.tripNode,
      meetingPointAllowed: elig.meetingPoint,
      // ── 可信度标注：未核验必须让界面看得见，不能假装可信 ──
      verified: elig.verified,
      verifiedAt: pl.verifiedAt || null,
      confidence: elig.confidence,
      dataSource: elig.dataSource,
      tags: pl.tags || [],
    };
  });

  return resp.ok({
    places,
    total: places.length,
    /** 便于界面直接给出统计，而不用自己遍历 */
    counts: {
      tripNodeAllowed: places.filter((x) => x.tripNodeAllowed).length,
      meetingPointAllowed: places.filter((x) => x.meetingPointAllowed).length,
    },
  });
}

async function detail(ctx) {
  const { repo } = ctx;
  require_fields(ctx.payload, ['placeId']);

  const place = await repo.get(C.PLACES, ctx.payload.placeId);
  if (!place) throw fail(CODES.NOT_FOUND, '地点不存在');

  const elig = placeEligibility(place);

  return resp.ok({
    place,
    eligibility: elig,
    // 兼容旧字段名
    usable: elig.meetingPoint,
    // 踏勘实测的步行时间，规划器会优先使用它而非直线估算
    walkableTo: place.walkableTo || [],
  });
}

/**
 * 按需求**自动预选**地点。
 *
 * ── 这一步是"AI 生成路线"与"AI 帮你搜"的分界 ──────────────
 * 只搜不选，用户仍要一个个勾；预选之后他可以直接生成、再微调。
 *
 * 规则都可解释，不神秘：
 *   ① 命中「必去」的地点**一定选上**，且不被数量上限约束；
 *   ② 其余按检索相关性顺序取，**跳过不可游览的类目**（地铁站、公交站…）——
 *      谁也不想被系统自动安排去一个公交站；
 *   ③ 数量由**节奏**决定：轻松 3、正常 4、紧凑 5 ——
 *      说了"少走点路"的人不该被塞五个景点。
 *
 * 放在服务端（而不是小程序里）的理由：**这里是业务规则，必须能被测试**。
 * 小程序端没有测试环境，规则写在那里等于没测过。
 */
const PACE_LIMITS = { relaxed: 3, normal: 4, packed: 5 };

/**
 * 以 `kw` 命名、但**不是 `kw` 本身**的地方。
 *
 * 「哈工大**科技园**」「XX**校区**」「XX**分店**」—— 它们是**借这个名字**的地方，
 * 不是用户说的那个地方。
 */
const SUB_ENTITY_SUFFIX_RE =
  /^(科技园|产业园|工业园区|校区|分校区|分校|店|分店|门店|专柜|园区|大厦|写字楼|商务中心|购物中心|广场店|停车场|公寓|小区|门|口|站)/;

/**
 * 在候选里找与 `kw` **最接近的那一个**。
 *
 * ⚠️ 为什么需要它（2026-10-13 第四次踩到"名字包含即相等"）：
 * 用户说「冰雪大世界」，而候选里有 10 条名字含这五个字的 POI ——
 * 冰雪大世界本身、梦幻冰雪馆、VR 游戏店、民宿、宾馆、公寓、摩天轮…
 * 旧的"含这几个字就全选"把十条全排进了行程。
 *
 * **用户说的"冰雪大世界"是一个地方，不是十个。**
 *
 * 排序依据（都可解释，从强到弱）：
 *   ⓪ 名字**恰好等于**关键词 —— 就是它；
 *   ① 名字含关键词，且**不是**"关键词 + 后缀"形态 —— 大概率是它；
 *   ② **上游认定该词匹配**（`foundBy`），但名字对不上 ——
 *      上游做了模糊/简称匹配，比我们自己的字符串规则更懂；
 *   ③ 名字是"关键词 + 后缀"形态（「哈工大**科技园**」）——
 *      它是**借这个名字**的地方，排最后；
 *
 * ②在③之前是关键：「哈工大」的候选里有「哈工大科技园」（③），
 * 而上游搜「哈工大」也会返回「哈尔滨工业大学」（②）——
 * **简称与全称对不上字符串，但上游认得**，那就听上游的。
 */
function bestMatch(candidates, kw, seen) {
  const pool = (candidates || []).filter(
    (c) => c.placeId && !seen.has(c.placeId) && c.visitable !== false && c.name
  );
  if (!pool.length) return null;

  const score = (c) => {
    if (c.name === kw) return 0;
    const named = c.name.indexOf(kw) >= 0;
    const isExtension =
      c.name.indexOf(kw) === 0 && c.name.length > kw.length &&
      SUB_ENTITY_SUFFIX_RE.test(c.name.slice(kw.length));
    if (named && !isExtension) return 1;
    const fuzzed = (c.foundBy || []).indexOf(kw) >= 0;
    if (!named && fuzzed) return 2;
    if (named && isExtension) return 3;
    return 4;
  };

  const hits = pool.filter((c) => score(c) < 4);
  if (!hits.length) return null;

  return hits.slice().sort((a, b) => score(a) - score(b) || a.name.length - b.name.length)[0];
}

function autoPick(candidates, req) {
  req = req || {};
  const pace = PACE_LIMITS[req.pace] ? req.pace : 'normal';
  const limit = PACE_LIMITS[pace];
  const mustTexts = Array.isArray(req.mustVisitTexts) ? req.mustVisitTexts : [];
  /**
   * 调用方用到的检索词。**每个词至少选一个** ——
   * 用户说了「先去哈工大…再去冰雪大世界」，行程里就该有两个地方。
   * 只靠"相关性前几名"，第一个词会把名额占满，第二个词永远选不上。
   */
  const keywords = Array.isArray(req.keywords) ? req.keywords.filter(Boolean) : [];

  const picked = [];
  const seen = new Set();
  const take = (c, reason) => {
    picked.push({ placeId: c.placeId, name: c.name, reason });
    seen.add(c.placeId);
  };
  /**
   * 用户"点名"的地方 = 检索词。
   *
   * ⚠️ **不能再把 `mustVisitTexts` 也并进来**（2026-10-13 修正）。
   *
   * 它们是**同一句话的两份表示**：
   *
   *     searchKeywords  = ["哈工大", "冰雪大世界", "哈学院"]        ← 用户原话
   *     mustVisitTexts  = ["哈尔滨工业大学", "哈尔滨冰雪大世界", …]  ← 解析层规范化后的
   *
   * 合并之后「哈工大」和「哈尔滨工业大学」成了两个独立条目，
   * 各自选了一个地方 —— 用户说**三个**地方，出来**四个**：
   *
   *     哈工大        → 哈工大科技园
   *     哈尔滨工业大学 → 哈尔滨工业大学     ← 同一个地方，选了两次
   *
   * **用两份数据做同一件事，必然重复。**
   *
   * 检索词已经涵盖了必去项（规则解析器就是从必去项生成检索词的，
   * 提示词也要求模型把点名的地方都放进 searchKeywords）。
   * 没有检索词时才退回必去项。
   */
  const named = keywords.length ? keywords : mustTexts;

  /**
   * 「在某个区域逛」还是「去某几个具体地方」—— **这决定了要不要替他补地点**。
   *
   * ⚠️ 实测（2026-10-13）：用户说「先去哈工大玩一小时再去冰雪大世界玩3小时」，
   * 他已经把行程排好了（1 小时 + 3 小时），系统却还按"节奏"补地点，
   * 一路补到 10 个。
   *
   * 判据（两条，都可解释）：
   *   · **点了两个以上地方** → 他给的是行程单（"先去 A 再去 B"）→ 只选他说的；
   *   · **只点了一个、或说了"附近"** → 他心里只有一个目标或一片区域，
   *     系统按节奏补足是帮忙；
   *   · **什么都没认出来** → 更该按节奏给一份起点。
   *
   * 多塞一个地方都是替用户做决定 —— 而他已经说得很具体了。
   */
  const areaMode = Boolean(req.anchorText) || named.length <= 1;

  /**
   * ⓪ **每个"点名提到的地方"各取一个最佳匹配。**
   *
   * ⚠️ 两次真实事故都在这一步（2026-10-13）：
   *   ① 检索只发了「哈工大」一个词，候选里根本没有冰雪大世界
   *      → 改成多关键词检索；
   *   ② 必去判据是"名字里含这几个字"且**不设数量上限** ——
   *      候选里 10 条名字带「冰雪大世界」的全被选了进来：
   *
   *          哈尔滨冰雪大世界 ✓   ← 用户要的
   *          哈尔滨冰雪大世界梦幻冰雪馆
   *          穿越冰雪大世界(哈尔滨印象城C座店)   ← VR 游戏店
   *          冰雪大世界民宿                     ← 住宿
   *          哈尔滨欣怡宾馆(冰雪大世界凯利广场店)  ← 住宿
   *          漫步云端公寓(哈尔滨大世界世茂大道地铁站) ← 公寓
   *          …
   *
   * **用户说的"冰雪大世界"是一个地方，不是十个。**
   * 所以每个名字**只取一个最接近的**（见 bestMatch）。
   */
  for (const kw of named) {
    const best = bestMatch(candidates, kw, seen);
    if (best) take(best, mustTexts.indexOf(kw) >= 0 ? '必去' : `你提到的「${kw}」`);
  }

  /**
   * ① 区域漫游时才按节奏补足。点名模式到此为止。
   *
   * 名额上限要**为"点名的地方"留出空间** —— 否则它们会把名额挤掉，
   * 用户明说要去的地方反而选不上。
   */
  const quota = areaMode ? Math.max(limit, named.length) : named.length;
  for (const c of candidates) {
    if (picked.length >= quota) break;
    if (!c.placeId || seen.has(c.placeId)) continue;
    if (c.visitable === false) continue;
    take(c, pace === 'relaxed' ? '按「少走路」少选几个' : '相关性靠前');
  }

  return {
    placeIds: picked.map((x) => x.placeId),
    items: picked,
    limit,
    pace,
    /** 覆盖情况如实回传 —— 哪个检索词没选上，界面要说出来 */
    keywordsCovered: keywords.filter((kw) =>
      picked.some((x) => x.name && x.name.indexOf(kw) >= 0)
    ),
    keywordsMissing: keywords.filter(
      (kw) => !picked.some((x) => x.name && x.name.indexOf(kw) >= 0)
    ),
    note: picked.length
      ? `按「${pace === 'relaxed' ? '轻松' : pace === 'packed' ? '紧凑' : '正常'}」节奏预选 ` +
        `${picked.length} 个地点：` +
        picked.map((x) => `${x.name}（${x.reason}）`).join('、')
      : '按当前需求没找到合适的地点，请换个说法或直接搜索',
  };
}

// ─────────────────────────────────────────────────────────
// 检索（外部 POI → 候选池 → 入库）
// ─────────────────────────────────────────────────────────

/** 把上游条目转成 places 集合的文档。**一律未核验**，只能作行程节点。 */
function toPlaceDoc(item, now) {
  return {
    name: item.title,
    category: item.category || '未分类',
    location: item.location,
    entranceLocation: null,
    visitDurationMin: Object.assign({}, DEFAULT_VISIT_DURATION),
    /** 标出来源与"时长未校准"，让界面和评测都能分辨 */
    visitDurationSource: 'default-untuned',
    walkableTo: [],
    address: item.address || null,
    dataSource: 'tencent-poi',
    poiId: item.poiId,
    /** 未核验：可安排进游览顺序，不能作集合点 */
    verifiedAt: null,
    verifiedBy: null,
    confidence: 'low',
    tags: [],
    notes: null,
    createdAt: now,
    updatedAt: now,
  };
}

function rankByDistance(rows, center, basis, verifiedIds) {
  const withMetrics = rows.map((r) => {
    const straight =
      center && r.location ? Math.round(haversineMeters(center, r.location)) : null;
    return Object.assign({}, r, {
      straightLineMeters: straight,
      verified: verifiedIds.has(r.placeId),
    });
  });

  const dist = (x) => (x.straightLineMeters == null ? Number.MAX_SAFE_INTEGER : x.straightLineMeters);

  if (basis === 'verified') {
    // 已核验优先，其次按距离 —— "优先推荐我们核验过的地方"
    withMetrics.sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0) || dist(a) - dist(b));
  } else {
    withMetrics.sort((a, b) => dist(a) - dist(b));
  }
  return withMetrics;
}

/**
 * 地点检索：外部 POI 作为候选池。
 *
 * 流程：调上游检索 → 按 poiId 去重入库 → 排序 → 返回候选。
 * 入库的地点一律 `verifiedAt: null` —— **可用，但如实标注未核验**。
 */
async function search(ctx) {
  const { repo, openid, env } = ctx;
  const p = ctx.payload || {};
  const now = new Date(ctx.now ? ctx.now : Date.now());
  const started = Date.now();

  const keyword = (p.keyword || '').trim();
  /**
   * 检索中心的三级取值：
   *   ① 调用方给的 center（前端应传用户当前位置）
   *   ② 给了 region 就用城市范围，不需要中心
   *   ③ 都没给 → 退回**默认中心**（哈尔滨市中心，种子数据所在区域）
   *
   * 第 ③ 条是为本项目"单城"的定位服务的。但它必须**回传**（`centerUsed`），
   * 否则调用方会以为结果来自自己指定的位置。
   */
  const centerUsed = p.center || (p.region ? null : DEFAULT_CENTER);
  const center = centerUsed;

  const provider = (ctx.createMapProvider || createMapProvider)(p.provider || process.env.MAP_PROVIDER, {
    // 覆盖 Key 仅用于开发期自测（与 map.probe 同一约定），正式环境不可用
    key: env === 'dev' ? p.overrideKey : undefined,
    timeoutMs: p.timeoutMs,
  });
  /**
   * ── 检索范围：**默认全城**，不是"我附近" ──────────────────
   *
   * ⚠️ 2026-10-13 修正。首版一律用 `nearby(用户位置, 5000)`，后果是：
   * 用户说「我想去冰雪大世界」，而真正的冰雪大世界在松北区、离他十几公里，
   * **被半径排除在外** —— 系统于是在附近找了家同名的 VR 游戏店
   * 「穿越冰雪大世界(哈尔滨印象城C座店)」推荐给他。
   *
   * **"找那个地方"（相关性）与"找附近的地方"（距离）是两种检索。**
   * 用户指名道姓说要去哪时，半径只会帮倒忙。需要"附近的"时显式传 `scope: 'nearby'`。
   *
   * 距离仍然照常计算并返回，只是不再拿它当筛选条件。
   */
  const scope = p.scope === 'nearby' ? 'nearby' : 'city';
  const useNearby = scope === 'nearby' && Boolean(center);

  /**
   * ── 多关键词检索 ─────────────────────────────────────────
   *
   * ⚠️ **实测踩到的坑（2026-10-13）**：用户说
   * 「先去哈工大玩一小时再去冰雪大世界玩3小时」，
   * 而 `searchKeyword` 是**单个字符串** —— 于是只搜了「哈工大」：
   * 冰雪大世界根本没进候选，用户看到的全是哈工大的各种门。
   *
   * **用户说了几个地方，就要搜几次。**
   *
   * 兼容：仍接受 `keyword`（单数）；`keywords` 给定时以它为准。
   * 上限 5 个 —— 一条需求里提到的地方不会太多，也防滥用。
   */
  const provided = (Array.isArray(p.keywords) && p.keywords.length ? p.keywords : [keyword])
    .map((k) => String(k == null ? '' : k).trim())
    .filter(Boolean)
    .slice(0, 5);

  /**
   * ⚠️ 空关键词是**合法**的：它表示"不带关键词，把范围内的都列出来"，
   * 排序与预选的测试就是靠它构造场景的。
   * 这里**不越权拦截** —— 真的搜不到东西由上游如实报错。
   */
  const keywordList = provided.length ? provided : [''];

  const perKeyword = [];
  let mapApiCalls = 0;
  for (const kw of keywordList) {
    // eslint-disable-next-line no-await-in-loop
    const up = await provider.searchPlaces({
      keyword: kw,
      center: useNearby ? center : undefined,
      radius: p.radius,
      region: useNearby ? undefined : p.region || DEFAULT_REGION,
      pageSize: p.pageSize,
    });
    mapApiCalls++;
    perKeyword.push({ keyword: kw, upstream: up });
  }

  /** 部分关键词失败不算整体失败 —— 但要如实标注，不能让用户以为搜全了 */
  const okOnes = perKeyword.filter((x) => x.upstream.ok);
  const failedKeywords = perKeyword
    .filter((x) => !x.upstream.ok)
    .map((x) => ({ keyword: x.keyword, reason: x.upstream.reason, message: x.upstream.message }));

  if (!okOnes.length) {
    const first = perKeyword[0].upstream;
    await logEvent(repo, {
      ts: now,
      type: 'upstream_call',
      action: 'place.search',
      userId: openid,
      result: 'error',
      errCode: first.reason || 'UPSTREAM_FAILED',
      durationMs: Date.now() - started,
      mapApiCalls,
      detail: { keywords: keywordList, status: first.status || null },
    });
    return resp.ok({
      ok: false,
      reason: first.reason,
      status: first.status || null,
      message: first.message,
      hint: first.hint || null,
      upstream: {
        parsedVia: first.parsedVia || null,
        rawHead: first.rawHead || null,
        timingMs: first.timingMs || null,
      },
      candidates: [],
      mapApiCalls,
    });
  }

  /**
   * ── 轮转合并 ─────────────────────────────────────────────
   *
   * **不能按关键词顺序拼接**（先搜完哈工大再搜冰雪大世界）——
   * 那样第一名的关键词会把整个列表占满，第二个地方永远排在后面，
   * 正是用户看到"全是哈工大的各种门"的原因。
   *
   * 轮转取：各关键词的第 1 名、各关键词的第 2 名、……
   * 这样"每个提到的地方"都能出现在靠前的位置。
   */
  const items = [];
  const seenPoi = new Set();
  const maxLen = Math.max(...okOnes.map((x) => x.upstream.items.length));
  for (let rank = 0; rank < maxLen; rank++) {
    for (const { keyword: kw, upstream: up } of okOnes) {
      const item = up.items[rank];
      if (!item) continue;
      // 同一个 POI 可能被多个关键词命中 —— 只保留一次，并记下所有来源
      const key = item.poiId || `${item.title}|${item.location && item.location.latitude}`;
      if (seenPoi.has(key)) {
        const prev = items.find(
          (x) => (x.poiId || `${x.title}|${x.location && x.location.latitude}`) === key
        );
        if (prev && prev.foundBy.indexOf(kw) < 0) prev.foundBy.push(kw);
        continue;
      }
      seenPoi.add(key);
      items.push(Object.assign({}, item, { foundBy: [kw] }));
    }
  }

  const upstream = Object.assign({}, okOnes[0].upstream, { items });

  // ── 去重：以 poiId 为键。集合规模在项目量级内，直接全量取回建映射，
  //    避免依赖不确定的查询操作符（这是今天反复踩过的坑）。
  const existing = await repo.find(C.PLACES, {}, { limit: 500 });
  const byPoiId = new Map();
  const verifiedIds = new Set();
  for (const pl of existing) {
    if (pl.poiId) byPoiId.set(pl.poiId, pl);
    if (pl.verifiedAt && pl.confidence !== 'low') verifiedIds.add(pl._id);
  }

  const save = p.save !== false;
  let created = 0;
  let reused = 0;
  const rows = [];

  for (const item of upstream.items) {
    if (!item.title || !item.location) continue; // 缺名称或坐标的条目直接丢弃

    let place = item.poiId ? byPoiId.get(item.poiId) : null;
    if (place) {
      reused++;
    } else if (save) {
      const doc = toPlaceDoc(item, now);
      const saved = await repo.insert(C.PLACES, doc);
      place = saved || Object.assign({ _id: doc._id }, doc);
      created++;
      if (item.poiId) byPoiId.set(item.poiId, place);
    } else {
      // 不入库：仍返回候选，但没有 placeId，界面要据此禁用"加入行程"
      rows.push({
        placeId: null,
        poiId: item.poiId,
        name: item.title,
        category: item.category,
        address: item.address,
        location: item.location,
        saved: false,
        /** 这个候选是被哪个检索词找到的 —— 多关键词时要能说清 */
        foundBy: item.foundBy || [],
      });
      continue;
    }

    rows.push({
      placeId: place._id,
      poiId: item.poiId,
      name: place.name,
      foundBy: item.foundBy || [],
      category: place.category,
      address: place.address || item.address || null,
      location: place.location,
      visitDurationMin: place.visitDurationMin,
      visitDurationSource: place.visitDurationSource || null,
      verified: Boolean(place.verifiedAt) && place.confidence !== 'low',
      dataSource: place.dataSource,
      saved: true,
    });
  }

  /**
   * ── 排序 ──
   *
   * ⚠️ 默认是 **`relevance`（保留上游的相关性排序）**，这是 2026-10-13 修正的。
   *
   * 首版默认按"到检索中心的直线距离"重排，**把上游的相关性排序整个冲掉了**。
   * 实测后果：搜「冰雪大世界」时，结果前列全是附近的地铁站
   * （哈尔滨站[地铁站]、尚志大街[地铁站]…）—— 因为它们离用户更近，
   * 而真正的冰雪大世界反而被挤到后面。
   *
   * 搜索的第一诉求是"**找到我要的那个地方**"，那是相关性；
   * 距离是第二诉求（"顺便看看近的"），不该抢第一的位置。
   *
   * 距离仍然照常计算并随结果返回 —— 只是不再拿它当默认排序依据。
   */
  const basis =
    p.rankBy === 'distance' ? 'distance' : p.rankBy === 'verified' ? 'verified' : 'relevance';

  let ranked;
  if (basis === 'relevance') {
    // `rows` 是按上游返回顺序推入的，所以下标就是上游的相关性名次
    const withIdx = rows.map((r, i) => {
      const straight =
        center && r.location ? Math.round(haversineMeters(center, r.location)) : null;
      return Object.assign({}, r, {
        upstreamIndex: i,
        straightLineMeters: straight,
        verified: verifiedIds.has(r.placeId),
        /**
         * 能不能作为**游览地点**。
         *
         * ⚠️ 实测踩到的坑（三次，都是同一类）：
         *   · 搜「冰雪大世界」，上游把「冰雪大世界[公交站]」排在前面
         *     （类目 `基础设施;交通设施:公交车站`）；
         *   · 真实类目是「公交车站」而不是「公交站」，正则漏掉了；
         *   · 搜出来还混着「冰雪大世界民宿」「哈尔滨欣怡宾馆(…)」
         *     「漫步云端公寓(…地铁站)」—— **住的地方不是玩的地方**。
         *
         * 住宿类的类目常常笼统到查不出来，所以**类目与名字都要查**
         * （见 rulebased.isVisitablePlace）。
         *
         * 这里**不硬过滤**（用户也可能真的在找某个交通设施或住处），
         * 而是把不可游览的**稳定地排到后面**，并打上标记让界面能说明。
         */
        visitable: isVisitablePlace(r.name, r.category),
        /** 为什么不可游览 —— 界面要能说清，而不是让用户猜 */
        notVisitableReason: (() => {
          if (!isVisitableCategory(r.category)) return '交通/公共设施';
          if (LODGING_NAME_RE.test(String(r.name || ''))) return '住宿场所';
          return null;
        })(),
      });
    });

    // 稳定分区：可游览的在前，各自保持上游的相对顺序
    ranked = withIdx
      .filter((x) => x.visitable)
      .concat(withIdx.filter((x) => !x.visitable));
  } else {
    ranked = rankByDistance(rows, center, basis, verifiedIds);
  }

  /**
   * 可选：用**真实步行时间**精排前 K 个。
   *
   * 直线距离在短距离下完全不可靠（实测：直线 10 米 → 实际步行 76 米，见工作日志），
   * 所以"哪些地方现在去最方便"这个问题，只有真实路线能回答。
   * 但每次检索会多消耗 K 次地图配额，因此**默认关闭**，由调用方显式开启。
   */
  let enriched = 0;
  if (p.enrichWalk && center) {
    const topK = Math.min(p.enrichWalkTop || 5, ranked.length);
    for (let i = 0; i < topK; i++) {
      const r = ranked[i];
      if (!r.location) continue;
      const route = await provider.walkingRoute(center, r.location);
      mapApiCalls++;
      enriched++;
      r.walkMinutes = route.ok ? route.durationMinutes : null;
      r.walkMeters = route.ok ? route.distanceMeters : null;
      r.walkSource = route.ok ? 'upstream' : 'unavailable';
      if (!route.ok) r.walkError = route.message || route.reason;
    }
    // 拿到真实时间的排前面，按时间升序；拿不到的保持原有相对顺序排在后面
    const okOnes = ranked.filter((x) => typeof x.walkMinutes === 'number');
    const rest = ranked.filter((x) => typeof x.walkMinutes !== 'number');
    okOnes.sort((a, b) => a.walkMinutes - b.walkMinutes);
    ranked = okOnes.concat(rest);
  }

  const limit = Math.min(Math.max(p.limit || 20, 1), 50);
  const candidates = ranked.slice(0, limit);

  /**
   * 自动预选：调用方（行程页的"理解"入口）给出节奏与必去，
   * 这里返回"该选哪些、为什么"。规则在服务端，所以能被测试。
   */
  const picked = p.autoPick ? autoPick(candidates, p.autoPick) : null;

  await logEvent(repo, {
    ts: now,
    type: 'upstream_call',
    action: 'place.search',
    userId: openid,
    result: 'ok',
    durationMs: Date.now() - started,
    mapApiCalls,
    detail: { keyword, created, reused, itemCount: upstream.items.length, enriched },
  });

  return resp.ok({
    ok: true,
    candidates,
    total: candidates.length,
    upstreamCount: upstream.count,
    /** 实际使用的检索范围 —— 调用方必须能看到，避免误以为用了自己给的位置 */
    centerUsed,
    regionUsed: useNearby ? null : p.region || DEFAULT_REGION,
    /** 本次是"找那个地方"还是"找附近的" */
    scopeUsed: useNearby ? 'nearby' : 'city',
    saved: { created, reused, skipped: upstream.items.length - created - reused },
    ranking: {
      basis,
      enriched,
      note:
        enriched > 0
          ? `前 ${enriched} 个已用真实步行时间精排（每项多消耗 1 次地图配额）`
          : basis === 'relevance'
            ? '按检索结果的相关性排序（上游顺序）；交通设施等不可游览地点排在最后，距离仅作参考。' +
              '需要"离我最近"时传 rankBy: "distance"；开启 enrichWalk 可用真实步行时间精排' +
              '（直线距离在短距离下不可靠：实测直线 10 米对应实际步行 76 米）'
            : basis === 'distance'
              ? '按到检索中心的直线距离排序，未消耗地图配额'
              : '已核验地点优先，其次按距离',
      /** 说明每个候选的排序依据，界面可直接展示 */
      basisMeaning: {
        relevance: '上游检索的相关性——"找到你要的那个地方"',
        distance: '到检索中心的直线距离——"离我最近的"',
        verified: '已实地核验的优先',
      },
      timeEstimateCaveat:
        '外部检索地点的停留时长是**估值**（visitDurationSource: default-untuned），' +
        '用于生成时间线，但不是踏勘结论。',
    },
    parsedVia: upstream.parsedVia,
    rawHead: upstream.rawHead,
    mapApiCalls,
    /** 实际用了哪些检索词 —— 用户说了几个地方就该有几个 */
    keywordsUsed: provided,
    /**
     * 哪些检索词失败了。**必须如实回传** ——
     * 否则用户会以为"提到的地方都搜过了"，而实际漏了一个。
     */
    failedKeywords,
    /** 非 null 表示调用方要求了自动预选（"AI 生成路线"的关键一步） */
    picked,
  });
}

module.exports = { list, detail, search, autoPick, bestMatch };

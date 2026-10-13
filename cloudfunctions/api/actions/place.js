'use strict';

const resp = require('../lib/resp');
const { CODES, require_fields, fail } = require('../lib/errors');
const { placeEligibility, canBeMeetingPoint } = require('../lib/authz');
const { createMapProvider } = require('../lib/map');
const { haversineMeters } = require('../lib/geo');
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

  const provider = createMapProvider(p.provider || process.env.MAP_PROVIDER, {
    // 覆盖 Key 仅用于开发期自测（与 map.probe 同一约定），正式环境不可用
    key: env === 'dev' ? p.overrideKey : undefined,
    timeoutMs: p.timeoutMs,
  });
  const upstream = await provider.searchPlaces({
    keyword,
    center: center || undefined,
    radius: p.radius,
    region: p.region,
    pageSize: p.pageSize,
  });

  let mapApiCalls = 1;

  if (!upstream.ok) {
    await logEvent(repo, {
      ts: now,
      type: 'upstream_call',
      action: 'place.search',
      userId: openid,
      result: 'error',
      errCode: upstream.reason || 'UPSTREAM_FAILED',
      durationMs: Date.now() - started,
      mapApiCalls,
      detail: { keyword, status: upstream.status || null },
    });
    return resp.ok({
      ok: false,
      reason: upstream.reason,
      status: upstream.status || null,
      message: upstream.message,
      hint: upstream.hint || null,
      upstream: {
        parsedVia: upstream.parsedVia || null,
        rawHead: upstream.rawHead || null,
        timingMs: upstream.timingMs || null,
      },
      candidates: [],
      mapApiCalls,
    });
  }

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
      });
      continue;
    }

    rows.push({
      placeId: place._id,
      poiId: item.poiId,
      name: place.name,
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

  // ── 排序：默认按到中心的直线距离 —— **零成本**，不消耗地图配额
  const basis = p.rankBy === 'verified' ? 'verified' : 'distance';
  let ranked = rankByDistance(rows, center, basis, verifiedIds);

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
    regionUsed: p.region || null,
    saved: { created, reused, skipped: upstream.items.length - created - reused },
    ranking: {
      basis,
      enriched,
      note:
        enriched > 0
          ? `前 ${enriched} 个已用真实步行时间精排（每项多消耗 1 次地图配额）`
          : '按直线距离排序，未消耗地图配额。开启 enrichWalk 可用真实步行时间精排' +
            '（直线距离在短距离下不可靠：实测直线 10 米对应实际步行 76 米）',
      timeEstimateCaveat:
        '外部检索地点的停留时长是**估值**（visitDurationSource: default-untuned），' +
        '用于生成时间线，但不是踏勘结论。',
    },
    parsedVia: upstream.parsedVia,
    rawHead: upstream.rawHead,
    mapApiCalls,
  });
}

module.exports = { list, detail, search };

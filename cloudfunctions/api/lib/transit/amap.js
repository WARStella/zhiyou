'use strict';

/**
 * 高德**公交路径规划（含地铁）** provider。
 *
 * ── 为什么需要它（2026-10-14，用户："我这是旅游项目，公交地铁确实需要"）
 *
 * 哈尔滨的景点分散在不同区（中央大街在道里、冰雪大世界在松北、哈西一片另算），
 * **跨区靠步行不成立**。所以公交地铁不是加分项，是"这个应用能不能用"的前提。
 *
 * 而腾讯那边：距离矩阵**明确只有 walking / bicycling / driving 三种，没有公交**
 * （见 `lib/map/matrix-modes.js`）。腾讯另有 `direction/v1/transit`，
 * 但入参与其余三种不同、且**至今未实测**。
 *
 * 高德这边是官方文档确证的：
 *   「路线规划接口2.0……支持驾车、公交、步行、骑行、电动车路线规划」
 *   「公交路线规划：可结合业务场景设置不同的公交换乘策略」
 *
 * ── 接口与必填参数（官方文档原文）──────────────────────────
 *
 *   origin       lon,lat（**经度在前**，与腾讯的 lat,lng 相反 ⚠️）
 *   destination  同上
 *   city         **必填** —— 市内公交换乘的起点城市（城市名或 citycode）
 *   cityd        跨城公交才填
 *   strategy     0 最快捷 / 1 最经济 / 2 最少换乘 / 3 最少步行 / **5 不乘地铁**
 *   nightflag    是否计算夜班车
 *
 * `strategy` 里有"不乘地铁"这一档，反过来说明**默认方案含地铁**。
 * 而且这几档本身就是可解释的偏好 —— 正好能喂给 `lib/mode-choice.js`，
 * 不是黑箱参数。
 *
 * ⚠️ 端点与响应字段**尚未持 Key 实测**（文档已读，但文档与实际不总一致 ——
 * 本项目在腾讯 `id`/`_id` 上吃过一次）。所以本文件把"实际命中的字段路径"
 * 记进 `parsedVia`，并有 `transitProbe` 先问清楚。
 */

const { defaultTransport, redact, maskSecret } = require('../http');
const { resolveKey } = require('../amap/key');

/** 「公交路径规划 2.0（公交地铁一体化）」端点 */
const DEFAULT_ENDPOINT = 'https://restapi.amap.com/v5/direction/transit/integrated';
const DEFAULT_TIMEOUT_MS = 8000;

/** 换乘策略 —— 与官方文档逐条对应，中文名直接可展示 */
const STRATEGY = {
  FASTEST: '0',
  CHEAPEST: '1',
  FEWEST_TRANSFER: '2',
  LEAST_WALK: '3',
  NO_SUBWAY: '5',
};

const STRATEGY_LABEL = {
  0: '最快捷',
  1: '最经济',
  2: '最少换乘',
  3: '最少步行',
  5: '不乘地铁',
};

/** 高德 status 码的常见成因（只写确证的几条，不编） */
function statusHint(status) {
  const hints = {
    '10001': 'Key 不正确或已过期 —— 检查云函数环境变量 AMAP_KEY',
    '10002': '没有请求权限 —— 该 Key 可能未开通「Web服务API」或「公交路径规划」',
    '10003': '访问过于频繁 —— 已达 QPS 限制',
    '10004': '今日访问量已达上限',
    '10009': '请求 Key 与绑定平台不符 —— Key 需为「Web服务」类型',
    '10012': '权限不足 —— 该 Key 可能未开通此接口',
    '10021': 'QPS 超出限制',
    '20000': '请求参数错误',
    '20001': '缺少必填参数 —— 公交规划 **city 是必填**，漏了会报这个',
    '20003': '参数值非法',
    '20800': '规划点超出范围',
    '20801': '起点或终点附近没有公交站点 —— 该点可能公交不可达',
    '20802': '无公交方案 —— 这两个点之间没有可用的公共交通',
  };
  return hints[String(status)] || null;
}

/** 高德要求 `lon,lat`，且小数不超过 6 位 */
function ll(point) {
  return `${Number(point.longitude).toFixed(6)},${Number(point.latitude).toFixed(6)}`;
}

function createAmapTransitProvider(opts) {
  opts = opts || {};
  const normalized = resolveKey(opts);
  const key = normalized.key;
  const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const http = opts.http || defaultTransport;

  return {
    name: 'amap-transit',

    keyStatus() {
      return { configured: Boolean(key), masked: maskSecret(key), trimmed: normalized.trimmed };
    },

    /**
     * 公交（含地铁）路线规划。
     *
     * @param {object} input
     * @param {{latitude:number,longitude:number}} input.from
     * @param {{latitude:number,longitude:number}} input.to
     * @param {string} input.city        **必填** —— 城市名或 citycode（如「哈尔滨」或 230100）
     * @param {string} [input.strategy]  见 STRATEGY，缺省 0（最快捷）
     * @param {number} [input.cityd]     跨城公交才需要
     * @returns {Promise<object>} 恒返回结构，不抛异常
     */
    async route(input) {
      input = input || {};
      const from = input.from;
      const to = input.to;
      const city = input.city;
      const strategy = input.strategy === undefined || input.strategy === null ? STRATEGY.FASTEST : String(input.strategy);

      const base = {
        provider: 'amap-transit',
        operation: 'direction/transit/integrated',
        from: from || null,
        to: to || null,
        city: city || null,
        strategy,
        strategyLabel: STRATEGY_LABEL[strategy] || null,
      };

      if (!from || !to || typeof from.latitude !== 'number' || typeof to.latitude !== 'number') {
        return Object.assign(base, {
          ok: false,
          reason: 'ORIGIN_DESTINATION_REQUIRED',
          message: '公交规划需要 from 与 to，各含 {latitude, longitude}',
        });
      }
      /**
       * ⚠️ `city` 是**必填**。漏了高德回 20001「缺少必填参数」——
       * 而那个错误码不点明是 city，所以在这里先拦住并说清楚。
       */
      if (!city) {
        return Object.assign(base, {
          ok: false,
          reason: 'CITY_REQUIRED',
          message: '公交规划必须给出 city（城市名或 citycode）—— 高德用它确定市内公交换乘范围',
          hint: '如 city: "哈尔滨"；本项目单城，通常由服务端常量补齐',
        });
      }
      if (!key) {
        return Object.assign(base, {
          ok: false,
          reason: 'AMAP_KEY_NOT_CONFIGURED',
          message: '云函数环境变量 AMAP_KEY 未配置，无法做公交规划',
          hint: '云开发控制台 → 云函数 → api → 配置 → 环境变量 → 新增 AMAP_KEY（需「Web服务」类型 Key）',
        });
      }

      const requestUrl =
        `${endpoint}?origin=${encodeURIComponent(ll(from))}` +
        `&destination=${encodeURIComponent(ll(to))}` +
        `&city=${encodeURIComponent(String(city))}` +
        `&strategy=${encodeURIComponent(strategy)}` +
        (input.cityd ? `&cityd=${encodeURIComponent(String(input.cityd))}` : '') +
        (input.nightflag ? `&nightflag=${encodeURIComponent(String(input.nightflag))}` : '') +
        `&key=${encodeURIComponent(key)}`;

      const safeUrl = redact(requestUrl);
      const started = Date.now();
      let res;
      try {
        res = await http(requestUrl, { timeoutMs });
      } catch (e) {
        return Object.assign(base, {
          ok: false,
          requestUrl: safeUrl,
          reason: e && e.code === 'UPSTREAM_MAP_FAILED' ? 'UPSTREAM_FAILED' : 'UNKNOWN',
          message: (e && e.message) || String(e),
          details: (e && e.details) || null,
          timingMs: Date.now() - started,
        });
      }

      const timingMs = Date.now() - started;
      const body = res.json || {};
      const status = body.status;
      const ok = String(status) === '1';
      const parsed = ok ? parseTransit(body) : null;

      return Object.assign(base, {
        ok,
        requestUrl: safeUrl,
        reason: ok ? null : 'UPSTREAM_STATUS_' + String(status),
        status,
        message: body.info || body.message || null,
        hint: ok ? null : statusHint(status),
        httpStatus: res.httpStatus,
        timingMs,
        /** 上游报的方案总数 */
        routeCount: body.count === undefined ? null : body.count,
        ...(parsed || {}),
        parsedVia: parsed ? parsed.parsedVia : null,
        rawHead: String(res.rawBody || '').slice(0, 1200),
      });
    },
  };
}

/**
 * 解析公交方案。
 *
 * ⚠️ **字段路径依官方文档，未持 Key 实测。** 所以把实际命中的路径记进
 * `parsedVia` —— 与腾讯 provider 同一条纪律：不靠记忆定死，由原始返回核对。
 *
 * 关注的是**规划需要的那几个数**，不是把整个换乘方案都搬进来：
 *   · `durationMinutes` 总耗时（规划器的输入）
 *   · `walkingMeters`   步行总距离（"最少步行"这类偏好的依据）
 *   · `cost`            票价（可展示，也是"最经济"的依据）
 *   · `segments`        换乘概览（界面上要说清"坐几号线、在哪换"）
 */
function parseTransit(body) {
  const transits = (body.route && Array.isArray(body.route.transits) && body.route.transits) || [];
  const first = transits[0] || null;

  const parsedVia = {
    list: 'route.transits[]',
    duration: 'route.transits[0].duration',
    walkingDistance: 'route.transits[0].walking_distance',
    cost: 'route.transits[0].cost',
    segments: 'route.transits[0].segments[]',
  };

  if (!first) {
    return {
      routes: [],
      best: null,
      parsedVia,
      emptyReason: 'NO_TRANSIT_ROUTE',
    };
  }

  const durationSeconds = toNumber(first.duration);
  const walkingMeters = toNumber(first.walking_distance);
  const costYuan = toNumber(first.cost);

  const segments = (Array.isArray(first.segments) && first.segments) || [];
  const steps = segments.map((seg) => {
    const bus = (seg.bus && seg.bus.buslines && seg.bus.buslines[0]) || null;
    const walking = seg.walking || null;
    const railway = seg.railway || null;
    return {
      /** 这一段是走路还是坐车 —— 界面要靠它区分图标 */
      kind: walking ? 'walking' : bus || railway ? 'transit' : 'unknown',
      /** 上游原话的指引（与腾讯同一条纪律：不自己编路线描述） */
      instruction: seg.instruction || null,
      /** 线路名，如「地铁2号线」「110路」 */
      lineName: bus ? bus.name || null : railway ? railway.name || null : null,
      /** ⚠️ 地铁还是公交：`bus.type` 里带「地铁」字样时是地铁 */
      isSubway: bus ? /地铁/.test(String(bus.type || '')) : Boolean(railway),
      viaStationCount: bus && bus.via_num !== undefined ? toNumber(bus.via_num) : null,
      departureStop: bus && bus.departure_stop ? bus.departure_stop.name || null : null,
      arrivalStop: bus && bus.arrival_stop ? bus.arrival_stop.name || null : null,
      walkingMeters: walking ? toNumber(walking.distance) : null,
      durationSeconds: walking ? toNumber(walking.duration) : null,
    };
  });

  return {
    routes: transits.slice(0, 5).map((t) => ({
      durationMinutes: toNumber(t.duration) === null ? null : Math.round((toNumber(t.duration) / 60) * 10) / 10,
      walkingMeters: toNumber(t.walking_distance),
      costYuan: toNumber(t.cost),
      transferCount: Array.isArray(t.segments) ? Math.max(0, t.segments.filter((s) => s.bus || s.railway).length - 1) : null,
      hasSubway: Array.isArray(t.segments)
        ? t.segments.some((s) => (s.bus && /地铁/.test(String(s.bus.type || ''))) || s.railway)
        : null,
    })),
    best: {
      durationMinutes: durationSeconds === null ? null : Math.round((durationSeconds / 60) * 10) / 10,
      durationSeconds,
      walkingMeters,
      costYuan,
      steps,
      /** 有几步是坐车 —— 0 表示"其实全靠走"，那就不该推荐公交 */
      transitStepCount: steps.filter((s) => s.kind === 'transit').length,
      hasSubway: steps.some((s) => s.isSubway),
    },
    parsedVia,
    emptyReason: null,
  };
}

function toNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  createAmapTransitProvider,
  parseTransit,
  statusHint,
  STRATEGY,
  STRATEGY_LABEL,
  DEFAULT_ENDPOINT,
};

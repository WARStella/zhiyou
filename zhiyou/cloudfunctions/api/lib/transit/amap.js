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

/** 「公交路径规划」端点 —— **用 v3，不用 v5**。理由见下面那段实测记录 */
const DEFAULT_ENDPOINT = 'https://restapi.amap.com/v3/direction/transit/integrated';
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * ── 为什么是 v3 而不是 v5（2026-10-14 实测，别再改回去）──────
 *
 * 高德同时存在两套公交接口：
 *
 *   v3 `/v3/direction/transit/integrated`  城市参数 `city` / `cityd`
 *   v5 `/v5/direction/transit/integrated`  城市参数 `city1` / `city2`
 *
 * 两种都试过，**同一个 Key、同一组坐标**：
 *
 *   v5 → `{"status":"0","info":"MISSING_REQUIRED_PARAMS","infocode":"20001"}`
 *        （参数按 v5 文档写全了：origin/destination/city1/strategy/show_fields）
 *   v3 → `{"status":"1","info":"OK","count":"5", route.transits:[…]}` ✅
 *
 * 排查过程中被**证伪**的两条思路，一并记下来免得重走：
 *   · "用假 Key 探参数对不对" —— 高德**先校 Key 再校参数**，
 *     假 Key 无论参数对错都只回 `INVALID_USER_KEY`，问不出东西。
 *   · "Key 没开通路径规划" —— 同一个 Key 走 v3 是通的，所以服务是开着的。
 *
 * 另外 `/v5/place/text`（照片那条路）用同一个 Key 也是通的，
 * 说明**不是 Key 或平台的问题，是这个 v5 端点与这组参数不匹配**。
 *
 * 留 v3 还有一个好处：v3 的字段是**实测确认过的**（见下面 parseTransit），
 * 而 v5 的字段只有第三方参数表，没实测。
 */

/**
 * 换乘策略 —— **v3 的档位**（官方文档原文）。
 *
 * ⚠️ v5 的档位不同（0-8，含"地铁图模式""地铁优先""时间最短"）。
 * 这里用 v3，所以是五档。改动端点时必须同步改这里 ——
 * 两者混用不会报错，只会让"最少步行"静默变成别的东西。
 */
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

/** 高德错误码的成因（只写确证的几条，不编） */
function statusHint(code) {
  if (code === undefined || code === null) return null;
  const hints = {
    '10001': 'Key 不正确或已过期 —— 检查云函数环境变量 AMAP_KEY',
    '10002': '没有请求权限 —— 该 Key 可能未开通「Web服务API」或「公交路径规划」',
    '10003': '访问过于频繁 —— 已达 QPS 限制',
    '10004': '今日访问量已达上限',
    '10009': '请求 Key 与绑定平台不符 —— Key 需为「Web服务」类型',
    '10012': '权限不足 —— 该 Key 可能未开通此接口',
    '10021': 'QPS 超出限制',
    '20000': '请求参数错误',
    /**
     * ⚠️ 这一条是实测踩到的（2026-10-14）：我照 v3 文档用了 `city` / `cityd`，
     * 而 v5 要 **`city1` / `city2`** —— 且 v5 没有 `city` 这个参数。
     * 上游只回"缺少必填参数"，不点明是哪个，所以这里把最可能的原因写出来。
     */
    '20001': '缺少必填参数 —— 公交规划 v5 的起点城市参数名是 **city1**（不是 city），跨城还要 city2',
    '20003': '参数值非法',
    '20800': '规划点超出范围',
    '20801': '起点或终点附近没有公交站点 —— 该点可能公交不可达',
    '20802': '无公交方案 —— 这两个点之间没有可用的公共交通',
  };
  return hints[String(code)] || null;
}

/** 上游给的是文字说明（如 `MISSING_REQUIRED_PARAMS`）时的兜底解释 */
function hintFromInfo(info) {
  if (!info) return null;
  const text = String(info).toUpperCase();
  if (text.includes('MISSING_REQUIRED_PARAMS')) {
    return '缺少必填参数。公交规划 v5 需要 origin / destination / **city1**（起点城市 citycode）三者齐全';
  }
  if (text.includes('INVALID_USER_KEY') || text.includes('INVALID_USER_SCODE')) {
    return 'Key 无效 —— 确认 AMAP_KEY 是否已配置、是否与「Web服务」平台绑定';
  }
  if (text.includes('SERVICE_NOT_AVAILABLE') || text.includes('INVALID_USER_SERVICE')) {
    return '该 Key 未开通这项服务 —— 控制台 Key 详情页的「可使用服务」里要勾上公交路径规划';
  }
  return null;
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
     * 公交（含地铁）路线规划 —— **v3 端点**（理由见文件头那段实测记录）。
     *
     * @param {object} input
     * @param {{latitude:number,longitude:number}} input.from
     * @param {{latitude:number,longitude:number}} input.to
     * @param {string} input.city        **必填** —— 起点城市 citycode（哈尔滨 = 0451）
     * @param {string} [input.cityd]     终点城市 citycode，**跨城才填**
     * @param {string} [input.strategy]  见 STRATEGY，缺省 `0`（最快捷）
     * @returns {Promise<object>} 恒返回结构，不抛异常
     */
    async route(input) {
      input = input || {};
      const from = input.from;
      const to = input.to;
      const city = input.city;
      const strategy =
        input.strategy === undefined || input.strategy === null ? STRATEGY.FASTEST : String(input.strategy);

      const base = {
        provider: 'amap-transit',
        requestCount: 0,
        operation: 'direction/transit/integrated',
        apiVersion: 'v3',
        from: from || null,
        to: to || null,
        city: city || null,
        cityd: input.cityd || null,
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
       * ⚠️ 起点城市是**必填**。上游对缺参只回 `20001 缺少必填参数`，
       * **不点明是哪个参数** —— 所以本地先拦住并说清字段名。
       */
      if (!city) {
        return Object.assign(base, {
          ok: false,
          reason: 'CITY_REQUIRED',
          message: '公交规划必须给出起点城市 citycode',
          hint: '如 city: "0451"（哈尔滨 citycode）；本项目单城，通常由服务端常量补齐',
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

      /**
       * ⚠️ 这里**没有** v5 那套 `show_fields=cost` —— v3 默认就返回票价与耗时。
       * 加一个 v3 不认识的参数不会报错，但会让人误以为"是按 v5 调的"。
       */
      const requestUrl =
        `${endpoint}?origin=${encodeURIComponent(ll(from))}` +
        `&destination=${encodeURIComponent(ll(to))}` +
        `&city=${encodeURIComponent(String(city))}` +
        (input.cityd ? `&cityd=${encodeURIComponent(String(input.cityd))}` : '') +
        `&strategy=${encodeURIComponent(strategy)}` +
        (input.nightflag ? `&nightflag=${encodeURIComponent(String(input.nightflag))}` : '') +
        `&key=${encodeURIComponent(key)}`;

      const safeUrl = redact(requestUrl);
      const started = Date.now();
      let res;
      try {
        base.requestCount++;
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
      const info = body.info || body.message || null;
      /**
       * ⚠️ 成功判定**不能只看 `status`**（2026-10-14 由实测暴露）。
       *
       * 实测的错误返回长这样：
       *     {"status":"0","info":"MISSING_REQUIRED_PARAMS","infocode":"20001"}
       *
       * 我原先写 `ok = String(status) === '1'`，那么 `status: "0"` 会被判为
       * **失败**（碰巧对了）；但反过来说，只要上游某次用别的成功码，
       * 我就会把成功当失败。更稳的判法是：**有 `infocode` 或有 `info` 文本 = 出错**，
       * 再加上显式的 `status === '1'`。
       *
       * 这套字段（`infocode` / `info`）是这次实测才发现真实存在的 ——
       * 文档里只讲了 `status`，而**取证实测胜过读文档**。
       */
      const infocode = body.infocode === undefined ? null : String(body.infocode);
      /**
       * ⚠️ 成功判定经历了两轮修正，两轮都是实测逼出来的：
       *
       * 第一版 `ok = status === '1'` —— 太松。
       * 第二版 `ok = status === '1' && !infocode && !info` —— **错了**：
       *   实测的**成功**返回是
       *     `{"status":"1","info":"OK","infocode":"10000", …}`
       *   它**也带 info 与 infocode**，于是成功会被判成失败。
       *
       * 现在按实测的三个样本定规则：
       *   成功      status:'1'  infocode:'10000'  info:'OK'
       *   缺必填    status:'0'  infocode:'20001'  info:'MISSING_REQUIRED_PARAMS'
       *   Key 无效  status:'0'  infocode:'10001'  info:'INVALID_USER_KEY'
       *
       * 即：**`10000` 才是成功码**。缺 infocode 时回落到"status 为 1 且 info 不是错误文本"。
       */
      const OK_INFOCODE = '10000';
      const ok =
        String(status) === '1' &&
        (infocode !== null
          ? infocode === OK_INFOCODE
          : !info || /^ok$/i.test(String(info)));

      const parsed = ok ? parseTransit(body, { includeGeometry: input.includeGeometry, fastest: strategy === STRATEGY.FASTEST }) : null;

      return Object.assign(base, {
        ok,
        requestUrl: safeUrl,
        reason: ok ? null : 'UPSTREAM_STATUS_' + String(status === undefined ? infocode : status),
        status,
        /** 上游的错误码与文字说明 —— 实测才发现这两个字段，要如实带出去 */
        infocode,
        info,
        message: info,
        /**
         * 提示优先按 `infocode` 查（那是更细的错误码），再回落到 `status`，
         * 最后按 `info` 文本兜底 —— 实测那次 `hint` 为 null 就是因为
         * 我拿数字码去查表，而上游给的是文字。
         */
        hint: ok ? null : statusHint(infocode) || statusHint(status) || hintFromInfo(info),
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
function parseTransit(body, opts) {
  const route = body.route || {};
  const transits = ((Array.isArray(route.transits) && route.transits) || []).slice();
  if (opts && opts.fastest) transits.sort((a, b) =>
    (toNumber(a.duration) == null ? Infinity : Number(a.duration)) - (toNumber(b.duration) == null ? Infinity : Number(b.duration)));
  const usable = t => (opts && opts.includeGeometry ? [toNumber(t.duration), toNumber(t.distance)] : [toNumber(t.duration)])
    .every(n => n !== null && n >= 0);
  const first = (opts && opts.fastest ? transits.find(t => usable(t) && (t.segments || []).some(s =>
    s.bus && Array.isArray(s.bus.buslines) && s.bus.buslines.length)) : transits[0]) || null;

  /**
   * ⚠️ 下面这些路径是**实测确认过的**（2026-10-14，见
   * `test/fixtures/upstream/direction-transit-integrated-harbin.json`），
   * 不是照文档写的。与腾讯 provider 同一条纪律：由原始返回核对。
   */
  const parsedVia = {
    list: 'route.transits[]',
    duration: 'route.transits[].duration（**秒**，字符串）',
    walkingDistance: 'route.transits[].walking_distance（米）',
    cost: 'route.transits[].cost（元）',
    segments: 'route.transits[].segments[]',
    walkingInstruction: 'segments[].walking.steps[].instruction（上游原话）',
    buslines: 'segments[].bus.buslines[]（**数组**，可能多条可选线路）',
    lineType: 'segments[].bus.buslines[].type（「地铁线路」/「普通公交线路」）',
    entranceExit: 'segments[].entrance.name / segments[].exit.name（**几号口**）',
  };

  if (!first) {
    return { routes: [], best: null, parsedVia, emptyReason: 'NO_TRANSIT_ROUTE' };
  }

  const toMinutes = (seconds) => (seconds === null ? null : Math.round((seconds / 60) * 10) / 10);

  /** 把一个方案的 segments 摊成"走路一段、坐车一段"的序列 */
  function stepsOf(transit) {
    const segments = (Array.isArray(transit.segments) && transit.segments) || [];
    const steps = [];

    for (const seg of segments) {
      const walking = seg.walking || null;
      if (walking && toNumber(walking.distance) !== null) {
        const instr = (Array.isArray(walking.steps) && walking.steps) || [];
        steps.push({
          kind: 'walking',
          /** 上游原话的第一句 —— 与腾讯同一条纪律：不自己编路线描述 */
          instruction: instr.length ? instr[0].instruction || null : null,
          /** 全部步行指引，界面需要"到哪里拐弯"时用 */
          allInstructions: instr.map((s) => s.instruction).filter(Boolean),
          walkingMeters: toNumber(walking.distance),
          durationSeconds: toNumber(walking.duration),
        });
      }

      const buslines = (seg.bus && Array.isArray(seg.bus.buslines) && seg.bus.buslines) || [];
      // 同一 segment 的 buslines 是备选线路，不是连续换乘。
      for (const line of buslines.slice(0, 1)) {
        const name = line.name || null;
        const type = String(line.type || '');
        steps.push({
          kind: 'transit',
          instruction: name,
          lineName: name,
          /** ⚠️ 实测确认：`type` 为「地铁线路」时是地铁，否则「普通公交线路」 */
          isSubway: /地铁/.test(type),
          lineType: type || null,
          viaStationCount: toNumber(line.via_num),
          viaStops: (Array.isArray(line.via_stops) && line.via_stops) || [],
          departureStop: line.departure_stop ? line.departure_stop.name || null : null,
          arrivalStop: line.arrival_stop ? line.arrival_stop.name || null : null,
          /* 线路自身的里程与耗时（秒） */
          distanceMeters: toNumber(line.distance),
          durationSeconds: toNumber(line.duration),
          /**
           * 首末班时间 —— **两个坑叠在一起**（2026-10-14，靠真实返回才发现）：
           *
           * ① 它是**时刻字符串**（`"0532"`），不能转数字 —— 转了会丢前导零，
           *    显示成「5:32」就错了。
           * ② 实测发现 **`start_time` 可能是空数组 `[]`**，而值在
           *    `station_start_time` 里。地铁线路就是这种形态。
           *    直接把 `[]` 当值会得到一个"看起来有值、实际是空数组"的字段
           *    —— 界面上会渲染出空白。
           *
           * 所以：按 `start_time` → `station_start_time` 依次取，
           * 且**空数组一律视为没有**。
           */
          startTime: pickTime(line.start_time, line.station_start_time),
          endTime: pickTime(line.end_time, line.station_end_time),
        });
      }

      /**
       * 地铁/公交的**出入口**（实测发现，文档里的示例没提）。
       * 对集合协同这是最有用的信息之一 —— "在 1 号口等"比"在世茂大道站等"清楚得多。
       */
      const entrance = seg.entrance && seg.entrance.name ? seg.entrance : null;
      const exit = seg.exit && seg.exit.name ? seg.exit : null;
      if (entrance || exit) {
        steps.push({
          kind: 'entrance-exit',
          instruction: [entrance && `进 ${entrance.name}`, exit && `出 ${exit.name}`]
            .filter(Boolean)
            .join(' / '),
          entranceName: entrance ? entrance.name : null,
          entranceLocation: entrance ? parseAmapLocation(entrance.location) : null,
          exitName: exit ? exit.name : null,
          exitLocation: exit ? parseAmapLocation(exit.location) : null,
        });
      }
    }

    return steps;
  }

  function summaryOf(transit) {
    const steps = stepsOf(transit);
    const rideSteps = steps.filter((s) => s.kind === 'transit');
    return {
      durationMinutes: toMinutes(toNumber(transit.duration)),
      durationSeconds: toNumber(transit.duration),
      walkingMeters: toNumber(transit.walking_distance),
      costYuan: toNumber(transit.cost),
      /** 线路总里程（米）—— 与 walking_distance 不是一回事 */
      distanceMeters: toNumber(transit.distance),
      /** `walking_distance` 是米，要转成人类可读的公里时前端处理 */
      transferCount: Math.max(0, rideSteps.length - 1),
      hasSubway: rideSteps.some((s) => s.isSubway),
      hasBus: rideSteps.some((s) => !s.isSubway),
      lineNames: rideSteps.map((s) => s.lineName).filter(Boolean),
      /** 首末班时间（取第一条线路的，供界面提示） */
      firstLineStartTime: rideSteps.length ? rideSteps[0].startTime : null,
      lastLineEndTime: rideSteps.length ? rideSteps[0].endTime : null,
    };
  }

  const bestSteps = stepsOf(first);
  const subwayRoutes = transits.filter(t => summaryOf(t).hasSubway && usable(t))
    .sort((a, b) => Number(a.duration) - Number(b.duration));
  const subway = subwayRoutes[0];

  return {
    /** 上游可能给 5 个方案；全部给出来，"最少换乘/最少步行"才有比较依据 */
    routes: transits.slice(0, 5).map(summaryOf),
    bestSubway: subway ? Object.assign(summaryOf(subway), { steps: stepsOf(subway) }, opts && opts.includeGeometry ? { route: geometryOf(subway) } : {}) : null,
    best: Object.assign(summaryOf(first), {
      steps: bestSteps,
      /** 有几步是坐车 —— 0 表示"其实全靠走"，那就不该推荐公交 */
      transitStepCount: bestSteps.filter((s) => s.kind === 'transit').length,
      ...(opts && opts.includeGeometry ? { route: geometryOf(first) } : {}),
    }),
    /** 起终点整体信息（route 层，不是某个方案） */
    routeSummary: {
      distanceMeters: toNumber(route.distance),
      /** 打车参考价 —— 展示用，"其实打车更贵/更快"是用户会问的 */
      taxiCostYuan: toNumber(route.taxi_cost),
    },
    parsedVia,
    emptyReason: null,
  };
}

// 每条上游折线单独保留；缺失的接驳段不能用直线补齐。
function geometryOf(transit) {
  const polylines = [];
  let partial = false;
  let unsupported = false;
  const add = (raw, mode, distance) => {
    const pieces = typeof raw === 'string' ? raw.split(';') : [];
    const points = pieces.map(parseAmapLocation);
    if (points.length >= 2 && points.every(Boolean)) polylines.push({ mode, points });
    else if (distance == null || Number(distance) > 0) partial = true;
  };
  for (const seg of transit.segments || []) {
    const walking = seg.walking || {};
    const walkingSteps = Array.isArray(walking.steps) ? walking.steps : [];
    if (Number(walking.distance) > 0 && !walkingSteps.length) partial = true;
    for (const step of walkingSteps) add(step.polyline, 'walking', step.distance == null ? walking.distance : step.distance);
    const line = seg.bus && Array.isArray(seg.bus.buslines) && seg.bus.buslines[0];
    if (line) add(line.polyline, /地铁/.test(line.type || '') ? 'subway' : 'transit', line.distance);
    if ((seg.railway && (seg.railway.id || seg.railway.name)) || (seg.taxi && Number(seg.taxi.distance) > 0)) {
      partial = true;
      unsupported = true;
    }
  }
  const points = polylines.flatMap(p => p.points);
  return { polylines, points, pointCount: points.length, decoded: polylines.length > 0, partial, unsupported };
}

/** 高德的坐标是 `"经度,纬度"` 字符串 */
function parseAmapLocation(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',');
  if (parts.length !== 2) return null;
  const lng = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!parts.every(p => p.trim()) || !Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { latitude: lat, longitude: lng };
}

/**
 * 取时刻字符串，**空数组视为没有**。
 *
 * 实测（2026-10-14）：地铁线路的 `start_time` 是 `[]`，而
 * `station_start_time` 才有 `"0532"`。而 `[]` 是 truthy ——
 * 直接用 `a || b` 会拿到 `[]`，界面上渲染成空白，且不报错。
 */
function pickTime(primary, fallback) {
  const ok = (v) => typeof v === 'string' && v.trim().length > 0;
  if (ok(primary)) return primary.trim();
  if (ok(fallback)) return fallback.trim();
  return null;
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

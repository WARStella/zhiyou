'use strict';

/**
 * 腾讯位置服务 —— 步行路线规划（WebService API）。
 *
 * 接口形态（**以官方文档与 map.probe 实测为准**）：
 *   GET https://apis.map.qq.com/ws/direction/v1/walking/
 *       ?from=<纬度>,<经度>&to=<纬度>,<经度>&key=<KEY>
 *   → { status: 0, message: 'query ok', result: { routes: [ { distance, duration, polyline, steps } ] } }
 *
 * ⚠️ 三件必须实测确认、不得凭记忆写死的事：
 *   ① `from`/`to` 的经纬度顺序（腾讯位置服务通常为 `纬度,经度`，与 GeoJSON 相反）
 *   ② 坐标系：本项目全库 GCJ-02，需确认该接口接受 GCJ-02 且返回同系
 *   ③ `distance` / `duration` 的单位（推测为 米 / 秒）
 *
 * ── 已实测确认（2026-10-14 首次成功调用）─────────────────────
 *   请求：中央大街 (45.7756, 126.6175) → 防洪纪念塔 (45.781, 126.6185)
 *   返回：`status: 0`，`distance: 815`，`duration: 12`，8 段 `steps`，`polyline` 120 个数
 *
 *   ① **坐标系一致（GCJ-02）** —— polyline 第一个点是 `45.775524, 126.617213`，
 *      与输入坐标相差约 25 米，属同一坐标系。
 *   ② **`distance` 单位 = 米**（815 米与两点实际距离量级吻合）。
 *   ③ **`duration` 单位 = 分钟，不是秒** —— 见下方 `checkDurationUnit`。
 *      这是首版代码的实际 bug，会导致步行时间被算成 1/60。
 *   ④ **`polyline` 是差分压缩格式**，不是简单的 (纬度, 经度) 序列：
 *      首对为绝对坐标，其后为相对前一点的增量（且有 `0,0` 占位）。
 *      **解码规则需以官方文档为准，不要凭观察猜。**
 *      `steps[].polyline_idx` 给出每段在数组中的索引区间，是解码的钥匙。
 *      ⚠️ 但**核心功能不需要它**：集合推荐只依赖 `distance` + `duration`。
 *      首版地图上画"起点→终点"连线即可，精确路径留到有余力时再做。
 *
 * ── 已确认的错误码 ──────────────────────────────────────────
 *   `311` key 格式错误 · `121` 配额未分配（不是用尽）· `374` 起终点坐标错误
 *   详见 `STATUS_HINTS`。
 *
 * 仍未确认的：`from`/`to` 是否严格 `纬度,经度`（本次按此传入即成功，可视为确认）。
 *
 * 因此 `walkingRoute` **把原始返回一并带出**，由 `map.probe` 展示供逐项核对，
 * 而不是在这里假定解析正确。
 *
 * 另一条纪律：本模块**绝不**在失败时返回估算值。失败就是 `ok:false`，
 * 由调用方决定是否降级到直线估算（见 lib/geo.js），
 * 否则会出现"地图接口挂了，却给出一个看起来可行的方案"（docs/01 §3）。
 */

const { HttpError, redact, maskSecret } = require('../http');

const DEFAULT_BASE = 'https://apis.map.qq.com/ws/direction/v1/walking/';
/** 地点检索端点（WebServiceAPI · 搜索服务） */
const DEFAULT_SEARCH_BASE = 'https://apis.map.qq.com/ws/place/v1/search';
/** 上游 page_size 上限 */
const SEARCH_PAGE_SIZE_MAX = 20;
/** nearby 半径上限（米） */
const SEARCH_RADIUS_MAX = 10000;
const DEFAULT_TIMEOUT_MS = 8000;

/** 原始返回体的截断长度：够看清结构，又不至于把响应撑爆 */
const RAW_HEAD_LIMIT = 1200;

/**
 * 上游 status 码 → 可执行的下一步。
 *
 * 只收录**已实测确认**的码，不凭记忆补全 —— 猜错的指引比没有指引更糟。
 * 新遇到的码先加到这里，再写进 docs/04_工作日志.md。
 */
const STATUS_HINTS = {
  121:
    '每日调用量已达上限。注意：**这不一定是真的用完了** —— ' +
    '腾讯位置服务的免费配额需要完成开发者实名认证后才生效，未认证账号配额为 0，' +
    '表现就是"一调用就说达到上限"。请到控制台「配额管理」核对配额数字，并检查账号认证状态。',
  311:
    'Key 格式错误。常见原因：从控制台复制时**漏了字符或多带了空白**。' +
    '注意：因格式错误被拒的请求**不计入配额**。',
  374:
    '起终点坐标错误。实测确认：**起终点完全相同会被直接拒绝**。' +
    '调用方应先判断两点是否重合（或距离小于几米），重合时不必请求上游。',
};

const statusHint = (status) =>
  STATUS_HINTS[status] ||
  (status === 0 ? null : `上游返回 status=${status}，请到腾讯位置服务控制台核对 Key 的服务勾选与配额。`);

/**
 * `duration` 的单位自检 —— **这是本项目最重要的一次实测发现**。
 *
 * 2026-10-14 实测：中央大街 → 防洪纪念塔 **815 米**，`duration` 返回 **12**。
 *   · 按**秒**理解 → 68 米/秒（244 km/h），荒谬
 *   · 按**分钟**理解 → 68 米/分钟（约 4 km/h），与步行速度吻合
 *   ⇒ **单位是分钟，不是秒。**
 *
 * 首版代码写成 `durationMinutes = durationSeconds / 60`，会把步行时间算成实际的 1/60 ——
 * 规划器的可行性检查会全部误判为"时间充裕"。这类"数值算错但不报错"的缺陷，
 * 正是 `map.probe` 存在的意义。
 *
 * 但**单位不该靠一次观察就永久写死**：这里用"隐含速度是否落在合理步速区间"自行判定，
 * 并把判定依据一并返回，任何一次调用都能自我复核。
 */
const PLAUSIBLE_WALK_M_PER_MIN = [30, 150]; // 1.8 ~ 9 km/h，放宽以覆盖慢走与快走

function checkDurationUnit(distanceMeters, duration) {
  if (distanceMeters == null || duration == null || duration <= 0) {
    return { unit: null, impliedMPerMin: null, plausible: null, note: '缺少 distance 或 duration，无法自检' };
  }
  const asMinute = distanceMeters / duration;
  const asSecond = distanceMeters / (duration / 60);
  const inRange = (v) => v >= PLAUSIBLE_WALK_M_PER_MIN[0] && v <= PLAUSIBLE_WALK_M_PER_MIN[1];

  if (inRange(asMinute) && !inRange(asSecond)) {
    return {
      unit: 'minute',
      impliedMPerMin: Math.round(asMinute),
      plausible: true,
      note: `按分钟理解得 ${Math.round(asMinute)} 米/分，符合合理步速`,
    };
  }
  if (inRange(asSecond) && !inRange(asMinute)) {
    return {
      unit: 'second',
      impliedMPerMin: Math.round(asSecond),
      plausible: true,
      note: `按秒理解得 ${Math.round(asSecond)} 米/分钟，符合合理步速`,
    };
  }
  return {
    unit: 'minute',
    impliedMPerMin: Math.round(asMinute),
    plausible: false,
    note:
      `两种单位假设都不落在合理步速区间（按分钟 ${Math.round(asMinute)} 米/分，` +
      `按秒 ${Math.round(asSecond)} 米/分钟），需人工核对 —— 暂按分钟处理`,
  };
}

/**
 * 规范化 Key。
 *
 * ⚠️ 2026-10-13 实际踩到：从控制台表格复制 Key 时把前面的**制表符和空格**一起带进了
 * 云函数环境变量，导致接口稳定返回 `311 key格式错误`。
 * 当时是靠 `maskSecret` 的输出里那个 `\t ` 才看出来的 ——
 * 如果只报 "keyConfigured: true"，这个 bug 会一直藏着。
 *
 * **不要指望人工粘贴永远干净**：这里统一 trim，并把"发生过 trim"作为诊断信息带出去，
 * 让使用者知道自己的粘贴有问题，而不是悄悄替他们掩盖。
 */
function normalizeKey(raw) {
  if (raw == null) return { key: '', trimmed: false, hadValue: false };
  const s = String(raw);
  const t = s.trim();
  return { key: t, trimmed: t !== s, hadValue: s.length > 0 };
}

function createTencentProvider(opts) {
  opts = opts || {};
  const rawKey = opts.key !== undefined ? opts.key : process.env.MAP_KEY;
  const normalized = normalizeKey(rawKey);
  const key = normalized.key;
  const http = opts.http || require('../http').defaultTransport;
  const baseUrl = opts.baseUrl || DEFAULT_BASE;
  const searchBaseUrl = opts.searchBaseUrl || DEFAULT_SEARCH_BASE;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  return {
    name: 'tencent',
    /** 是否配置了 Key —— 用于自检显示，不泄露值 */
    keyConfigured: Boolean(key),
    keyMasked: key ? maskSecret(key) : null,
    /** Key 前后带有空白（粘贴污染），已自动去除。非空时应在自检结果里提示使用者修正 */
    keyWasTrimmed: normalized.trimmed,

    /**
     * 查询步行路线。
     * @returns {Promise<object>} **调用方必须检查 `ok`**
     */
    async walkingRoute(from, to) {
      const requestUrl =
        `${baseUrl}?from=${from.latitude},${from.longitude}` +
        `&to=${to.latitude},${to.longitude}` +
        `&key=${encodeURIComponent(key)}`;

      const base = {
        provider: 'tencent',
        // ⚠️ 请求 URL 已脱敏，Key 不会出现在结果里
        requestUrl: redact(requestUrl),
        from: { latitude: from.latitude, longitude: from.longitude },
        to: { latitude: to.latitude, longitude: to.longitude },
      };

      if (!key) {
        return Object.assign(base, {
          ok: false,
          reason: 'MAP_KEY_NOT_CONFIGURED',
          message: '云函数环境变量 MAP_KEY 未配置，无法调用地图服务',
          hint: '云开发控制台 → 云函数 → api → 配置 → 环境变量 → 新增 MAP_KEY',
        });
      }

      const started = Date.now();
      let res;
      try {
        res = await http(requestUrl, { timeoutMs });
      } catch (e) {
        return Object.assign(base, {
          ok: false,
          reason: e && e.code === 'UPSTREAM_MAP_FAILED' ? 'UPSTREAM_FAILED' : 'UNKNOWN',
          message: (e && e.message) || String(e),
          details: (e && e.details) || null,
          timingMs: Date.now() - started,
        });
      }

      const timingMs = Date.now() - started;
      const body = res.json || {};
      const status = body.status;
      const message = body.message;
      const routes = (body.result && body.result.routes) || [];
      const route = routes[0] || null;

      const distanceMeters = route && typeof route.distance === 'number' ? route.distance : null;
      const durationRaw = route && typeof route.duration === 'number' ? route.duration : null;
      const unitCheck = checkDurationUnit(distanceMeters, durationRaw);
      const durationMinutes =
        unitCheck.unit === 'second' && durationRaw !== null
          ? Math.round((durationRaw / 60) * 10) / 10
          : durationRaw;

      const polyline = (route && Array.isArray(route.polyline) && route.polyline) || [];
      const steps = (route && Array.isArray(route.steps) && route.steps) || [];

      const ok = status === 0 && Boolean(route) && distanceMeters !== null;

      return Object.assign(base, {
        ok,
        reason: ok ? null : 'UPSTREAM_STATUS_' + String(status),
        // ── 原始字段，逐项核对用 ──
        status,
        message,
        /** 把 status 码翻译成可执行的下一步（只收录实测确认过的码） */
        hint: ok ? null : statusHint(status),
        httpStatus: res.httpStatus,
        timingMs,
        routeCount: routes.length,
        // ── 解析结果，字段路径写在这里，便于核对是否解析错位 ──
        parsedVia: {
          distance: 'result.routes[0].distance',
          duration: 'result.routes[0].duration',
          polyline: 'result.routes[0].polyline',
          steps: 'result.routes[0].steps',
        },
        distanceMeters,
        /** 上游原样返回的 duration（单位由 unitCheck 判定） */
        durationRaw,
        /** 单位自检结果，见 checkDurationUnit 的注释 */
        durationUnit: unitCheck.unit,
        unitCheck,
        /** 归一化后的分钟数 —— 规划器只用这个字段 */
        durationMinutes,
        /** 折线点数：腾讯返回**扁平数组**，每 2 个数一个点，但其中含 0,0 占位，实际有效点见 polylinePointCount */
        polylineNumbers: polyline.length,
        polylinePointCount: polyline.length ? Math.floor(polyline.length / 2) : 0,
        polylineHead: polyline.slice(0, 8),
        stepCount: steps.length,
        firstStep: steps[0] || null,
        // ── 原始返回头部，供人工核对结构与坐标系 ──
        rawHead: String(res.rawBody || '').slice(0, RAW_HEAD_LIMIT),
      });
    },

    /**
     * 地点检索（WebServiceAPI · 搜索服务 `/ws/place/v1/search`）。
     *
     * 用途：**外部 POI 作为候选池**。检索回来的地点一律以
     * `dataSource: 'tencent-poi'`、`verifiedAt: null` 入库 ——
     * 可以安排进游览顺序，但不能作集合点（见 lib/authz.js 的分级）。
     *
     * ⚠️ **响应字段名未实测确认**：POI 主键在不同文档里写作 `id` 或 `_id`，
     * 坐标写作 `lat`/`lng`。这里两种写法都接受，并把**实际命中的那个**
     * 写进 `parsedVia` —— 与步行路线接口同一条纪律：不靠记忆定死，由原始返回核对。
     */
    async searchPlaces(input) {
      input = input || {};
      const keyword = input.keyword || '';
      const pageSize = Math.min(Math.max(input.pageSize || SEARCH_PAGE_SIZE_MAX, 1), SEARCH_PAGE_SIZE_MAX);
      const pageIndex = Math.max(input.pageIndex || 1, 1);

      // boundary 三种写法：周边 / 城市 / 矩形。这里支持前两种（够用且不易写错）
      let boundary;
      if (input.center && typeof input.center.latitude === 'number') {
        const radius = Math.min(Math.max(input.radius || 5000, 100), SEARCH_RADIUS_MAX);
        boundary = `nearby(${input.center.latitude},${input.center.longitude},${radius})`;
      } else if (input.region) {
        // region(城市名, 0)：0 表示不限制结果类型
        boundary = `region(${input.region},0)`;
      } else {
        return {
          ok: false,
          provider: 'tencent',
          reason: 'SEARCH_BOUNDARY_REQUIRED',
          message: '地点检索必须给出范围：center（周边）或 region（城市名）',
          hint: 'center: {latitude, longitude} + radius（米）；或 region: "哈尔滨"',
        };
      }

      const requestUrl =
        `${searchBaseUrl}?keyword=${encodeURIComponent(keyword)}` +
        `&boundary=${encodeURIComponent(boundary)}` +
        `&page_size=${pageSize}&page_index=${pageIndex}` +
        `&key=${encodeURIComponent(key)}`;

      const base = {
        provider: 'tencent',
        // ⚠️ 请求 URL 已脱敏，Key 不会出现在结果里
        requestUrl: redact(requestUrl),
        keyword,
        boundary,
      };

      if (!key) {
        return Object.assign(base, {
          ok: false,
          reason: 'MAP_KEY_NOT_CONFIGURED',
          message: '云函数环境变量 MAP_KEY 未配置，无法调用地图服务',
          hint: '云开发控制台 → 云函数 → api → 配置 → 环境变量 → 新增 MAP_KEY',
        });
      }

      const started = Date.now();
      let res;
      try {
        res = await http(requestUrl, { timeoutMs });
      } catch (e) {
        return Object.assign(base, {
          ok: false,
          reason: e && e.code === 'UPSTREAM_MAP_FAILED' ? 'UPSTREAM_FAILED' : 'UNKNOWN',
          message: (e && e.message) || String(e),
          details: (e && e.details) || null,
          timingMs: Date.now() - started,
        });
      }

      const timingMs = Date.now() - started;
      const body = res.json || {};
      const status = body.status;
      const message = body.message;
      const list = Array.isArray(body.data) ? body.data : [];

      let idVia = null;
      const items = list.map((it) => {
        const rawId = it.id !== undefined ? it.id : it._id;
        if (idVia === null && rawId !== undefined && rawId !== null) {
          idVia = it.id !== undefined ? 'data[].id' : 'data[]._id';
        }
        const loc = it.location || {};
        const lat = loc.lat !== undefined ? loc.lat : loc.latitude;
        const lng = loc.lng !== undefined ? loc.lng : loc.longitude;
        return {
          poiId: rawId === undefined ? null : rawId,
          title: it.title || it.name || null,
          address: it.address || null,
          category: it.category || null,
          location:
            typeof lat === 'number' && typeof lng === 'number'
              ? { latitude: lat, longitude: lng }
              : null,
          /** 仅 nearby 检索时上游返回 */
          distanceMeters: typeof it.distance === 'number' ? it.distance : null,
          adInfo: it.ad_info || null,
          tel: it.tel || null,
        };
      });

      const ok = status === 0;

      return Object.assign(base, {
        ok,
        reason: ok ? null : 'UPSTREAM_STATUS_' + String(status),
        status,
        message,
        hint: ok ? null : statusHint(status),
        httpStatus: res.httpStatus,
        timingMs,
        /** 上游报告的总数（可能远大于本次返回条数） */
        count: typeof body.count === 'number' ? body.count : items.length,
        itemCount: items.length,
        items,
        parsedVia: {
          list: 'data[]',
          id: idVia || '未命中（id 与 _id 都缺失，需核对返回结构）',
          title: 'data[].title',
          location: 'data[].location.lat / .lng',
          distance: 'data[].distance（仅 nearby 检索返回）',
        },
        rawHead: String(res.rawBody || '').slice(0, RAW_HEAD_LIMIT),
      });
    },
  };
}

module.exports = {
  createTencentProvider,
  DEFAULT_BASE,
  RAW_HEAD_LIMIT,
  HttpError,
  /** 导出供测试：单位自检是"数值算错但不报错"这类缺陷的唯一防线 */
  checkDurationUnit,
  STATUS_HINTS,
};

'use strict';

/**
 * 假地图服务 —— 供本地测试使用，**绝不在生产环境启用**。
 *
 * 职责边界（2026-10-13 明确）：
 *   · **本文件只负责"行为"** —— Key 语义、错误码、返回结构、坐标与时间的量纲。
 *     铁律是**必须与真服务遵守同一契约**；替身比真身宽松，缺陷就测不出来
 *     （这一点今天栽过两次：缺 Key 没有修复指引、起终点相同却返回成功）。
 *   · **数据在 `fake-data.js`** —— "有哪些地点"不承载任何断言，
 *     免得本文件看起来像"为了通过某些测试而凑的一堆特判"。
 *
 * 为什么需要替身：外部 HTTP 不该出现在单元测试里（慢、不稳定、要花钱），
 * 但"规划器拿到路线时间之后怎么工作"必须被测到。
 *
 * ⚠️ 本文件**不读任何测试专用的环境变量**。测试通过 `ctx.createMapProvider`
 * 注入工厂（见 lib/invoke.js 的说明），产品代码里不留后门。
 *
 * 输出参数与 lib/geo.js 保持一致（绕行系数 1.3、步速 75 米/分），
 * 因此算出的时间与真实估值同量级，便于对照。
 */

const { haversineMeters, DETOUR_FACTOR } = require('../geo');
const { PLACE_POOL } = require('./fake-data');
const { decodeRoute } = require('./polyline');

const WALK_SPEED_M_PER_MIN = 75;

function createFakeProvider(opts) {
  opts = opts || {};
  const speed = opts.walkSpeedMPerMin || WALK_SPEED_M_PER_MIN;
  /**
   * 让测试模拟"地图服务挂了"。
   *
   * ⚠️ 只通过**显式参数**注入，不读环境变量。
   * 这里曾经有一个 `MAP_FAKE_FAIL=walk` 的后门 —— 那是为了绕开
   * "调用方在模块加载时就解构了 provider 工厂"这个约束。
   * 现在调用方改从 `ctx.createMapProvider` 取工厂，测试直接注入即可，
   * **产品代码里不留测试钩子**。
   */
  const failWith = opts.failWith || null;
  /**
   * 假服务也遵守 Key 语义 —— 包括**前后空白要 trim**。
   * 否则真实世界最常见的粘贴错误（`"\t KEY"`）在本地测不到。
   */
  const rawKey = opts.key !== undefined ? opts.key : process.env.MAP_KEY;
  const key = rawKey == null ? 'FAKE_KEY_OK' : String(rawKey).trim();
  const keyWasTrimmed = rawKey != null && String(rawKey) !== key;

  return {
    name: 'fake',
    keyConfigured: Boolean(key),
    keyMasked: key ? `${key.slice(0, 4)}${'*'.repeat(Math.max(4, key.length - 8))}${key.slice(-4)}` : null,
    keyWasTrimmed,

    /**
     * 各出行方式探针的假实现。
     *
     * ⚠️ **假服务在这里只能返回"无数据"**，不能编造路况 ——
     * 编一份"畅通/拥堵"的假结构，会让人以为这条链路已经实测过了。
     * 而它的真实结构**恰恰是这次探针要去发现的东西**。
     */
    async probeDirections(input) {
      input = input || {};
      return {
        ok: false,
        provider: 'fake',
        reason: 'FAKE_PROVIDER_HAS_NO_TRAFFIC',
        message: '假地图服务没有真实路况数据',
        hint:
          '路况必须用真实 provider 探针确认（自检页的「地图接口探针」）。' +
          '假服务编一份路况出来，只会让人以为这条链路已经验证过了。',
        results: [],
      };
    },

    async walkingRoute(from, to) {
      const base = {
        provider: 'fake',
        requestUrl: '(fake provider: no HTTP request)',
        from: { latitude: from.latitude, longitude: from.longitude },
        to: { latitude: to.latitude, longitude: to.longitude },
      };

      if (!key) {
        return Object.assign(base, {
          ok: false,
          reason: 'MAP_KEY_NOT_CONFIGURED',
          message: '云函数环境变量 MAP_KEY 未配置，无法调用地图服务',
          timingMs: 1,
        });
      }

      if (/^INVALID/i.test(key)) {
        return Object.assign(base, {
          ok: false,
          reason: 'UPSTREAM_STATUS_311',
          status: 311,
          message: 'invalid key（假服务模拟鉴权失败）',
          httpStatus: 200,
          timingMs: 1,
        });
      }

      /**
       * 起终点完全相同 → 上游拒绝。
       * 与腾讯位置服务实测行为一致（`status: 374 起终点坐标错误`）。
       * 假服务必须复现这条，否则本地测不到"调用方需自行判重"这个约束。
       */
      if (from.latitude === to.latitude && from.longitude === to.longitude) {
        return Object.assign(base, {
          ok: false,
          reason: 'UPSTREAM_STATUS_374',
          status: 374,
          message: '起终点坐标错误（假服务模拟）',
          httpStatus: 200,
          timingMs: 1,
        });
      }

      if (failWith) {
        return Object.assign(base, {
          ok: false,
          reason: failWith.reason || 'UPSTREAM_FAILED',
          message: failWith.message || '假服务模拟失败',
          timingMs: 1,
        });
      }

      const straight = haversineMeters(from, to);
      const distanceMeters = Math.round(straight * DETOUR_FACTOR);
      // ⚠️ 与腾讯位置服务保持一致：duration 的单位是**分钟**，不是秒。
      // 详见 lib/map/tencent.js 的 checkDurationUnit —— 那里有实测依据。
      const durationMinutes = Math.max(1, Math.round(distanceMeters / speed));

      /**
       * 折线用**真实的差分压缩格式**造，不要图省事写成绝对坐标。
       *
       * ⚠️ 首版是 `[from.lat, from.lng, 0, 0, to.lat, to.lng]` —— 第三对直接写了
       * 绝对坐标，可格式上它应该是**增量**。这样解出来会得到"起点 + 终点"
       * 这种荒唐值，而**假服务自己不会报错**。
       *
       * **替身比真实情况宽松，缺陷就测不出来** —— 这个坑今天已经踩过两次
       * （内存仓储、编造的 POI 类目）。
       */
      const mid = {
        latitude: (from.latitude + to.latitude) / 2,
        longitude: (from.longitude + to.longitude) / 2,
      };
      const pts = [
        { latitude: from.latitude, longitude: from.longitude },
        mid,
        { latitude: to.latitude, longitude: to.longitude },
      ];
      const polyline = [pts[0].latitude, pts[0].longitude];
      for (let i = 1; i < pts.length; i++) {
        polyline.push(Math.round((pts[i].latitude - pts[i - 1].latitude) * 1e6));
        polyline.push(Math.round((pts[i].longitude - pts[i - 1].longitude) * 1e6));
      }

      /** 分步指引：文案要像真的，但**不编造具体路名**（假服务没有路网数据） */
      const half = Math.round(distanceMeters / 2);
      const steps = [
        {
          instruction: '从起点出发前行',
          act_desc: '',
          dir_desc: '',
          road_name: '',
          distance: half,
          polyline_idx: [0, 2],
        },
        {
          instruction: '继续前行到达终点',
          act_desc: '',
          dir_desc: '',
          road_name: '',
          distance: distanceMeters - half,
          polyline_idx: [2, 4],
        },
      ];

      return Object.assign(base, {
        ok: true,
        reason: null,
        status: 0,
        message: 'fake ok',
        httpStatus: 200,
        timingMs: 1,
        routeCount: 1,
        parsedVia: {
          distance: 'result.routes[0].distance',
          duration: 'result.routes[0].duration',
        },
        distanceMeters,
        durationRaw: durationMinutes,
        durationUnit: 'minute',
        /**
         * 解码后的路线（导航用）—— 与真实 provider 同形。
         * 假的也要**走同一个解码器**，否则调用方在真数据上会撞到没测过的分支。
         */
        route: decodeRoute({
          distance: distanceMeters,
          duration: durationMinutes,
          polyline,
          steps,
        }),
        unitCheck: {
          unit: 'minute',
          impliedMPerMin: Math.round(distanceMeters / durationMinutes),
          plausible: true,
          note: '假服务：距离与时长按 75 米/分 换算，与真实单位约定一致',
        },
        durationMinutes,
        polylineNumbers: polyline.length,
        polylinePointCount: 3,
        polylineHead: polyline,
        stepCount: 1,
        firstStep: { instruction: '(fake) 直行到达', distance: distanceMeters },
        rawHead: JSON.stringify({ status: 0, message: 'fake ok', result: { routes: [{ distance: distanceMeters, duration: durationMinutes }] } }),
      });
    },

    /**
     * 地点检索的假实现。
     *
     * 遵守与真实 provider 相同的契约：
     *   · 缺 Key / Key 非法 → 失败；
     *   · 缺检索范围 → `SEARCH_BOUNDARY_REQUIRED`（**这条要用测试守住**：
     *     写成"没范围就随便搜"会让真实环境的行为在本地测不到）。
     *
     * 返回的假 POI 用哈尔滨真实地名，便于人工核对时一眼看出是假数据。
     */
    async searchPlaces(input) {
      input = input || {};
      const keyword = input.keyword || '';

      const base = { provider: 'fake', keyword, boundary: null, requestUrl: '(fake provider: no HTTP request)' };

      if (!key) {
        return Object.assign(base, {
          ok: false,
          reason: 'MAP_KEY_NOT_CONFIGURED',
          message: '云函数环境变量 MAP_KEY 未配置，无法调用地图服务',
          // 与真实 provider 保持一致：失败必须带可执行的修复指引
          hint: '云开发控制台 → 云函数 → api → 配置 → 环境变量 → 新增 MAP_KEY',
        });
      }

      if (!input.center && !input.region) {
        return Object.assign(base, {
          ok: false,
          reason: 'SEARCH_BOUNDARY_REQUIRED',
          message: '地点检索必须给出范围：center（周边）或 region（城市名）',
          hint: 'center: {latitude, longitude} + radius（米）；或 region: "哈尔滨"',
        });
      }

      const center = input.center || { latitude: 45.7756, longitude: 126.6175 };
      const boundary = input.center
        ? `nearby(${center.latitude},${center.longitude},${input.radius || 5000})`
        : `region(${input.region},0)`;

      const POOL = PLACE_POOL;

      // 关键词过滤：空关键词返回全部（真实上游要求关键词，这里放宽以便测试排序）
      const matched = keyword
        ? POOL.filter((x) => x.title.includes(keyword) || x.category.includes(keyword))
        : POOL;

      const items = matched.map((x) => ({
        poiId: x.poiId,
        title: x.title,
        address: x.address,
        category: x.category,
        location: { latitude: x.latitude, longitude: x.longitude },
        distanceMeters: Math.round(
          haversineMeters(center, { latitude: x.latitude, longitude: x.longitude })
        ),
        adInfo: { city: '哈尔滨市', district: '道里区' },
        tel: null,
      }));

      return Object.assign(base, {
        ok: true,
        reason: null,
        status: 0,
        message: 'fake ok',
        httpStatus: 200,
        timingMs: 1,
        boundary,
        count: items.length,
        itemCount: items.length,
        items,
        parsedVia: {
          list: 'data[]（假服务）',
          id: 'data[].id',
          title: 'data[].title',
          location: 'data[].location.lat / .lng',
        },
        rawHead: JSON.stringify({ status: 0, message: 'fake ok', count: items.length, data: items.slice(0, 1) }),
      });
    },
  };
}

module.exports = { createFakeProvider };

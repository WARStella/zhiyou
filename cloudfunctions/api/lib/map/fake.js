'use strict';

/**
 * 假地图服务 —— 供本地测试使用，**绝不在生产环境启用**。
 *
 * 为什么需要：外部 HTTP 接口不该出现在单元测试里（慢、不稳定、要花钱）。
 * 但"规划器如何在拿到路线时间后工作"必须被测到 —— 否则本地测不到任何东西。
 *
 * 输出参数与 lib/geo.js 保持一致（绕行系数 1.3、步速 75 米/分），
 * 因此假服务算出的时间与真实估值同量级，便于对照。
 */

const { haversineMeters, DETOUR_FACTOR } = require('../geo');

const WALK_SPEED_M_PER_MIN = 75;

function createFakeProvider(opts) {
  opts = opts || {};
  const speed = opts.walkSpeedMPerMin || WALK_SPEED_M_PER_MIN;
  /** 让测试可以模拟"地图服务挂了" */
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

      // 折线用扁平数组，模拟腾讯返回的形态（lat,lng 交替，含 0,0 占位）
      const polyline = [from.latitude, from.longitude, 0, 0, to.latitude, to.longitude];

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

      const POOL = [
        { poiId: 'fake_poi_1', title: '圣索菲亚教堂', category: '旅游景点:教堂', address: '透笼街88号', latitude: 45.7703, longitude: 126.6206 },
        { poiId: 'fake_poi_2', title: '防洪纪念塔', category: '旅游景点:景点', address: '中央大街尽头', latitude: 45.781, longitude: 126.6185 },
        { poiId: 'fake_poi_3', title: '兆麟公园', category: '旅游景点:公园', address: '森林街41号', latitude: 45.7749, longitude: 126.624 },
        { poiId: 'fake_poi_4', title: '老道外中华巴洛克', category: '旅游景点:历史街区', address: '靖宇街', latitude: 45.757, longitude: 126.642 },
        { poiId: 'fake_poi_5', title: '斯大林公园', category: '旅游景点:公园', address: '斯大林街', latitude: 45.783, longitude: 126.619 },
      ];

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

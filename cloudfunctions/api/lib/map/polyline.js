'use strict';

/**
 * 腾讯路线 `polyline` 的**解码**。
 *
 * ── 格式（2026-10-13 用真实录音实测确认，不是猜的）──────────
 *
 *     [lat0, lng0, dLat1, dLng1, dLat2, dLng2, ...]
 *
 *   · 首两个数是**绝对坐标**（GCJ-02，与项目全链路一致）；
 *   · 之后是整数**增量**，单位 **1e-6 度**。
 *
 * ── 怎么确认的 ────────────────────────────────────────────
 *
 * 把 `test/fixtures/upstream/direction-walking-central-avenue.json`
 * 里的 120 个数解出来，末点是 `45.781070, 126.618451` ——
 * **正是这次请求的目的地防洪纪念塔**（45.7810, 126.6185）。
 *
 * **末点落在已知目的地**，这不是巧合，是格式对了。
 * 另外 120 个数解出 60 个点，相邻点跨度全部合理（无跳变）。
 *
 * ── `steps[].polyline_idx` 是**数组下标**，不是点下标 ──────────
 *
 * 录音里 `polyline_idx` 最大到 75，而点数只有 60 —— 所以它只可能是
 * 扁平数组的下标。除以 2 得到点下标：`[36,75]` → 点 18..37。
 * 各步的点数与距离也大致成比例（62m/4点、110m/6点、212m/8点、245m/20点），
 * 与"下标"这一解释吻合。
 */

/** 增量单位：1e-6 度 */
const DELTA_SCALE = 1e6;

/** 这条折线是否是差分压缩格式（首两个绝对、其余为增量） */
function isCompressed(flat) {
  if (!Array.isArray(flat) || flat.length < 2) return false;
  const [lat, lng] = flat;
  // 首点必须是合法的经纬度
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  // 第二对之后必须是整数增量（腾讯返回的就是整数）
  for (let i = 2; i < flat.length; i++) {
    if (!Number.isInteger(flat[i])) return false;
  }
  return true;
}

/**
 * 解出坐标点数组。
 *
 * @param {number[]} flat 上游返回的扁平数组
 * @returns {{latitude:number, longitude:number}[]} 解码后的点；输入非法时返回 []
 */
function decodePolyline(flat) {
  if (!Array.isArray(flat) || flat.length < 2) return [];

  // 已经是点数组（`[{latitude, longitude}]` 或 `[[lat,lng]]`）→ 直接规整
  if (typeof flat[0] === 'object') {
    return flat
      .map((p) =>
        Array.isArray(p)
          ? { latitude: p[0], longitude: p[1] }
          : { latitude: p.latitude, longitude: p.longitude }
      )
      .filter((p) => typeof p.latitude === 'number' && typeof p.longitude === 'number');
  }

  if (!isCompressed(flat)) return [];

  let lat = flat[0];
  let lng = flat[1];
  const points = [{ latitude: lat, longitude: lng }];
  for (let i = 2; i + 1 < flat.length; i += 2) {
    lat += flat[i] / DELTA_SCALE;
    lng += flat[i + 1] / DELTA_SCALE;
    points.push({ latitude: lat, longitude: lng });
  }
  return points;
}

/**
 * 把一条路线解成**导航可用的形状**：完整路径 + 分步指引。
 *
 * ⚠️ 这里只做"解码与对齐"，**不生成任何文案** ——
 * `instruction` 一律用上游的原话。导航指令是不能自己编的：
 * 编错一个路口，用户就多走一公里。
 *
 * @param {object} route 上游 `result.routes[0]`
 * @returns {{points, steps, distanceMeters, durationMinutes}}
 */
function decodeRoute(route) {
  route = route || {};
  const points = decodePolyline(route.polyline);

  const steps = (Array.isArray(route.steps) ? route.steps : []).map((s, i) => {
    const idx = Array.isArray(s.polyline_idx) ? s.polyline_idx : null;
    /**
     * `polyline_idx` 是**扁平数组下标**（见文件头的说明），除以 2 得点下标。
     * 越界一律夹到合法范围 —— 上游截断过（录音里就有），不能因此崩。
     */
    const from = idx ? Math.max(0, Math.min(points.length - 1, Math.floor(idx[0] / 2))) : 0;
    const to = idx
      ? Math.max(from, Math.min(points.length - 1, Math.floor(idx[1] / 2)))
      : points.length - 1;
    return {
      seq: i + 1,
      /** 上游原话，一字不改 */
      instruction: s.instruction || null,
      actDesc: s.act_desc || null,
      dirDesc: s.dir_desc || null,
      roadName: s.road_name || null,
      distanceMeters: typeof s.distance === 'number' ? s.distance : null,
      /** 这一段对应路径上的哪几个点 —— 导航时高亮当前段要用 */
      fromIndex: from,
      toIndex: to,
      points: points.slice(from, to + 1),
    };
  });

  return {
    points,
    steps,
    distanceMeters: typeof route.distance === 'number' ? route.distance : null,
    durationMinutes: typeof route.duration === 'number' ? route.duration : null,
    /** 上游给的总体走向（"西北"），没有就 null */
    direction: route.direction || null,
    /** 解码是否成功 —— 路径画不出来时要能说清是"没数据"还是"解不开" */
    decoded: points.length > 0,
    pointCount: points.length,
  };
}

module.exports = { decodePolyline, decodeRoute, isCompressed, DELTA_SCALE };

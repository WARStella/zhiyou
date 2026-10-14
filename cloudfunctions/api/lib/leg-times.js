'use strict';

/**
 * 把**真实出行耗时**接进规划 —— 用户要求的那一步。
 *
 * ── 之前是什么状态（2026-10-14 之前）──────────────────────
 *
 *   · `trip.plan` 恒按**步行速度换算的估算**算每一段
 *     （`trip.js` 里写着"首版恒为 walking"）；
 *   · `lib/mode-choice.js` 写好了、测过了，但**整个云函数没有一处调用它**；
 *   · 距离矩阵与公交两个 provider 也没接进规划。
 *
 * 结果是：界面上看不出"这段其实坐地铁更快"，而哈尔滨的景点跨区
 * （中央大街在道里、冰雪大世界在松北），步行根本走不过去。
 *
 * ── 这一层做什么 ──────────────────────────────────────────
 *
 * 对每一段（相邻两站之间）取**各方式的真实耗时**，然后交给
 * `mode-choice.chooseMode` 选一种。方式与来源：
 *
 *   walking / bicycling / driving —— 腾讯**距离矩阵**（一次请求拿三种）
 *   transit                      —— 高德**公交路径规划**（含地铁）
 *
 * ⚠️ 公交只有高德有 —— 腾讯距离矩阵按官方文档**明确没有公交**
 * （见 `lib/map/matrix-modes.js`）。所以这一层天然跨两个供应商，
 * 每条候选都带 `provider` 字段，答辩时要能说清"这个数是哪家给的"。
 *
 * ── 三条纪律 ──────────────────────────────────────────────
 *
 *   ① **取不到就标取不到，不拿别的方式冒充。** 公交不可达就如实排除，
 *      而不是拿驾车耗时顶上（那会让人按一个不存在的时间安排行程）。
 *   ② **来源必须可区分。** `matrix` / `transit` / `cache` / `estimated` 四态，
 *      界面要让用户看得见"这是实测还是估算"。
 *   ③ **估算只作最后的兜底**，且带上 `estimated` 标记 ——
 *      本项目实测过"直线 10 米 / 实际步行 76 米"，短距离估算根本不可信。
 */

const modeChoice = require('./mode-choice');
const {
  TRAVEL_MODE,
  findLegRecord,
  withLegRecord,
  walkMinutes,
  haversineMeters,
  WALK_SOURCE,
  MAX_WALK_METERS,
} = require('./geo');const { MATRIX_MODES } = require('./map/matrix-modes');

/** 距离矩阵能给的三种方式（与 provider 的单一事实来源保持一致） */
const MATRIX_MODE_SET = MATRIX_MODES;

/**
 * 直线上限：超过它就不必问驾车/步行了。
 *
 * 依据：本项目单城（哈尔滨），行程内相邻两站的直线距离通常在几公里内。
 * 设一个上限是为了**不浪费配额**，不是为了拒绝 —— 超限时仍会问公交，
 * 因为"离得远"恰恰是公交最该出场的场景。
 */
const MAX_MATRIX_STRAIGHT_M = 20000;

/** 直线距离近到一定程度就不问驾车 —— 几百米内开车没意义，纯浪费配额 */
const MIN_DRIVING_STRAIGHT_M = 800;

/**
 * 为一段取各方式的真实耗时。
 *
 * @param {object} p
 * @param {{latitude,longitude}} p.fromPoint   起点坐标（可能是"我的位置"，不一定是地点）
 * @param {object} p.toPlace                   终点地点（含 _id / location）
 * @param {object} [p.fromPlace]               起点地点（有 _id 时可用缓存）
 * @param {object} p.providers                 `{ map, transit }` 两个 provider
 * @param {object} [p.opts]                    `{ weather, preference, skipDriving, allowTransit }`
 * @returns {Promise<{candidates:Array, choice:object}>}
 */
async function legTravelTimes(p) {
  const providers = p.providers || {};
  const opts = p.opts || {};
  const toPlace = p.toPlace;
  const fromPlace = p.fromPlace || null;
  const cacheHolder = fromPlace || null;

  const candidates = [];
  /** 记下哪些数来自缓存，便于在结果里区分来源 */
  const fromCache = [];
  /**
   * 实际发出的上游调用次数 —— **由这里如实累加**，
   * 不靠"有没有产生候选"去反推（反推会在失败时漏计，
   * 而配额统计恰恰最需要把失败也算进去）。
   */
  const calls = { matrix: 0, transit: 0 };

  if (!toPlace || !toPlace.location) {
    return { candidates: [], choice: modeChoice.chooseMode([], opts) };
  }

  // ── 1) 先看缓存：每种方式有没有已记录的耗时 ──
  const cached = {};
  if (cacheHolder) {
    for (const mode of [TRAVEL_MODE.WALKING, TRAVEL_MODE.BICYCLING, TRAVEL_MODE.DRIVING, TRAVEL_MODE.TRANSIT]) {
      const rec = findLegRecord(cacheHolder, toPlace._id, mode);
      if (rec) {
        cached[mode] = rec;
        fromCache.push(mode);
        candidates.push({ mode, minutes: rec.minutes, meters: rec.meters, provider: 'cache', source: rec.source });
      }
    }
  }

  // ── 2) 距离矩阵：一次请求拿 walking / bicycling / driving 三种 ──
  const straight = haversineMeters(
    p.fromPoint || (fromPlace && fromPlace.location),
    toPlace.location
  );

  const needMatrix =
    providers.map &&
    typeof providers.map.distanceMatrix === 'function' &&
    straight !== null &&
    straight <= MAX_MATRIX_STRAIGHT_M;

  if (needMatrix) {
    /** 只问还没有缓存的那些方式；骑车在雨雪天不划算，交给 mode-choice 去排 */
    const modesToAsk = MATRIX_MODE_SET.filter((m) => !cached[m]);
    if (opts.skipDriving || (straight !== null && straight < MIN_DRIVING_STRAIGHT_M)) {
      /** 太近就不问驾车 —— 省一次计算 */
      const idx = modesToAsk.indexOf(TRAVEL_MODE.DRIVING);
      if (idx >= 0) modesToAsk.splice(idx, 1);
    }

    for (const mode of modesToAsk) {
      const origin = p.fromPoint || (fromPlace && fromPlace.location);
      let r;
      calls.matrix += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        r = await providers.map.distanceMatrix(origin, [toPlace.location], mode);
      } catch (e) {
        r = { ok: false, reason: 'THREW', message: (e && e.message) || String(e) };
      }
      const el = r && r.ok && r.elements && r.elements[0] ? r.elements[0] : null;

      /**
       * ⚠️ 单位自检不通过的候选**一律拒绝**（2026-10-14）。
       *
       * 用户实测报："14426 米、24.7 分钟、显示为步行" ——
       * 那等于 **35 km/h 的步行**，人会按一个不可能的速度安排行程。
       *
       * `distanceMatrix` 会把"隐含速度落在合理区间外"标成
       * `unitCheck.plausible === false`，这里据此拒绝，而不是照单全收。
       *
       * 宁可这一段没有步行候选（界面会说"没取到方案"），
       * 也不能给一个荒谬的数。
       */
      const unitBad = el && el.unitCheck && el.unitCheck.plausible === false;

      if (el && el.usable && el.durationMinutes !== null && !unitBad) {
        candidates.push({
          mode,
          minutes: el.durationMinutes,
          meters: el.distanceMeters,
          provider: 'tencent-matrix',
          source: 'upstream',
        });
      } else if (unitBad) {
        candidates.push({
          mode,
          ok: false,
          provider: 'tencent-matrix',
          reason: `上游返回的耗时与「${mode}」不符：${el.unitCheck.note}`,
          excludedBy: 'IMPLAUSIBLE_SPEED',
          impliedSpeedMPerMin: el.unitCheck.impliedSpeedMPerMin,
          rawDuration: el.durationRaw,
          rawDistanceMeters: el.distanceMeters,
        });
      } else {
        /**
         * ⚠️ 如实排除，**不拿别的方式顶上**。
         *
         * `usable: false` 的两种情况都要说清：`NO_ROAD_NEARBY` 时上游给的
         * `distance` 是**直线距离**（`duration` 缺失）；`duration` 缺失时
         * 我们连耗时都没有。两种都不该猜。
         */
        candidates.push({
          mode,
          ok: false,
          provider: 'tencent-matrix',
          reason:
            el && el.failureReason === 'NO_ROAD_NEARBY'
              ? '附近没有可吸附的道路，上游未给出路面耗时'
              : el && el.durationMinutes === null
                ? '上游未返回该方式的耗时'
                : (r && (r.message || r.reason)) || '取不到该方式的用时',
        });
      }
    }
  }

  // ── 3) 公交（含地铁）：高德，逐段一次请求 ──
  const wantTransit = opts.allowTransit !== false;
  const transitNeedsFetch = wantTransit && !cached[TRAVEL_MODE.TRANSIT];
  /**
   * ⚠️ 没配 `AMAP_KEY` 时**连请求都不发**（2026-10-14）。
   *
   * 首版只看 provider 有没有 `route` 方法就去调，于是本地测试
   * （注入的 transit provider 为 null → 回落到真实高德）会**去打外网**：
   * 慢、不稳、还被记成"上游失败"，把真正的断言盖掉。
   *
   * 用一个便宜的 `keyStatus()` 先探一下就能避免 —— provider 本来就提供它。
   */
  const transitReady =
    providers.transit &&
    typeof providers.transit.route === 'function' &&
    (typeof providers.transit.keyStatus !== 'function' ||
      (providers.transit.keyStatus() || {}).configured === true);

  if (transitNeedsFetch && transitReady && opts.transitCity) {
    const origin = p.fromPoint || (fromPlace && fromPlace.location);
    let tr;
    calls.transit += 1;
    try {
      tr = await providers.transit.route({
        from: origin,
        to: toPlace.location,
        city: opts.transitCity,
        strategy: opts.transitStrategy,
      });
    } catch (e) {
      tr = { ok: false, reason: 'THREW', message: (e && e.message) || String(e) };
    }

    if (tr && tr.ok && tr.best && tr.best.durationMinutes !== null) {
      candidates.push({
        mode: TRAVEL_MODE.TRANSIT,
        minutes: tr.best.durationMinutes,
        meters: tr.best.walkingMeters,
        provider: 'amap-transit',
        source: 'upstream',
        /** 换乘细节 —— 界面要能说清"坐几号线、在哪个口" */
        transit: {
          lineNames: (tr.best.steps || []).filter((s) => s.kind === 'transit').map((s) => s.lineName).filter(Boolean),
          hasSubway: Boolean(tr.best.hasSubway),
          entranceName: pickStep(tr.best.steps, 'entrance-exit', 'entranceName'),
          exitName: pickStep(tr.best.steps, 'entrance-exit', 'exitName'),
          costYuan: tr.best.costYuan,
          walkingMeters: tr.best.walkingMeters,
          transferCount: tr.best.transferCount,
        },
      });
    } else {
      candidates.push({
        mode: TRAVEL_MODE.TRANSIT,
        ok: false,
        provider: 'amap-transit',
        reason:
          tr && tr.emptyReason === 'NO_TRANSIT_ROUTE'
            ? '这两点之间没有公交方案'
            : (tr && (tr.hint || tr.message)) || '公交方案取不到',
      });
    }
  }

  // ── 4) 兜底：一种可用候选都没有时，给一个**明确标注为估算**的步行 ──
  const usableCount = candidates.filter((c) => c.ok !== false && typeof c.minutes === 'number').length;
  if (!usableCount) {
    const straight = haversineMeters(
      p.fromPoint || (fromPlace && fromPlace.location),
      toPlace.location
    );

    /**
     * ⚠️ **超过 MAX_WALK_METERS 就不给"步行"这个候选**（2026-10-14 修）。
     *
     * 用户报的症状：从"我的位置"到冰雪大世界 **12618 米，显示的却是步行**。
     *
     * 12.6 公里步行约 2 小时 40 分 —— **任何情况下都不该建议**。
     * 但第一版的兜底是无条件的：只要没有可用候选就塞一个"步行估算"，
     * 于是**矩阵取不到数据时就会给出这种荒谬建议**，而且它还带着
     * "估算"标签，看起来像是认真算过。
     *
     * 诚实比"有个数"重要：宁可显示"这段取不到方案"，也不给一个
     * 人根本不会照做的建议。
     *
     * `MAX_WALK_METERS`（3000 米）是项目里已有的判据 ——
     * `geo.js` 用它排除"明显不合理的步行集合候选点"。同一个道理。
     */
    if (straight !== null && straight > MAX_WALK_METERS) {
      const km = Math.round(straight / 100) / 10;
      candidates.push({
        mode: TRAVEL_MODE.WALKING,
        ok: false,
        provider: 'estimate',
        /**
         * ⚠️ 公里数是**算出来的**，不写死 —— 我第一版在这里写了
         * "12 公里步行不可行"，而实际距离会变（实测那条是 17 公里）。
         * 写死的数字在别的路段上就是错的。
         */
        reason:
          `直线约 ${Math.round(straight)} 米（${km} 公里），超过步行上限 ${MAX_WALK_METERS} 米 —— ` +
          `不给步行建议（${km} 公里步行约 ${Math.round(straight / 75 / 60 * 10) / 10} 小时）`,
        /** 让别人看得出这是**按距离排除**，不是取数失败 */
        excludedBy: 'TOO_FAR_TO_WALK',
        straightMeters: Math.round(straight),
      });
    } else {
      const w = walkMinutes(fromPlace || { location: p.fromPoint }, toPlace, opts.params || {});
      if (w) {
        candidates.push({
          mode: TRAVEL_MODE.WALKING,
          minutes: w.minutes,
          meters: w.meters,
          provider: 'estimate',
          /** ⚠️ 必须是 estimated —— 界面要能让用户看出"这不是实测" */
          source: WALK_SOURCE.ESTIMATED,
          reason: '取不到真实耗时，按直线距离估算（短距离下偏差可能很大）',
        });
      }
    }
  }

  const choice = modeChoice.chooseMode(candidates, {
    preference: opts.preference,
    weather: opts.weather,
  });

  /**
   * ⚠️ 把选中的候选**充实回完整形态**（2026-10-14）。
   *
   * `mode-choice.normalize()` 刻意只保留 `{mode, minutes, meters}` ——
   * 它是纯决策函数，不该知道 provider、来源、换乘细节这些事。
   * 但那意味着 `choice.chosen` 上**没有 `source` 与 `provider`**，
   * 而调用方（`trip.plan`）需要它们来回答"这个数是实测还是估算"。
   *
   * 症状很有欺骗性：`source` 拿到 `undefined`，于是回落到默认值 `'upstream'`，
   * **界面上把踏勘实测显示成"接口预测"**，而且不报错。
   *
   * 所以在这一层按 `mode` 把它认回来 —— 同一段里同一方式只有一个候选。
   */
  const enriched = enrichChosen(choice, candidates);

  return {
    candidates,
    choice: enriched,
    fromCache,
    calls,
    straightMeters: straight === null ? null : Math.round(straight),
  };
}

/** 把 `choice.chosen` 与它在原始候选里的那条合并（保留 provider / source / transit 细节） */
function enrichChosen(choice, candidates) {
  if (!choice || !choice.chosen) return choice;
  const full = (candidates || []).find((c) => c && c.mode === choice.chosen.mode && c.ok !== false);
  if (!full) return choice;
  return Object.assign({}, choice, {
    chosen: Object.assign({}, choice.chosen, {
      provider: full.provider || null,
      source: full.source || null,
      /** 公交的换乘细节（几号线、哪个口）—— 只在 transit 上有 */
      transit: full.transit || null,
      /**
       * 候选自己的说明（如"取不到真实耗时，按直线距离估算（短距离下偏差可能很大）"）。
       *
       * ⚠️ 与 `choice.reason` 是**两件事**，都要留着：
       *   · `choice.reason` 说"**为什么选它**"（比第二快的省了几分钟）
       *   · `candidate.reason` 说"**这个数可不可信**"（估算？上游没给时长？）
       *
       * 只留前者的话，用户看不到"这是估算" —— 而这正是本项目
       * 反复强调要能区分的东西（同一条路直线估算与真实路线差 1.35 倍，
       * 短距离下差 7.6 倍）。
       */
      candidateReason: full.reason || null,
    }),
  });
}

/** 从步骤里取某个字段（找不到返回 null，不抛错） */
function pickStep(steps, kind, field) {
  const hit = (steps || []).find((s) => s && s.kind === kind);
  return hit ? hit[field] || null : null;
}

/**
 * 把一批结果写回地点缓存 —— **只写上游取回的真实值**，不写估算。
 *
 * 估算写进缓存会让"一次估算变成永久事实"（`docs/01 §2.2` 的写入规则：
 * "取不到时不写缓存 —— 否则一次估算会变成永久事实"）。
 *
 * @param {object} repo
 * @param {Array} entries `[{ fromPlace, toPlace, candidates }]`
 * @returns {Promise<number>} 写了几条
 */
async function persistLegTimes(repo, C, entries) {
  let written = 0;
  for (const entry of entries || []) {
    if (!entry.fromPlace || !entry.fromPlace._id || !entry.toPlace || !entry.toPlace._id) continue;
    let list = entry.fromPlace.walkableTo || [];
    let touched = false;

    for (const c of entry.candidates || []) {
      /** 只缓存真实来源；估算与失败都不写 */
      if (c.ok === false) continue;
      if (c.source !== 'upstream') continue;
      if (typeof c.minutes !== 'number' || c.minutes <= 0) continue;

      /**
       * ⚠️ **不覆盖可信度更高的记录**（2026-10-14 修）。
       *
       * `source` 是数据的一部分：
       *   survey（踏勘实测）> upstream（接口预测）> estimated（直线估算）
       *
       * 第一版无脑覆盖，于是**踏勘实测的步行时间被"接口取回值"顶掉了** ——
       * 数值可能差不多（同一段路），但标签从 `survey` 降成 `upstream`，
       * 而下游一切"这个数有多可信"的判断都建立在它上面。
       *
       * 数值本身不会被改坏，所以这种错**没有任何症状** —— 只能靠纪律挡住。
       */
      const existing = findLegRecord({ walkableTo: list }, entry.toPlace._id, c.mode);
      if (existing && existing.source === 'survey') continue;

      list = withLegRecord(
        { walkableTo: list },
        entry.toPlace._id,
        { minutes: c.minutes, meters: c.meters, mode: c.mode, source: 'upstream' }
      );
      touched = true;
    }

    if (touched) {
      // eslint-disable-next-line no-await-in-loop
      await repo.update(C.PLACES, entry.fromPlace._id, { walkableTo: list });
      written += 1;
    }
  }
  return written;
}

/**
 * 为一条行程取回**所有段**的真实耗时。
 *
 * @param {object} p
 * @param {Array} p.places       按游览顺序的地点（含 _id / location）
 * @param {{latitude,longitude}} [p.startPoint] 出发位置（"我的位置"）
 * @param {object} p.providers
 * @param {object} [p.opts]
 * @returns {Promise<{legs:Array, entries:Array, calls:{matrix:number, transit:number}}>}
 */
async function resolveTripLegTimes(p) {
  const places = p.places || [];
  const opts = p.opts || {};
  const legs = [];
  const entries = [];
  const calls = { matrix: 0, transit: 0 };

  for (let i = 0; i < places.length; i++) {
    const toPlace = places[i];
    const fromPlace = i > 0 ? places[i - 1] : null;
    /** 第一段的起点是"我的位置"，不是地点 */
    const fromPoint = i === 0 ? p.startPoint || null : null;

    if (i === 0 && !fromPoint) {
      /** 没有出发位置时第一段不计 —— 与实际规划器的行为保持一致 */
      legs.push({ toPlaceId: toPlace._id, candidates: [], choice: null, skipped: 'NO_START_POINT' });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const r = await legTravelTimes({
      fromPoint,
      fromPlace,
      toPlace,
      providers: p.providers,
      opts: Object.assign({}, opts, { transitCity: opts.transitCity }),
    });

    calls.matrix += r.calls.matrix;
    calls.transit += r.calls.transit;

    legs.push({
      fromPlaceId: fromPlace ? fromPlace._id : null,
      toPlaceId: toPlace._id,
      candidates: r.candidates,
      choice: r.choice,
      straightMeters: r.straightMeters,
    });
    entries.push({ fromPlace, toPlace, candidates: r.candidates });
  }

  return { legs, entries, calls };
}

module.exports = {
  resolveTripLegTimes,
  legTravelTimes,
  persistLegTimes,
  pickStep,
  MAX_MATRIX_STRAIGHT_M,
  MIN_DRIVING_STRAIGHT_M,
};

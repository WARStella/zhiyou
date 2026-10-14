'use strict';

/**
 * 距离矩阵探针 —— 回答三个**至今只能靠算术倒推**的问题。
 *
 * ── 为什么现在才做 ────────────────────────────────────────
 *
 * `lib/map/tencent.js` 的距离矩阵里，`duration` 的单位一直标注着
 * "真实行为由 `map.matrixProbe` 实测确认" —— 而这个探针**从没做过**。
 *
 * 代价在 2026-10-14 显现：用户实测看到「步行 24.7 分钟 14426 米」
 * （= 35 km/h 的步行）。我靠纯算术倒推才知道原始值是 `1482`，
 * 也不知道上游到底返回了什么。
 *
 * **算术倒推能猜到结论，但猜不出原因。** 这个探针就是去拿原始值。
 *
 * ── 它要回答的三个问题 ────────────────────────────────────
 *
 *   ① **`duration` 的单位**是秒还是分钟？
 *   ② **有没有尊重 `mode`？** —— 同一对起终点，三种方式的耗时
 *      如果**几乎一样**，说明 mode 被忽略了。
 *   ③ **`duration` 与 `distance` 是不是同一段路？** ——
 *      用"隐含速度"核对（步行 75 米/分左右，驾车几百米/分）。
 *
 * ── 设计上的一条纪律 ──────────────────────────────────────
 *
 * **三种方式各发一次请求，并把三组原始值并排列出来。**
 * 只发一次看不出"mode 被忽略"——那正是这次问题的形态：
 * 单看 walking 那一组，675 米/分会被当成"单位错了"；
 * 三组并排才看得出"walking 和 driving 拿到的是同一个数"。
 */

const resp = require('../lib/resp');
const { CODES, assert } = require('../lib/errors');
const { createMapProvider } = require('../lib/map');

/**
 * 默认探针起终点：中央大街 → 冰雪大世界方向。
 *
 * 与 `transit-probe` 用同一对点，便于**交叉核对**：
 * 公交那次实测是「地铁 69.5 分 / 步行距离 3442 米」，
 * 若矩阵给出的步行耗时与之差得离谱，说明矩阵那条路不可信。
 */
const DEFAULT_FROM = { latitude: 45.7756, longitude: 126.6175 };
const DEFAULT_TO = { latitude: 45.8029, longitude: 126.5353 };

/** 三种方式各问一次 —— 这是能看出"mode 被忽略"的唯一办法 */
const PROBE_MODES = ['walking', 'bicycling', 'driving'];
/** 各方式的合理速度区间（米/分钟）—— 与 lib/mode-choice.js 的口径一致 */
const SPEED_RANGE = {
  walking: [40, 120],
  bicycling: [150, 400],
  driving: [200, 1200],
};

const MODE_LABEL = { walking: '步行', bicycling: '骑行', driving: '驾车' };

function endpointOf(requestUrl) {
  if (!requestUrl) return null;
  const m = String(requestUrl).match(/^https?:\/\/([^?]+)/);
  return m ? m[1] : null;
}

/** 从 provider 的返回里取第一格，并把可核对的字段都列出来 */
function summarize(target, r) {
  const el = r && r.elements && r.elements[0] ? r.elements[0] : null;
  const out = {
    mode: target.mode,
    ok: Boolean(r && r.ok),
    reason: (r && r.reason) || null,
    message: (r && r.message) || null,
    endpoint: endpointOf(r && r.requestUrl),
    httpStatus: (r && r.httpStatus) !== undefined ? r.httpStatus : null,
    timingMs: (r && r.timingMs) !== undefined ? r.timingMs : null,
    /** 上游原始值 —— **这是本次探针最要紧的东西** */
    distanceMeters: el ? el.distanceMeters : null,
    durationRaw: el ? el.durationRaw : null,
    durationMinutes: el ? el.durationMinutes : null,
    unitCheck: el ? el.unitCheck || null : null,
    usable: el ? el.usable : null,
    failureReason: el ? el.failureReason : null,
    rawStatus: el ? el.rawStatus : null,
  };
  if (el && el.unitCheck && el.unitCheck.impliedSpeedMPerMin !== null) {
    out.impliedSpeedMPerMin = el.unitCheck.impliedSpeedMPerMin;
  }
  return out;
}

async function probe(ctx) {
  const { env } = ctx;
  const p = ctx.payload || {};
  const from = p.from || DEFAULT_FROM;
  const to = p.to || DEFAULT_TO;

  // 探针会真实调用外部服务（可能产生费用），仅在开发环境开放
  assert(env === 'dev', CODES.FORBIDDEN_ENV, `当前环境为 ${env}，距离矩阵探针仅限 dev`);

  /**
   * ⚠️ 调用约定必须与 `actions/map.js` 的 `map.probe` 一致：
   *   `makeProvider(name, opts)`
   *
   * 我第一版写成 `makeProvider(undefined, {})` —— 与既有探针**两种约定**，
   * 于是各处的默认值处理走的是不同分支。
   * `key: p.overrideKey` 这一项是照抄 `map.probe` 的：只在显式传入时覆盖，
   * 否则用环境变量（用于跑"无效 Key"那种情形）。
   */
  const providerName = p.provider || process.env.MAP_PROVIDER || 'tencent';
  const makeProvider = (name, opts) =>
    (ctx.createMapProvider || createMapProvider)(name || providerName, opts);
  const provider = makeProvider(providerName, {
    key: p.overrideKey,
    timeoutMs: p.timeoutMs,
  });

  const steps = [];

  // ── 第 1 层：Key（不发请求）──
  const keyStatus = typeof provider.keyStatus === 'function' ? provider.keyStatus() : { configured: null };
  steps.push({
    step: 'api-key',
    ok: keyStatus.configured === true,
    detail:
      keyStatus.configured === true
        ? `MAP_KEY 已配置（${keyStatus.masked}${keyStatus.trimmed ? '，已去除前后空白' : ''}）`
        : keyStatus.configured === null
          ? '这个 provider 没有提供 keyStatus()，无法判断 Key 状态（先补上再跑探针）'
          : 'MAP_KEY 未配置 —— 云开发控制台 → 云函数 → api → 配置 → 环境变量 → 新增 MAP_KEY（腾讯位置服务 WebService Key）',
  });

  if (keyStatus.configured !== true) {
    return resp.ok({
      ok: false,
      verdict: 'KEY_MISSING',
      steps,
      hint: '先配 MAP_KEY 再点这个探针',
    });
  }

  // ── 第 2 层：三种方式各问一次 ──
  const probeFrom = { latitude: from.latitude, longitude: from.longitude };
  const toList = [{ latitude: to.latitude, longitude: to.longitude }];
  const results = [];
  let matrixCalls = 0;

  for (const mode of PROBE_MODES) {
    let r;
    try {
      // eslint-disable-next-line no-await-in-loop
      r = await provider.distanceMatrix(probeFrom, toList, mode);
    } catch (e) {
      r = { ok: false, reason: 'THREW', message: (e && e.message) || String(e) };
    }
    matrixCalls += 1;
    results.push(summarize({ mode }, r));
  }

  const anyOk = results.some((x) => x.ok && x.usable);
  steps.push({
    step: 'upstream',
    ok: anyOk,
    detail: anyOk
      ? `矩阵可用，${results.filter((x) => x.ok && x.usable).length} / ${PROBE_MODES.length} 种方式拿到数据`
      : '三种方式都没拿到数据 —— 看 results 里的 reason 与 message',
    raw: { matrixApiCalls: matrixCalls, endpoint: results.find((x) => x.endpoint)?.endpoint || null },
  });

  // ── 第 3 层：单位与 mode 的判定 ──

  /**
   * ① `mode` 有没有被尊重？
   *
   * 判据：三种方式的**耗时是否几乎相同**。
   * 同一对起终点，步行与驾车耗时本来就该差一个数量级
   * （步行 75 米/分 vs 驾车几百米/分）。
   *
   * ⚠️ 这是本次问题的**核心判据**：
   * 单看 walking 的 675 米/分会以为"单位错了"，
   * 三组并排才看得出"walking 拿到的是驾车的时间"。
   */
  const usable = results.filter((x) => x.ok && x.usable && typeof x.durationRaw === 'number' && x.durationRaw > 0);
  let modeRespected = null;
  let modeNote = '未测：可用数据少于两种方式，无法比对';
  if (usable.length >= 2) {
    const raws = usable.map((x) => x.durationRaw);
    const max = Math.max(...raws);
    const min = Math.min(...raws);
    /** 允许 20% 的差异（路况与路线本就略有不同），超过就说明方式有区别 */
    const ratio = min > 0 ? max / min : Infinity;
    modeRespected = ratio > 1.2;
    modeNote = modeRespected
      ? `三种方式的耗时确实不同（最大/最小 = ${ratio.toFixed(2)}），**mode 被尊重**`
      : `三种方式的耗时几乎相同（最大/最小 = ${ratio.toFixed(2)}）—— ` +
        '**mode 很可能被忽略了**：上游对步行也返回了驾车耗时';
  }
  steps.push({ step: 'mode-respected', ok: modeRespected, detail: modeNote });

  /**
   * ② 单位：只用**通过合理性自检**的那些方式判。
   *
   * 若某个方式两种解释都不合理（`plausible === false`），
   * 那它的单位无从判定 —— 而原因往往正是 ①（mode 被忽略）。
   */
  const unitVotes = usable.filter((x) => x.unitCheck && x.unitCheck.plausible === true);
  const unitSeconds = unitVotes.filter((x) => x.unitCheck.unit === 'seconds').length;
  const unitMinutes = unitVotes.filter((x) => x.unitCheck.unit === 'minutes').length;
  const implausible = usable.filter((x) => x.unitCheck && x.unitCheck.plausible === false);

  let unitVerdict = null;
  let unitDetail;
  if (!unitVotes.length) {
    unitDetail =
      '未测：没有一种方式的隐含速度落在合理区间 —— ' +
      (implausible.length ? '见 implausible（往往意味着 mode 被忽略）' : '数据不足');
  } else if (unitSeconds && !unitMinutes) {
    unitVerdict = 'seconds';
    unitDetail = `判为**秒**（${unitSeconds} 种方式的隐含速度合理，且都只有"按秒"解释合理）`;
  } else if (unitMinutes && !unitSeconds) {
    unitVerdict = 'minutes';
    unitDetail = `判为**分钟**（${unitMinutes} 种方式只有"按分钟"解释合理）—— **当前代码除以 60 是错的**`;
  } else {
    unitVerdict = 'mixed';
    unitDetail = '不同方式指向不同单位 —— 需要人工核对，不要统一处理';
  }
  steps.push({ step: 'duration-unit', ok: unitVerdict === 'seconds', detail: unitDetail });

  /**
   * ③ 与公交探针那次实测**交叉核对**。
   *
   * 公交实测：中央大街 → 冰雪大世界，地铁 69.5 分、**步行段合计 3442 米**。
   * 矩阵若说步行只要十几分钟，两者矛盾 —— 这种跨接口比对
   * 比单看一个数更能说明问题。
   */
  const walk = results.find((x) => x.mode === 'walking');
  let crossCheck = null;
  if (walk && walk.ok && walk.usable && typeof walk.durationMinutes === 'number') {
    crossCheck = {
      note:
        '公交探针在同一条线上实测：地铁 69.5 分钟、步行段合计 3442 米。' +
        '若矩阵给出的**步行**耗时明显低于此，说明矩阵的步行走的不是同一回事。',
      walkDurationMinutes: walk.durationMinutes,
      transitProbeReference: { subwayMinutes: 69.5, walkingMetersInThatRoute: 3442 },
    };
  }

  const ok = Boolean(unitVerdict === 'seconds' && modeRespected !== false);

  return resp.ok({
    ok,
    verdict: ok
      ? 'OK'
      : !anyOk
        ? 'UPSTREAM_FAILED'
        : modeRespected === false
          ? 'MODE_IGNORED'
          : unitVerdict === 'minutes'
            ? 'UNIT_IS_MINUTES'
            : 'UNIT_UNCLEAR',
    probeFrom: probeFrom,
    probeTo: toList[0],
    steps,
    /** 三种方式并排 —— **这才是能看出问题的形态** */
    results,
    unitVerdict,
    modeRespected,
    crossCheck,
    mapApiCalls: matrixCalls,
    hint: ok
      ? null
      : modeRespected === false
        ? '矩阵没有按 mode 区分耗时。可行办法：矩阵只用于**驾车**，步行/骑行改用各自的路线接口（direction/v1/walking 等），它们本来就区分方式。'
        : unitVerdict === 'minutes'
          ? '把 lib/map/tencent.js 里矩阵的除数从 60 改成 1（字段名 durationRaw 已不预设单位）。'
          : '看 results 里各方式的原始 distance/duration 与 unitCheck.note。',
  });
}

module.exports = { probe, DEFAULT_FROM, DEFAULT_TO, PROBE_MODES, SPEED_RANGE, MODE_LABEL };

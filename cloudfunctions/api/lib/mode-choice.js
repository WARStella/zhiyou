'use strict';

/**
 * 出行方式的选择 —— **纯函数，与接口无关**。
 *
 * ── 需求（2026-10-13 用户提出）────────────────────────────
 *
 *   "综合考虑不同出行方式的所耗时间，一般情况按最短时间优先，
 *    特殊情况如雨雪以安全为主。"
 *
 * 拆成两件事：
 *
 *   ① **一般情况**：把各方式的耗时摆出来，取最短（`fastest`）
 *   ② **雨雪等特殊情况**：先排除不安全的方式，再取最短（`safety`）
 *
 * ── 用户自己选（2026-10-14 用户提出）──────────────────────
 *
 *   "我希望出行方式可以给出用户选项，让用户自己选择"
 *
 * 所以再加一维 `preferredMode`。**语义是"偏好"，不是"强制"**，
 * 这个区分是这一层最要紧的设计决定：
 *
 *   · 用户选了步行、而目标 12 公里走不过去时，
 *     **不能什么都不给** —— 那等于让他自己去想办法；
 *   · 也不能**闷着换一种** —— 那等于偷偷替他改主意；
 *   · 正确做法：给可行的方案，并**说清"你想走但走不了，因为……"**。
 *
 * 这与"不猜天气"是同一条纪律：不擅自替用户做决定，
 * 但也不假装他要的那个方式可行。
 *
 * ── 为什么做成纯函数 ────────────────────────────────────
 *
 * 各方式的真实耗时要从腾讯的驾车／骑行／公交接口取，
 * 而**那三个端点还没实测**（见 `map.probe` 第 ⑥ 项）。
 *
 * 但"选哪种"这件事**不依赖接口** —— 拿到耗时之后的判断是确定的。
 * 所以先把判断写出来、测起来；接口回来之后只需接上真实耗时。
 * 这与地图 provider、需求解析 provider 是同一个模式：
 * **把会变的部分关在接口后面，让判断逻辑可以被测试。**
 *
 * ── 一条纪律：不猜天气 ──────────────────────────────────
 *
 * "今天是雨雪天"**只能由用户说**（或将来接天气接口），
 * 系统**不自己推断**。凭日期猜"冬天可能下雪"然后擅自改出行方式，
 * 是替用户做决定 —— 与"点名两个地方却选了十个"是同一类错误。
 */

/** 方式的中文名 —— 界面与理由文案共用一份，避免两处漂移 */
const MODE_LABEL = {
  walking: '步行',
  bicycling: '骑行',
  driving: '驾车',
  transit: '公交',
  subway: '地铁',
};

/**
 * 用户可以选的偏好值。
 *
 * `auto` = 让系统按最短时间挑（默认，也是"没表态"）。
 * 其余四种 = "我想用这个"。
 */
const PREFERRED_MODE = {
  AUTO: 'auto',
  WALKING: 'walking',
  BICYCLING: 'bicycling',
  DRIVING: 'driving',
  TRANSIT: 'transit',
  SUBWAY: 'subway',
};

/** 界面用的选项列表（含 `auto`）—— 前端直接拿它渲染，避免两处漂移 */
const MODE_OPTIONS = [
  { value: 'auto', label: '自动（按最快）' },
  { value: 'walking', label: '步行' },
  { value: 'bicycling', label: '骑行' },
  { value: 'driving', label: '驾车' },
  { value: 'transit', label: '公交地铁' },
  { value: 'subway', label: '地铁优先' },
];

const isPreferredMode = (v) =>
  v === undefined || v === null || v === '' || Object.values(PREFERRED_MODE).includes(v);

/** 雨雪天**不适合**的方式（各有各的理由，不是拍脑袋列的） */
const BAD_WEATHER_BLOCK = {
  bicycling: '雨雪路面骑行容易打滑',
};

/**
 * 雨雪天步行的距离上限（米）。
 *
 * 依据：雨雪天步行速度下降、体感差、湿滑风险随距离累积。
 * 1500 米约等于 20 分钟步行 —— 超过这个距离，"走过去"就不再是合理选择。
 * **这是一个可调参数，不是真理**；写在这里是为了让它可解释、可改。
 */
const BAD_WEATHER_WALK_LIMIT_M = 1500;

/**
 * 把分钟数格式化成**给用户看的**样子（2026-10-14 加）。
 *
 * ── 为什么必须有它 ────────────────────────────────────────
 *
 * 实测（用户截图）：骑行 72.7 分钟与驾车 19.3 分钟相减，
 * 拼出来的是「多 **53.400000000000006** 分钟」——
 * 浮点减法在老实的十进制下就是这个结果。
 *
 * ⚠️ **不是在源头把精度四舍五入掉**：`minutes` 要保持浮点，
 *    排序、比较与 `extra` 的计算都依赖它的精度
 *    （先各自取整再相减会累积误差）。所以只在**拼文案**这一步格式化。
 *
 * 取一位小数并去掉多余的 `.0`：整数说「72 分钟」，有小数才说「72.7 分钟」——
 * 这也是界面一直以来的口径。
 */
function fmtMin(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** 把一段的候选项整理成可比的形式：不可用的直接排除并说明 */
function normalize(candidates) {
  const usable = [];
  const excluded = [];
  for (const c of candidates || []) {
    if (!c || !c.mode) continue;
    if (c.ok === false || typeof c.minutes !== 'number' || c.minutes <= 0) {
      excluded.push({ mode: c.mode, reason: c.reason || '取不到这一段的用时' });
      continue;
    }
    usable.push({ mode: c.mode, minutes: c.minutes, meters: c.meters || null });
  }
  return { usable, excluded };
}

/**
 * 选一种出行方式。
 *
 * @param {Array} candidates 各方式的候选项
 *        `[{mode, minutes, meters?, ok?, reason?}]`
 * @param {object} opts
 *        `preference`: `'fastest'`（默认）| `'safety'`
 *        `weather`:    仅信息用，写进理由（如 `'雨雪'`）
 * @returns {{chosen, considered, excluded, reason, preference}}
 */
function chooseMode(candidates, opts) {
  opts = opts || {};
  const preference = opts.preference === 'safety' ? 'safety' : 'fastest';
  const { usable, excluded } = normalize(candidates);

  if (!usable.length) {
    /**
     * ⚠️ 理由必须**说得具体**（2026-10-14 改）。
     *
     * 原来写的是「没有可用的出行方式（步行、骑行、驾车都取不到用时）」——
     * 两个毛病：
     *   ① 把**按距离排除**说成了"取不到用时"。用户看到"取不到"会以为
     *      重试一下就有，而实际是"17 公里步行本来就不该建议"；
     *   ② 同一个方式可能有多条失败候选（矩阵一条、估算一条），
     *      于是渲染出「步行、骑行、驾车、**步行**」这种重复。
     *
     * 现在：按方式去重，并把各自的**具体原因**带上。
     */
    const seen = new Map();
    for (const e of excluded) {
      if (!seen.has(e.mode)) {
        seen.set(e.mode, e.reason);
        continue;
      }
      /**
       * 同一个方式有多条失败候选时，**保留"按规则排除"而不是"取数失败"**。
       *
       * 例：步行在矩阵那条是"附近没有可吸附的道路"（上游的事），
       * 在估算那条是"超过步行上限 3000 米"（我们的判断）。
       * 对用户有意义的是后者 —— 前者会让人以为重试一下就能走。
       */
      const prev = String(seen.get(e.mode) || '');
      const next = String(e.reason || '');
      if (!/超过|上限|太远/.test(prev) && /超过|上限|太远/.test(next)) seen.set(e.mode, next);
    }
    const detail = Array.from(seen.entries())
      .map(([mode, why]) => `${MODE_LABEL[mode] || mode}（${why}）`)
      .join('、');
    return {
      chosen: null,
      considered: [],
      excluded,
      preference,
      reason: seen.size ? `没有可用的出行方式：${detail}` : '没有可比较的出行方式',
    };
  }

  // ── 安全模式：先排除不安全的，再在剩下的里取最短 ──
  let pool = usable;
  const safetyExcluded = [];

  if (preference === 'safety') {
    pool = [];
    for (const c of usable) {
      const blocked = BAD_WEATHER_BLOCK[c.mode];
      if (blocked) {
        safetyExcluded.push({ mode: c.mode, reason: blocked });
        continue;
      }
      if (c.mode === 'walking' && c.meters && c.meters > BAD_WEATHER_WALK_LIMIT_M) {
        safetyExcluded.push({
          mode: c.mode,
          reason: `${MODE_LABEL.walking} ${c.meters} 米，超过雨雪天的 ${BAD_WEATHER_WALK_LIMIT_M} 米上限`,
        });
        continue;
      }
      pool.push(c);
    }

    /**
     * ⚠️ **如果安全模式下一种都不剩，不能就此说"没有方案"** ——
     * 那会让用户在雨雪天哪儿也去不了。
     * 退回全部候选，并在理由里**如实说明"没有更安全的选择"**。
     */
    if (!pool.length) {
      const fallback = usable.slice().sort((a, b) => a.minutes - b.minutes)[0];
      return {
        chosen: fallback,
        considered: usable.slice().sort((a, b) => a.minutes - b.minutes),
        excluded: excluded.concat(safetyExcluded),
        preference,
        reason:
          `雨雪天没有更安全的选择，仍按最短用时取${MODE_LABEL[fallback.mode] || fallback.mode}` +
          `（${fmtMin(fallback.minutes)} 分钟）—— 请自行留意路况`,
        degraded: true,
      };
    }
  }

  const sorted = pool.slice().sort((a, b) => a.minutes - b.minutes);
  const label = MODE_LABEL[sorted[0].mode] || sorted[0].mode;

  /**
   * ── 用户的偏好优先（2026-10-14）────────────────────────
   *
   * 选中的判断顺序（三条，顺序不能换）：
   *
   *   ① **用户选的那个可用 → 就用它。** 哪怕它不是最快的 ——
   *      用户说"我想走过去"，那是他的选择，系统不该拿"开车更快"反驳他。
   *   ② **用户选的那个不可用 → 给最快的，但理由里必须说清为什么没按他选的来。**
   *      这是"偏好不是强制"的落点：不能让他寸步难行，
   *      更不能闷着换一种方式而不告诉他。
   *   ③ 没选（`auto`）→ 沿用原来"最快优先"的行为。
   *
   * ⚠️ **用户明确的偏好优先于雨雪规则**（2026-10-14 定）。
   *
   * 所以这里在**未过滤的 `usable`** 里找用户选的方式，而不是在
   * 已被 safety 过滤过的 `pool` 里找。理由：
   *
   *   天气是**用户自己说的**。他既说了"雨雪"、又选了骑行，
   *   说明他知道这个情况仍然要用骑行（可能只是小雨、可能他打算慢点骑）。
   *   系统用"雨雪不适合骑行"去反驳他，**又是一次替他做决定** ——
   *   与"凭日期猜下雪"是同一类错误。
   *
   * 但也不能装作没这回事：理由里会带上路况提醒（见下面的 `weatherCaveat`）。
   */
  const wanted = opts.preferredMode && opts.preferredMode !== PREFERRED_MODE.AUTO ? opts.preferredMode : null;
  const userPick = wanted ? usable.find((c) => c.mode === wanted) : null;
  const matched = wanted ? sorted.find((c) => c.mode === wanted) : null;
  const chosen = userPick || matched || sorted[0];
  const chosenLabel = MODE_LABEL[chosen.mode] || chosen.mode;
  /**
   * 用户选的这个方式**恰好被雨雪规则排除了**。
   * 仍按用户的选择，但理由里要提一句 —— 不能装作没这回事。
   */
  const overrodeWeather = Boolean(
    userPick && safetyExcluded.some((e) => e.mode === userPick.mode)
  );
  const weatherCaveat = overrodeWeather
    ? `；注意${(safetyExcluded.find((e) => e.mode === userPick.mode) || {}).reason || '雨雪天这条路况更差'}`
    : '';

  // ── 理由必须写清"选了谁、为什么"（§6.5：改得清楚）──
  let reason;
  if (userPick) {
    /**
     * 用户选的那个可用。**理由要说明它与最快方案的差别**，
     * 而不是假装它最快 —— 用户可能想知道自己为了这个选择多花了多久。
     */
    const fastest = sorted[0];
    if (fastest.mode === chosen.mode) {
      reason = `你选的${chosenLabel}：${fmtMin(chosen.minutes)} 分钟（同时也是最快的方式）${weatherCaveat}`;
    } else {
      const extra = chosen.minutes - fastest.minutes;
      reason =
        `按你选的${chosenLabel}：${fmtMin(chosen.minutes)} 分钟，` +
        `比${MODE_LABEL[fastest.mode] || fastest.mode}（${fmtMin(fastest.minutes)} 分钟）多 ${fmtMin(extra)} 分钟` +
        weatherCaveat;
    }
  } else if (wanted) {
    /**
     * ⚠️ **用户选了、但那个方式不可用。这段文案是这一层最重要的输出。**
     *
     * 必须同时说清三件事，缺一件用户就会困惑或不满：
     *   ① 你想用的那个不可用；
     *   ② **为什么**（具体原因，不是"取不到"）；
     *   ③ 所以给你哪个。
     */
    const why = (excluded.find((e) => e.mode === wanted) || {}).reason || '这一段取不到它的用时';
    reason =
      `你想用${MODE_LABEL[wanted] || wanted}，但${why} —— ` +
      `已改为${chosenLabel}（${fmtMin(chosen.minutes)} 分钟）`;
  } else {
    const runnerUp = sorted[1];
    if (preference === 'safety') {
      const parts = safetyExcluded.map((e) => `${MODE_LABEL[e.mode] || e.mode}（${e.reason}）`);
      reason =
        `雨雪天以安全为主：${chosenLabel} ${fmtMin(chosen.minutes)} 分钟` +
        (parts.length ? `；已排除 ${parts.join('、')}` : '');
    } else if (runnerUp) {
      const saved = runnerUp.minutes - chosen.minutes;
      reason =
        `${chosenLabel}最快：${fmtMin(chosen.minutes)} 分钟，比${MODE_LABEL[runnerUp.mode] || runnerUp.mode}` +
        `（${fmtMin(runnerUp.minutes)} 分钟）省 ${fmtMin(saved)} 分钟`;
    } else {
      reason = `只取到了${chosenLabel}：${fmtMin(chosen.minutes)} 分钟`;
    }
  }

  return {
    chosen,
    considered: sorted,
    excluded: excluded.concat(safetyExcluded),
    preference,
    /** 用户选的那个（null = 没选/自动）—— 界面据此显示"你选的是…" */
    preferredMode: wanted,
    /**
     * 是否按用户选的来了。false 时界面**必须**显示 reason（里面有原因）。
     *
     * ⚠️ 判据是 `userPick`（在**未过滤**的 usable 里找到的），
     * 不是 `matched`（在 safety 过滤后的 pool 里找的）——
     * 用户明确的偏好优先于雨雪规则，所以"找到了"就该算按他选的来。
     */
    matchedPreference: wanted ? Boolean(userPick) : null,
    reason,
  };
}

/**
 * 对整条路线逐段选方式。
 *
 * @param {Array} legs 每段的候选：`[{fromName, toName, candidates: [...]}]`
 * @param {object} opts 同 chooseMode
 */
function chooseForLegs(legs, opts) {
  const out = (legs || []).map((leg) => {
    const picked = chooseMode(leg.candidates, opts);
    return {
      fromName: leg.fromName,
      toName: leg.toName,
      chosen: picked.chosen,
      managed: picked.chosen ? (MODE_LABEL[picked.chosen.mode] || picked.chosen.mode) : null,
      reason: picked.reason,
      considered: picked.considered,
      excluded: picked.excluded,
      /** 用户选的那个；未选为 null */
      preferredMode: picked.preferredMode,
      /** 是否按用户选的来了 —— 界面据此决定要不要突出显示原因 */
      matchedPreference: picked.matchedPreference,
    };
  });

  const changed = out.filter((l) => l.chosen && l.chosen.mode !== 'walking').length;
  return {
    legs: out,
    /** 有多少段不是步行 —— 界面用来提示"这次不只靠走" */
    nonWalkingLegs: changed,
    preference: opts && opts.preference === 'safety' ? 'safety' : 'fastest',
    note:
      changed > 0
        ? `${out.length} 段里有 ${changed} 段不用步行`
        : `${out.length} 段都可以步行`,
  };
}

module.exports = {
  chooseMode,
  chooseForLegs,
  MODE_LABEL,
  BAD_WEATHER_BLOCK,
  BAD_WEATHER_WALK_LIMIT_M,
  /** 用户可选的出行方式（2026-10-14） */
  PREFERRED_MODE,
  MODE_OPTIONS,
  isPreferredMode,
  /** 给用户看的分钟数格式化 —— 界面与别处拼文案都要用它，别自己拼 */
  fmtMin,
};

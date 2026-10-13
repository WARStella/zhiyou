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
};

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
    return {
      chosen: null,
      considered: [],
      excluded,
      preference,
      reason:
        excluded.length
          ? `没有可用的出行方式（${excluded.map((e) => MODE_LABEL[e.mode] || e.mode).join('、')}都取不到用时）`
          : '没有可比较的出行方式',
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
          `（${fallback.minutes} 分钟）—— 请自行留意路况`,
        degraded: true,
      };
    }
  }

  const sorted = pool.slice().sort((a, b) => a.minutes - b.minutes);
  const chosen = sorted[0];
  const label = MODE_LABEL[chosen.mode] || chosen.mode;

  // ── 理由必须写清"选了谁、为什么"（§6.5：改得清楚）──
  let reason;
  const runnerUp = sorted[1];
  if (preference === 'safety') {
    const parts = safetyExcluded.map((e) => `${MODE_LABEL[e.mode] || e.mode}（${e.reason}）`);
    reason =
      `雨雪天以安全为主：${label} ${chosen.minutes} 分钟` +
      (parts.length ? `；已排除 ${parts.join('、')}` : '');
  } else if (runnerUp) {
    const saved = runnerUp.minutes - chosen.minutes;
    reason =
      `${label}最快：${chosen.minutes} 分钟，比${MODE_LABEL[runnerUp.mode] || runnerUp.mode}` +
      `（${runnerUp.minutes} 分钟）省 ${saved} 分钟`;
  } else {
    reason = `只取到了${label}：${chosen.minutes} 分钟`;
  }

  return {
    chosen,
    considered: sorted,
    excluded: excluded.concat(safetyExcluded),
    preference,
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
};

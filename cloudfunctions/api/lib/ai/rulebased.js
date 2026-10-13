'use strict';

/**
 * 需求解析 —— **规则实现**。
 *
 * 这不是"假的 AI"，而是计划书 §6.5 明确要求的降级路径：
 *   > 系统生成候选变更，用户确认后生效。**模型不可用时，保留手动修改与
 *   > 确定性可行性检查。**
 *
 * 它的价值有三层：
 *   ① 模型不可用（欠费、限流、网络）时，产品仍然能用；
 *   ② 本地测试可以完整覆盖解析→规划→调整全链路，不依赖外部服务；
 *   ③ 它给出的是**可复现**的基线 —— 模型解析的评测（附录 C）需要对照组。
 *
 * ⚠️ 边界：规则解析**只处理能确定的表达**。含糊的话（"有点累""尽量少走"）
 * 一律进 `uncertainties` 让用户确认，绝不擅自翻译成具体数值 ——
 * 这正是 §6.2 那条：
 *   > "有点累"不能自动转换成具体步行上限；
 *   > "尽量少走"不能直接当作绝对禁止步行。必要时追问或提供选项。
 */

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 把「五」「十二」「二十」这类中文数字转成整数；已经是阿拉伯数字的也接受。 */
function toNumber(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (!s) return null;

  // 十位：十五 / 二十 / 二十五
  const m = s.match(/^(.)?十(.)?$/);
  if (m) {
    const tens = m[1] ? CN_DIGITS[m[1]] : 1;
    const ones = m[2] ? CN_DIGITS[m[2]] : 0;
    if (tens == null || ones == null) return null;
    return tens * 10 + ones;
  }
  if (s.length === 1 && CN_DIGITS[s] != null) return CN_DIGITS[s];
  return null;
}

/** 时段词 → 12/24 小时制的修正量。 */
const PERIODS = [
  { re: /凌晨/, base: 0 },
  { re: /早上|早晨|清晨|上午/, base: 0 },
  { re: /中午/, base: 12 },
  { re: /下午|午后/, base: 12 },
  { re: /傍晚|晚上|夜里|夜晚/, base: 12 },
];

/**
 * 把「下午五点」「17:00」「五点半」转成 `HH:mm`。
 * 返回 null 表示**没有把握**，调用方应放进 uncertainties 而不是猜。
 */
function parseClock(hourText, minuteText, periodText) {
  let hour = toNumber(hourText);
  if (hour == null || hour < 0 || hour > 24) return null;

  let minute = 0;
  if (minuteText === '半') minute = 30;
  else if (minuteText != null && minuteText !== '') {
    const m = toNumber(minuteText);
    if (m == null || m < 0 || m > 59) return null;
    minute = m;
  }

  const period = PERIODS.find((p) => p.re.test(periodText || ''));
  if (period) {
    // 「下午五点」= 17:00；「晚上八点」= 20:00
    if (period.base === 12 && hour < 12) hour += 12;
    if (period.base === 0 && hour === 12) hour = 0;
  } else if (hour <= 11) {
    // 没说时段又是个小数字：可能是上午也可能是下午。
    // **不猜** —— 交给调用方追问。
    return { ambiguous: true, hour, minute };
  }

  if (hour >= 24) return null;
  return {
    hour,
    minute,
    text: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

/** 把解析出的时刻落到某个基准日（默认今天）。 */
function clockToDate(clock, base) {
  const d = new Date(base ? base.getTime() : Date.now());
  d.setHours(clock.hour, clock.minute, 0, 0);
  return d;
}

// ── 规则表 ────────────────────────────────────────────────

/** 结束时间：「五点前」「17:00 之前」「六点结束」 */
const END_TIME_RES = [
  /(凌晨|早上|早晨|清晨|上午|中午|下午|午后|傍晚|晚上|夜里|夜晚)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,2})\s*[:：]\s*(\d{2})?\s*(?:之?前|以前|前)/,
  /(凌晨|早上|早晨|清晨|上午|中午|下午|午后|傍晚|晚上|夜里|夜晚)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,2})\s*点\s*(半|[一二三四五六七八九十]{1,2}|\d{1,2})?\s*(?:之?前|以前|前|结束|完|回|收工)/,
];

/** 开始时间：「三点出发」「下午两点开始」 */
const START_TIME_RES = [
  /(凌晨|早上|早晨|清晨|上午|中午|下午|午后|傍晚|晚上|夜里|夜晚)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,2})\s*[:：]\s*(\d{2})?\s*(?:出发|开始|动身)/,
  /(凌晨|早上|早晨|清晨|上午|中午|下午|午后|傍晚|晚上|夜里|夜晚)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,2})\s*点\s*(半|[一二三四五六七八九十]{1,2}|\d{1,2})?\s*(?:出发|开始|动身)/,
];

/** 节奏：只识别**明确**的表达。含糊的一律进 uncertainties。 */
const PACE_RULES = [
  { pace: 'relaxed', re: /少走(点|一些|儿)?路?|轻松|悠[闲哉]|慢慢(走|逛|看)|别太赶|不着急|放松/ },
  { pace: 'packed', re: /尽可能多|尽量多|多去(几|些)个?|紧凑|赶时间|时间紧|都想去/ },
];

/** 含糊表达 —— **必须**让用户确认，不能擅自换算成数值。 */
const VAGUE_RULES = [
  { re: /有点累|挺累|累了/, field: 'maxWalkMinutes', why: '"有点累"不能自动换算成步行上限，请确认一个具体分钟数' },
  { re: /尽量少走|少走点|不想走|走不动/, field: 'maxWalkMinutes', why: '"尽量少走"不等于禁止步行，请确认是偏好还是硬上限' },
  { re: /随[便意]|都行|看情况|无所谓/, field: 'preferences', why: '表述含糊，需要追问具体偏好' },
];

/** 锚点：「中央大街附近」「在XX一带」 */
const ANCHOR_RES = [
  /([\u4e00-\u9fa5A-Za-z0-9·]{2,16}?)\s*(?:附近|周边|一带|左近)/,
  /(?:在|从)\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,12}?)\s*(?:开始|出发)/,
];

/**
 * 从捕获到的片段里剥掉动词、时间词、人称，以及尾部的游览动词。
 *
 * 实测踩到的坑：`我下午想去中央大街附近` 会被整体捕获，
 * 得到「我下午想去中央大街」这种检索词，搜出来全是垃圾。
 */
const PHRASE_PREFIX_RE =
  /^(?:我|我们|咱们|你|他|她|想|要|打算|准备|计划|去|到|在|逛|逛一逛|看看|看|游玩|游|今天|明天|后天|上午|中午|下午|午后|傍晚|晚上|早上|早晨|然后|再|顺便|附近|周边|一带)+/;

/** 尾部同理：「冰雪大世界附近逛逛」→「冰雪大世界」 */
const PHRASE_SUFFIX_RE =
  /(?:附近|周边|一带|左近|逛逛|逛一逛|转转|走走|看看|玩一玩|玩|参观|游览|游玩|一下|吧|呢)+$/;

function cleanPlacePhrase(s) {
  let out = String(s || '').trim();
  // 反复剥离：`我下午想去` 可能一次剥不干净
  for (let i = 0; i < 6; i++) {
    const next = out.replace(PHRASE_PREFIX_RE, '').replace(PHRASE_SUFFIX_RE, '');
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

/**
 * 不适合作为"游览地点"的 POI 类目。
 *
 * ⚠️ **实测踩到的坑（两次）**：
 *
 * 第一次：用户说「我想去冰雪大世界」，库里有一条 POI 叫「冰雪大世界[地铁站]」，
 * 类目 `基础设施;交通设施:地铁站`。它是**地铁站**，不是那个冰雪乐园。
 *
 * 第二次：修完第一版之后仍然出错 —— 因为真实类目是
 * `基础设施;交通设施:公交车站`，而我的正则写的是「公交站」：
 *
 *     /公交站/.test('基础设施;交通设施:公交车站')  // → false ❌
 *     「公交车站」里没有连续的「公交站」三个字（公交-车-站）
 *
 * 而当时的测试用的是**我自己编的**类目字符串（`…:地铁站`），恰好能匹配，
 * 所以测试是绿的。**用自己编的数据测自己写的规则，等于没测。**
 *
 * 因此这里改用**词干**匹配（`公交` 而不是 `公交站`），
 * 并且测试必须使用真实返回过的类目字符串。
 *
 * 腾讯的 POI 类目格式是「大类;中类:小类」这种自由文本，只能用关键词排除。
 */
const NON_VISITABLE_CATEGORY_RE =
  /地铁|轻轨|公交|巴士|车站|火车站|汽车站|机场|码头|港口|停车场|加油|加气|充电站|收费站|服务区|高速|道路|路口|门牌|出入口|天桥|地下通道|隧道|卫生间|公共厕所|厕所|ATM|银行|营业厅|售票处|咨询处|派出所|岗亭/;

/** 这条类目是否**可以**作为游览地点（交通设施、公共设施一律不算） */
function isVisitableCategory(category) {
  return !NON_VISITABLE_CATEGORY_RE.test(String(category || ''));
}

/** 去掉 POI 名里的类别或门店后缀：「冰雪大世界[地铁站]」→「冰雪大世界」 */
function baseName(name) {
  return String(name || '')
    .replace(/[\[【（(][^\]】）)]*[\]】）)]\s*$/, '')
    .trim();
}

/**
 * 从地点记录里挑出**能作为"用户想去的地方"**的名字。
 *
 * 过滤掉交通设施等不可游览的类目 —— 否则「冰雪大世界」会被
 * 「冰雪大世界[地铁站]」抢先匹配（见 NON_VISITABLE_CATEGORY_RE 的说明）。
 */
function pickKnownPlaceNames(places) {
  return (places || [])
    .filter((p) => p && p.name && isVisitableCategory(p.category))
    .map((p) => p.name);
}

/**
 * 文本里是否点名了某个已知地点。
 *
 * ⚠️ **双向包含是危险的，这里踩过一次真实的坑**：
 * 用户说「我想去冰雪大世界」，库里有一条检索回来的 POI 叫
 * 「哈尔滨悦苒民宿(哈尔滨冰雪大世界融创文旅城龙川路地铁站)」——
 * 因为它的名字里**嵌了地标名**，`n.includes(text)` 就命中了它。
 *
 * 所以只承认**真正的简称**：用户的说法要至少覆盖全名的一半长度。
 *   · 「索菲亚」→「圣索菲亚教堂」 3/6 = 0.5 ✓
 *   · 「冰雪大世界」→ 那条民宿名 5/30 ≈ 0.17 ✗
 *
 * 比对时同时考虑**去掉类别后缀的名字**：「Theone钢琴教室(民生路店)」
 * 去掉后缀就是「Theone钢琴教室」，用户这么说应当算完整提到。
 */
const ABBREV_MIN_RATIO = 0.5;

function matchKnown(text, knownPlaceNames) {
  if (!Array.isArray(knownPlaceNames) || !knownPlaceNames.length) return null;
  const t = String(text || '').trim();
  if (t.length < 2) return null;

  const scored = [];
  for (const n of knownPlaceNames) {
    if (!n || typeof n !== 'string') continue;
    const base = baseName(n) || n;

    // 用户在话里完整提到了某个已知地点 —— 这条永远安全
    if (t.includes(n)) {
      scored.push({ n, score: 3 });
      continue;
    }
    // 与"去掉后缀的名字"完全一致（如用户说「Theone钢琴教室」，库里是「Theone钢琴教室(民生路店)」）
    if (t === base) {
      scored.push({ n, score: 2 });
      continue;
    }
    // 真正的简称：长度要过半，避免"碰巧是某个长名字的子串"
    if (base.includes(t) && t.length / base.length >= ABBREV_MIN_RATIO) {
      scored.push({ n, score: 1 });
    }
  }

  if (!scored.length) return null;
  // 先按匹配强度，再按名字长度（避免「教堂」抢在「圣索菲亚教堂」前面）
  scored.sort((a, b) => b.score - a.score || b.n.length - a.n.length);
  return scored[0].n;
}

/**
 * 必去 / 排除。
 *
 * 实测踩到的坑：`尽量多去几个地方` 会被当成"必去：几个地方"。
 * 所以分两档：
 *   · **强信号**（一定要 / 必须 / 想去 …）→ 直接采纳；
 *   · **弱信号**（光一个"去 XX"）→ **只有 XX 命中已知地点名才采纳**。
 */
const MUST_STRONG_RES = [
  /(?:一定要|必须|务必|非得|不能错过|想去|要去|打算去)\s*(?:去)?\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,12})/g,
];
const MUST_WEAK_RE = /去\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,12})/g;
const AVOID_RE = /(?:不去|别去|不要去|排除|跳过|不想去)\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,12})/g;

/**
 * 常见类别词 —— 用户说「想去教堂」时，教堂不是已知地点名，
 * 但它是**合法的检索词**。范围刻意很小：只收与城市步行游览相关的。
 */
const CATEGORY_WORDS = [
  '教堂', '公园', '博物馆', '纪念馆', '广场', '步行街', '老街', '中央大街',
  '美食', '小吃', '咖啡', '茶馆', '书店', '市场', '夜市', '江边', '湿地',
  '寺庙', '美术馆', '剧院', '音乐厅', '观景台', '地标',
];

/** 停留延长：「多待一会儿」只在调整场景用，这里先给出意图 */
const STAY_RES = /多(?:待|停|逛|玩)\s*(\d+|[一二两三四五六七八九十]{1,2})?\s*(分钟|小时|钟头)?/;

/**
 * 规划时就指定停留时长：「逛一小时」「待 40 分钟」「玩两个小时」。
 *
 * ⚠️ 与上面的 `STAY_RES`（调整场景的「**多**待一会儿」）是两回事：
 *   · 这里回答"每个地方待多久"——影响**生成路线**时的停留时间；
 *   · `STAY_RES` 回答"多待一会儿"——影响对**已有行程**的调整。
 *
 * **实测踩到的坑**：用户说「我想去冰雪大世界，逛一小时」，
 * 首版规则只认「**多**逛一小时」，没有「多」就认不出，
 * 于是停留用了默认的 45 分钟 —— 用户明确说了时长，系统却当没听见。
 */
const STAY_DURATION_RE =
  /(?:逛|待|呆|玩|看|游览|参观|停留)\s*(?:上|大概|大约|差不多|近)?\s*(半|\d+|[一二两三四五六七八九十]{1,2})\s*(?:个)?\s*(小时|钟头|分钟|分)/;

/**
 * 「去 X」的目标 —— **最常见的表达方式，必须兜住**。
 *
 * 实测踩到的坑：用户说「我想去冰雪大世界」，而"冰雪大世界"不在已知地点库里，
 * 于是系统什么都不给。可这句话的意思再清楚不过：他要去冰雪大世界。
 *
 * 抽出来的 X 直接当检索词用。注意要接 `cleanPlacePhrase`，
 * 否则「去中央大街附近逛逛」会抽出「中央大街附近逛逛」。
 */
const GOAL_RE = /(?:想|要|打算|准备|计划|愿意)?\s*去\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,20})/;

// ── 主解析 ────────────────────────────────────────────────

/**
 * 解析一段自然语言需求。
 *
 * @param {string} text 用户原话（**原样保留进 rawText**，附录 C 的评测要用）
 * @param {object} opts { now, knownPlaceNames }
 * @returns {object} 见文件末尾的返回结构说明
 */
function parse(text, opts) {
  opts = opts || {};
  const now = opts.now ? new Date(opts.now) : new Date();
  const raw = String(text == null ? '' : text).trim();

  const out = {
    rawText: raw,
    parser: 'rulebased',
    anchorText: null,
    searchKeyword: null,
    /** 「去 X」里抽出的目标地名（可能在已知库之外） */
    goalText: null,
    /** 并列表达里的其余目标：「想去教堂和公园」→ ['公园'] */
    goalAlternatives: [],
    /** **规划时**的每站停留分钟数（「逛一小时」→ 60）；null 表示没说 */
    stayMinutes: null,
    startClock: null,
    endClock: null,
    pace: 'normal',
    mustVisitTexts: [],
    avoidTexts: [],
    extendStayMin: null,
    /** 解析到的字段与依据 —— 便于人工核对与评测打分 */
    matched: [],
    /**
     * **没有把握的地方**。§6.2：含糊表达不得自动转换成具体数值，
     * 必须追问或提供选项。界面要把它们显示成待确认项。
     */
    uncertainties: [],
  };

  if (!raw) {
    out.uncertainties.push({ field: 'rawText', why: '没有输入内容' });
    return out;
  }

  // ① 结束时间
  for (const re of END_TIME_RES) {
    const m = raw.match(re);
    if (!m) continue;
    const clock = parseClock(m[2], m[3], m[1]);
    if (clock && clock.ambiguous) {
      out.uncertainties.push({
        field: 'endAt',
        why: `「${m[0].trim()}」没说上午还是下午，请确认`,
        candidates: [`${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`, `${String(clock.hour + 12).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`],
      });
    } else if (clock) {
      out.endClock = clock;
      out.matched.push({ field: 'endAt', text: m[0].trim(), value: clock.text, rule: 'endTime' });
    }
    break;
  }

  // ② 开始时间
  for (const re of START_TIME_RES) {
    const m = raw.match(re);
    if (!m) continue;
    const clock = parseClock(m[2], m[3], m[1]);
    if (clock && clock.ambiguous) {
      out.uncertainties.push({ field: 'startAt', why: `「${m[0].trim()}」没说上午还是下午，请确认` });
    } else if (clock) {
      out.startClock = clock;
      out.matched.push({ field: 'startAt', text: m[0].trim(), value: clock.text, rule: 'startTime' });
    }
    break;
  }

  // ③ 节奏（明确表达才算）
  for (const r of PACE_RULES) {
    const m = raw.match(r.re);
    if (m) {
      out.pace = r.pace;
      out.matched.push({ field: 'pace', text: m[0], value: r.pace, rule: 'pace' });
      break;
    }
  }

  // ④ 含糊表达 → 必须确认，绝不自动换算
  for (const v of VAGUE_RULES) {
    const m = raw.match(v.re);
    if (m) out.uncertainties.push({ field: v.field, why: v.why, text: m[0] });
  }

  // ⑤ 锚点（捕获后必须**剥掉动词与时间词**，否则检索词会是「我下午想去中央大街」）
  for (const re of ANCHOR_RES) {
    const m = raw.match(re);
    if (!m) continue;
    const cleaned = cleanPlacePhrase(m[1]);
    if (cleaned && cleaned.length >= 2) {
      out.anchorText = cleaned;
      out.matched.push({ field: 'anchor', text: m[0].trim(), value: cleaned, rule: 'anchor' });
    }
    break;
  }

  // ⑥ 必去 / 排除 —— 按**在原文中出现的先后**收集，顺序与用户说话一致
  const known = Array.isArray(opts.knownPlaceNames) ? opts.knownPlaceNames : null;
  const hits = [];

  const collect = (re, strong, field) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(raw)) !== null) {
      const cleaned = cleanPlacePhrase(m[1]);
      if (!cleaned || cleaned.length < 2) continue;
      const canonical = matchKnown(cleaned, known);

      /**
       * 采信规则：
       *   · 给了已知地点名 → **必须命中**，否则「一定要去看看」「多去几个地方」
       *     都会被当地名收进来；
       *   · 没给已知地点名 → 只收强信号（一定要/必须/想去…），
       *     光一个"去 XX"太容易误判。
       */
      if (known) {
        if (!canonical) continue;
      } else if (!strong) {
        continue;
      }

      hits.push({
        index: m.index,
        field,
        value: canonical || cleaned,
        text: m[0].trim(),
        rule: strong ? (field === 'avoid' ? 'avoid' : 'must-strong') : 'must-known',
      });
    }
  };

  collect(MUST_STRONG_RES[0], true, 'mustVisit');
  collect(MUST_WEAK_RE, false, 'mustVisit');
  collect(AVOID_RE, true, 'avoid');

  hits.sort((a, b) => a.index - b.index);

  const avoided = new Set(hits.filter((h) => h.field === 'avoid').map((h) => h.value));
  const wanted = new Set(hits.filter((h) => h.field === 'mustVisit').map((h) => h.value));

  for (const h of hits) {
    if (h.field === 'avoid') {
      if (out.avoidTexts.indexOf(h.value) < 0) {
        out.avoidTexts.push(h.value);
        out.matched.push(h);
      }
      continue;
    }
    // 同一句里又说要去、又说不去 → **以排除为准**（宁可少去，不可把用户
    // 明确排除的地方塞进行程），并在下面记一条待确认
    if (avoided.has(h.value)) continue;
    if (out.mustVisitTexts.indexOf(h.value) < 0) {
      out.mustVisitTexts.push(h.value);
      out.matched.push(h);
    }
  }

  // ⑨ 必去与排除指向同一个名字 → 自相矛盾，必须让用户澄清
  const both = [...avoided].filter((n) => wanted.has(n));
  if (both.length) {
    out.uncertainties.push({
      field: 'mustVisit',
      why: `「${both.join('、')}」同时出现在必去和排除里，已按**排除**处理，请确认`,
      text: both.join('、'),
    });
  }

  // ⑦ 停留延长（调整场景：「多待一会儿」）
  const stay = raw.match(STAY_RES);
  if (stay) {
    const n = toNumber(stay[1]);
    const unit = stay[2] || '分钟';
    if (n != null) {
      out.extendStayMin = unit === '分钟' ? n : n * 60;
      out.matched.push({ field: 'extendStay', text: stay[0], value: out.extendStayMin, rule: 'stay' });
    } else {
      out.uncertainties.push({
        field: 'extendStayMin',
        why: `「${stay[0]}」没说要多久，请确认具体时长`,
      });
    }
  }

  /**
   * ⑦.2 规划时的停留时长（「逛一小时」）。
   *
   * 放在 ⑦ 之后、用独立的匹配：两者语义不同（见 STAY_DURATION_RE 的说明），
   * 但同现时以"规划时长"为准 —— 那是用户对这次游览的直接描述。
   */
  const stayDurMatch = raw.match(STAY_DURATION_RE);
  /**
   * ⚠️ 「**多**待 20 分钟」是**调整**语义（在已有行程上多待一会儿），
   * 不是"每个地方待 20 分钟"。两条规则会同时匹配到它，所以这里要看**前一个字**。
   *
   * 用显式判断而不是 lookbehind：后者的运行时可移植性没必要赌。
   */
  const stayDur =
    stayDurMatch && raw.charAt(stayDurMatch.index - 1) !== '多' ? stayDurMatch : null;
  if (stayDur) {
    // 「半小时」→ 30 分钟；其余走中文/阿拉伯数字转换
    const n = stayDur[1] === '半' ? 0.5 : toNumber(stayDur[1]);
    if (n != null && n > 0) {
      // ⚠️ 单位是**第 2 个捕获组**（`(?:个)` 是非捕获组）—— 数错组号会让
      //    「一小时」被当成 1 分钟，而且不报错。
      const unit = stayDur[2];
      const minutes = unit === '小时' || unit === '钟头' ? Math.round(n * 60) : n;
      // 明显不合理的时长要求确认，而不是照单全收（也不可能逛 20 小时）
      if (minutes > 8 * 60) {
        out.uncertainties.push({
          field: 'stayMinutes',
          why: `「${stayDur[0]}」看上去太长（${minutes} 分钟），请确认`,
          text: stayDur[0],
        });
      } else {
        out.stayMinutes = minutes;
        out.matched.push({
          field: 'stayMinutes',
          text: stayDur[0].trim(),
          value: minutes,
          rule: 'stay-duration',
        });
      }
    }
  }

  /**
   * ⑦.5 「去 X」的目标。
   *
   * 用户说的地标**可能不在已知库里**（如"冰雪大世界"）—— 但那句话的意思
   * 再清楚不过：他要去 X。所以单独抽出来，作为检索词的兜底。
   * 不加这一步，「我想去冰雪大世界」会什么都搜不到。
   */
  const goal = raw.match(GOAL_RE);
  if (goal) {
    /**
     * 并列结构要拆开：「想去教堂和公园」的目标不是一个叫"教堂和公园"的地方。
     * 取第一段当检索词，其余的记进 `goalAlternatives` ——
     * 前端可以据此再搜一次，也让用户知道系统没有忽略后半句。
     */
    const parts = String(goal[1])
      .split(/[和跟与、,，及]/)
      .map((x) => cleanPlacePhrase(x))
      .filter((x) => x && x.length >= 2);

    if (parts.length) {
      out.goalText = parts[0];
      if (parts.length > 1) out.goalAlternatives = parts.slice(1);
      out.matched.push({
        field: 'goal',
        text: goal[0].trim(),
        value: parts[0],
        rule: 'goal',
      });
    }
  }

  // ⑧ 检索关键词：**宁可不给，也不给垃圾**
  //
  // 实测踩到的坑：原先用"剥掉时间与节奏词后剩下的中文"当兜底，
  // 结果「我下午想去中央大街附近逛逛」被剥成「我下午想去中央大街」，
  // 搜出来全是无关结果。检索词错了比没有更糟 —— 用户会以为系统理解错了。
  //
  // 优先级：锚点 → 必去 → 「去 X」目标 → 文中已知地点（**排除的剔除**）
  //        → 常见类别词 → null（交给用户补）
  if (out.anchorText) {
    out.searchKeyword = out.anchorText;
    out.matched.push({ field: 'searchKeyword', text: out.anchorText, value: out.anchorText, rule: 'from-anchor' });
  } else if (out.mustVisitTexts.length) {
    out.searchKeyword = out.mustVisitTexts[0];
    out.matched.push({
      field: 'searchKeyword',
      text: out.mustVisitTexts[0],
      value: out.mustVisitTexts[0],
      rule: 'from-must',
    });
  } else if (out.goalText) {
    out.searchKeyword = out.goalText;
    out.matched.push({
      field: 'searchKeyword',
      text: out.goalText,
      value: out.goalText,
      rule: 'from-goal',
    });
  } else {
    // ⚠️ 必须**排除避开的**：实测「一定要去中央大街，别去兆麟公园」曾把
    //    兆麟公园选成检索词 —— 那会把用户明确不想去的地方搜出来推荐给他
    const mentioned = (known || [])
      .filter((n) => n && raw.includes(n) && out.avoidTexts.indexOf(n) < 0)
      .sort((a, b) => b.length - a.length);

    if (mentioned.length) {
      out.searchKeyword = mentioned[0];
      out.matched.push({
        field: 'searchKeyword',
        text: mentioned[0],
        value: mentioned[0],
        rule: 'from-known',
      });
    } else {
      const cat = CATEGORY_WORDS.find((w) => raw.includes(w) && out.avoidTexts.indexOf(w) < 0);
      if (cat) {
        out.searchKeyword = cat;
        out.matched.push({ field: 'searchKeyword', text: cat, value: cat, rule: 'from-category' });
      } else {
        out.uncertainties.push({
          field: 'searchKeyword',
          why: '没能从这句话里认出要去的地方，请补充一个地名（如"中央大街"），或直接搜索地点',
        });
      }
    }
  }

  return out;
}

/**
 * 解析结果 → 可直接下发 `trip.plan` 的结构。
 *
 * 只转换**已确定**的字段；`uncertainties` 一律不转 ——
 * 宁可少给一个约束，也不用猜出来的数值去算可行性。
 */
function toStructured(parsed, opts) {
  opts = opts || {};
  const base = opts.now ? new Date(opts.now) : new Date();

  const structured = {
    rawText: parsed.rawText,
    startAt: parsed.startClock ? clockToDate(parsed.startClock, base).toISOString() : null,
    endAt: parsed.endClock ? clockToDate(parsed.endClock, base).toISOString() : null,
    startPoint: opts.startPoint || null,
    anchorText: parsed.anchorText,
    mustVisitTexts: parsed.mustVisitTexts,
    avoidTexts: parsed.avoidTexts,
    pace: parsed.pace,
    /** 「逛一小时」→ 60：**每站**停留分钟数，未说则为 null */
    stayMin: parsed.stayMinutes == null ? null : parsed.stayMinutes,
    maxWalkMinutes: null, // 含糊表达**不换算**（§6.2）
    preferences: [],
  };

  const constraints = [];
  if (structured.endAt) {
    constraints.push({
      key: 'endAt',
      value: structured.endAt,
      hardness: 'hard',
      confirmedAt: new Date(base.getTime()).toISOString(),
      confirmedBy: 'user',
    });
  }

  return { structured, constraints };
}

/**
 * 面向用户的解析说明 —— 界面直接展示，不藏依据。
 *
 * ⚠️ **不能只依赖 `matched`**（2026-10-13 修正）。
 * `matched` 是"解析过程记录"，模型不一定填——实测 DeepSeek 返回了正确的
 * `endClock` / `pace` / `mustVisitTexts`，却把 `matched` 留空，
 * 于是界面显示「没有能确定的项」，而实际上解析出了一堆东西。
 *
 * 所以这里**以结构化字段为准**：先取 `matched` 里的原文片段（有价值），
 * 再为任何"有值但没被 matched 覆盖"的字段补一条。
 */
function explain(parsed) {
  parsed = parsed || {};
  const lines = [];
  const seen = new Set();

  const LABEL = {
    endAt: '结束时间',
    startAt: '开始时间',
    pace: '节奏',
    anchor: '区域',
    mustVisit: '必去',
    avoid: '排除',
    extendStay: '延长停留',
    searchKeyword: '检索词',
    stayMinutes: '每站停留',
    goal: '目标地点',
  };
  const UNIT = { stayMinutes: ' 分钟', extendStay: ' 分钟' };

  const push = (field, value, text) => {
    const label = LABEL[field];
    if (!label || value == null || value === '') return;
    const key = `${field}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    const unit = UNIT[field] || '';
    lines.push(text ? `${label}：${value}${unit}（来自「${text}」）` : `${label}：${value}${unit}`);
  };

  // 1) 解析过程记录：带原文片段，最有用
  for (const m of parsed.matched || []) push(m.field, m.value, m.text);

  // 2) 兜底：结构化字段里有值、但 matched 没提到的，补上
  if (parsed.startClock) push('startAt', parsed.startClock.text);
  if (parsed.endClock) push('endAt', parsed.endClock.text);
  if (parsed.pace && parsed.pace !== 'normal') push('pace', parsed.pace);
  if (parsed.anchorText) push('anchor', parsed.anchorText);
  if (parsed.stayMinutes != null) push('stayMinutes', parsed.stayMinutes);
  if (parsed.extendStayMin != null) push('extendStay', parsed.extendStayMin);
  for (const n of parsed.mustVisitTexts || []) push('mustVisit', n);
  for (const n of parsed.avoidTexts || []) push('avoid', n);
  if (parsed.searchKeyword) push('searchKeyword', parsed.searchKeyword);

  return lines;
}

module.exports = {
  parse,
  toStructured,
  explain,
  toNumber,
  parseClock,
  // 供调用方（与测试）复用
  matchKnown,
  baseName,
  pickKnownPlaceNames,
  isVisitableCategory,
  cleanPlacePhrase,
  NON_VISITABLE_CATEGORY_RE,
  _rules: { END_TIME_RES, START_TIME_RES, PACE_RULES, VAGUE_RULES, ANCHOR_RES, GOAL_RE },
};

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

/**
 * 尾部同理：「冰雪大世界附近逛逛」→「冰雪大世界」。
 *
 * ⚠️ **实测踩到的坑（2026-10-13）**：用户说
 * 「先去哈工大**玩一小时**再去冰雪大世界玩3小时」，拆开之后得到
 * 「哈工大玩一小时」—— 因为首版的尾巴清单里只有「玩一玩」「玩」，
 * **没有"玩 + 时长"这种组合**。
 *
 * 所以这里补上「动词 + 数量 + 时间单位」这一类尾巴：
 * 玩一小时 / 逛两小时 / 待 40 分钟 / 游览 3 个小时 …
 */
const PHRASE_SUFFIX_RE =
  /(?:附近|周边|一带|左近|逛逛|逛一逛|转转|走走|看看|玩一玩|参观|游览|游玩|一下|吧|呢|(?:玩|逛|待|呆|看|游|耍|停留)(?:上|个)?(?:半|\d+|[一二两三四五六七八九十]{1,2})?(?:个)?(?:小时|钟头|分钟|分)?|(?:半|\d+|[一二两三四五六七八九十]{1,2})(?:个)?(?:小时|钟头|分钟|分))+$/;

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

/** 并列 / 顺接的连接词 —— 两端都可能是地名 */
const PLACE_SPLIT_RE = /[和跟与、,，及]|然后再|然后|接着|之后|再去|再|又去|又/;

/**
 * 把可能并列的地名串拆成多个，并逐个清洗。
 *
 * 「先去哈工大玩一小时再去冰雪大世界玩3小时」→ ['哈工大', '冰雪大世界']
 *
 * ⚠️ **一个必须有的保护：拆出空片段就不拆。**
 *
 * 连接词本身可能是地名的一部分 —— 「**和平**路」「**和**兴路」。
 * 若不加保护：
 *
 *     '和平路'.split(/[和...]/)  →  ['', '平路']  →  「平路」 ❌
 *
 * 而地名**不可能以连接词开头**，所以"首段为空"就是"这个词不是连接词"的信号。
 * 同理末段为空（「中央大街和」）也不拆。
 */
function splitPlaces(s) {
  const str = String(s == null ? '' : s).trim();
  if (!str) return [];

  const rawParts = str.split(PLACE_SPLIT_RE);

  /**
   * 保护：**首段为空就不拆**。
   *
   * 地名不可能以连接词开头 —— 「**和平**路」「**和**兴路」若被拆开，
   * 会得到「平路」这种根本不是地名的东西。
   *
   * ⚠️ **只管开头，不管结尾**（2026-10-13 修正）。
   * 首版连"末段为空"也当成不拆的信号，结果踩了另一个坑：
   * `GOAL_RE` 的 `{2,20}` 会把长句**截断**在连接词上 ——
   *
   *     「先去哈工大玩一小时再去冰雪大世界玩两小时再去哈学院玩一小时」
   *       → 捕获到 20 字：「哈工大玩一小时再去冰雪大世界玩两小时再去」
   *       → 拆出末段为空 → **整串当成一个地名** ❌
   *
   * 结尾为空是**截断**留下的痕迹，不是"连接词属于名字"的证据，丢掉那一段即可。
   */
  if (!rawParts[0]) {
    const whole = cleanPlacePhrase(str);
    return whole.length >= 2 ? [whole] : [];
  }

  return rawParts
    .map((x) => cleanPlacePhrase(x))
    .filter((x) => x && x.length >= 2);
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
  /地铁|轻轨|公交|巴士|车站|火车站|汽车站|机场|码头|港口|停车场|加油|加气|充电站|收费站|服务区|高速|道路|路口|门牌|出入口|天桥|地下通道|隧道|卫生间|公共厕所|厕所|ATM|银行|营业厅|售票处|咨询处|派出所|岗亭|宾馆|酒店|民宿|公寓|旅馆|客栈|招待所|住宿|青年旅舍|旅舍/;

/**
 * **住宿类** —— 与交通设施同属"可以出现在候选里，但不是游览地点"。
 *
 * ⚠️ 实测踩到的坑（2026-10-13）：搜「冰雪大世界」，返回里混着
 * 「冰雪大世界民宿」「哈尔滨欣怡宾馆(冰雪大世界凯利广场店)」
 * 「漫步云端公寓(…地铁站)」—— 它们是**住的地方**，不是玩的地方。
 * 用户说"去冰雪大世界玩"，系统把宾馆排进行程，一眼就看出不对。
 *
 * 单独列一份是因为**名字也要查**：这些 POI 的类目常常是笼统的
 * 「生活服务」之类，光看类目查不出来，但名字里的「宾馆/民宿/公寓」
 * 是明确的住宿信号，且基本不会出现在游览地名字里。
 */
const LODGING_NAME_RE = /宾馆|酒店|民宿|公寓|旅馆|客栈|招待所|青年旅舍|旅舍|度假村|别墅/;

/** 这条类目是否**可以**作为游览地点（交通设施、住宿、公共设施一律不算） */
function isVisitableCategory(category) {
  return !NON_VISITABLE_CATEGORY_RE.test(String(category || ''));
}

/**
 * 这个候选能不能作为**游览地点** —— 类目与名字都要查。
 *
 * 名字这一关是必要的：住宿类的类目常常笼统到查不出来，
 * 而「XX宾馆」「XX公寓」这样的名字本身就是明确信号。
 */
function isVisitablePlace(name, category) {
  if (!isVisitableCategory(category)) return false;
  if (LODGING_NAME_RE.test(String(name || ''))) return false;
  return true;
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

/**
 * **纯类目词** —— 这些是"什么类型的场所"，不是"哪个地方"。
 *
 * ⚠️ 为什么不直接用 `CATEGORY_WORDS`：
 * 那份表是给**检索兜底**用的，里面混进了「中央大街」这类**真实地名**
 * （它确实是个好检索词）。用它来判断"这是不是具体地点"会误伤 ——
 * 「一定要去中央大街」的必去项会被整个丢掉。
 *
 * 两份表的用途不同，所以必须分开：
 *   · `CATEGORY_WORDS`         检索兜底 —— "没认出地名时拿什么去搜"
 *   · `GENERIC_CATEGORY_WORDS` 语义判断 —— "这几个字是不是具体地点"
 */
const GENERIC_CATEGORY_WORDS = [
  '教堂', '公园', '博物馆', '纪念馆', '广场', '步行街', '老街',
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
/**
 * 「去 X」目标。
 *
 * `g` 标志是必须的：用户可能说了好几个「去」——
 * 「想去中央大街，然后去防洪纪念塔」。只取第一个会丢掉后半句。
 *
 * ⚠️ **必须用惰性匹配 + 前瞻停在连接词上**（2026-10-13 修正）。
 *
 * 首版是贪婪的 `{2,20}`，于是：
 *
 *     「先去哈工大玩一小时**再去**冰雪大世界玩两小时**再去**哈学院玩一小时」
 *       → 一次吞掉 20 个字：「哈工大玩一小时再去冰雪大世界玩两小时再去」
 *       → **连下一个「去」都被吃了**，哈学院整个丢失 ❌
 *
 * 现在遇到「再/然后/接着/之后」或标点就停，每个「去 X」各成一段。
 * 「和/跟/与/、」故意**不**停 —— 那些可能是地名的一部分（「和平路」），
 * 交给 `splitPlaces` 带保护地拆。
 */
const GOAL_RE =
  /(?:想|要|打算|准备|计划|愿意)?\s*去\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,30}?)(?=再|然后|接着|之后|又|，|,|。|；|;|！|!|？|\?|$)/g;

/**
 * ── 出行方式（2026-10-14 用户报的漏洞）────────────────────────
 *
 * 用户原话："当我在行程框内输入**我想骑车去哈工大**时只会帮我选四个
 *            和哈工大相关的地点"
 *
 * ── 为什么这是个真漏洞 ────────────────────────────────────
 *
 * "骑车"是**出行方式约束**，而规则解析器里**一个字都没识别它** ——
 * 它被当成地名的一部分（"骑车去哈工"），于是：
 *   · 目的地认不出来；
 *   · 就算认出来了，出行方式也丢了，规划按"自动"算，用户说的骑车白说。
 *
 * ⚠️ 匹配**必须紧跟「去」**，否则「我想去地铁站」会被读成"要用地铁" ——
 *    而用户说的是**目的地是地铁站**。这个反例是设计这条规则时最先确认的。
 *
 * 用词干（`骑车` 而不是 `骑车去`）加 lookahead 到「去」，
 * 与文件里类目词那条"用词干而不是全词"的教训同源。
 */
const TRAVEL_MODE_RES = [
  { re: /骑车|骑行|单车|自行车|脚踏车/, mode: 'bicycling' },
  { re: /步行|走路|走过去|徒步/, mode: 'walking' },
  { re: /开车|驾车|自驾|打车|出租车|网约车|拼车/, mode: 'driving' },
  { re: /公交|地铁|轻轨|坐车|乘车|巴士/, mode: 'transit' },
];

/**
 * 出行方式的白名单与容错（2026-10-14 加）。
 *
 * ⚠️ 存在的理由：走 AI 解析时这个值是**模型直接给的**，
 *    而模型很爱给同义词或中文（`bike` / `bicycle` / `自行车` / `骑行` / `走`）。
 *    原样透传的话，下游 `isPreferredMode` 判断失败，
 *    最后表现为"用户说的出行方式没生效"——**而且不报错**。
 *
 * 认不出就置 null：宁可当成"没说"（系统用默认值，界面上显示"自动"），
 * 也不要塞一个谁也认不出的野值进去。
 */
const PREFERRED_MODE_ALIASES = {
  walking: ['walking', 'walk', 'foot', 'onfoot', '步行', '走路', '徒步', '走'],
  bicycling: ['bicycling', 'bicycle', 'bike', 'cycling', 'cycle', '单车', '自行车', '骑车', '骑行'],
  driving: ['driving', 'drive', 'car', 'taxi', '驾车', '开车', '自驾', '打车', '出租车'],
  transit: ['transit', 'bus', 'subway', 'metro', '公交', '地铁', '轻轨', '坐车', '乘车'],
};

function normalizePreferredMode(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  for (const mode of Object.keys(PREFERRED_MODE_ALIASES)) {
    if (PREFERRED_MODE_ALIASES[mode].indexOf(s) >= 0) return mode;
  }
  return null;
}

/**
 * 归一化"按目的地分别记的出行方式"（2026-10-14 加）。
 *
 * 走 AI 解析时这也是模型直接给的，同样可能给同义词或中文。
 * **认不出的条目整条丢弃**，不保留半截 —— 一个野值会让下游
 * `isPreferredMode` 判断失败，表现为"用户说的方式没生效"且不报错。
 */
function normalizeModeByText(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const key of Object.keys(v)) {
    const place = String(key == null ? '' : key).trim();
    if (!place) continue;
    const mode = normalizePreferredMode(v[key]);
    if (mode) out[place] = mode;
  }
  return out;
}

/**
 * 判断"出行方式词 + 去"这个组合 —— 只看紧跟在方式词后面的那个「去」。
 *
 * @returns {string|null} 出行方式，或 null
 */
function detectTravelMode(raw) {
  for (const r of TRAVEL_MODE_RES) {
    const m = raw.match(r.re);
    if (!m) continue;
    /**
     * ⚠️ 方式词后面**必须紧跟「去」**（允许一个"坐"之类的赘字）。
     *    不检查的话「我想去地铁站」会被判成 transit。
     */
    const after = raw.slice(m.index + m[0].length, m.index + m[0].length + 3);
    if (/^\s*(?:去|到|往)/.test(after)) return r.mode;
  }
  return null;
}

/**
 * 把"出行方式 + 去"从文本里抹掉，让 `MUST_STRONG_RES` / `GOAL_RE`
 * 能正常认出后面的地名。
 *
 * ── 为什么必须抹（不止是"锦上添花"）────────────────────────
 *
 * `MUST_STRONG_RES` 里有「想去」「要去」，而「想**骑车去**哈工大」里
 * 那个「想去」并不相邻。首版没抹，结果：
 *
 *     输入「我想骑车去哈工大」→ mustVisitTexts = []   ← 目的地丢了
 *     输入「我想去哈工大」    → mustVisitTexts = ["哈工大"]  ✓
 *
 * 多两个字就把"必去"降级成了"顺路看看"，于是一句话规划变成
 * "在哈工大附近随便挑几个点"—— 正是用户报的现象。
 */
const TRAVEL_MODE_INFIX_RE =
  /(?:骑车|骑行|单车|自行车|脚踏车|步行|走路|走过去|徒步|开车|驾车|自驾|打车|出租车|网约车|拼车|公交|地铁|轻轨|坐车|乘车|巴士)\s*(?=(?:去|到|往))/g;

/**
 * ── 按目的地分别记出行方式（2026-10-14 用户要求）──────────────
 *
 * 用户原话：
 *   "若多个地名则**只自动选择用户说过出行方式的目的地**
 *    （比如：我想骑车去哈工大，再去冰雪大世界
 *      **只是去哈工大的出行方式选择为骑车，冰雪大世界依旧需要用户自己选择**）"
 *
 * ── 为什么单个 `preferredMode` 不够 ───────────────────────
 *
 * 出行方式是"**到某个目的地**"的属性，不是整句话的属性。
 * 一句话里说了两个地方、只对其中一个说了方式时，全局偏好
 * 会把"骑车"也套到另一个地方上 —— 而用户根本没这么说。
 *
 * 例：「我想骑车去哈工大，再去冰雪大世界」
 *   → 骑车是**哈工大**那一程的方式；冰雪大世界那程**没说**，
 *     应当让用户在逐段选择器里自己挑。
 *
 * 所以这里返回 `{ '哈工大': 'bicycling' }` 这样的映射。
 * 没说方式的那些地方就**不出现在映射里** —— 缺省即"没说"。
 *
 * ── 怎么把方式词与地名对上 ────────────────────────────────
 *
 * 方式词后面紧跟「去/到/往」，再往后就是那个地名。所以按**位置**配对：
 * 取方式词之后、**最早出现的那个**「去」后面紧跟的片段。
 *
 * ⚠️ 只在**真的有点名地点**时才逐一配对。配不上的（比如
 *    "骑车去吧"后面什么也没有）退回全局 `preferredMode`，
 *    免得一句话说得笼统就整个丢掉。
 */
function collectModesByText(originalText, modeInfos) {
  const map = {};
  for (const info of modeInfos || []) {
    /** 从方式词之后找最近的一个「去/到/往」 */
    const tail = originalText.slice(info.index + info.text.length);
    const m = tail.match(/(?:去|到|往)\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,16})/);
    if (!m) continue;
    /**
     * ⚠️ 一定要**切到下一个连接词之前** —— 否则
     *    「骑车去哈工大，再去冰雪大世界」会把
     *    「哈工大，再去冰雪大世界」整串当地名。
     */
    const place = m[1].split(/[，,、；;。！!？?]|再|然后|接着|之后|又/)[0].trim();
    if (place) map[place] = info.mode;
  }
  return map;
}

/**
 * 摘出文本里**所有**出行方式表达（含位置），供按地名配对用。
 *
 * @returns {Array<{mode:string, text:string, index:number}>}
 */
function detectTravelModeInfos(raw) {
  const found = [];
  for (const r of TRAVEL_MODE_RES) {
    const re = new RegExp(r.re.source, 'g');
    let m;
    while ((m = re.exec(raw)) !== null) {
      const after = raw.slice(m.index + m[0].length, m.index + m[0].length + 3);
      if (!/^\s*(?:去|到|往)/.test(after)) continue;
      found.push({ mode: r.mode, text: m[0], index: m.index });
      /** 零长度匹配保护 */
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  /** 按出现顺序排 —— 配对时靠它保持"先说先配" */
  return found.sort((a, b) => a.index - b.index);
}

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
  let raw = String(text == null ? '' : text).trim();

  const out = {
    rawText: raw,
    parser: 'rulebased',
    anchorText: null,
    /**
     * 用户说的出行方式（2026-10-14 加）：
     * `walking` / `bicycling` / `driving` / `transit`。
     *
     * ⚠️ 以前**完全没有这个字段** —— 「我想骑车去哈工大」里的「骑车」
     *    被当成了地名的一部分，用户说了白说：规划仍按「自动」算，
     *    该骑车的那段可能给他排成步行。
     */
    preferredMode: null,
    /**
     * **按目的地分别记的出行方式**（2026-10-14 加）：
     * `{ '哈工大': 'bicycling' }`。
     *
     * 用户原话："若多个地名则**只自动选择用户说过出行方式的目的地**
     * （我想骑车去哈工大，再去冰雪大世界 —— 只是去哈工大的方式选为骑车，
     *   **冰雪大世界依旧需要用户自己选择**）"
     *
     * ⚠️ 出行方式是"**到某个目的地**"的属性，不是整句话的属性。
     *    没说方式的那些地方**不在这个映射里** —— 缺省即"没说"。
     */
    preferredModeByText: {},
    /**
     * 全句只有一个方式表达、且**没能与任何地名配对**时才算"全局偏好"。
     *
     * ⚠️ 有它才能分清两种"只有一个方式"：
     *   · 「我想骑车去哈工大」    → 配对成功 → 按地名生效，**不是全局**
     *   · 「我想骑车去」          → 配不上地名 → 当全局偏好（笼统但用户确实说了）
     */
    modeIsGlobal: false,
    searchKeyword: null,
    /** 「去 X」里抽出的目标地名（可能在已知库之外） */
    goalText: null,
    /** 并列表达里的其余目标：「想去教堂和公园」→ ['公园'] */
    goalAlternatives: [],
    /** 锚点的并列项：「中央大街和索菲亚教堂」→ ['索菲亚教堂'] */
    anchorAlternatives: [],
    /** 「逛一小时」→ 60：**每站**停留分钟数，未说则为 null */
    stayMinutes: null,
    /**
     * **按地点分别给的停留时长**：`{"哈工大": 60, "冰雪大世界": 120}`。
     *
     * ⚠️ 实测（2026-10-13）：用户说「先去哈工大玩一小时再去冰雪大世界玩两小时」，
     * 而 schema 只有单个 `stayMinutes` —— **模型听懂了却装不下**，
     * 只好塞两条 matched，再反过来问用户"您说了三个不同的时长，请确认统一哪个"。
     *
     * **听不懂是模型的问题；听懂了接不住，是 schema 的问题。**
     */
    stayMinutesByText: {},
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

  /**
   * ── 出行方式先摘出来（2026-10-14 用户报的漏洞）──────────────
   *
   * 用户原话："我想骑车去哈工大时只会帮我选四个和哈工大相关的地点"
   *
   * 两件事一起做：
   *   ① 把"骑车"识别成 `preferredMode`（否则用户说了白说，
   *      规划仍按"自动"算，该骑车的地方可能给他排步行）；
   *   ② 把"骑车"从文本里**抹掉**再跑其余规则 ——
   *      否则「想**骑车去**哈工大」里的「想去」不相邻，
   *      `MUST_STRONG_RES` 抓成「骑车去哈工」（而它不在库里，被丢弃），
   *      `MUST_WEAK_RE` 的「去哈工大」又因值已在 `hits` 里而跳过，
   *      结果 `mustVisitTexts` 为空 ——
   *      **目的地被降级成"在它附近随便挑几个点"**，正是用户报的现象。
   *
   * ⚠️ 只在**方式词后面紧跟「去/到/往」**时才抹
   *    （见 `TRAVEL_MODE_INFIX_RE` 的 lookahead）——
   *    「我想去地铁站」里的"地铁"是**地名的一部分**，抹了就成了「我想去站」。
   *
   * ⚠️ **原话保留在 `originalText`**，`out.rawText` 照旧是用户原话
   *    （附录 C 的评测要按原话打分）。下面所有规则改用抹过的副本 ——
   *    注意是**重新赋值给 `raw`**，这样各处 `raw.match(...)` 与
   *    `m.index` 的下标仍然彼此一致，不必逐条改（改漏一条就会出现
   *    "用抹过的文本匹配、却拿原文本的下标去比较"的错位）。
   */
  const originalText = raw;
  const modeInfos = detectTravelModeInfos(originalText);
  out.preferredMode = modeInfos.length ? modeInfos[0].mode : null;
  /**
   * ⚠️ 全局 `preferredMode` **只在全句只有一个方式表达时才用它兜底**
   *    （见 `modeIsGlobal` 的说明）。多个地方各说各的方式时，
   *    配对映射才是权威，全局值会把方式张冠李戴。
   */
  out.preferredModeByText = collectModesByText(originalText, modeInfos);
  out.modeIsGlobal = modeInfos.length === 1 && Object.keys(out.preferredModeByText).length === 0;
  if (out.preferredMode) {
    out.matched.push({
      field: 'preferredMode',
      text: modeInfos[0].text.trim(),
      value: out.preferredMode,
      rule: 'travelMode',
    });
  }
  for (const place of Object.keys(out.preferredModeByText)) {
    out.matched.push({
      field: 'preferredModeByText',
      text: place,
      value: place + ' → ' + out.preferredModeByText[place],
      rule: 'travelModeByPlace',
    });
  }
  raw = originalText.replace(TRAVEL_MODE_INFIX_RE, '');

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
    /**
     * ⚠️ 锚点也可能是并列的：「我想去**中央大街和索菲亚教堂**」——
     * 首版整串当成一个地名，检索词成了「中央大街和索菲亚教堂」。
     * 这里用与 goal 相同的拆分（含"连接词可能是地名的一部分"的保护）。
     */
    const parts = splitPlaces(m[1]);
    if (parts.length) {
      out.anchorText = parts[0];
      if (parts.length > 1) out.anchorAlternatives = parts.slice(1);
      out.matched.push({
        field: 'anchor',
        text: m[0].trim(),
        value: parts.join(' / '),
        rule: 'anchor',
      });
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
      /**
       * ⚠️ **捕获到的可能是并列的几个地方**：「我想去**中央大街和索菲亚教堂**」，
       * `MUST_WEAK_RE` 会把整串当必须去的地点 —— 那它的 value 是
       * 「中央大街和索菲亚教堂」，`autoPick` 拿它去匹配，**永远匹配不到任何 POI**。
       *
       * 所以这里逐个拆开，每个都当一条独立记录（原文位置相同，顺序不变）。
       */
      const parts = splitPlaces(m[1]);
      for (const cleaned of parts) {
        /**
         * ⚠️ **类目词不是地名**（2026-10-13 第三次踩到同一类错误）。
         *
         * 用户说「想去**公园**」时，「公园」是个**类目**，不是某个具体的公园。
         * 但简称匹配会把它认成「兆麟公园」：
         *
         *     matchKnown('公园', [...'兆麟公园'...])  →  '兆麟公园'  ❌
         *     长度比 2/4 = 0.5，恰好卡在简称阈值上
         *
         * 后果与「哈工大」匹配到「哈工大[地铁站]」、「冰雪大世界」匹配到
         * 「…龙川路地铁站」完全同源：**名字里含这几个字 ≠ 就是那个地方**。
         *
         * 类目词仍可用于**检索**（「想去公园」→ 搜"公园"是对的），
         * 只是不能当成"用户点名要去某处"。
         */
        if (GENERIC_CATEGORY_WORDS.indexOf(cleaned) >= 0) continue;

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
   *
   * ⚠️ **要按地点分别记录**（2026-10-13 修正）：
   * 用户说「先去哈工大玩一小时再去冰雪大世界玩两小时」，
   * 而 schema 只有单个 `stayMinutes` —— **听懂了却装不下**。
   * 所以这里扫描**每一处**时长，并把紧邻它前面的地名一起记下来。
   */
  const stayHits = [];
  {
    const re = new RegExp(STAY_DURATION_RE.source, 'g');
    let m;
    while ((m = re.exec(raw)) !== null) {
      // 「多待 20 分钟」是**调整**语义，不是规划时长（见上面的说明）
      if (raw.charAt(m.index - 1) === '多') continue;
      const n = m[1] === '半' ? 0.5 : toNumber(m[1]);
      if (n == null || n <= 0) continue;
      const unit = m[2]; // ⚠️ 单位是第 2 个捕获组，数错组号会让「一小时」变成 1 分钟
      const minutes = unit === '小时' || unit === '钟头' ? Math.round(n * 60) : n;
      stayHits.push({ index: m.index, end: m.index + m[0].length, text: m[0].trim(), minutes: minutes });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }

  const unreasonable = stayHits.filter((h) => h.minutes > 8 * 60);
  for (const h of unreasonable) {
    out.uncertainties.push({
      field: 'stayMinutes',
      why: `「${h.text}」看上去太长（${h.minutes} 分钟），请确认`,
      text: h.text,
    });
  }

  const goodStay = stayHits.filter((h) => h.minutes <= 8 * 60);
  if (goodStay.length) {
    // 整句只有一个时长 → 当成"每站都待这么久"
    out.stayMinutes = goodStay[0].minutes;
    for (const h of goodStay) {
      out.matched.push({
        field: 'stayMinutes',
        text: h.text,
        value: h.minutes,
        rule: 'stay-duration',
      });
    }
  }

  /**
   * ⑦.5 「去 X」的目标。
   *
   * 用户说的地标**可能不在已知库里**（如"冰雪大世界"）—— 但那句话的意思
   * 再清楚不过：他要去 X。所以单独抽出来，作为检索词的兜底。
   * 不加这一步，「我想去冰雪大世界」会什么都搜不到。
   */
  /**
   * 「去 X」目标。
   *
   * ⚠️ **必须全局匹配**（2026-10-13 修正）：首版只取第一个「去」，
   * 于是「想去中央大街，**然后去**防洪纪念塔」只得到「中央大街」，
   * 后半句整个丢掉 —— 与"只搜一个关键词"是同一个毛病。
   */
  const goalParts = [];
  const goalTexts = [];
  GOAL_RE.lastIndex = 0;
  let gm;
  while ((gm = GOAL_RE.exec(raw)) !== null) {
    const parts = splitPlaces(gm[1]);
    /**
     * ⚠️ **「别去 X」里也有一个「去」** —— 会被 `GOAL_RE` 匹配到。
     *
     * 实测（2026-10-13）：把 `GOAL_RE` 改成全局匹配后，
     * 「一定要去中央大街，**别去**兆麟公园」的目标地点变成了
     * 「中央大街 / 兆麟公园」—— **用户明确不想去的地方被当成了目标**，
     * 而它同时又出现在「排除」里，自相矛盾。
     *
     * 所以目标必须**排除掉排除项**（与检索词的处理一致）。
     */
    const kept = parts.filter((p) => out.avoidTexts.indexOf(p) < 0);
    for (const p of kept) {
      if (goalParts.indexOf(p) < 0) goalParts.push(p);
    }
    if (kept.length) goalTexts.push(gm[0].trim());
    // 零长度匹配保护：正则若匹配到空串会死循环
    if (GOAL_RE.lastIndex === gm.index) GOAL_RE.lastIndex++;
  }

  if (goalParts.length) {
    out.goalText = goalParts[0];
    if (goalParts.length > 1) out.goalAlternatives = goalParts.slice(1);
    out.matched.push({
      field: 'goal',
      text: goalTexts.join(' / '),
      value: goalParts.join(' / '),
      rule: 'goal',
    });
  }

  /**
   * ⑦.6 把时长**按地点分开**。
   *
   *     「先去哈工大玩一小时再去冰雪大世界玩两小时」
   *        → { 哈工大: 60, 冰雪大世界: 120 }
   *
   * 做法：对每一处时长，**往前找最近出现过的目标地名**。
   * 不用位置切段是因为「玩一小时」可能出现在地名之前，往前找更稳。
   *
   * ⚠️ 只有两处以上时长才分开记 —— 只说了一个时长时，
   * 那是"每站都待这么久"，塞进 map 反而会让别的站取不到值。
   */
  if (goodStay.length >= 2 && goalParts.length) {
    for (const h of goodStay) {
      let best = null;
      for (const g of goalParts) {
        const idx = raw.lastIndexOf(g, h.index);
        if (idx >= 0 && (!best || idx > best.idx)) best = { g: g, idx: idx };
      }
      if (best) out.stayMinutesByText[best.g] = h.minutes;
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

  /**
   * ⑨ **多个检索词** —— 用户一次可能说了好几个地方。
   *
   * ⚠️ **实测踩到的坑（2026-10-13）**：用户说
   * 「先去哈工大玩一小时再去冰雪大世界玩3小时」，
   * 而 `searchKeyword` 是**单个字符串** —— 检索只发了「哈工大」，
   * 冰雪大世界根本没进候选，用户看到的全是哈工大的各种门。
   *
   * **用户说了几个地方，就要搜几次。**
   * 这里把所有提到的地方收集起来（主检索词排第一），供检索层逐个调用。
   */
  const kws = [];
  const addKw = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (s && kws.indexOf(s) < 0 && out.avoidTexts.indexOf(s) < 0) kws.push(s);
  };
  addKw(out.searchKeyword);
  for (const t of out.mustVisitTexts) addKw(t);
  addKw(out.goalText);
  for (const t of out.goalAlternatives) addKw(t);
  for (const t of out.anchorAlternatives) addKw(t);
  // 文中出现的已知地点（排除避开的）—— 用户可能顺口提了一个没被规则捕获的地方
  for (const n of known || []) {
    if (n && raw.indexOf(n) >= 0 && out.avoidTexts.indexOf(n) < 0) addKw(n);
  }
  /** 上限 5：一条需求里提到的地方不会太多 */
  out.searchKeywords = kws.slice(0, 5);

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
    /**
     * **按地点分别给的停留时长**：`{"哈工大": 60, "冰雪大世界": 120}`。
     * 规划器会按地点名匹配；匹配不上就回落到 `stayMin`。
     */
    stayByText:
      parsed.stayMinutesByText && Object.keys(parsed.stayMinutesByText).length
        ? parsed.stayMinutesByText
        : null,
    maxWalkMinutes: null, // 含糊表达**不换算**（§6.2）
    preferences: [],
    /**
     * 出行方式（2026-10-14 加）：`walking` / `bicycling` / `driving` / `transit`。
     *
     * ⚠️⚠️ **这个对象是逐字段列举的** —— `parse` 认出了新字段、
     *    但这里没加一行，它就会被**静默丢掉**，而且不报错。
     *    项目里已经因为同一个形态栽过好几次（`spec`、`startLegView`、
     *    `legToNext`、响应拼装都是逐字段列举）。
     *    **在 `parse` 里加字段时，必须回来这里也加一行。**
     *
     * ⚠️ 走 AI 解析时，这个值是**模型直接给的**，所以必须校验：
     *    它完全可能返回 `"bike"` / `"自行车"` / `"骑行"` 这类不在枚举里的值。
     *    这里**单点收口**（两条解析路径都经过本函数），
     *    认不出的值一律置 null 而不是原样透传 —— 一个野值会让下游
     *    `isPreferredMode` 判断失败，最后表现为"用户说的出行方式没生效"，
     *    而那种失败**不报错**、极难定位。
     */
    preferredMode: normalizePreferredMode(parsed.preferredMode),
    /**
     * 按目的地分别记的出行方式（2026-10-14 加）。键是**地名**，
     * 值是归一化后的方式；认不出的整条丢弃。
     */
    preferredModeByText: normalizeModeByText(parsed.preferredModeByText),
    /**
     * "这个方式是全局偏好"还是"只属于某个地名"。
     *
     * 用户要求："**若多个地名则只自动选择用户说过出行方式的目的地**" ——
     * 界面据此决定：配对上的按地名生效，没配对上的留给用户自己选。
     */
    modeIsGlobal: parsed.modeIsGlobal === true,
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

  /** 检索词（复数）—— 后面渲染说明时要用 */
  const kws = (parsed.searchKeywords || []).length
    ? parsed.searchKeywords
    : parsed.searchKeyword
      ? [parsed.searchKeyword]
      : [];

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
    /**
     * 单位只在**值是纯数字**时补。
     * 否则「哈工大 60 分钟 / 哈学院 60 分钟」会被加成「… 分钟 分钟」，
     * 或「检索词：A / B」这种本就没有单位的值被硬加一个。
     */
    const unit =
      UNIT[field] && /^[\d.]+$/.test(String(value)) ? UNIT[field] : '';
    lines.push(text ? `${label}：${value}${unit}（来自「${text}」）` : `${label}：${value}${unit}`);
  };

  // 1) 解析过程记录：带原文片段，最有用
  //
  // ⚠️ `searchKeyword`（单数）要跳过 —— 它只是"主检索词"，一个值。
  // 直接显示它会让用户以为系统只搜了一个地方（实测踩到：
  // 用户说「先去哈工大再去冰雪大世界再去哈学院」，
  // 界面显示「检索词：哈工大」，而实际三个都搜了）。
  // 检索词统一在下面按**复数**渲染。
  for (const m of parsed.matched || []) {
    if (m.field === 'searchKeyword') continue;
    /**
     * ⚠️ 按地点给的时长时，逐条的 `stayMinutes` 记录**不再单独显示**。
     *
     * 用户说「哈工大1小时、冰雪大世界2小时」时，逐条记录会长成
     * 「每站停留：60 分钟」「每站停留：120 分钟」—— 两个值并排、互相矛盾，
     * 看起来像系统自相冲突。下面统一按地点渲染一份。
     */
    if (m.field === 'stayMinutes' && Object.keys(parsed.stayMinutesByText || {}).length) continue;
    push(m.field, m.value, m.text);
  }

  // 2) 兜底：结构化字段里有值、但 matched 没提到的，补上
  if (parsed.startClock) push('startAt', parsed.startClock.text);
  if (parsed.endClock) push('endAt', parsed.endClock.text);
  if (parsed.pace && parsed.pace !== 'normal') push('pace', parsed.pace);
  if (parsed.anchorText) push('anchor', parsed.anchorText);
  if (parsed.stayMinutes != null && !Object.keys(parsed.stayMinutesByText || {}).length) {
    push('stayMinutes', parsed.stayMinutes);
  }
  /** 按地点分别给的时长 —— 一次列清，而不是显示两个互相矛盾的值 */
  const byText = parsed.stayMinutesByText || {};
  const byTextKeys = Object.keys(byText);
  if (byTextKeys.length) {
    push('stayMinutes', byTextKeys.map((k) => `${k} ${byText[k]} 分钟`).join(' / '));
  }
  if (parsed.extendStayMin != null) push('extendStay', parsed.extendStayMin);
  for (const n of parsed.mustVisitTexts || []) push('mustVisit', n);
  for (const n of parsed.avoidTexts || []) push('avoid', n);

  /**
   * 3) 检索词 —— **按复数渲染**。
   *
   * ⚠️ 实测踩到的坑（2026-10-13）：用户说
   * 「先去哈工大再去冰雪大世界再去哈学院」，界面只显示「检索词：哈工大」，
   * 让人以为漏搜了两个地方 —— 而实际三个都搜了，只是这里打印了单数字段。
   *
   * 检索词与「目标地点」常常是同一份列表。**同一件事不显示两遍**，
   * 但保留「检索词」这个标签 —— 用户验的是"系统拿什么去搜了"。
   */
  const goalHit = (parsed.matched || []).find((m) => m.field === 'goal');
  const goals = [].concat(parsed.goalText ? [parsed.goalText] : [], parsed.goalAlternatives || []);
  const sameAsGoals =
    kws.length > 0 && kws.length === goals.length && kws.every((k, i) => k === goals[i]);

  // 与检索词完全重复的「目标地点」不再单独输出（下面是它的替身）
  if (sameAsGoals && goalHit) {
    const already = lines.findIndex((l) => l.indexOf('目标地点：') === 0);
    if (already >= 0) lines.splice(already, 1);
  }

  if (kws.length) {
    push('searchKeyword', kws.join(' / '), sameAsGoals && goalHit ? goalHit.text : null);
  }

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
  /** 类目 + 名字双重判断 —— 住宿类的类目常常笼统到查不出来 */
  isVisitablePlace,
  cleanPlacePhrase,
  /** 把可能并列的地名串拆开（含"连接词可能是地名一部分"的保护） */
  splitPlaces,
  NON_VISITABLE_CATEGORY_RE,
  LODGING_NAME_RE,
  CATEGORY_WORDS,
  GENERIC_CATEGORY_WORDS,
  _rules: { END_TIME_RES, START_TIME_RES, PACE_RULES, VAGUE_RULES, ANCHOR_RES, GOAL_RE },
};

'use strict';

/**
 * 内容安全的**本地规则层** —— 离线、确定性、零成本、可单测。
 *
 * ── 为什么需要这一层，而不是把所有文本都丢给微信 `msgSecCheck` ──────────
 *
 * ① **不能只靠云**：聊天发送是高频操作，每发一句话都先走一次云调用，
 *    等于给"发消息"这个动作加了一次外部依赖。断网、未配置、权限没开时
 *    云调用必然失败，而"失败就放行"等于这个功能从未存在。
 * ② **云接口不管我们最该管的那一类**：手机号、微信号、外部链接、拉群广告
 *    不是"违法违规内容"，微信的词库不管，但在这个产品里必须挡 ——
 *    小队聊天是熟人小圈子，一旦被导流，私域就成了别人的流量池。
 * ③ **语义是确定性的**：`138xxxx` 这种串是不是手机号，不需要语境判断，
 *    本地判断比模型判断更稳、更快、更可解释。
 *
 * ── 这一层**刻意不做**什么 ────────────────────────────────────────
 *
 * **不建涉政 / 涉黄 / 涉暴词表。** 原因不是省事，是这类判断有三个硬约束：
 *   · 同一个词在不同语境里意思完全不同，词表必然既漏又误伤；
 *   · 词表一旦写进仓库就固定了，内容安全是持续对抗，需要专业团队持续更新；
 *   · 误伤一个正常用户的代价，远大于省下的一次云调用。
 * 这部分交给微信官方词库（`lib/safety/cloud.js`）——**不属于自己的判断，
 * 就不要用一份自己维护的词表假装能覆盖。**
 *
 * 所以本层的定位是"**业务规则**"，不是"合规审查"。
 */

/** 命中即拒绝（输入）／命中即脱敏（输出）的分组 */
const GROUPS = {
  /** 联系方式：手机号、微信/QQ 号、邮箱 */
  CONTACT: 'contact',
  /** 站外链接与二维码导流 */
  LINK: 'link',
  /** 拉群 / 刷单 / 招代理这类明确的导流话术 */
  SOLICIT: 'solicit',
  /** 人身威胁（`severe`：输出侧不脱敏，直接整条替换） */
  THREAT: 'threat',
  /** 控制字符、零宽字符、双向控制符 */
  CONTROL: 'control',
};

const digits = (match) => (match.length <= 4 ? '****'
  : match.slice(0, 3) + '*'.repeat(Math.max(3, match.length - 7)) + match.slice(-4));

/**
 * 规则表 —— 每条都必须回答三个问题，否则不该出现在这里：
 *   ① 它挡的是什么（label，用点号分段，便于统计与排障）；
 *   ② 为什么本地判断不会误伤（`why`，写在注释里，不写就说明还没想清楚）；
 *   ③ 输出侧怎么处理（`maskable` / `placeholder`）。
 *
 * ⚠️ 正则一律带 `g`，且**不使用后行断言**：云函数运行在 Node 16 上，
 * 虽然 16 已支持 lookbehind，但把兼容性压到最低要求没有成本。
 */
const RULES = [
  {
    group: GROUPS.CONTACT,
    label: 'contact.phone',
    // 11 位大陆手机号。前后不许紧邻数字，避免把 18 位订单号里的片段当手机号。
    pattern: '(?:^|[^0-9])(1[3-9][0-9]{9})(?![0-9])',
    pick: 1,
    why: '手机号是定长且有固定号段的结构，本地判断准确率高于任何模型。',
    maskable: true,
    placeholder: digits,
  },
  {
    group: GROUPS.CONTACT,
    label: 'contact.phone_spaced',
    // 「138 0013 8000」这类用空格/短横拆开写的绕过写法
    pattern: '(?:^|[^0-9])(1[3-9][0-9](?:[ \\-][0-9]{4}){2})(?![0-9])',
    pick: 1,
    why: '拆开写是绕过关键词过滤最常见的形式，而它的结构依然固定。',
    maskable: true,
    placeholder: digits,
  },
  {
    group: GROUPS.CONTACT,
    label: 'contact.wechat',
    // 「加微信/加V/加我vx」以及显式写出的微信号。
    // 「微信号」三个字之间允许夹空格 —— 拆开写是最常见的一种绕过。
    pattern: '(?:加(?:我)?(?:的)?(?:微信|威信|vx|VX|V信|v信|威))|(?:微信[ \\t]*(?:号)?[ \\t]*[:：][ \\t]*[A-Za-z][-_A-Za-z0-9]{5,19})',
    why: '「加微信」这类短句在熟人聊天里没有正当用途，误伤面极小。',
    maskable: true,
    placeholder: () => '〔联系方式已屏蔽〕',
  },
  {
    group: GROUPS.CONTACT,
    label: 'contact.qq',
    pattern: '(?:QQ|扣扣|企鹅)[ \\t]*(?:号)?[ \\t]*[:：]?[ \\t]*[1-9][0-9]{4,11}',
    why: 'QQ 号必须带前缀才判定，避免把普通数字串当号。',
    maskable: true,
    placeholder: () => '〔联系方式已屏蔽〕',
  },
  {
    group: GROUPS.CONTACT,
    label: 'contact.email',
    pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
    why: '邮箱格式自带 @ 与顶级域，几乎不会与正常中文句子碰撞。',
    maskable: true,
    placeholder: () => '〔邮箱已屏蔽〕',
  },
  {
    group: GROUPS.LINK,
    label: 'link.url',
    pattern: '(?:https?:\\/\\/|www\\.)[^\\s一-龥]{3,}',
    why: '站外链接在小队聊天里只会是导流或钓鱼，没有正当场景。',
    maskable: true,
    placeholder: () => '〔链接已省略〕',
  },
  {
    group: GROUPS.LINK,
    label: 'link.domain',
    // 裸域名：xx.com / xx.cn 等。顶级域用白名单，避免把「3.5」「1.2」当域名。
    pattern: '(?:^|[^A-Za-z0-9.-])[A-Za-z0-9-]{2,30}\\.(?:com|cn|net|org|top|xyz|vip|cc|io|me|co)(?![A-Za-z0-9])',
    why: '只认固定的常见顶级域，宁可漏掉冷门后缀也不误伤正常文本。',
    maskable: true,
    placeholder: () => '〔链接已省略〕',
  },
  {
    group: GROUPS.LINK,
    label: 'link.qrcode',
    pattern: '(?:扫码|扫一扫|长按识别|识别二维码|小程序码)',
    why: '二维码/小程序码是站外导流的入口，聊天里出现即属于业务不允许的行为。',
    maskable: true,
    placeholder: () => '〔二维码内容已屏蔽〕',
  },
  {
    group: GROUPS.SOLICIT,
    label: 'solicit.group',
    // 「加群 / 拉群 / 进群」必须与第二人称或动作连用，单独一个「群」不判
    pattern: '(?:加|拉|进|建)(?:个|一个)?群|群号[ \\t]*[:：]?[ \\t]*[0-9]{5,}',
    why: '必须出现明确的拉人动作，单个「群」字在正常聊天里太常见。',
    maskable: true,
    placeholder: () => '〔导流内容已屏蔽〕',
  },
  {
    group: GROUPS.SOLICIT,
    label: 'solicit.ad',
    pattern: '(?:刷单|刷好评|日结|招代理|招兼职|高额返(?:现|利)|代开发票|办证|博彩|赌博|私彩|时时彩)',
    why: '这些词在旅游小队场景没有任何正当用法，且都是同一类"拉人下水"的话术。',
    maskable: true,
    placeholder: () => '〔导流内容已屏蔽〕',
  },
  {
    group: GROUPS.THREAT,
    label: 'threat.person',
    // 只收明确针对人的威胁；「累死了」「笑死」这类常见夸张说法一律不收。
    pattern: '(?:弄死你|打死你|砍死你|杀了你|杀你全家|全家死光|人肉你|扒你)',
    why: '都是明确指向具体人的暴力威胁，不存在玩笑与正经用法混淆的空间。',
    /** 输出侧不做脱敏：一句话里出现暴力威胁，整条回答都不可信。 */
    severe: true,
    maskable: false,
  },
  {
    group: GROUPS.CONTROL,
    label: 'control.invisible',
    // C0/C1 控制符、零宽字符、双向覆盖符。允许 \n \r \t —— 正常排版要用。
    // ⚠️ 刻意**不含** U+FE0F（emoji 变体选择符）：它是正常输入，"❤️" 就是两码位。
    pattern: '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]',
    why:
      '这些字符肉眼不可见：既能把违禁词拆开绕过检测，也能让显示内容与看到的完全不一致。' +
      '昵称里更要挡 —— 「小明」与「小明\\u200B」在界面上长得一模一样，' +
      '后者可以冒充别人。正常输入不需要它们，所以一律拒绝，不做例外。',
    severe: true,
    maskable: false,
  },
];

/** 全角转半角后长度不变，因此可以用同一组下标回原串取原文。 */
function foldWidth(text) {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

function compile(rule) {
  // 规则来自本文件常量，不接受外部拼装 —— 没有 ReDoS 的注入面。
  return new RegExp(rule.pattern, 'g');
}

/** 规则命中时取原文的哪一段（带前缀分支的正则用 `pick` 指出真正的命中） */
function pickText(match, rule) {
  if (!rule.pick) return match[0];
  const value = match[rule.pick];
  return value === undefined ? match[0] : value;
}

/**
 * 扫描一段文本。
 *
 * @param {string} text
 * @param {string[]} [groups] 只跑这些分组（策略表按字段决定）；不给就全跑
 * @returns {{level:'pass'|'risky', hits:Array<{group,label,text,index,length,severe}>}}
 *   `level` 只有两档：本地规则**不产出 `review`** —— 没有人工复核队列的产品里，
 *   一个"待复核"状态最终一定退化成"放行"或"误伤"，不如不要这一档。
 */
function scan(text, groups) {
  const source = text == null ? '' : String(text);
  if (!source) return { level: 'pass', hits: [] };
  const folded = foldWidth(source);
  const active = groups && groups.length ? RULES.filter((r) => groups.includes(r.group)) : RULES;
  const hits = [];

  for (const rule of active) {
    const re = compile(rule);
    let m;
    // 上限只为防御：一段 1000 字的文本命中几十次已足够判定，不需要跑完全部。
    for (let guard = 0; guard < 50 && (m = re.exec(folded)) !== null; guard++) {
      const value = pickText(m, rule);
      if (!value) continue;
      /**
       * 下标回溯到原始串：`foldWidth` 是逐字符 1:1 替换，所以可以直接用。
       * 但带前缀分支的规则（如 `(?:^|[^0-9])(1...)`）命中段前面还有 0—1 个字符，
       * 用 `lastIndex - value.length` 反推会差一位 —— 所以用 `indexOf(value, 起点)` 定位。
       */
      const from = Math.max(0, m.index - 1);
      const at = folded.indexOf(value, from);
      hits.push({
        group: rule.group,
        label: rule.label,
        text: at >= 0 ? source.slice(at, at + value.length) : value,
        index: at >= 0 ? at : m.index,
        length: value.length,
        severe: rule.severe === true,
      });
      if (re.lastIndex === m.index) re.lastIndex++; // 空匹配保护
    }
  }

  hits.sort((a, b) => a.index - b.index || b.length - a.length);
  const unique = hits.filter((hit, i) => i === 0 || hit.index !== hits[i - 1].index || hit.label !== hits[i - 1].label);
  return { level: unique.length ? 'risky' : 'pass', hits: unique };
}

/**
 * 输出侧脱敏：把联系方式、链接替换成可读的占位，**不整条丢弃**。
 *
 * 为什么不直接整条替换：模型回答里出现一个手机号，通常是因为用户问到了
 * 营业时间、联系电话这类正当信息，直接丢掉整段回答对用户是净损失。
 * 但 `severe`（暴力威胁 / 不可见字符）例外 —— 那种内容说明这条输出根本不可信。
 */
function mask(text) {
  let out = text == null ? '' : String(text);
  const masked = [];

  for (const rule of RULES) {
    if (!rule.maskable) continue;
    /**
     * ⚠️ 每条规则都要**重新折叠一次**当前文本。
     *
     * 前一条规则的替换会改变字符串长度（`〔链接已省略〕` 与原文长度不等），
     * 复用一开始算好的下标就会把后面的替换插到错位置 —— 症状是
     * "脱敏之后反而留下半截手机号"，而它不会报任何错。
     */
    const folded = foldWidth(out);
    const re = compile(rule);
    const parts = [];
    let m;
    for (let guard = 0; guard < 50 && (m = re.exec(folded)) !== null; guard++) {
      const value = pickText(m, rule);
      if (!value) continue;
      const from = Math.max(0, m.index - 1);
      const at = folded.indexOf(value, from);
      if (at < 0) continue;
      parts.push({ at, length: value.length, rule, value });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    // 同一条规则内从后往前替换，前面的下标才不会失效
    for (const part of parts.sort((a, b) => b.at - a.at)) {
      const placeholder = typeof part.rule.placeholder === 'function'
        ? part.rule.placeholder(part.value)
        : '〔已屏蔽〕';
      out = out.slice(0, part.at) + placeholder + out.slice(part.at + part.length);
      masked.push({ label: part.rule.label, group: part.rule.group });
    }
  }

  const verdict = scan(out);
  return { text: out, masked, severe: verdict.hits.some((h) => h.severe) };
}

/** 命中项的标签集（去重，写入元信息用；**不带原文**） */
const labelsOf = (hits) => [...new Set((hits || []).map((h) => h.label))];
const groupsOf = (hits) => [...new Set((hits || []).map((h) => h.group))];

module.exports = { GROUPS, RULES, scan, mask, labelsOf, groupsOf, foldWidth };

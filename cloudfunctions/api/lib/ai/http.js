'use strict';

/**
 * 需求解析 —— **模型实现**（OpenAI 兼容的 chat/completions 协议）。
 *
 * DeepSeek、混元、通义等多数国内模型都提供兼容端点，所以这一个实现能覆盖多种选择，
 * 换模型只改环境变量，不改代码。
 *
 * Key 只从**云函数环境变量**读（`AI_API_KEY`），客户端与仓库都拿不到 ——
 * 这条对应计划书 11/12 验收「密钥不在客户端或仓库」，与地图服务同一约定。
 *
 * ⚠️ 提示词是有版本的（`PROMPT_VERSION`）。附录 C 的评测要能说清
 * "这个分数是哪一版提示词跑出来的"，所以版本号必须随结果回传。
 */

const { defaultTransport, redact } = require('../http');
const { parseJsonLoose } = require('./json');

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * 给模型的系统提示。
 *
 * 三条纪律写在最前面，因为它们决定了这个系统的可信度：
 *   ① 不猜 —— 说了但含糊的必须进 uncertainties，不能编成具体数值；
 *   ② 不生成数值 —— 时长、距离、开放时间都由工具算，模型只做理解；
 *   ③ 原话保留 —— rawText 一字不改，评测要用。
 *
 * ── v2 改了什么（2026-10-13，实测 DeepSeek 后）────────────────
 *
 *   · **补上 `stayMinutes`** —— v1 的 schema 里根本没有这个字段，
 *     于是用户说「玩一小时」模型听懂了却无处可放，信息直接丢掉。
 *     **schema 与解析器的期望必须一致，否则模型答对了也没用。**
 *   · **说清"没说" ≠ "不确定"** —— v1 让模型把"用户没有提到出发时间"
 *     也报成 uncertainties，界面上全是废话待确认项。
 *     真正的 uncertainty 是"**说了，但没法确定**"（如"五点前"没说上下午）。
 *   · **说明 matched 的用途** —— 它是给人看"我理解到了什么"的，
 *     模型常把它留空，导致界面显示"没有能确定的项"。
 */
const SYSTEM_PROMPT = `你是一个城市徒步游览的需求解析器。把用户的一句话转成 JSON。

四条必须遵守的纪律：
1. **不猜**。用户说得**含糊**（如"有点累""尽量少走""随便"）时，把该项放进 uncertainties 并说明原因，**绝对不要**编造具体数值。
2. **"没说"不等于"不确定"**。用户没提到出发时间、结束时间、节奏，那是**正常情况**，不必报告——系统会用默认值，界面上也没有必要打扰用户。**只有"说了但没法确定"才进 uncertainties**，例如"五点前结束"而没说上午还是下午。
3. **不生成数值**。你只负责"听懂"，不负责估算距离、时长、营业时间——那些由系统用真实数据计算。
4. **原话保留**。rawText 必须与用户输入完全一致，一个字都不要改。

只输出 JSON，不要解释，不要 markdown 代码块。JSON 结构：
{
  "rawText": "用户原话，一字不改",
  "anchorText": "提到的主要区域或地点，没有则 null",
  "searchKeyword": "用于搜索地点的主关键词，没有则 null",
  "searchKeywords": ["所有要用去搜索的地点关键词"],
  "startClock": {"hour": 0-23, "minute": 0-59} 或 null,
  "endClock": {"hour": 0-23, "minute": 0-59} 或 null,
  "pace": "relaxed" | "normal" | "packed",
  "mustVisitTexts": ["一定要去的地方"],
  "avoidTexts": ["明确不想去的地方"],
  "preferredMode": "walking" | "bicycling" | "driving" | "transit" 或 null,
  "stayMinutes": 每个地点都待同样久时的分钟数（整数）或 null,
  "stayMinutesByText": {"地点关键词": 分钟数},
  "extendStayMin": 在**已有行程**上多待多少分钟，或 null,
  "matched": [{"field":"字段名","text":"原文片段","value":"解析值"}],
  "uncertainties": [{"field":"字段名","why":"为什么没把握，给用户看"}]
}

关于时间：
- 说"五点前结束"但没说是上午还是下午时，**不要**自行假定，放进 uncertainties，
  并给出 candidates 数组如 ["05:00","17:00"]；
- 如果上下文明显（如"下午五点"、"上午十点出发，六点前结束"）则直接给出 24 小时制。

关于停留时长：
- 「逛一小时」/「玩两个小时」/「待 40 分钟」→ stayMinutes（60 / 120 / 40）；
- **每个地方时长不同时**填 stayMinutesByText，例如
  「先去哈工大玩一小时再去冰雪大世界玩两小时再去哈学院玩一小时」
    → {"哈工大": 60, "冰雪大世界": 120, "哈学院": 60}，
  此时 stayMinutes 留 null。**不要因为时长不同就把它当成"需要用户确认"** ——
  系统本来就支持按地点分别设时长，照实填即可。
- 「多待 20 分钟」（对已有行程的调整）→ extendStayMin。
  与上面两个语义不同，**不要混用**。

关于 anchorText：
- **只在用户说"某地附近/周边/一带"这类"一片区域"时才填**（如"中央大街附近逛逛"）。
- 用户点名要去的**具体地点不要填在这里**，放进 searchKeywords。
  填错会让系统以为他是"在某个区域随便逛"，从而**自作主张多加地点**。

关于检索词：
- 用户一次可能说了**好几个**地方，例如「先去哈工大玩一小时再去冰雪大世界玩3小时」。
  **每一个都要进 searchKeywords**（["哈工大", "冰雪大世界"]），
  系统会逐个搜索 —— 只给一个会导致另一个地方完全搜不到。
- searchKeywords 里**不要**放动词、时间、数量（不要"哈工大玩一小时"，只要"哈工大"）。
- 用户明确不想去的地方**不要**放进 searchKeywords。
- ⚠️ **出行方式的词不要混进 searchKeywords**。用户说「我想骑车去哈工大」，
  检索词只有「哈工大」，**不是**「骑车去哈工大」也不是「骑车」——
  混进去会让搜索变成"找哈工大相关的地点"，而用户要的是"**去**哈工大"。

关于 preferredMode（出行方式）：
- 用户明确说了怎么去时填它：
  「骑车 / 骑行 / 自行车」→ "bicycling"；「步行 / 走路 / 走过去」→ "walking"；
  「开车 / 自驾 / 打车」→ "driving"；「公交 / 地铁 / 坐车」→ "transit"。
- **没说就填 null** —— 这是正常情况，不要进 uncertainties，系统会用默认值。
- ⚠️ **只有当它是"怎么去"时才填**。用户说「我想去**地铁站**」时，
  「地铁」是**目的地名字的一部分**，preferredMode 必须是 null，
  而且「地铁站」要完整进 searchKeywords。
  同理「骑车公园」「步行街」都不是出行方式。
  判断标准：这个词**后面紧跟着"去/到/往"**才是出行方式。

关于 mustVisitTexts 与 preferredMode 的关系：
- 「我想骑车去哈工大」里，**「哈工大」是必须去的具体目的地**，
  它不是"顺路看看的地方"，也不是"一片区域"。
  anchorText 要留 null，mustVisitTexts 要有「哈工大」。
  把它漏掉会让系统以为用户只是想在哈工大附近随便逛逛 ——
  那是**完全不同的一次规划**。

关于 matched：
- 把**每一个**解析出来的字段都记一条，text 是原文里对应的片段。
- 这个数组会直接显示给用户看"我理解到了什么"，**留空会让用户以为什么都没听懂**。`;

/** 提示词版本 —— 改了提示词就必须改它，否则评测结果无法归因 */
const PROMPT_VERSION = 'intent-v5';

function createHttpParser(opts) {
  opts = opts || {};
  const key = (opts.key !== undefined ? opts.key : process.env.AI_API_KEY || '').trim();
  const baseUrl = (opts.baseUrl || process.env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = opts.model || process.env.AI_MODEL || DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const http = opts.http || defaultTransport;

  return {
    name: 'http',
    promptVersion: PROMPT_VERSION,
    model,
    /** 没配 Key 就是不可用 —— 由调用方降级到规则解析，而不是报错 */
    available: Boolean(key),
    keyMasked: key ? `${key.slice(0, 4)}${'*'.repeat(Math.max(4, key.length - 8))}${key.slice(-4)}` : null,

    async parse(text, o) {
      o = o || {};
      if (!key) {
        return {
          ok: false,
          reason: 'AI_KEY_NOT_CONFIGURED',
          message: '云函数环境变量 AI_API_KEY 未配置，无法调用大模型',
          // 失败必须带可执行的修复指引（与地图服务同一约定）
          hint:
            '云开发控制台 → 云函数 → api → 配置 → 环境变量 → 新增 AI_API_KEY。' +
            'Key 到 platform.deepseek.com 申请；**为本项目单独申请**，' +
            '不要复用其他工具的（账单会纠缠）。' +
            '配好之前系统会自动降级到规则解析，功能不中断。',
        };
      }

      const url = `${baseUrl}/chat/completions`;
      const started = Date.now();
      let res;
      try {
        res = await http(url, {
          method: 'POST',
          timeoutMs,
          errorCode: 'AI_UPSTREAM_FAILED',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            /**
             * temperature: 0 —— 解析要**可复现**。附录 C 的评测会重复跑同一批样例，
             * 随机性会直接污染分数。理解任务也不需要创造性。
             */
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: String(text == null ? '' : text) },
            ],
            response_format: { type: 'json_object' },
          }),
        });
      } catch (e) {
        return {
          ok: false,
          reason: 'AI_UPSTREAM_FAILED',
          message: (e && e.message) || String(e),
          requestUrl: redact(url),
          timingMs: Date.now() - started,
        };
      }

      const timingMs = Date.now() - started;
      const body = res.json || {};
      const choice = (body.choices || [])[0];
      const content = choice && choice.message && choice.message.content;

      if (!content) {
        return {
          ok: false,
          reason: 'AI_EMPTY_RESPONSE',
          message: '模型没有返回内容',
          httpStatus: res.httpStatus,
          timingMs,
          rawHead: String(res.rawBody || '').slice(0, 600),
        };
      }

      /**
       * ⚠️ 用容错解析而不是裸 `JSON.parse`。
       *
       * 模型经常把 JSON 包在 markdown 代码块里，或前后加一句"好的"。
       * 那是**已知的常见行为**，不该让整次解析失败 ——
       * 尤其 `response_format` 并非所有模型都可靠支持（有的忽略、有的报错）。
       * 详见 lib/ai/json.js 的说明。
       */
      const parsed = parseJsonLoose(content);
      if (!parsed) {
        return {
          ok: false,
          reason: 'AI_BAD_JSON',
          message: '模型返回的不是合法 JSON（已尝试剥离 markdown 代码块与前后解释）',
          rawHead: String(content).slice(0, 600),
          timingMs,
        };
      }

      // 原话保留是硬要求：模型改了口径就不能用于评测归因
      if (parsed.rawText !== text) {
        parsed.rawTextModelOutput = parsed.rawText;
        parsed.rawText = text;
        parsed.rawTextCorrected = true;
      }

      return {
        ok: true,
        parsed,
        requestUrl: redact(url),
        httpStatus: res.httpStatus,
        timingMs,
        usage: body.usage || null,
        promptVersion: PROMPT_VERSION,
        model,
        /**
         * 模型的**原始输出**（截断）。
         * 成功时也要带出来 —— 核对"它到底返回了什么结构"只能靠它，不能靠记忆。
         * 与地图探针带 rawHead 是同一条纪律。
         */
        rawHead: String(content).slice(0, 600),
      };
    },
  };
}

module.exports = { createHttpParser, PROMPT_VERSION, SYSTEM_PROMPT, DEFAULT_BASE_URL, DEFAULT_MODEL };

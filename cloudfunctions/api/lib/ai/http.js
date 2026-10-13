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

/** 提示词版本 —— 改了提示词就必须改它，否则评测结果无法归因 */
const PROMPT_VERSION = 'intent-v1';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * 给模型的系统提示。
 *
 * 三条纪律写在最前面，因为它们决定了这个系统的可信度：
 *   ① 不猜 —— 含糊表达必须进 uncertainties，不能编成具体数值；
 *   ② 不生成数值 —— 时长、距离、开放时间都由工具算，模型只做理解；
 *   ③ 原话保留 —— rawText 一字不改，评测要用。
 */
const SYSTEM_PROMPT = `你是一个城市徒步游览的需求解析器。把用户的一句话转成 JSON。

三条必须遵守的纪律：
1. **不猜**。用户说得含糊（如"有点累""尽量少走""随便"）时，把该项放进 uncertainties 数组并说明原因，**绝对不要**编造具体数值。
2. **不生成数值**。你只负责"听懂"，不负责估算距离、时长、营业时间——那些由系统用真实数据计算。
3. **原话保留**。rawText 必须与用户输入完全一致，一个字都不要改。

只输出 JSON，不要解释，不要 markdown 代码块。JSON 结构：
{
  "rawText": "用户原话",
  "anchorText": "提到的主要区域或地点，没有则 null",
  "searchKeyword": "用于搜索地点的关键词，没有则 null",
  "startClock": {"hour": 0-23, "minute": 0-59} 或 null,
  "endClock": {"hour": 0-23, "minute": 0-59} 或 null,
  "pace": "relaxed" | "normal" | "packed",
  "mustVisitTexts": ["一定要去的地方"],
  "avoidTexts": ["明确不想去的地方"],
  "extendStayMin": 数字或 null,
  "matched": [{"field":"字段名","text":"原文片段","value":"解析值"}],
  "uncertainties": [{"field":"字段名","why":"为什么没把握，给用户看"}]
}

注意：说"五点前结束"但没说是上午还是下午时，**不要**自行假定；
如果上下文明显（如"下午五点"）则直接给出 17 点。`;

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
        return { ok: false, reason: 'AI_KEY_NOT_CONFIGURED', message: '云函数环境变量 AI_API_KEY 未配置' };
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

      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        return {
          ok: false,
          reason: 'AI_BAD_JSON',
          message: '模型返回的不是合法 JSON',
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
      };
    },
  };
}

module.exports = { createHttpParser, PROMPT_VERSION, SYSTEM_PROMPT, DEFAULT_BASE_URL, DEFAULT_MODEL };

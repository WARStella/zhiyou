'use strict';

/**
 * 内容安全闸门 —— 把"本地规则 + 微信云接口"合成**一个判定**。
 *
 * ── 判定顺序（顺序本身是设计的一部分）──────────────────────────
 *
 *   本地规则 ──risky──▶ 拒绝（不花一次云调用，用户立刻拿到可改的提示）
 *      │
 *      └─pass─▶ 云接口 ──risky──▶ 拒绝
 *                  │
 *                  ├─review──▶ 放行但留痕（没有人工复核队列，不假装在复核）
 *                  │
 *                  └─失败/超时──▶ 按 SAFETY_FAIL_MODE 放行或拒绝
 *
 * 为什么本地排在最前：① 它比云调用快两个数量级；② 它命中的那类内容
 * （手机号、链接）**无论云端怎么判都该拒绝**，先拒能省一次配额；
 * ③ 云调用失败时，本地规则仍然有效 —— 这是"断网也不裸奔"的来源。
 *
 * ── 失败策略为什么默认 open ───────────────────────────────────
 *
 * 本项目是比赛体验版：`api/config.json` 漏登记权限、云开发套餐不含该接口，
 * 都会让**所有**聊天直接失败。对"内容安全"这类**发布合规**要求来说，
 * 正确做法是 `SAFETY_FAIL_MODE=closed`（拒绝一切无法确认的内容）；
 * 对"还在联调"的阶段，`open` 让主链路可用，并把 `degraded` 如实写进
 * 响应元信息与事件日志 —— **降级必须可见**，不能悄悄发生。
 * 两种模式都由环境变量选，代码不替部署方做决定。
 */

const crypto = require('crypto');
const lexicon = require('./lexicon');
const policy = require('./policy');
const { defaultProvider } = require('./cloud');

const MODES = ['off', 'local', 'cloud'];

function pickMode(value) {
  const mode = String(value == null ? '' : value).trim().toLowerCase();
  return MODES.includes(mode) ? mode : 'cloud';
}
function pickFailMode(value) {
  return String(value == null ? '' : value).trim().toLowerCase() === 'closed' ? 'closed' : 'open';
}
function pickInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value == null ? '' : value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 进程内短缓存。
 *
 * 为什么需要：同一句话被用户反复重发（网络抖动时的重试）、同一个昵称
 * 被反复提交，都会产生**完全相同**的检测请求。不缓存等于把配额
 * 送给这些重复请求，而这些请求的结论本来就不会变。
 *
 * 为什么有上限：云函数实例是长驻的，无界 Map 会慢慢吃掉内存。
 * 这里用最朴素的"超限删最旧的"，没有引入 LRU 实现 —— 命中率瓶颈
 * 不在淘汰策略上，写一个手写链表只会多一处可能出错的地方。
 */
function createCache(ttlMs, max) {
  const map = new Map();
  return {
    get(key, now) {
      const row = map.get(key);
      if (!row) return null;
      if (now - row.at > ttlMs) { map.delete(key); return null; }
      return row.verdict;
    },
    set(key, verdict, now) {
      map.set(key, { verdict, at: now });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    clear() { map.clear(); },
    get size() { return map.size; },
  };
}

/**
 * @param {object} [options]
 * @param {object} [options.env]      环境变量（默认 process.env）
 * @param {object} [options.provider] 显式注入的云 provider；`null` = 明确不用云
 * @param {number|Function} [options.now] 时间基准（测试可复现）
 */
function createSafetyGate(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const mode = pickMode(env.SAFETY_MODE);
  const failMode = pickFailMode(env.SAFETY_FAIL_MODE);
  const timeoutMs = pickInt(env.SAFETY_TIMEOUT_MS, 1500, 200, 5000);
  const cache = createCache(pickInt(env.SAFETY_CACHE_TTL_MS, 10 * 60 * 1000, 0, 60 * 60 * 1000),
    pickInt(env.SAFETY_CACHE_MAX, 500, 1, 5000));
  const clock = typeof opts.now === 'function' ? opts.now : () => Date.now();

  let resolved = false;
  let provider = null;
  function getProvider() {
    if (resolved) return provider;
    resolved = true;
    provider = opts.provider !== undefined ? opts.provider : defaultProvider();
    return provider;
  }

  const providerName = () => {
    const p = getProvider();
    return p && p.name ? p.name : 'unavailable';
  };

  /** 把一次云检测的错误翻译成"降级"或"拒绝" */
  function onCloudFailure(reason) {
    if (failMode === 'closed') {
      return {
        ok: false, code: 'CONTENT_CHECK_UNAVAILABLE',
        message: '内容安全检查暂时不可用，请稍后再试',
        provider: providerName(), degraded: reason, level: null,
      };
    }
    return { ok: true, level: 'pass', provider: providerName(), degraded: reason, review: false };
  }

  /**
   * 文本检测（单段）。`groups` 由策略表给定，不同字段挡的东西不一样。
   * @returns {Promise<{applied:true, ok:boolean, level, labels:string[], provider, cached, degraded, review, message?, code?}>}
   */
  async function checkText({ text, groups, scene, openid, title, nickname }) {
    const source = text == null ? '' : String(text);

    // ① 本地规则：命中即拒绝，不再向下走
    const local = lexicon.scan(source, groups);
    if (local.level === 'risky') {
      return {
        applied: true, ok: false, level: 'risky', labels: lexicon.labelsOf(local.hits),
        provider: 'local', cached: false, degraded: null, review: false,
        code: 'CONTENT_REJECTED',
        message: policy.rejectMessage(lexicon.groupsOf(local.hits)),
      };
    }

    if (mode === 'off' || mode === 'local') {
      return { applied: true, ok: true, level: 'pass', labels: [], provider: 'local', cached: false, degraded: null, review: false };
    }

    const cloud = getProvider();
    if (!cloud || !cloud.textAvailable) {
      return { applied: true, ...onCloudFailure('provider_unavailable') };
    }

    // ② 云接口：缓存按 scene+内容，与 groups 无关（groups 只影响本地判定）
    const key = scene + '\u0000' + crypto.createHash('sha256').update(source).digest('hex');
    const now = clock();
    const hit = cache.get(key, now);
    if (hit) {
      return {
        applied: true, ok: hit.ok, level: hit.level, labels: hit.labels,
        provider: providerName(), cached: true, degraded: hit.degraded || null, review: hit.review === true,
        ...(hit.ok ? {} : { code: 'CONTENT_REJECTED', message: policy.rejectMessage(['wx']) }),
      };
    }

    let result;
    try {
      result = await cloud.checkText({ content: source, openid, scene, title, nickname });
    } catch (_) {
      result = { ok: false, reason: 'threw', level: null };
    }

    if (!result || !result.ok) {
      const verdict = { applied: true, ...onCloudFailure((result && result.reason) || 'unknown') };
      return verdict;
    }

    const verdict = result.level === 'risky'
      ? {
        applied: true, ok: false, level: 'risky', labels: [result.label || 'wx.risky'],
        provider: providerName(), cached: false, degraded: null, review: false,
        code: 'CONTENT_REJECTED',
        message: '内容未通过平台内容安全检测，请修改后再发送',
      }
      : {
        applied: true, ok: true, level: result.level, labels: result.label ? [result.label] : [],
        provider: providerName(), cached: false, degraded: null, review: result.level === 'review',
      };

    cache.set(key, { ok: verdict.ok, level: verdict.level, labels: verdict.labels, review: verdict.review }, now);
    return verdict;
  }

  /**
   * 输入检测：按策略表对该动作的每个字段逐一过检，**任一字段不过即拒绝**。
   * 只对命中的动作做事 —— 其余动作连负载都不看（性能与"少碰用户数据"都要求这样）。
   */
  async function checkInput({ action, payload, openid }) {
    const entries = policy.inputEntries(action);
    if (mode === 'off' || !entries.length) return { applied: false, ok: true };
    const data = payload || {};
    let applied = false;
    let review = false;
    /** 降级要一路带到响应里 —— 中途丢掉，用户与排障者就都看不到"这次没真正送检" */
    let degraded = null;
    for (const entry of entries) {
      const value = data[entry.field];
      // 不是字符串/全空白 = 这个字段没被使用，交给动作层自己的参数校验
      if (typeof value !== 'string' || !value.trim()) continue;
      const verdict = await checkText({
        text: value, groups: entry.groups, scene: entry.scene, openid,
        title: entry.kind === 'chat' ? '队伍消息' : entry.kind === 'nickname' ? '昵称' : '游览助手提问',
        nickname: entry.kind === 'nickname' ? value : undefined,
      });
      applied = true;
      if (!verdict.ok) return { ...verdict, applied: true, field: entry.field };
      review = review || verdict.review === true;
      degraded = degraded || verdict.degraded || null;
    }
    return { applied, ok: true, review, level: 'pass', provider: providerName(), degraded, labels: [] };
  }

  /**
   * 图片检测：本地只做"确实是图"的结构校验（`decodeImage` 已做），
   * 这里只走云。**未配置/失败时按 fail mode 处理**，不假装检查过。
   *
   * 走不走云由 `policy.IMAGE_POLICY` 决定：不在表里的动作连字节都不看。
   */
  async function checkImage({ action, bytes, contentType }) {
    if (mode === 'off') return { applied: false, ok: true, skipped: 'mode' };
    if (!policy.imageEntry(action)) return { applied: false, ok: true, skipped: 'not_in_policy' };
    if (mode === 'local') return { applied: false, ok: true, skipped: 'local_only' };
    const cloud = getProvider();
    if (!cloud || !cloud.imageAvailable) {
      return { applied: true, ...onCloudFailure('provider_unavailable') };
    }
    let result;
    try {
      result = await cloud.checkImage({ buffer: bytes, contentType });
    } catch (_) {
      result = { ok: false, reason: 'threw' };
    }
    if (!result || !result.ok) return { applied: true, ...onCloudFailure((result && result.reason) || 'unknown') };
    if (result.level === 'risky') {
      return {
        applied: true, ok: false, level: 'risky', provider: providerName(), cached: false, degraded: null,
        code: 'CONTENT_REJECTED', message: '照片未通过内容安全检测，请更换一张后重试',
      };
    }
    return { applied: true, ok: true, level: 'pass', provider: providerName(), cached: false, degraded: null };
  }

  /**
   * 输出检测：**先脱敏再判定**。
   *
   * 与输入侧的差别：输入不合适就拒绝（用户自己改）；输出不合适不能整条丢掉
   * 而不给理由，所以先把联系方式/链接换成占位，再把 `severe` 的内容替换掉。
   * 替换后的文本才算"最终文案"，存进会话的也必须是替换后的版本 ——
   * 否则下一轮把未脱敏的旧回答又显示出来。
   */
  async function checkOutput({ action, text, useCloud }) {
    const entry = policy.outputEntry(action);
    if (mode === 'off' || !entry) return { applied: false, ok: true, text, replaced: false, labels: [] };
    const source = text == null ? '' : String(text);
    if (!source.trim()) return { applied: true, ok: true, text: source, replaced: false, labels: [] };
    /** 只有模型生成的主文案值得送云；固定模板与知识库原文只做本地脱敏 */
    const cloudAllowed = useCloud !== false;

    const masked = lexicon.mask(source);
    // `severe`（人身威胁/不可见字符）不做脱敏：一条回答里出现这种内容，说明整条不可信
    if (masked.severe) {
      return {
        applied: true, ok: false, text: source, replaced: true, level: 'risky',
        labels: ['severe'], provider: 'local',
        notice: '这条回答未通过内容安全检查，已省略。可以换个问法再试。',
      };
    }

    if (mode === 'cloud' && cloudAllowed) {
      const cloud = getProvider();
      if (cloud && cloud.textAvailable) {
        let result = null;
        try {
          result = await cloud.checkText({ content: masked.text, scene: policy.SCENE.SOCIAL_LOG });
        } catch (_) { result = { ok: false, reason: 'threw' }; }
        /**
         * 输出侧的失败策略与输入侧**不同**：输出已经生成，云端判不了时
         * 保留脱敏后的文本（fail-open）才是对用户负责的选择 ——
         * 否则一次接口抖动就会让助手的每条回答都变成"暂时不可用"。
         * `closed` 模式下仍然整条替换，遵守部署方的选择。
         */
        if (result && result.ok && result.level === 'risky') {
          return {
            applied: true, ok: false, text: masked.text, replaced: true, level: 'risky',
            labels: [result.label || 'wx.risky'], provider: providerName(), replaced_by: 'cloud',
            notice: '这条回答未通过平台内容安全检测，已省略。可以换个问法再试。',
          };
        }
        if ((!result || !result.ok) && failMode === 'closed') {
          return {
            applied: true, ok: false, text: masked.text, replaced: true, level: null,
            labels: [], provider: providerName(), notice: '内容安全检查暂时不可用，这条回答已省略。',
          };
        }
      }
    }

    return {
      applied: true, ok: true, text: masked.text, replaced: false,
      level: 'pass', provider: masked.masked.length ? 'local' : providerName(),
      masked: masked.masked.length, labels: [...new Set(masked.masked.map((row) => row.label))],
    };
  }

  /**
   * **同步**判断这个动作要不要过检。
   *
   * 为什么单独给一个同步方法：`checkInput` 是 `async`，即使只做本地扫描也会
   * 让入口多让出一次微任务。对 `meet.create`、`trip.plan` 这些**完全没有**
   * 内容策略的动作，"多一次 await"既没有收益，又会改变入口的时序 ——
   * 页面级的时序测试对 microtask 的插入很敏感（本项目已经出现过因为多一次
   * await 而间歇失败的用例）。入口先用它过滤，剩下的动作才真的进异步路径。
   */
  function covers(action) {
    if (mode === 'off') return false;
    return policy.inputEntries(action).length > 0;
  }

  return {
    mode, failMode, timeoutMs,
    providerName,
    covers,
    checkText, checkInput, checkImage, checkOutput,
    /** 仅供测试：观察缓存行为 */
    __cache: cache,
  };
}

/** 进程级闸门：环境变量在云函数实例生命周期内不会变，重复构造只是白造对象 */
let shared;
function defaultGate() {
  if (!shared) shared = createSafetyGate();
  return shared;
}
function resetDefaultGate() { shared = undefined; }

module.exports = { createSafetyGate, defaultGate, resetDefaultGate, MODES, createCache };

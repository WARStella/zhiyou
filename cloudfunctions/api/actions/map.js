'use strict';

const resp = require('../lib/resp');
const { CODES, assert } = require('../lib/errors');
const { createMapProvider } = require('../lib/map');
const { logEvent } = require('../lib/trace');

/**
 * 地图步行路线接口探针 —— 计划书 10/14 任务的执行工具。
 *
 * 任务原文：**验证地图步行路线接口，检查坐标系、返回字段、额度与失败情况**
 * 验收原文：**两个真实地点之间能取得路线与预计时间**
 *
 * ── 三条设计纪律 ────────────────────────────────────────────
 *
 * 1. **把原始返回带出来**，而不是只给解析结果。
 *    字段名、单位、坐标系必须由实测确认 —— `lib/map/tencent.js` 里明确列了
 *    三项"待实测确认"，不靠记忆写死。
 *
 * 2. **逐项跑失败情形**，确认"失败就是失败"。
 *    地图接口挂掉时给出估算值冒充，是本项目最不能犯的错（docs/项目计划书.md#data-model §3）。
 *
 * 3. **Key 只从云函数环境变量读**，结果里的请求 URL 已脱敏。
 *    计划书 11/12 验收项：密钥不在客户端或仓库。
 */

/** 默认起点/终点：哈尔滨中央大街 → 防洪纪念塔（种子数据的近似坐标） */
const DEFAULT_FROM = { latitude: 45.7756, longitude: 126.6175, label: '中央大街' };
const DEFAULT_TO = { latitude: 45.781, longitude: 126.6185, label: '防洪纪念塔' };

function pickPoint(input, fallback) {
  if (!input) return fallback;
  return {
    latitude: input.latitude,
    longitude: input.longitude,
    label: input.label || null,
  };
}

/** 单个情形的执行包装：任何异常都转成结构化条目，不让整份报告失败 */
async function runCase(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    return Object.assign({ name, ok: !!detail.ok, durationMs: Date.now() - started }, detail);
  } catch (e) {
    return {
      name,
      ok: false,
      durationMs: Date.now() - started,
      reason: 'THREW',
      message: (e && (e.errMsg || e.message)) || String(e),
      errCode: e && e.errCode !== undefined ? e.errCode : null,
    };
  }
}

async function probe(ctx) {
  const { repo, env } = ctx;
  const p = ctx.payload || {};

  // 探针会真实调用外部服务（可能产生费用），仅在开发环境开放
  assert(env === 'dev', CODES.FORBIDDEN_ENV, `当前环境为 ${env}，地图探针仅限 dev`);

  const providerName = p.provider || process.env.MAP_PROVIDER || 'tencent';
  // 与 trip / place 一致：工厂从 ctx 注入，生产代码里不留测试钩子
  const makeProvider = (name, opts) =>
    (ctx.createMapProvider || createMapProvider)(name || providerName, opts);

  const provider = makeProvider(providerName, {
    // 只在显式传入时覆盖 Key（用于跑"无效 Key"情形），否则用环境变量
    key: p.overrideKey,
    timeoutMs: p.timeoutMs,
  });

  const from = pickPoint(p.from, DEFAULT_FROM);
  const to = pickPoint(p.to, DEFAULT_TO);

  const results = [];

  // ① 主用例：两个真实地点之间取得路线与预计时间 —— **这就是 10/14 的验收，也是唯一的关键用例**
  results.push(
    await runCase('① 正常两点：取得路线与预计时间', async () => {
      const r = await provider.walkingRoute(from, to);
      return Object.assign({}, r, {
        // 便于人工核对坐标系：把输入原样带回
        inputFrom: from,
        inputTo: to,
        summary: r.ok
          ? `${r.distanceMeters} 米 / ${r.durationMinutes} 分钟` +
            (r.unitCheck && r.unitCheck.plausible === false ? '（⚠️ 单位自检未通过，见 unitCheck）' : '')
          : `失败：${r.message || r.reason}${r.hint ? ' · ' + r.hint : ''}`,
      });
    })
  );

  // ② 极近距离（约 10 米）：**信息项**，不作为判据。
  //    成员就站在集合点旁边是这个尺度的真实场景，值得记录上游怎么处理。
  results.push(
    await runCase('② 极近距离（约 10 米，信息项）', async () => {
      const near = {
        latitude: from.latitude + 0.00009, // ≈10 米
        longitude: from.longitude,
        label: '起点旁约 10 米',
      };
      const r = await provider.walkingRoute(from, near);
      return Object.assign({}, r, {
        informational: true,
        summary: r.ok
          ? `${r.distanceMeters} 米 / ${r.durationMinutes} 分钟`
          : `被拒绝：${r.message || r.reason}`,
      });
    })
  );

  if (p.runFailureCases !== false) {
    // ③ 起终点相同：**实测确认（2026-10-14）上游会直接拒绝**，返回
    //    `status: 374 起终点坐标错误`。这属于**期望失败**，不是缺陷 ——
    //    调用方应先判断两点是否重合，重合时不必请求上游、也就不会消耗配额。
    results.push(
      await runCase('③ 起终点相同（期望被拒绝）', async () => {
        const r = await provider.walkingRoute(from, from);
        return Object.assign({}, r, {
          expectedFailure: true,
          summary: r.ok
            ? '⚠️ 起终点相同竟然返回了路径 —— 说明调用方必须自行判重'
            : `已正确拒绝：${r.message || r.reason}`,
        });
      })
    );

    // ④ 无效 Key：确认鉴权失败被识别为失败，而不是当成"距离 0"
    results.push(
      await runCase('④ 无效 Key（鉴权失败情形）', async () => {
        const bad = makeProvider(providerName, {
          key: 'INVALID_KEY_PROBE_0000',
          timeoutMs: p.timeoutMs,
        });
        const r = await bad.walkingRoute(from, to);
        return Object.assign({}, r, {
          expectedFailure: true,
          summary: r.ok
            ? '⚠️ 无效 Key 竟然成功 —— 需检查鉴权配置'
            : `已正确拒绝：${r.message || r.reason}`,
        });
      })
    );

    // ⑤ Key 未配置：确认缺 Key 时给出可执行的修复指引，而不是含糊失败
    results.push(
      await runCase('⑤ 未配置 Key（缺失依赖情形）', async () => {
        const none = makeProvider(providerName, { key: '' });
        const r = await none.walkingRoute(from, to);
        return Object.assign({}, r, {
          expectedFailure: true,
          summary: r.message || r.reason,
        });
      })
    );

    /**
     * ⑥ **各出行方式的方向接口探针**（信息项，2026-10-13 新增）
     *
     * 用户希望"调取路况，动态调整出行方式"。但**步行不受路况影响** ——
     * 要看路况就必须支持骑行／驾车／公交，而这三个端点本项目从未实测过。
     *
     * 所以这里**不解析字段，只带出结构**（键路径 + 样本值 + 像路况的字段名）。
     * 拿到真实结构再决定怎么解析 —— 猜错字段名会得到一个
     * "看起来有值、其实是 undefined"的路况，而且**不报错**。
     *
     * 信息项：它失败**不影响**探针判据（真实的"没有权限/没勾服务"也是有效结论）。
     */
    results.push(
      await runCase('⑥ 各出行方式（驾车／骑行／公交，信息项）', async () => {
        const p2 = makeProvider(providerName, { key: p.overrideKey });
        if (typeof p2.probeDirections !== 'function') {
          return {
            ok: false,
            informational: true,
            reason: 'NOT_SUPPORTED',
            summary: `provider「${providerName}」不支持各出行方式探针`,
          };
        }
        const r = await p2.probeDirections({ from: from, to: to });
        if (!r.ok) {
          return {
            ok: false,
            informational: true,
            reason: r.reason,
            message: r.message,
            hint: r.hint || null,
            summary: r.message || r.reason,
          };
        }
        const modes = (r.results || []).map((x) => x.mode);
        const okModes = (r.results || []).filter((x) => x.ok).map((x) => x.mode);
        return {
          ok: true,
          informational: true,
          modesTried: modes,
          modesOk: okModes,
          /** 每个方式的结构清单 —— 这是探针真正的产出 */
          results: r.results,
          trafficLikeKeys: (r.results || [])
            .filter((x) => x.trafficLikeKeys && x.trafficLikeKeys.length)
            .map((x) => ({ mode: x.mode, keys: x.trafficLikeKeys })),
          summary:
            `试了 ${modes.length} 种出行方式，可用 ${okModes.length} 种：` +
            (okModes.length ? okModes.join('、') : '(全部不可用，见各条 reason)') +
            '。**结构清单在下方 results 里** —— 有没有路况字段，看 routeKeys / trafficLikeKeys。',
        };
      })
    );
  }

  // 判据只看**关键用例**（①）；② 是信息项，③④⑤ 期望失败
  const critical = results.filter((r) => !r.expectedFailure && !r.informational);
  const informational = results.filter((r) => r.informational);
  const criticalFailed = critical.filter((r) => !r.ok);
  const unexpectedSuccess = results.filter((r) => r.expectedFailure && r.ok);

  await logEvent(repo, {
    ts: new Date(ctx.now ? ctx.now : Date.now()),
    type: 'upstream_call',
    action: 'map.probe',
    userId: ctx.openid,
    result: criticalFailed.length === 0 ? 'ok' : 'error',
    errCode: criticalFailed.length ? criticalFailed[0].reason || 'UPSTREAM_MAP_FAILED' : null,
    durationMs: results.reduce((s, r) => s + (r.durationMs || 0), 0),
    mapApiCalls: results.length, // 计入调用成本（11/8、11/12 要统计）
    detail: {
      provider: providerName,
      keyConfigured: provider.keyConfigured,
      caseCount: results.length,
    },
  });

  return resp.ok({
    kind: 'mapProbe',
    provider: providerName,
    keyConfigured: provider.keyConfigured,
    keyMasked: provider.keyMasked,
    /** Key 粘贴时带了前后空白，已自动去除 —— 应提示使用者去修环境变量 */
    keyWasTrimmed: Boolean(provider.keyWasTrimmed),
    keyWarning: provider.keyWasTrimmed
      ? '检测到 MAP_KEY 前后有多余空白（常见于从控制台表格复制），已自动去除。' +
        '建议到云函数环境变量里把值重新填干净，避免其他调用方踩到同样的问题。'
      : null,
    from,
    to,
    results,
    passed: critical.filter((r) => r.ok).length,
    total: critical.length,
    informationalCount: informational.length,
    mapApiCalls: results.length,
    verdict:
      criticalFailed.length === 0 && unexpectedSuccess.length === 0
        ? '关键用例通过；失败情形已被正确拒绝'
        : criticalFailed.length > 0
          ? '关键用例失败 —— 见 ok:false 条目；此时**不得**降级为估算值冒充结果'
          : '失败情形竟然成功 —— 鉴权或参数校验可能有问题',
    checklist: [
      '坐标系：把返回 polylineHead 里的数与输入坐标比对，确认同一坐标系（本项目要求 GCJ-02）',
      '单位：`duration` 的单位由 `unitCheck` **自动判定**（用隐含步速是否合理来判断）。' +
        '2026-10-14 实测结论：**单位是分钟**（815 米返回 12），不是秒',
      '字段：核对 parsedVia 里记录的字段路径是否与实际返回结构一致',
      '额度：控制台「配额管理 → 账户额度」看总额度；⚠️ **额度必须分配给 Key**，否则报 121',
      '失败情形：③④⑤ 必须被拒绝；若成功，说明鉴权或参数校验有问题',
    ],
    note:
      '探针会真实调用外部接口，仅在 dev 环境开放。Key 未在结果中出现（URL 已脱敏）。' +
      '每项都带 timingMs，可作为 11/8 性能基线的原始数据。',
  });
}

module.exports = { probe, DEFAULT_FROM, DEFAULT_TO };

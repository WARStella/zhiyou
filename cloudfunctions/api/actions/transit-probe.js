'use strict';

/**
 * 公交（含地铁）路线的探针 —— `transit.probe`。
 *
 * ── 为什么必须探一次再往下做 ──────────────────────────────
 *
 * `lib/transit/amap.js` 的字段路径**依官方文档、未持 Key 实测**。
 * 而本项目已经吃过"文档与实际不一致"的亏（腾讯 POI 主键 `id` / `_id` 两种写法），
 * 所以这里有一条纪律：**不靠记忆定死，由原始返回核对**。
 *
 * 三个待确认的未知量：
 *
 *   ① **端点对不对** —— `v5/direction/transit/integrated` 是否真的存在、
 *      以及这条接口在该 Key 下**是否已开通权限**（高德的接口是逐个开通的，
 *      控制台「可使用服务」列表里要有「公交路径规划」）。
 *   ② **字段路径对不对** —— `route.transits[].duration` 等是否与实际一致。
 *      不一致时 `parsedVia` 与 `rawHead` 是唯一能定位的东西。
 *   ③ **地铁能不能识别** —— 解析靠 `bus.type` 里是否含「地铁」字样。
 *      这条**纯属推测**，必须用真实返回验证。
 *
 * 另外顺带问一件事：**公交路径规划的免费额度是多少**。
 * 腾讯那边是明牌（各 6,000/天），高德这边我只确证了"照片字段未标注付费"，
 * 路径规划的额度没查到 —— 而"额度够不够"直接决定这个功能能不能长期用。
 * 探针本身回答不了配额，但它会暴露权限问题（10002/10012/10003）。
 *
 * ⚠️ 会真实调用上游，**消耗一次配额** —— 由调用者决定何时点。
 */

const resp = require('../lib/resp');
const { CODES, assert } = require('../lib/errors');
const { createAmapTransitProvider, STRATEGY, STRATEGY_LABEL } = require('../lib/transit/amap');

/**
 * 默认探针起终点：中央大街 → 哈尔滨冰雪大世界方向。
 *
 * 选它是因为这条线**必须要坐地铁/公交**（跨松花江，步行 12 公里以上），
 * 所以一个正常的返回里应当能看到轨道段 —— 用它验地铁识别最有意义。
 */
const DEFAULT_FROM = { latitude: 45.7756, longitude: 126.6175 };
const DEFAULT_TO = { latitude: 45.8029, longitude: 126.5353 };
const DEFAULT_CITY = '0451';

async function probe(ctx) {
  const p = ctx.payload || {};
  const from = p.from || DEFAULT_FROM;
  const to = p.to || DEFAULT_TO;
  const city = p.city || DEFAULT_CITY;

  const provider = ctx.createTransitProvider
    ? ctx.createTransitProvider()
    : createAmapTransitProvider({ providerName: p.provider });

  const steps = [];

  // ── 第 1 层：Key（不发请求）──
  const keyStatus = typeof provider.keyStatus === 'function' ? provider.keyStatus() : { configured: null };
  steps.push({
    step: 'api-key',
    ok: keyStatus.configured === true,
    detail:
      keyStatus.configured === true
        ? `AMAP_KEY 已配置（${keyStatus.masked}${keyStatus.trimmed ? '，已去除前后空白' : ''}）`
        : 'AMAP_KEY 未配置 —— 云开发控制台 → 云函数 → api → 配置 → 环境变量 → 新增 AMAP_KEY（需「Web服务」类型 Key）',
  });

  if (keyStatus.configured !== true) {
    steps.push({ step: 'upstream', ok: null, detail: '未测：Key 没配，不发请求（省配额）' });
    steps.push({ step: 'fields', ok: null, detail: '未测' });
    steps.push({ step: 'subway', ok: null, detail: '未测' });
    return resp.ok({
      ok: false,
      verdict: 'KEY_MISSING',
      steps,
      hint: '配好 AMAP_KEY 之后再点一次。注意控制台 Key 的「可使用服务」里要有**公交路径规划**',
    });
  }

  // ── 第 2 层：端点与权限（真实请求，消耗一次配额）──
  const r = await provider.route({ from, to, city, strategy: STRATEGY.RECOMMENDED });

  steps.push({
    step: 'upstream',
    ok: r.ok,
    detail: r.ok
      ? `接口可用，上游返回 ${r.routeCount === null ? '?' : r.routeCount} 个方案`
      : `调用失败：status ${r.status} ${r.message || ''}`,
    raw: {
      endpoint: 'restapi.amap.com/v5/direction/transit/integrated',
      status: r.status,
      hint: r.hint,
      timingMs: r.timingMs,
    },
  });

  if (!r.ok) {
    steps.push({ step: 'fields', ok: null, detail: '未测：上游没通，字段无从核对' });
    steps.push({ step: 'subway', ok: null, detail: '未测' });

    /**
     * 把"这次是哪一类失败"直接说清（2026-10-14 实测两次之后补的）。
     *
     * 两次实测把范围收窄到：
     *   · 假 Key → `INVALID_USER_KEY` / 10001  → 高德**先校验 Key**
     *   · 真 Key → `MISSING_REQUIRED_PARAMS` / 20001 → Key 有效，卡在参数校验
     *   而照片走 `/v5/place/text` 用**同一个 Key** 是通的。
     *
     * ⚠️ 一个被证伪的思路也记在这里：曾想"用假 Key 探参数对不对"
     * （因为假 Key 只报 Key 错、不报参数错），但实测**去掉必填参数也照样报
     * INVALID_USER_KEY** —— 说明高德先校 Key、再校参数，这条路走不通。
     * 留着这条是为了别有人（包括我）再试一遍。
     */
    const byInfo = r.infocode ? `${r.infocode} ${r.info || ''}`.trim() : String(r.info || r.status || '');
    return resp.ok({
      ok: false,
      verdict: 'UPSTREAM_FAILED',
      steps,
      failure: { status: r.status, infocode: r.infocode || null, info: r.info || null, byInfo },
      hint: r.hint || '上游未通。请看 failure 里的 infocode 与 info 定位',
      rawHead: r.rawHead || null,
      /** 这次请求实际发了什么 —— 参数类问题的第一手证据 */
      requestUrl: r.requestUrl || null,
      /** 下面两句是两次实测的结论，直接给出来省一轮往返 */
      knownFacts: [
        'Key 已被高德识别（否则会回 10001 INVALID_USER_KEY），所以问题不在"Key 有没有配"。',
        '同一个 Key 走 /v5/place/text（照片）是通的 —— 两条接口需要分别开通。',
        '若 info 是 MISSING_REQUIRED_PARAMS：v5 公交的必填是 origin / destination / **city1**（citycode），跨城加 city2。',
      ],
    });
  }

  // ── 第 3 层：字段路径 ──
  const hasRoute = Boolean(r.best);
  steps.push({
    step: 'fields',
    ok: hasRoute ? true : null,
    detail: hasRoute
      ? `解析成功：耗时 ${r.best.durationMinutes} 分钟、步行 ${r.best.walkingMeters} 米、票价 ${r.best.costYuan} 元`
      : r.emptyReason === 'NO_TRANSIT_ROUTE'
        ? '接口通了，但这组起终点之间**没有公交方案**（换个起终点再试）'
        : '解析未得到方案',
    /**
     * ⚠️ 这一项是给"文档与实测不一致"准备的。
     * 若下面的路径与实际返回不同，说明要改解析代码 —— 而不是改测试去迁就。
     */
    raw: { parsedVia: r.parsedVia, segmentCount: hasRoute ? r.best.steps.length : 0 },
  });

  // ── 第 4 层：地铁识别（纯推测，必须实测）──
  steps.push({
    step: 'subway',
    ok: hasRoute ? Boolean(r.best.hasSubway) : null,
    detail: !hasRoute
      ? '未测'
      : r.best.hasSubway
        ? `识别到轨道段：${r.best.steps.filter((s) => s.isSubway).map((s) => s.lineName).filter(Boolean).join('、') || '（线路名缺失）'}`
        : '**没有识别到地铁段** —— 若实际方案里应当有地铁，说明 `bus.type` 里没有「地铁」字样，识别规则要改',
    raw: hasRoute
      ? {
          transitStepCount: r.best.transitStepCount,
          lines: r.best.steps.filter((s) => s.kind === 'transit').map((s) => ({ lineName: s.lineName, isSubway: s.isSubway })),
        }
      : null,
  });

  const fieldsOk = hasRoute;
  const subwayOk = hasRoute ? Boolean(r.best.hasSubway) : null;

  return resp.ok({
    ok: fieldsOk,
    verdict: !fieldsOk ? 'NO_ROUTE' : subwayOk ? 'OK' : 'SUBWAY_NOT_DETECTED',
    probeFrom: from,
    probeTo: to,
    city,
    strategy: STRATEGY.RECOMMENDED,
    strategyLabel: STRATEGY_LABEL[STRATEGY.RECOMMENDED],
    steps,
    routes: r.routes || [],
    best: r.best
      ? {
          durationMinutes: r.best.durationMinutes,
          walkingMeters: r.best.walkingMeters,
          costYuan: r.best.costYuan,
          hasSubway: r.best.hasSubway,
          steps: r.best.steps,
        }
      : null,
    mapApiCalls: 1,
    /** 原始返回头部 —— 字段对不上时，这是唯一能定位的东西 */
    rawHead: r.rawHead || null,
    hint: fieldsOk
      ? subwayOk
        ? null
        : '字段解析通了，但没识别到地铁。请把 rawHead 贴回来，我按真实字段改识别规则'
      : '接口通了但没解析出方案，把 rawHead 贴回来核对字段路径',
  });
}

module.exports = probe;

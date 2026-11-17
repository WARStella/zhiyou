'use strict';

/**
 * 照片服务探针 —— `photo.probe`。
 *
 * ── 为什么单独做一条探针 ──────────────────────────────────
 *
 * "取照片没通"至少有五种互不相干的原因，而它们在小程序上的表现几乎一样
 * （都是"没有照片"）：
 *
 *   ① `place.fetchPhotos` 这个 action **根本没部署上去**（云函数是旧的）；
 *   ② `AMAP_KEY` 没配；
 *   ③ Key 配了但类型不对（不是「Web服务」）；
 *   ④ Key 类型对但没开通「关键字搜索API」；
 *   ⑤ 接口全通，只是这个 POI 恰好没有照片，或名字匹配不上。
 *
 * 前四条是配置问题，第五条不是问题。**混在一起看就无法行动**，
 * 所以这条探针**分层报告**，每一层单独说通没通、以及不通时该改什么。
 *
 * 与 `map.probe` / `ai.probe` 同一套路（项目里已有一条这样的纪律）。
 * 它真实调用上游，所以**会消耗一次配额** —— 这由调用者决定何时点。
 */

const resp = require('../lib/resp');
const { createPhotoService } = require('../lib/photo');

/** 默认用哈尔滨一个几乎肯定有照片的地标做探针 */
const DEFAULT_PROBE_NAME = '哈尔滨站';
const DEFAULT_PROBE_LOCATION = { latitude: 45.7596, longitude: 126.6297 };

async function probe(ctx) {
  const p = ctx.payload || {};
  const name = p.name || DEFAULT_PROBE_NAME;
  const location = p.location || DEFAULT_PROBE_LOCATION;

  const svc = ctx.createPhotoService
    ? ctx.createPhotoService()
    : createPhotoService({ providerName: p.provider });

  const steps = [];

  // ── 第 1 层：Key 配没配（不需要网络，不会消耗配额）──
  const keyStatus = typeof svc.keyStatus === 'function' ? svc.keyStatus() : { configured: null };
  steps.push({
    step: 'provider',
    ok: true,
    detail: `照片服务：${svc.providerName}`,
  });
  steps.push({
    step: 'api-key',
    ok: keyStatus.configured === true,
    detail:
      keyStatus.configured === true
        ? `AMAP_KEY 已配置（${keyStatus.masked}${keyStatus.trimmed ? '，已去除前后空白' : ''}）`
        : 'AMAP_KEY 未配置 —— 云开发控制台 → 云函数 → api → 配置 → 环境变量 → 新增 AMAP_KEY',
  });

  /**
   * Key 没配就不必往下走：再调一次只会拿到同一个结论，还白费一次配额。
   * 但**要明确说"后面两层没测"** —— 否则会被读成"后面两层也失败了"。
   */
  if (keyStatus.configured !== true) {
    steps.push({ step: 'upstream', ok: null, detail: '未测：Key 没配，不发请求（省配额）' });
    steps.push({ step: 'fields', ok: null, detail: '未测' });
    return resp.ok({
      ok: false,
      verdict: 'KEY_MISSING',
      steps,
      hint: '按第 2 步的提示配好 AMAP_KEY，再点一次这条探针',
    });
  }

  // ── 第 2 层：真实调用（消耗一次配额）──
  const result = await svc.fetchForPlace(
    { _id: '__probe__', name, location },
    { persist: false } // 探针不落云存储：它验的是接口，不是要存东西
  );

  steps.push({
    step: 'upstream',
    ok: result.upstreamOk === true,
    detail: result.upstreamOk
      ? `上游调用成功，返回 ${result.matchedPoi ? '1' : '0'} 个匹配 POI` +
        (result.matchedPoi ? `（${result.matchedPoi.name}）` : '')
      : `上游调用失败：${result.upstreamReason || result.emptyReason || '未知'}`,
    raw: {
      upstreamReason: result.upstreamReason,
      emptyReason: result.emptyReason,
      matchedPoi: result.matchedPoi,
      matchBasis: result.matchBasis,
    },
  });

  // ── 第 3 层：字段形状 —— **这一层是给"文档与实测不一致"准备的** ──
  const photos = (result.photos || []).filter((ph) => !ph.persistError);
  steps.push({
    step: 'fields',
    ok: photos.length > 0 ? true : null,
    detail:
      photos.length > 0
        ? `拿到 ${photos.length} 张照片，字段解析正常（photos[].url / .title）`
        : result.emptyReason === 'POI_HAS_NO_PHOTO'
          ? '接口通了，但这个地点在上游确实没有照片 —— 换个更知名的地标再试'
          : result.emptyReason === 'NO_POI_MATCHED'
            ? '接口通了，但这个名字在上游匹配不到 POI'
            : `未取到照片（${result.emptyReason || '未知原因'}）`,
    raw: {
      emptyReason: result.emptyReason,
      /** 实际命中的字段名 —— 若与文档不符，这里会显示出来 */
      parsedVia: result.rawParsedVia || 'pois[].photos',
      trust: result.trust,
      verificationPassed: result.verification && result.verification.passed,
      verificationReason: result.verification && result.verification.reason,
    },
  });

  const upstreamOk = result.upstreamOk === true;
  return resp.ok({
    ok: upstreamOk,
    verdict: !upstreamOk
      ? 'UPSTREAM_FAILED'
      : photos.length
        ? 'OK'
        : result.emptyReason === 'POI_HAS_NO_PHOTO'
          ? 'NO_PHOTO_FOR_THIS_POI'
          : 'NO_MATCH',
    probeName: name,
    steps,
    photos: photos.map((ph) => ({ url: ph.url, title: ph.title, trusted: ph.trusted })),
    mapApiCalls: 1,
    hint: upstreamOk
      ? null
      : '上游不通：优先核对 Key 类型是否为「Web服务」、以及是否开通了「关键字搜索API」（控制台 Key 详情页的「可使用服务」列表）',
  });
}

module.exports = probe;

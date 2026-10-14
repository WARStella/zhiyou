'use strict';

/**
 * 地点照片 —— `place.fetchPhotos`。
 *
 * ── 这个 action 存在的理由 ────────────────────────────────
 *
 * 高德是**月配额**（个人认证 5,000/月），不是日配额。所以照片绝不能
 * 在 `place.list` 那种列表接口里顺手抓 —— 一个页面刷十次就是十次调用，
 * 而用户只对一两个集合点感兴趣。
 *
 * 做成**显式、单点、可缓存**的入口：
 *   一次调用只处理一个地点；取回的结果写回该地点的 `photos` 字段，
 *   下次直接读缓存，不重复消耗配额。
 *
 * ── 为什么只写可信的照片 ──────────────────────────────────
 *
 * 默认**丢弃未通过核验的照片**（距离守卫或名字比对不通过）。
 * 理由不是洁癖：一张错误的照片会让人按图去找，而集合点找错的代价
 * 是整队人等在原地 —— 比"没有照片"糟得多。
 * 需要留档排查时传 `keepUntrusted: true`，但标注仍然保留在照片上。
 *
 * ── 环境守卫 ──────────────────────────────────────────────
 *
 * 与 `place.survey` 同惯例：仅 dev。
 * 它写 `places`，而 `places` 是可信度层的输入。
 */

const resp = require('../lib/resp');
const { CODES, assert, require_fields } = require('../lib/errors');
const { placeEligibility } = require('../lib/authz');
const { createPhotoService } = require('../lib/photo');
const { logEvent } = require('../lib/trace');
const C = require('../lib/repo/collections');
const time = require('../lib/time');

async function fetchPhotos(ctx) {
  const { repo } = ctx;
  const p = ctx.payload || {};

  assert(ctx.env === 'dev', CODES.FORBIDDEN_ENV, `当前环境为 ${ctx.env}，照片抓取仅限 dev`);
  require_fields(p, ['placeId']);

  const place = await repo.get(C.PLACES, p.placeId);
  assert(place, CODES.NOT_FOUND, '地点不存在', { placeId: p.placeId });
  assert(place.name, CODES.INVALID_PARAM, '该地点没有名称，无法按名字检索照片');

  /**
   * 已经有照片时直接返回缓存。
   *
   * `refresh: true` 才重新抓 —— 配额有限，默认不做无谓的重复调用。
   */
  if (Array.isArray(place.photos) && place.photos.length && p.refresh !== true) {
    return resp.ok({
      cached: true,
      placeId: place._id,
      photos: place.photos,
      persistedCount: place.photos.filter((ph) => ph.fileID).length,
      message: '已有照片，未重复调用上游（配额有限）。需要重抓请传 refresh: true',
    });
  }

  const svc = ctx.createPhotoService
    ? ctx.createPhotoService()
    : createPhotoService({
        providerName: p.provider,
        providerOpts: { key: p.amapKey || undefined },
      });

  const result = await svc.fetchForPlace(place, {
    persist: p.persist !== false,
    keepUntrusted: p.keepUntrusted === true,
    region: p.region,
  });

  /**
   * 照片**落库**（写回 places），这样下次直接读缓存。
   *
   * 只写回照片与抓取时间，不碰 `verifiedAt`/`confidence` ——
   * 照片的存在**不构成**对地点物理属性的核验（那需要实地踏勘）。
   * 这条边界必须守住，否则"抓到一张图"会被读成"这个点验过了"。
   */
  const patch = {
    photos: result.photos,
    photosFetchedAt: new Date(ctx.now ? ctx.now : Date.now()),
    photosSource: result.provider,
  };
  const { doc } = await repo.update(C.PLACES, place._id, patch);

  await logEvent(repo, {
    ts: new Date(ctx.now ? ctx.now : Date.now()),
    type: 'data_change',
    action: 'place.fetchPhotos',
    userId: ctx.openid,
    placeId: place._id,
    provider: result.provider,
    photoCount: result.photos.length,
    persistedCount: result.persistedCount,
    emptyReason: result.emptyReason,
    verificationPassed: result.verification.passed,
    mapApiCalls: result.mapApiCalls,
  });

  const elig = placeEligibility(doc);

  return resp.ok({
    cached: false,
    placeId: doc._id,
    placeName: doc.name,
    provider: result.provider,
    photos: result.photos,
    persistedCount: result.persistedCount,
    emptyReason: result.emptyReason,
    matchedPoi: result.matchedPoi,
    matchBasis: result.matchBasis,
    /** 四项检查逐条给出 —— 界面与答辩直接引用，不再自己解释 */
    verification: result.verification,
    mapApiCalls: result.mapApiCalls,
    fetchedAt: time.toISO(patch.photosFetchedAt),
    /**
     * ⚠️ 照片**不改变**地点的核验等级。
     * 这句话必须出现在响应里：否则调用方会以为"抓到图 = 这个点确认过了"。
     */
    eligibility: elig,
    notice:
      '照片只提供辨识度辅助。它不构成对可达性、入口位置等物理属性的核验 —— ' +
      `该地点的核验等级仍为「${elig.verificationLabel}」，需实地踏勘才能升级。`,
  });
}

module.exports = fetchPhotos;

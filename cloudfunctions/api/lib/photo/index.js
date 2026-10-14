'use strict';

/**
 * 照片层门面。
 *
 * 一条链：**按名字取上游照片 → 核验照片是不是这个地点 → 落云存储 → 返回 fileID**。
 *
 * 为什么把三步收在一个门面里而不是留给 action：
 * action 层只该做"校验参数、调服务、包响应"（README 的开发纪律）。
 * 而这三步的顺序本身是设计的一部分 —— 先核验再落存储，
 * 避免把已经判定为"不可信"的图片白白下载上传一遍（月配额是有限的）。
 *
 * ── 依赖注入 ──────────────────────────────────────────────
 *
 * `opts.photoProvider` 与 `opts.store` 都可注入，测试因此不需要网络、
 * 不需要云环境。与 `lib/map` 的 `createMapProvider` 同一套约定。
 */

const { createAmapPhotoProvider } = require('./amap');
const { createFakePhotoProvider } = require('./fake');
const { createPhotoStore } = require('./storage');
const { verifyPhotos, CHECKS, CHECK_LABEL } = require('./verify');
const { MAX_TRUSTED_DISTANCE_M } = require('./shared');

const PROVIDERS = {
  amap: createAmapPhotoProvider,
  fake: createFakePhotoProvider,
};

/** 默认走 amap；测试可用 `PHOTO_PROVIDER=fake` 或显式传入 */
function createPhotoProvider(kind, opts) {
  const name = kind || process.env.PHOTO_PROVIDER || 'amap';
  const factory = PROVIDERS[name];
  if (!factory) throw new Error(`未知的照片服务：${name}（支持：${Object.keys(PROVIDERS).join(', ')}）`);
  return factory(opts || {});
}

function createPhotoService(opts) {
  opts = opts || {};
  const provider = opts.photoProvider || createPhotoProvider(opts.providerName, opts.providerOpts);
  const store = opts.store || createPhotoStore(opts.storageOpts);
  const maxDistanceMeters = opts.maxDistanceMeters || MAX_TRUSTED_DISTANCE_M;

  return {
    providerName: provider.name,
    keyStatus: () => provider.keyStatus(),

    /**
     * 取某个地点的照片。
     *
     * @param {object} place  `places` 里的一条记录（含 name / location）
     * @param {object} [o]
     * @param {boolean} [o.persist=true]     是否下载并落云存储
     * @param {boolean} [o.keepUntrusted=false] 是否保留未通过核验的照片
     *        （默认丢弃：不可信的照片展示出去比没有照片更糟）
     */
    async fetchForPlace(place, o) {
      o = o || {};
      const persist = o.persist !== false;
      const keepUntrusted = o.keepUntrusted === true;

      if (!place || !place.name) {
        return {
          ok: false,
          reason: 'PLACE_NAME_REQUIRED',
          message: '按名字取照片需要 place.name',
          photos: [],
        };
      }

      const upstream = await provider.photosByName({
        name: place.name,
        targetLocation: place.location || null,
        region: o.region,
      });

      const verification = verifyPhotos({
        placeName: place.name,
        placeLocation: place.location || null,
        photos: upstream.photos || [],
        matchedPoi: upstream.matchedPoi || null,
        maxDistanceMeters,
      });

      const base = {
        provider: provider.name,
        placeId: place._id || null,
        placeName: place.name,
        upstreamOk: upstream.ok,
        upstreamReason: upstream.reason || null,
        /** 四种"为什么没有照片"必须能分辨（§11.3 失败原因可定位） */
        emptyReason: upstream.emptyReason || verification.reason,
        matchedPoi: upstream.matchedPoi || null,
        matchBasis: upstream.matchBasis || null,
        trust: upstream.trust || null,
        verification,
        mapApiCalls: 1,
      };

      if (!upstream.ok || !upstream.photos || !upstream.photos.length) {
        return Object.assign(base, { ok: false, photos: [] });
      }

      /**
       * 先核验、后落存储。
       *
       * 不通过的照片默认**不下载** —— 月配额有限，而"下载了再丢掉"
       * 既浪费配额也浪费时间。要留档排查时用 `keepUntrusted: true`。
       */
      const candidates = verification.passed
        ? upstream.photos
        : keepUntrusted
          ? upstream.photos
          : [];

      const photos = [];
      for (let i = 0; i < candidates.length; i++) {
        const ph = candidates[i];
        const entry = {
          url: ph.url,
          title: ph.title || null,
          source: 'upstream',
          /** ⚠️ 由来源推导：联网抓来的图**永远不是**踏勘实拍（docs/01 §2.2.2） */
          verified: false,
          provider: ph.provider || provider.name,
          poisId: ph.poisId || null,
          poiName: ph.poiName || null,
          trustBasis: ph.trustBasis || null,
          distanceMeters: ph.distanceMeters === undefined ? null : ph.distanceMeters,
          photoVerification: {
            passed: verification.passed,
            reason: verification.reason,
            checks: verification.checks,
          },
          fileID: null,
          capturedAt: null,
          capturedBy: null,
        };

        if (persist) {
          const stored = await store.persist(place._id, i, ph);
          if (!stored.ok) {
            /**
             * 单张失败不放弃整组，但**必须留下原因** ——
             * 否则界面只知道"没图"，而不知道是下载失败、不是图片、还是上传失败。
             */
            entry.persistError = { reason: stored.reason, message: stored.message };
          } else {
            entry.fileID = stored.fileID;
            entry.byteLength = stored.byteLength;
            entry.contentType = stored.contentType;
          }
        }

        photos.push(entry);
      }

      return Object.assign(base, {
        ok: photos.length > 0,
        photos,
        /** 有多少张成功落存储 —— 没落成存储的图客户端拿不到，等于没有 */
        persistedCount: photos.filter((p) => p.fileID).length,
      });
    },
  };
}

module.exports = {
  createPhotoService,
  createPhotoProvider,
  PROVIDERS,
  CHECKS,
  CHECK_LABEL,
  MAX_TRUSTED_DISTANCE_M,
};

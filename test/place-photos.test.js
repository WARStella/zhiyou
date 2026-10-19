'use strict';

/**
 * `place.fetchPhotos` 的测试。
 *
 * 这个 action 的职责边界很明确，测试也就围绕那条边界写：
 *   · 照片被抓回来要落库（缓存），避免重复烧月配额；
 *   · **照片不改变地点的核验等级** —— 抓到图不等于这个点验过了；
 *   · 上游失败不阻断（照片是增强项）；
 *   · 仅 dev。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, expectOk, expectFail, C } = require('./helpers');
const { createPhotoService } = require('../cloudfunctions/api/lib/photo');
const { createFakePhotoProvider } = require('../cloudfunctions/api/lib/photo/fake');

/** 把照片服务注入 world —— 与 createMapProvider 同一套约定，测试不需要网络 */
async function worldWithPhotos(mode, opts) {
  opts = opts || {};
  const calls = [];
  const w = await makeWorld({
    createPhotoService: () =>
      createPhotoService({
        photoProvider: createFakePhotoProvider(Object.assign({ mode }, opts.providerOpts)),
        store: {
          async persist(placeId, index, photo) {
            calls.push({ placeId, index, url: photo.url });
            if (opts.uploadFails) return { ok: false, reason: 'UPLOAD_FAILED', message: '云存储上传失败' };
            return {
              ok: true,
              fileID: `cloud://test.env/poi-photos/${placeId}/${index}.img`,
              cloudPath: `poi-photos/${placeId}/${index}.img`,
              byteLength: 2048,
              contentType: 'image/jpeg',
            };
          },
        },
      }),
  });
  return Object.assign(w, { photoStoreCalls: calls });
}

test('place.fetchPhotos 仅限 dev', async () => {
  const w = await makeWorld({ env: 'prod' });
  expectFail(await w.A('place.fetchPhotos', { placeId: 'p_zhongyang' }), 'FORBIDDEN_ENV');
});

test('取到照片后落库，第二次调用走缓存不再消耗配额', async () => {
  const w = await worldWithPhotos('ok');
  const first = expectOk(await w.A('place.fetchPhotos', { placeId: 'p_zhongyang' }));

  assert.equal(first.cached, false);
  assert.equal(first.photos.length, 1);
  assert.match(first.photos[0].fileID, /^cloud:\/\//);
  assert.equal(first.mapApiCalls, 1, '一次调用只处理一个地点');

  const stored = await w.repo.get(C.PLACES, 'p_zhongyang');
  assert.equal(stored.photos.length, 1, '照片要落库，供下次直接读');
  assert.ok(stored.photosFetchedAt, '要记下抓取时间，缓存才有依据');

  // 第二次：不该再调上游
  const second = expectOk(await w.A('place.fetchPhotos', { placeId: 'p_zhongyang' }));
  assert.equal(second.cached, true);
  assert.equal(second.mapApiCalls, undefined, '缓存命中时不该报告上游调用');

  // refresh 才重抓
  const third = expectOk(await w.A('place.fetchPhotos', { placeId: 'p_zhongyang', refresh: true }));
  assert.equal(third.cached, false);
});

test('照片**不改变**地点的核验等级 —— 抓到图不等于这个点验过了', async () => {
  const w = await worldWithPhotos('ok');
  const before = await w.repo.get(C.PLACES, 'p_unverified');
  assert.equal(before.verifiedAt, null, '前提：这个点没有实地核验');

  const res = expectOk(await w.A('place.fetchPhotos', { placeId: 'p_unverified' }));

  /**
   * ⚠️ 这是本文件最重要的一条断言。
   * 照片只提供辨识度辅助；可达性与入口位置仍需实地踏勘（docs/项目计划书.md#data-model §2.2.2）。
   * 若这里变成 true，"抓到一张网图"就会被读成"这个点核验过了"。
   */
  assert.equal(res.eligibility.verificationLevel, 'none');
  assert.equal(res.eligibility.meetingPoint, false, '有照片不等于能当集合点');
  assert.match(res.notice, /不构成对可达性、入口位置等物理属性的核验/);

  const after = await w.repo.get(C.PLACES, 'p_unverified');
  assert.equal(after.verifiedAt, null, '抓照片不得顺手写 verifiedAt');
  assert.equal(after.confidence, before.confidence, '也不得改动 confidence');
});

test('照片带 source: upstream 且 verified: false', async () => {
  const w = await worldWithPhotos('ok');
  const res = expectOk(await w.A('place.fetchPhotos', { placeId: 'p_zhongyang' }));
  assert.equal(res.photos[0].source, 'upstream');
  assert.equal(res.photos[0].verified, false, '联网抓取的图永远不是踏勘实拍');
});

test('上游失败时 action 不抛异常，照片为空但地点记录仍可用', async () => {
  const w = await worldWithPhotos('upstream-failure');
  const res = expectOk(await w.A('place.fetchPhotos', { placeId: 'p_zhongyang' }));

  assert.equal(res.emptyReason, 'UPSTREAM_FAILED');
  assert.equal(res.photos.length, 0);
  // 地点本身不受影响 —— 集合点推荐该照常工作
  const stored = await w.repo.get(C.PLACES, 'p_zhongyang');
  assert.equal(stored.name, '中央大街');
  assert.equal(stored.verifiedAt !== null, true);
});

test('未配 Key 时给出可执行的修复指引，而不是一句"失败"', async () => {
  const w = await worldWithPhotos('no-key');
  const res = expectOk(await w.A('place.fetchPhotos', { placeId: 'p_zhongyang' }));
  assert.equal(res.emptyReason, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(res.photos.length, 0);
});

test('附近没有 POI、以及 POI 没有照片，是两种不同的空', async () => {
  for (const [mode, expected] of [
    ['no-poi', 'NO_POI_MATCHED'],
    ['poi-without-photo', 'POI_HAS_NO_PHOTO'],
  ]) {
    const w = await worldWithPhotos(mode);
    const res = expectOk(await w.A('place.fetchPhotos', { placeId: 'p_zhongyang' }));
    assert.equal(res.emptyReason, expected);
    assert.equal(res.photos.length, 0);
  }
});

test('距离守卫拦下的照片默认不落库、不展示', async () => {
  const w = await worldWithPhotos('far-away');
  const res = expectOk(await w.A('place.fetchPhotos', { placeId: 'p_zhongyang' }));

  assert.equal(res.photos.length, 0, '一张错图比没有图更糟');
  assert.equal(res.verification.passed, false);
  assert.equal(w.photoStoreCalls.length, 0, '未通过核验的图不该浪费配额去下载');
});

test('place.fetchPhotos 对不存在的 placeId 报 NOT_FOUND', async () => {
  const w = await worldWithPhotos('ok');
  expectFail(await w.A('place.fetchPhotos', { placeId: 'p_nope' }), 'NOT_FOUND');
  expectFail(await w.A('place.fetchPhotos', {}), 'INVALID_PARAM');
});

test('单张上传失败时如实报告 persistedCount 为 0', async () => {
  const w = await worldWithPhotos('ok', { uploadFails: true });
  const res = expectOk(await w.A('place.fetchPhotos', { placeId: 'p_zhongyang' }));

  assert.equal(res.persistedCount, 0, '没落成存储的图客户端拿不到，等于没有');
  assert.equal(res.photos[0].fileID, null);
  assert.equal(res.photos[0].persistError.reason, 'UPLOAD_FAILED');
});

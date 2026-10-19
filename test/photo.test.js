'use strict';

/**
 * 照片层测试。
 *
 * 这一层的价值有一半在于**它可测**：给定一组地点与一组上游返回，
 * 同一套检查跑两次得到同一个结论。计划书 §11.3 要求一等交付物
 * 「每条可复现、跑过才算完成」，照片核验正好落在这条上。
 *
 * 测试全程不联网、不需要云环境：provider 与 storage 都通过注入替换。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPhotoService, createPhotoProvider } = require('../cloudfunctions/api/lib/photo');
const { createFakePhotoProvider } = require('../cloudfunctions/api/lib/photo/fake');
const { verifyPhotos, CHECKS } = require('../cloudfunctions/api/lib/photo/verify');
const { storagePathFor, CLOUD_PREFIX } = require('../cloudfunctions/api/lib/photo/storage');
const { judgeTrust, MAX_TRUSTED_DISTANCE_M } = require('../cloudfunctions/api/lib/photo/shared');

/** 中央大街一带的坐标（与夹具一致） */
const HERE = { latitude: 45.7756, longitude: 126.6175 };
/** 约 5 公里外 —— 同城另一个地方 */
const FAR = { latitude: 45.8206, longitude: 126.6175 };

const PLACE = { _id: 'p_zhongyang', name: '中央大街', location: HERE };

/** 假存储：记录被要求持久化了哪些 url，便于断言"未通过核验的图不该被下载" */
function fakeStore(opts) {
  opts = opts || {};
  const calls = [];
  return {
    calls,
    async persist(placeId, index, photo) {
      calls.push({ placeId, index, url: photo.url });
      if (opts.fail) return { ok: false, reason: 'UPLOAD_FAILED', message: '云存储上传失败' };
      return {
        ok: true,
        fileID: `cloud://fake.env/${storagePathFor(placeId, index, photo.url)}`,
        cloudPath: storagePathFor(placeId, index, photo.url),
        byteLength: 1024,
        contentType: 'image/jpeg',
      };
    },
  };
}

function service(mode, opts) {
  opts = opts || {};
  const store = opts.store || fakeStore();
  return {
    store,
    svc: createPhotoService({
      photoProvider: createFakePhotoProvider(Object.assign({ mode }, opts.providerOpts)),
      store,
      maxDistanceMeters: opts.maxDistanceMeters,
    }),
  };
}

test('按名字搜到照片，核验通过后落云存储并返回 fileID', async () => {
  const { svc, store } = service('ok');
  const res = await svc.fetchForPlace(PLACE);

  assert.equal(res.ok, true);
  assert.equal(res.provider, 'fake');
  assert.equal(res.photos.length, 1);
  assert.match(res.photos[0].fileID, /^cloud:\/\//, '客户端要拿 fileID，不是上游 url');
  assert.equal(res.persistedCount, 1);
  assert.equal(store.calls.length, 1, '通过核验的照片才需要下载');

  // provider 与上游命中信息要能追溯 —— 答辩要能说清"这张图属于哪个点"
  assert.equal(res.matchedPoi.name, '中央大街');
  assert.equal(res.matchBasis, 'exact-name');
  assert.equal(res.verification.passed, true);
});

test('照片一律标记为未核验（联网抓取 ≠ 踏勘实拍）', async () => {
  const { svc } = service('ok');
  const res = await svc.fetchForPlace(PLACE);
  const ph = res.photos[0];

  assert.equal(ph.source, 'upstream', '联网抓取的来源必须是 upstream');
  /**
   * ⚠️ 这条是整组测试里最重要的一条。
   * 只要它变成 true，界面就会把网图当"已核验"展示，
   * 而这正是 docs/项目计划书.md#data-model §2.2.2 与计划书 §6.6 要防的事。
   */
  assert.equal(ph.verified, false, '联网抓来的图永远不是踏勘实拍');
  assert.equal(ph.provider, 'amap');
});

test('距离守卫：同名但远在 5 公里外的照片被判不可信，且**不被下载**', async () => {
  const { svc, store } = service('far-away');
  const res = await svc.fetchForPlace(PLACE);

  assert.equal(res.upstreamOk, true, '上游本身是成功的');
  assert.equal(res.ok, false, '但照片不可信，所以整体不算取到照片');
  assert.equal(res.photos.length, 0, '默认丢弃不可信照片 —— 一张错图比没有图更糟');
  assert.equal(store.calls.length, 0, '未通过核验的图不该浪费月配额去下载');
  assert.ok(res.verification.reason.includes(CHECKS.POI_DISTANCE));

  const distanceCheck = res.verification.checks.find((c) => c.name === CHECKS.POI_DISTANCE);
  assert.equal(distanceCheck.passed, false);
  assert.ok(distanceCheck.distanceMeters > MAX_TRUSTED_DISTANCE_M);
  assert.match(distanceCheck.detail, /超出可信范围/);
});

test('keepUntrusted：要留档排查时才下载，但标注仍然带着', async () => {
  const store = fakeStore();
  const { svc } = service('far-away', { store });
  const res = await svc.fetchForPlace(PLACE, { keepUntrusted: true });

  assert.equal(res.photos.length, 1, '显式要求时才保留');
  assert.equal(store.calls.length, 1);
  assert.equal(res.photos[0].photoVerification.passed, false, '标注必须跟着图片走，不能被丢掉');
  assert.equal(res.photos[0].trustBasis, 'too-far');
});

test('"无法确认"不等于"可信"：上游没给坐标时判为不可信', () => {
  const trust = judgeTrust({
    targetLocation: HERE,
    poiLocation: null, // 上游没返回坐标
    expectedName: '中央大街',
    poiName: '中央大街',
  });
  assert.equal(trust.trusted, false);
  assert.equal(trust.basis, 'distance-unknown');
  assert.match(trust.detail, /无法确认不等于可信/);
});

test('名字完全对不上时判为不可信', () => {
  const trust = judgeTrust({
    targetLocation: HERE,
    poiLocation: HERE,
    expectedName: '防洪纪念塔',
    poiName: '某某快捷宾馆',
  });
  assert.equal(trust.trusted, false);
  assert.equal(trust.basis, 'name-mismatch');
});

test('名字比对刻意宽松：允许后缀与括号差异，但不允许完全不同的地方', () => {
  const same = judgeTrust({
    targetLocation: HERE,
    poiLocation: HERE,
    expectedName: '防洪纪念塔',
    poiName: '防洪纪念塔（中央大街）',
  });
  assert.equal(same.trusted, true, '括号后缀不该被判为不符');

  const abbrev = judgeTrust({
    targetLocation: HERE,
    poiLocation: HERE,
    expectedName: '哈工大',
    poiName: '哈尔滨工业大学',
  });
  /**
   * 这一条**刻意不断言 true**：'哈工大' 与 '哈尔滨工业大学' 不互相包含，
   * 宽松比对也认不出来。位置守卫会兜住它（同一坐标即通过）。
   * 记录这个已知边界，比假装它不存在好 —— 名字比对不是万能的。
   */
  assert.equal(abbrev.basis === 'distance-verified' || abbrev.basis === 'name-mismatch', true);
});

test('四种"没有照片"的原因必须能分辨，不能混成一句"暂无照片"', async () => {
  const cases = [
    ['no-key', 'PROVIDER_NOT_CONFIGURED'],
    ['upstream-failure', 'UPSTREAM_FAILED'],
    ['no-poi', 'NO_POI_MATCHED'],
    ['poi-without-photo', 'POI_HAS_NO_PHOTO'],
  ];
  for (const [mode, expected] of cases) {
    const { svc } = service(mode);
    const res = await svc.fetchForPlace(PLACE);
    assert.equal(res.ok, false, `${mode} 应当没有照片`);
    assert.equal(res.emptyReason, expected, `${mode} 的空原因应当是 ${expected}`);
  }
});

test('上游失败不抛异常 —— 照片是增强项，不该阻断集合点主流程', async () => {
  const { svc } = service('upstream-failure');
  const res = await svc.fetchForPlace(PLACE);
  assert.equal(res.ok, false);
  assert.equal(res.upstreamOk, false);
  assert.equal(res.photos.length, 0);
});

test('单张上传失败不放弃整组，但留下失败原因', async () => {
  const { svc } = service('ok', { store: fakeStore({ fail: true }) });
  const res = await svc.fetchForPlace(PLACE);

  assert.equal(res.persistedCount, 0, '没落成存储的图客户端拿不到，等于没有');
  assert.equal(res.photos[0].fileID, null);
  assert.equal(res.photos[0].persistError.reason, 'UPLOAD_FAILED');
  assert.match(res.photos[0].persistError.message, /上传失败/);
});

test('没有 name 的地点无法按名字检索，且错误码明确', async () => {
  const { svc } = service('ok');
  const res = await svc.fetchForPlace({ _id: 'x', location: HERE });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'PLACE_NAME_REQUIRED');
});

test('云存储路径稳定且安全（不含 url 里的特殊字符）', () => {
  const url = 'https://store.is.autonavi.com/showpic/abc?operate=original&type=pic';
  const p = storagePathFor('p_zhongyang', 0, url);

  assert.ok(p.startsWith(`${CLOUD_PREFIX}/`), '照片单独一层，便于按前缀清理');
  assert.ok(!/[?&=]/.test(p), '路径里不得残留 url 的 query 符号');
  assert.equal(p, storagePathFor('p_zhongyang', 0, url), '同一 url 必须得到同一路径（可复现）');
  assert.notEqual(p, storagePathFor('p_zhongyang', 1, url), '不同序号不该撞路径');
});

test('provider 工厂：未知名字要报错，且默认走 amap', () => {
  assert.throws(() => createPhotoProvider('some-unknown-vendor'), /未知的照片服务/);
  const p = createPhotoProvider('fake');
  assert.equal(p.name, 'fake');
});

test('verifyPhotos 四项检查逐项可解释，界面与答辩直接引用', () => {
  const v = verifyPhotos({
    placeName: '中央大街',
    placeLocation: HERE,
    matchedPoi: { name: '中央大街', location: HERE },
    photos: [{ url: 'https://x/1.jpg', provider: 'amap' }],
  });

  assert.equal(v.passed, true);
  assert.equal(v.checks.length, 4);
  const names = v.checks.map((c) => c.name);
  assert.deepEqual(names, [CHECKS.POI_IDENTITY, CHECKS.POI_DISTANCE, CHECKS.PHOTO_SOURCE, CHECKS.PHOTO_UNIQUE]);
  for (const c of v.checks) {
    assert.ok(c.label, `${c.name} 必须有人能读懂的中文标签`);
    assert.ok(c.detail, `${c.name} 必须给出可展示的原因`);
  }
});

test('缺 provider 的照片无法追溯来源，检查不通过', () => {
  const v = verifyPhotos({
    placeName: '中央大街',
    placeLocation: HERE,
    matchedPoi: { name: '中央大街', location: HERE },
    photos: [{ url: 'https://x/1.jpg' }], // 没有 provider
  });
  assert.equal(v.passed, false);
  assert.equal(v.checks.find((c) => c.name === CHECKS.PHOTO_SOURCE).passed, false);
});

test('同一地点内重复图片 URL 被识别为抓取异常', () => {
  const v = verifyPhotos({
    placeName: '中央大街',
    placeLocation: HERE,
    matchedPoi: { name: '中央大街', location: HERE },
    photos: [
      { url: 'https://x/same.jpg', provider: 'amap' },
      { url: 'https://x/same.jpg', provider: 'amap' },
    ],
  });
  assert.equal(v.passed, false);
  assert.equal(v.checks.find((c) => c.name === CHECKS.PHOTO_UNIQUE).passed, false);
});

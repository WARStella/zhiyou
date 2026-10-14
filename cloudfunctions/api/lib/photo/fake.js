'use strict';

/**
 * 假照片 provider —— 照片层的离线路径。
 *
 * 与 `lib/map/fake.js` 同一个理由：照片要下载二进制、还要上传到云存储，
 * 让单元测试真去连外网是错的做法（慢、不稳、且测不出"上游失败"这种状态）。
 *
 * 它同时是一份**可执行的契约**：真实 provider 返回什么形状，这里就返回什么形状。
 * 测试断言的是形状与降级行为，不是某家上游的字段拼写。
 */

/** 1×1 透明 PNG —— 一个真实可解码的图片，不是随便一串字节 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

function createFakePhotoProvider(opts) {
  opts = opts || {};

  /**
   * 三种预设：正常 / 附近没有 POI / 上游失败。
   * 通过构造参数表达任意状态，而不是靠环境变量后门（同 `lib/map/fake.js` 的取舍）。
   */
  const mode = opts.mode || 'ok';

  return {
    name: 'fake',
    keyStatus() {
      return { configured: mode !== 'no-key', masked: mode === 'no-key' ? null : 'fake****key' };
    },

    /**
     * 与真实 provider **同签名同返回形状** —— 这是一份可执行的契约。
     * 测试断言形状与降级行为，不依赖某家上游的字段拼写。
     */
    async photosByName(input) {
      input = input || {};
      const name = input.name || null;
      const targetLocation = input.targetLocation || null;
      const base = {
        provider: 'fake',
        operation: 'place/text',
        keyword: name,
        region: input.region || '哈尔滨',
        targetLocation,
      };

      if (!name) {
        return Object.assign(base, {
          ok: false,
          reason: 'NAME_REQUIRED',
          message: '按名字取照片必须给出 name',
          photos: [],
          emptyReason: 'NAME_REQUIRED',
        });
      }
      if (mode === 'no-key') {
        return Object.assign(base, {
          ok: false,
          reason: 'AMAP_KEY_NOT_CONFIGURED',
          message: '云函数环境变量 AMAP_KEY 未配置，无法取 POI 照片',
          photos: [],
          emptyReason: 'PROVIDER_NOT_CONFIGURED',
        });
      }
      if (mode === 'upstream-failure') {
        return Object.assign(base, {
          ok: false,
          reason: 'UPSTREAM_FAILED',
          message: '上游请求超时（8000ms）',
          photos: [],
          emptyReason: 'UPSTREAM_FAILED',
        });
      }
      if (mode === 'no-poi') {
        return Object.assign(base, {
          ok: true,
          status: '1',
          poiCount: 0,
          matchedPoi: null,
          matchBasis: null,
          photos: [],
          emptyReason: 'NO_POI_MATCHED',
        });
      }
      if (mode === 'poi-without-photo') {
        return Object.assign(base, {
          ok: true,
          status: '1',
          poiCount: 1,
          matchedPoi: { id: 'FAKE_POI_1', name, address: '测试地址', location: targetLocation },
          matchBasis: 'exact-name',
          photos: [],
          emptyReason: 'POI_HAS_NO_PHOTO',
        });
      }
      /** mode === 'far-away'：名字对得上，但照片所属 POI 在约 5 公里外 —— 距离守卫必须拦下 */
      if (mode === 'far-away') {
        const far = targetLocation
          ? { latitude: targetLocation.latitude + 0.045, longitude: targetLocation.longitude }
          : null;
        return Object.assign(base, {
          ok: true,
          status: '1',
          poiCount: 1,
          matchedPoi: { id: 'FAKE_POI_FAR', name, address: '另一个区的同名地点', location: far },
          matchBasis: 'exact-name',
          /**
           * ⚠️ `trustBasis` / `distanceMeters` 必须由 provider 挂在**每张照片**上 ——
           * 真实 provider 就是这么做的（客户端逐张取用时才不会漏掉标注）。
           * fake 漏挂过一次，结果测试与线上行为不一致：契约型 fake 的价值
           * 全在于"形状一致"，漂移了它就是在骗人。
           */
          photos: [
            {
              url: opts.photoUrl || 'https://fake.local/far.png',
              title: '张冠李戴的图',
              provider: 'amap',
              poisId: 'FAKE_POI_FAR',
              poiName: name,
              trusted: false,
              trustBasis: 'too-far',
              distanceMeters: 5000,
            },
          ],
          emptyReason: null,
        });
      }

      return Object.assign(base, {
        ok: true,
        status: '1',
        poiCount: 1,
        matchedPoi: { id: 'FAKE_POI_1', name, address: '测试地址', location: targetLocation },
        matchBasis: 'exact-name',
        photos: [
          {
            url: opts.photoUrl || 'https://fake.local/photo-1.png',
            title: '广场入口',
            provider: 'amap',
            poisId: 'FAKE_POI_1',
            poiName: name,
          },
        ],
        emptyReason: null,
      });
    },
  };
}

module.exports = { createFakePhotoProvider, PNG_1X1 };

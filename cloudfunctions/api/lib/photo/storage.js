'use strict';

/**
 * 照片落云存储。
 *
 * ── 为什么不直接把上游图片 URL 交给客户端 ──────────────────
 *
 * 两个理由，都是硬约束：
 *
 *   ① **合法域名**：微信小程序对小程序内发起的外部请求要配合法域名。
 *      把一堆第三方图片域名逐个配进去既不可控，也把耦合留在了客户端。
 *   ② **缓存与配额**：高德是月配额。同一张照片被十个人看十次，
 *      不该消耗十次上游调用，更不该让上游挂掉时界面就空白。
 *
 * 落云存储之后客户端拿 `cloud://` fileID —— 它能同时喂给 `<image>`
 * 与 marker 的 `iconPath`（后者需**显式指定 width/height**，见 map 组件文档）。
 *
 * ── 依赖注入 ──────────────────────────────────────────────
 *
 * `opts.uploader` 允许测试注入假上传器。真实实现在云函数里用 `wx-server-sdk`
 * 的 `uploadFile`，但它**只在云环境内可用**，本地测试跑不起来 ——
 * 所以这一层必须可替换，否则照片整条链就无法测试。
 */

/** 云存储路径前缀。放照片单独一层，便于按前缀批量清理。 */
const CLOUD_PREFIX = 'poi-photos';

/** 允许的图片 content-type 前缀 —— 不信任 URL 后缀，看响应头 */
const IMAGE_CONTENT_TYPE_RE = /^image\//i;

/**
 * 由「地点 id + 照片序号 + url 摘要」生成稳定的云存储路径。
 *
 * 用摘要而不是直接把 url 塞进路径：url 里可能有 `?`、`=`、超长 query，
 * 直接当文件名会在上传时失败或产生极难排查的路径。
 */
function storagePathFor(placeId, index, url) {
  const hash = shortHash(String(url));
  return `${CLOUD_PREFIX}/${sanitize(placeId)}/${index}-${hash}.img`;
}

/** 只保留路径安全字符，其余替换为 `_`（云存储路径不接受某些符号） */
function sanitize(s) {
  return String(s || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** 稳定的短摘要（FNV-1a）。不追求抗碰撞，只求同 url 同路径。 */
function shortHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * 真实上传器 —— 云函数内用 `wx-server-sdk`。
 *
 * 刻意在这里**惰性 require**：本地测试环境没有 `wx-server-sdk`，
 * 顶层 require 会让整个模块在测试里加载失败。
 */
function createCloudUploader(opts) {
  opts = opts || {};
  return async function upload(buffer, cloudPath) {
    const cloud = opts.cloud || require('wx-server-sdk');
    const res = await cloud.uploadFile({ cloudPath, fileContent: buffer });
    return { fileID: res.fileID };
  };
}

function createPhotoStore(opts) {
  opts = opts || {};
  const uploader = opts.uploader || createCloudUploader(opts);
  const http = opts.http || require('../http').defaultTransport;
  const timeoutMs = opts.timeoutMs || 8000;
  const maxBytes = opts.maxBytes;

  return {
    /**
     * 下载一张照片并上传到云存储。
     *
     * 恒返回结构，不抛异常 —— **一张照片取不到不该让整条链失败**，
     * 因为照片是增强项：没有它，集合点仍然可用（只是少一个辨识度辅助）。
     */
    async persist(placeId, index, photo) {
      const url = photo && photo.url;
      if (!url) {
        return { ok: false, reason: 'URL_REQUIRED', message: '照片没有 url' };
      }

      let res;
      try {
        res = await http(url, { binary: true, timeoutMs, maxBytes, errorCode: 'UPSTREAM_PHOTO_FAILED' });
      } catch (e) {
        return {
          ok: false,
          reason: 'DOWNLOAD_FAILED',
          message: (e && e.message) || String(e),
          details: (e && e.details) || null,
        };
      }

      const contentType = res.contentType || '';
      if (!IMAGE_CONTENT_TYPE_RE.test(contentType)) {
        /**
         * 上游返回的不是图片。
         * 这一步不能省：有些图床在链接失效时返回一个 HTML 错误页，
         * 而 HTML 也能"下载成功" —— 存进去就变成一张打不开的图片，
         * 且没有任何报错，直到有人在演示现场点开它。
         */
        return {
          ok: false,
          reason: 'NOT_AN_IMAGE',
          message: `上游返回的 content-type 是「${contentType || '（空）'}」，不是图片`,
          byteLength: res.byteLength,
        };
      }

      const cloudPath = storagePathFor(placeId, index, url);
      try {
        const up = await uploader(res.buffer, cloudPath);
        return {
          ok: true,
          fileID: up.fileID,
          cloudPath,
          byteLength: res.byteLength,
          contentType,
        };
      } catch (e) {
        return {
          ok: false,
          reason: 'UPLOAD_FAILED',
          message: (e && e.message) || String(e),
          cloudPath,
        };
      }
    },
  };
}

module.exports = {
  createPhotoStore,
  createCloudUploader,
  storagePathFor,
  shortHash,
  CLOUD_PREFIX,
};

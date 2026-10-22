'use strict';
const { assert, CODES, fail } = require('./errors');
function createInviteProvider(options = {}) {
  return { async generate(scene, environment) {
    const version = (options.env || process.env).WX_CODE_ENV_VERSION || (environment === 'prod' ? 'release' : 'trial');
    assert(['release', 'trial', 'develop'].includes(version), CODES.INVALID_PARAM, 'WX_CODE_ENV_VERSION须为release、trial或develop');
    let result;
    try {
      const cloud = options.cloud || require('wx-server-sdk');
      result = await cloud.openapi.wxacode.getUnlimited({ scene, page: 'pages/invite/index', width: 430,
        checkPath: version === 'release', envVersion: version, isHyaline: false });
    } catch (_) { throw fail(CODES.INSUFFICIENT_DATA, '小程序码生成失败，请检查云调用权限和对应版本页面；可先分享邀请卡'); }
    const buffer = result && result.buffer;
    assert(Buffer.isBuffer(buffer) && buffer.length > 8 && buffer.length <= 1024 * 1024,
      CODES.INSUFFICIENT_DATA, '小程序码返回异常，请稍后重试');
    const png = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    assert(png || jpeg, CODES.INSUFFICIENT_DATA, '小程序码未返回有效图片，请检查发布版本与权限');
    return { imageBase64: buffer.toString('base64'), contentType: png ? 'image/png' : 'image/jpeg', envVersion: version };
  } };
}
module.exports = { createInviteProvider };

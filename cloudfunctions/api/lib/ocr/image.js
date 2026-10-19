'use strict';
const { assert, CODES } = require('../errors');
const MAX_IMAGE_BYTES = 1024 * 1024;
function decodeImage(encoded) {
  assert(typeof encoded === 'string' && encoded.length > 0 && encoded.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4 &&
    encoded.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded), CODES.INVALID_PARAM, '图片须为不超过 1MB 的 JPG 或 PNG');
  const bytes = Buffer.from(encoded, 'base64');
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert(bytes.length <= MAX_IMAGE_BYTES && bytes.toString('base64') === encoded && (jpeg || png), CODES.INVALID_PARAM, '图片编码无效，仅支持 JPG 或 PNG；请重新拍摄');
  return { bytes, mime: png ? 'image/png' : 'image/jpeg' };
}
module.exports = { decodeImage, MAX_IMAGE_BYTES };

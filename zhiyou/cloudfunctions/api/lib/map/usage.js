'use strict';

/** 真实 provider 在发请求时记数；旧 provider / 注入替身按一次调用计，保留兼容性。 */
function requestCount(result) {
  return result && Number.isInteger(result.requestCount) && result.requestCount >= 0
    ? result.requestCount : 1;
}

module.exports = { requestCount };

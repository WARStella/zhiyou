'use strict';
const resp = require('../lib/resp');
const { createMerchantSearch } = require('../lib/amap/merchants');
module.exports = async ctx => {
  const center = ctx.payload && ctx.payload.center || { latitude: 45.767, longitude: 126.625 };
  const result = await createMerchantSearch().search(center);
  return resp.ok({ provider: 'amap', sampleLocation: '默认查询哈尔滨圣索菲亚教堂附近餐饮；仅为接口验证，不代表用户当前位置',
    ...result, querySucceeded: result.ok, sampleCount: (result.items || []).length }, { mapApiCalls: result.mapApiCalls });
};

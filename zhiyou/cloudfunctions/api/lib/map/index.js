'use strict';

/**
 * 地图服务工厂。
 *
 * 选腾讯位置服务的理由（10/14 验证后会在此记录结论）：
 *   - 与微信生态一致，坐标系统一为 GCJ-02
 *   - WebService API 直接在云函数内用 Key 调用，**不需要小程序类目授权**
 *     （这一点很重要：位置接口受类目限制，但地图路线服务不受）
 *
 * ⚠️ Key 只从**云函数环境变量** `MAP_KEY` 读取。
 * 绝不写入代码、仓库、小程序包 —— 计划书 11/12 验收项。
 */

const { createTencentProvider } = require('./tencent');
const { createFakeProvider } = require('./fake');

const PROVIDERS = {
  tencent: createTencentProvider,
  fake: createFakeProvider,
};

/** 默认走 tencent；测试可用 `MAP_PROVIDER=fake` 或显式传入 */
function createMapProvider(kind, opts) {
  const name = kind || process.env.MAP_PROVIDER || 'tencent';
  const factory = PROVIDERS[name];
  if (!factory) throw new Error(`未知的地图服务：${name}（支持：${Object.keys(PROVIDERS).join(', ')}）`);
  return factory(opts || {});
}

module.exports = { createMapProvider, PROVIDERS, createTencentProvider, createFakeProvider };

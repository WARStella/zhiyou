'use strict';

/**
 * 云函数入口 —— 智游·灵动 统一 api。
 *
 * 这是唯一的业务入口云函数（理由见 docs/02_接口清单_v0.md §0）。
 * 它只做三件事：取微信身份、选仓储实现、交给 lib/invoke.js。
 * **业务逻辑一律不写在这里**，否则本地测试就跑不到线上真正执行的代码。
 */

const cloud = require('wx-server-sdk');
const { invoke } = require('./lib/invoke');
const { getRepo } = require('./lib/repo');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();

  // 环境判定：云开发环境名自定义为 dev / prod 两个，README 有说明
  const env = process.env.ZY_ENV || (wxContext.ENV && wxContext.ENV.includes('prod') ? 'prod' : 'dev');

  const repo = getRepo('cloud', { env: cloud.DYNAMIC_CURRENT_ENV });

  return invoke(event, {
    repo,
    openid: wxContext.OPENID,
    env,
    /**
     * 注入点必须**显式**声明，即使是"线上不注入替身"这个选择。
     *
     * 传 `null` 表示"用真实实现"，与"忘了写"是两件事 ——
     * 而 `lib/invoke.js` 只能看出前者。不写就会在入口直接抛错，
     * 而不是让动作层安静地回落到真实实现（那会掩盖真正的配置错误）。
     */
    createMapProvider: null,
    createPhotoService: null,
    createTransitProvider: null,
  });
};

'use strict';

/**
 * 云函数入口 —— 智游·灵动 统一 api。
 *
 * 这是唯一的业务入口云函数（理由见 docs/项目计划书.md#api-contract §0）。
 * 它只做三件事：取微信身份、选仓储实现、交给 lib/invoke.js。
 * **业务逻辑一律不写在这里**，否则本地测试就跑不到线上真正执行的代码。
 */

const cloud = require('wx-server-sdk');
const { invoke } = require('./lib/invoke');
const { adminOpenidsFromEnv } = require('./lib/ops-guard');
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
     * 运维/探针类 action 的白名单（2026-10-15）。
     *
     * **不配 = 全部拒绝**（fail closed）。理由见 `lib/ops-guard.js`：
     * "没配就当没限制"会让守卫在真正需要它的那一刻（刚部署、还没配变量）
     * 恰好失效 —— 而那一刻正是体验版刚发出去的时候。
     *
     * 值形如：`openidA,openidB`（云开发控制台 → 云函数 → api → 配置 → 环境变量）。
     */
    adminOpenids: adminOpenidsFromEnv(),
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
    createSpeechProvider: null,
    createOcrProvider: null,
    createGuideProvider: null,
    createInviteProvider: null,
    /** 订阅消息：线上走 cloud.openapi 云调用，`null` = 用真实实现 */
    createSubscribeProvider: null,
  });
};

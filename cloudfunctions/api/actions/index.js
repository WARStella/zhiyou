'use strict';

/**
 * Action 注册表 —— 新增接口只需在此登记，并在 docs/02_接口清单_v0.md 中同步。
 *
 * 命名规范：`域.动作`，域与 service/ 的模块划分一致
 * （team · intent · poi · planner · trip · meet · trace，见计划书 §9）。
 */

const user = require('./user');
const place = require('./place');
const crew = require('./crew');
const loc = require('./loc');
const trip = require('./trip');
const meet = require('./meet');
const map = require('./map');
const walkCacheCheck = require('./walk-cache-check');
const intent = require('./intent');
const ai = require('./ai');
const team = require('./team');

module.exports = {
  'ops.cleanupPlaceholderPlaces': require('./cleanup-places'),
  'team.current': team.current,
  'team.publishTrip': team.publishTrip,
  'team.progress': team.progress,
  'team.close': team.close,
  'team.cancelMeeting': team.cancelMeeting,
  // 用户与运维
  'user.login': user.login,
  'ops.health': user.health,

  /**
   * 个人资料（2026-10-14 用户要求「我的」界面要有用户id/头像/用户名/默认出行方式）。
   *
   * ⚠️ 这两个是**产品功能**，不是 ops 脚手架 —— 所以不带 ops. 前缀，
   * 也不限 dev。用户在正式版里就要能改自己的昵称与头像。
   */
  'user.getProfile': user.getProfile,
  'user.updateProfile': user.updateProfile,
  'ops.initDb': user.initDb,
  'ops.selfTest': user.selfTest,
  'ops.verifyIndexes': user.verifyIndexes,
  /** 步行估算的校准报告 —— 也是"绕路系数"模型的训练数据现状 */
  'ops.walkStats': user.walkStats,

  /**
   * 步行缓存体检 —— 找出 `walkableTo` 里隐含速度不可能的"步行"记录。
   *
   * 起因（2026-10-14）：用户看到「步行 24.7 分钟 14426 米」（= 584 米/分，
   * 那是驾车速度）。矩阵探针已证明矩阵本身没问题，所以问题在**缓存**：
   * 我加 `mode` 字段之前写进去的驾车/骑行耗时没有 `mode`，
   * 而兼容规则是"没有 mode 就当成步行" → 驾车时间被当月步行读。
   *
   * 影响两层，第二层看不见所以更要紧：界面显示荒谬时间，
   * 且 **`maxWalkMinutes` 硬约束失效**。
   *
   * 只读体检，**不自动删**（删数据不可逆，且"看起来不可能"未必等于"错"）。
   * 仅 dev。
   */
  'ops.walkCacheCheck': walkCacheCheck.walkCacheCheck,

  // 地点
  'place.list': place.list,
  'place.detail': place.detail,
  // 外部 POI 检索 → 候选池（一律未核验，只能作行程节点）
  'place.search': place.search,

  // 小队与权限
  'crew.create': crew.create,
  'crew.join': crew.join,
  'crew.leave': crew.leave,
  'crew.get': crew.get,
  'crew.remove': crew.remove,

  // 位置
  'loc.report': loc.report,
  'loc.list': loc.list,
  'loc.stopSharing': loc.stopSharing,

  // 行程与规划
  'trip.plan': trip.plan,
  'trip.get': trip.get,
  'trip.adjust': trip.adjust,
  'trip.confirmChange': trip.confirmChange,
  'trip.progress': trip.progress,
  /** 某一段的真实步行路线与转向指引 —— 内置导航的数据来源 */
  'trip.legRoute': trip.legRoute,

  // 集合
  'meet.recommend': meet.recommend,
  'meet.create': meet.create,
  'meet.confirm': meet.confirm,
  'meet.arrive': meet.arrive,
  'meet.depart': meet.depart,
  'meet.prepareDepart': require('./departure').prepare,
  'meet.get': meet.get,

  /**
   * 踏勘录入 —— `places` 集合**唯一的人工写入入口**。
   *
   * 10/13 定了"检索结果不入库、places 只由踏勘写入"，但没开写入的口子，
   * 结果 10/16 踏勘的数据只能手工敲控制台。仅 dev（与 ops.initDb 同惯例）。
   */
  'place.survey': require('./survey'),

  /**
   * 地点照片（2026-10-14）—— 按名字向高德取 POI 照片，核验后落云存储。
   *
   * 单独一个 action 而不是塞进 place.list：高德是**月**配额（5,000/月），
   * 列表接口顺手抓图会让一次页面刷新就烧掉几次配额。
   * 真实 provider 见 lib/photo/amap.js；本地测试用 PHOTO_PROVIDER=fake。
   */
  'place.fetchPhotos': require('./photos'),

  /**
   * 照片服务探针 —— 分层报告"取照片为什么不通"。
   *
   * 五种原因在小程序上表现一样（都是"没有照片"）：action 没部署、
   * Key 没配、Key 类型不对、服务没开通、POI 确实没图。混着看无法行动。
   */
  'photo.probe': require('./photo-probe'),

  /**
   * 公交（含地铁）路线探针 —— 先把三件事问清楚再往下做。
   *
   * ① 端点与权限（高德的接口逐个开通，Key 的「可使用服务」里要有公交路径规划）
   * ② 字段路径（依文档写的，未实测）
   * ③ 地铁识别（靠 `bus.type` 含「地铁」字样 —— 纯推测）
   *
   * 真实调用会消耗一次配额。见 lib/transit/amap.js。
   */
  'transit.probe': require('./transit-probe'),

  /** 距离矩阵探针 —— 单位与 mode 的实测（见下方注册处的说明） */
  'map.matrixProbe': require('./matrix-probe').probe,

  // 地图服务（10/14 验证）
  'map.probe': map.probe,

  // 需求解析（AI 层与算法层的接缝）
  'intent.parse': intent.parse,

  // 大模型探针（与 map.probe 同套路）
  'ai.probe': ai.probe,
};

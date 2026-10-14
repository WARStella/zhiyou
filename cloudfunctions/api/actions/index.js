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
  'ops.initDb': user.initDb,
  'ops.selfTest': user.selfTest,
  'ops.verifyIndexes': user.verifyIndexes,
  /** 步行估算的校准报告 —— 也是"绕路系数"模型的训练数据现状 */
  'ops.walkStats': user.walkStats,

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

  // 地图服务（10/14 验证）
  'map.probe': map.probe,

  // 需求解析（AI 层与算法层的接缝）
  'intent.parse': intent.parse,

  // 大模型探针（与 map.probe 同套路）
  'ai.probe': ai.probe,
};

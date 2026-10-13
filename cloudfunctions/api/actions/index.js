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

module.exports = {
  // 用户与运维
  'user.login': user.login,
  'ops.health': user.health,
  'ops.initDb': user.initDb,
  'ops.selfTest': user.selfTest,
  'ops.verifyIndexes': user.verifyIndexes,

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

  // 集合
  'meet.recommend': meet.recommend,
  'meet.create': meet.create,
  'meet.confirm': meet.confirm,
  'meet.arrive': meet.arrive,
  'meet.depart': meet.depart,
  'meet.get': meet.get,

  // 地图服务（10/14 验证）
  'map.probe': map.probe,

  // 需求解析（AI 层与算法层的接缝）
  'intent.parse': intent.parse,
};

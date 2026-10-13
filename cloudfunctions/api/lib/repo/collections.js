'use strict';

/**
 * 集合名常量。与 docs/01_数据模型_v1.md §2 一一对应。
 * 代码里禁止出现裸字符串集合名。
 */
module.exports = {
  USERS: 'users',
  PLACES: 'places',
  REQUIREMENTS: 'requirements',
  TRIPS: 'trips',
  TRIP_VERSIONS: 'trip_versions',
  CHANGE_PROPOSALS: 'change_proposals',
  CREWS: 'crews',
  CREW_MEMBERS: 'crew_members',
  LOCATIONS: 'locations',
  MEET_TASKS: 'meet_tasks',
  OPERATIONS: 'operations',
  EVENTS: 'events',
  DECISIONS: 'decisions',
  /**
   * **步行样本** —— 训练数据的原料（2026-10-13 新增）。
   *
   * ⚠️ 为什么要单独存：`geo.js` 里的 `DETOUR_FACTOR = 1.3` 是一个**常数**，
   * 用来把直线距离换算成步行距离。而今天实测：
   *
   *     直线 605 米 → 实际步行 815 米   倍率 1.35   ← 差不多
   *     直线  10 米 → 实际步行  76 米   倍率 7.6    ← 差了 7 倍
   *
   * **它不是常数，它随距离变化。** 这是一个标准回归问题，
   * 而训练数据只需要把每次调地图接口时的"直线 vs 实际"记下来 —— 不用等人。
   *
   * 这一条记录**现在就有用**（能算分段经验系数、能说清"估算到底差多少"），
   * 模型是它的自然延伸。
   */
  WALK_SAMPLES: 'walk_samples',
  PRIVACY_CONSENTS: 'privacy_consents',
};

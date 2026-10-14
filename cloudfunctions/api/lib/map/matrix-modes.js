'use strict';

/**
 * 距离矩阵支持的方式 —— **单一事实来源**。
 *
 * ⚠️ 为什么单独一个文件（2026-10-14）：
 *
 * 真实 provider（`tencent.js`）与假 provider（`fake.js`）都需要这份清单。
 * 各写一份必然漂移，而漂移的后果很具体：
 * **假服务放行了一个线上会被拒的方式** —— 测试绿灯、真机失败。
 * 那种"测过了却还是错"比没测更费时间。
 *
 * ── 清单本身的依据（官方文档原文）──────────────────────────
 *
 * 距离矩阵 `/ws/distance/v1/matrix` 的 `mode` 取值只有三个：
 *   「driving：驾车 / walking：步行 / bicycling：自行车」
 *
 * **没有公交。** 公交要走 `direction/v1/transit`，而且它的入参与其余三种不同
 * （要 `policy`、城市码等）。
 *
 * 所以"四种出行方式全算"这个目标，靠矩阵接口**只能做到三种**。
 * 这一条不能含糊：拿驾车耗时冒充公交耗时，比不做更糟 ——
 * 用户会按一个不存在的时间安排行程。
 */

const MATRIX_MODES = ['walking', 'bicycling', 'driving'];

/** 一对多计算的终点上限（官方：<= 200） */
const MATRIX_MAX_TO = 200;

/** 方式的中文名 —— 与 `lib/mode-choice.js` 的 MODE_LABEL 保持一致口径 */
const MATRIX_MODE_LABEL = {
  walking: '步行',
  bicycling: '骑行',
  driving: '驾车',
};

module.exports = { MATRIX_MODES, MATRIX_MAX_TO, MATRIX_MODE_LABEL };

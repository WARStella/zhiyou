// 地图组件只接受有限数值：纬度 [-90, 90]，经度 [-180, 180]。
// 不交换或截断异常值，避免把错误数据画成另一个地点。
function isValidPoint(point) {
  return Boolean(point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude) &&
    Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180)
}

module.exports = { isValidPoint }

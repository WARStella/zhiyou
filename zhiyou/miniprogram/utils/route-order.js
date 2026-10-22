// 顺序比较只用地点距离估算；实际交通耗时仍由 trip.plan 计算。
const { isValidPoint: valid } = require('./coordinates')
function distance(a, b) {
  const rad = x => x * Math.PI / 180
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2
  return 12742017.6 * Math.asin(Math.sqrt(Math.min(1, h)))
}
function suggestOrder(items, start) {
  if (items.length < 2 || items.some(x => !valid(x.location))) return items.slice()
  // 没有定位时固定用户的第一站，避免假设一个出发位置。
  const fixed = valid(start) ? [] : [items[0]]
  const origin = valid(start) ? start : items[0].location
  const rest = fixed.length ? items.slice(1) : items.slice()
  const n = rest.length
  const length = route => route.reduce((r, x) => ({ point: x.location, sum: r.sum + distance(r.point, x.location) }), { point: origin, sum: 0 }).sum
  let ordered
  if (n <= 10) {
    // 固定起点、无须返回起点的最短距离顺序；平局保留原顺序。
    const dp = Array.from({ length: 1 << n }, () => Array(n).fill(null))
    rest.forEach((x, i) => { dp[1 << i][i] = { cost: distance(origin, x.location), order: [i] } })
    for (let mask = 1; mask < (1 << n); mask++) {
      for (let last = 0; last < n; last++) {
        const state = dp[mask][last]
        if (!state) continue
        for (let next = 0; next < n; next++) {
          if (mask & (1 << next)) continue
          const m = mask | (1 << next)
          const cost = state.cost + distance(rest[last].location, rest[next].location)
          if (!dp[m][next] || cost < dp[m][next].cost - 0.01) dp[m][next] = { cost, order: state.order.concat(next) }
        }
      }
    }
    const best = dp[(1 << n) - 1].filter(Boolean).sort((a, b) => a.cost - b.cost)[0]
    ordered = best ? best.order.map(i => rest[i]) : rest
  } else {
    const remaining = rest.slice()
    ordered = []
    let point = origin
    while (remaining.length) {
      let best = 0
      remaining.forEach((x, i) => { if (distance(point, x.location) < distance(point, remaining[best].location)) best = i })
      const next = remaining.splice(best, 1)[0]
      ordered.push(next)
      point = next.location
    }
  }
  return length(ordered) < length(rest) - 1 ? fixed.concat(ordered) : items.slice()
}
module.exports = { suggestOrder }

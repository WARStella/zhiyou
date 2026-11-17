/** 行程页的展示数据；不修改计划、节点状态或导航数据。 */
const reached = n => n.status === 'arrived' || n.status === 'done'
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const dateOf = value => {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}
const dayKey = date => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
const clock = date => date ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : '--:--'

function greetingView(nickname, now = new Date()) {
  const hour = now.getHours()
  const greeting = hour < 6 ? '夜深了' : hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好'
  const name = typeof nickname === 'string' ? nickname.trim() : ''
  return { dateLabel: `${now.getMonth() + 1}月${now.getDate()}日 · 周${'日一二三四五六'[now.getDay()]}`,
    title: name ? `${greeting}，${name}` : greeting }
}

function buildTripDisplay(nodes, startLeg, now = new Date()) {
  nodes = nodes || []
  const totalCount = nodes.length
  const reachedCount = nodes.filter(reached).length
  const skippedCount = nodes.filter(n => n.status === 'skipped').length
  const allResolved = totalCount > 0 && nodes.every(n => n.status === 'done' || n.status === 'skipped')
  const active = nodes.find(n => n.status === 'arrived' || n.status === 'pending')
  const progressPct = totalCount ? Math.round(reachedCount * 100 / totalCount) : 0
  // 两个裁切半圆实现进度，避免依赖 conic-gradient 或原生 canvas。
  const degrees = totalCount ? reachedCount * 360 / totalCount : 0
  let walkMin = 0, walkMeters = 0, stayMin = 0
  let walkKnown = true, distanceKnown = true, stayKnown = true
  nodes.forEach((n, i) => {
    if (n.status === 'skipped') return
    const mode = i === 0 && startLeg ? startLeg.rawMode : n.travelMode
    const minutes = i === 0 && startLeg ? startLeg.minutes : n.travelFromPrevMin
    const meters = i === 0 && startLeg ? startLeg.meters : n.travelFromPrevMeters
    if (mode === 'walking') {
      if (nonnegative(minutes)) walkMin += minutes
      else walkKnown = false
      if (nonnegative(meters)) walkMeters += meters
      else distanceKnown = false
    }
    if (nonnegative(n.plannedStayMin)) stayMin += n.plannedStayMin
    else stayKnown = false
  })
  const first = nodes[0]
  const arrival = dateOf(first && first.plannedArriveAt)
  const departure = arrival && startLeg && nonnegative(startLeg.minutes)
    ? new Date(arrival.getTime() - startLeg.minutes * 60000) : arrival
  const remaining = nodes.filter(n => n.status !== 'skipped')
  const last = remaining[remaining.length - 1]
  const end = dateOf(last && last.plannedLeaveAt)
  const isToday = departure && dayKey(departure) === dayKey(now)
  const planLabel = departure ? isToday ? '今天' : `${departure.getMonth() + 1}月${departure.getDate()}日` : '本次'
  let endText = clock(end)
  if (departure && end && dayKey(departure) !== dayKey(end)) {
    const tomorrow = new Date(departure); tomorrow.setDate(tomorrow.getDate() + 1)
    endText = (dayKey(tomorrow) === dayKey(end) ? '次日 ' : `${end.getMonth() + 1}/${end.getDate()} `) + endText
  }
  return { totalCount, reachedCount, skippedCount, allResolved, progressPct,
    rightRotation: 180 + Math.min(180, degrees), leftRotation: 180 + Math.max(0, degrees - 180),
    allReached: totalCount > 0 && reachedCount === totalCount,
    focusLabel: active ? active.status === 'arrived' ? '正在游览' : '下一站' : allResolved ? '行程已结束' : '行程安排',
    focusName: active ? active.placeName || '未命名地点' : allResolved ? '本次游览告一段落' : '暂无目的地',
    focusNodeId: active ? active.nodeId : '',
    visiting: Boolean(active && active.status === 'arrived'),
    departureText: clock(departure), endText,
    walkMinText: walkKnown ? String(Math.round(walkMin)) : '待计算',
    stayMinText: stayKnown ? String(Math.round(stayMin)) : '待计算',
    walkMetersText: distanceKnown ? String(Math.round(walkMeters)) : '待计算',
    planLabel, sectionLabel: isToday ? '今天的安排' : '行程安排',
    subtitle: `${planLabel}计划游览 ${totalCount} 站，${walkKnown ? '步行约 ' + Math.round(walkMin) + ' 分钟' : '步行时间待计算'}`,
  }
}

module.exports = { greetingView, buildTripDisplay }

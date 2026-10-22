const { isValidPoint } = require('./coordinates')

const GAP = 10

function intersects(a, b) {
  return a.left < b.right + GAP && a.right + GAP > b.left &&
    a.top < b.bottom + GAP && a.bottom + GAP > b.top
}

/** 仅估计屏幕占位用于排列标签，绝不把投影坐标写回经纬度。 */
function project(point, scale, originLongitude) {
  const world = 256 * Math.pow(2, scale)
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, point.latitude))
  const sin = Math.sin(latitude * Math.PI / 180)
  const longitude = ((point.longitude - originLongitude + 540) % 360) - 180
  return { x: longitude / 360 * world,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * world }
}

function textSize(callout) {
  const fontSize = Number(callout.fontSize) || 12
  const padding = Number(callout.padding) || 6
  const lines = String(callout.content || '').split('\n')
  const width = Math.max(...lines.map(line => Array.from(line).reduce((sum, char) =>
    sum + fontSize * (char.codePointAt(0) > 255 ? 1 : 0.65), 0)))
  return { width: Math.ceil(width + padding * 2 + 8),
    height: Math.ceil(lines.length * fontSize * 1.4 + padding * 2 + 8) }
}

/**
 * 保留全部 marker 的坐标与 id；图标不互相碰撞隐藏，常显气泡仅作像素偏移。
 * 依据腾讯 map 组件说明的 collision 与 callout.anchorX/anchorY：
 * https://github.com/TencentLBS/tencentmap-miniprogram-skill/blob/main/references/map_component_guide.md
 */
function layoutMarkerLabels(markers, scale) {
  const zoom = Number.isFinite(scale) ? Math.max(3, Math.min(20, scale)) : 15
  const valid = markers.filter(isValidPoint)
  const originLongitude = valid.length ? valid[0].longitude : 0
  const positions = new Map(valid.map(marker => [marker.id, project(marker, zoom, originLongitude)]))
  const occupied = valid.map(marker => {
    const point = positions.get(marker.id)
    const width = Number(marker.width) || 26
    const height = Number(marker.height) || 26
    return { left: point.x - width / 2, right: point.x + width / 2,
      top: point.y - height, bottom: point.y }
  })
  const offsets = new Map()
  // 固定 id 顺序，避免云端返回顺序变化导致同位置的标签反复换位。
  valid.slice().sort((a, b) => a.id - b.id).forEach(marker => {
    if (!marker.callout) return
    const point = positions.get(marker.id)
    const nameSize = textSize(marker.callout)
    const chatSize = marker.chatBubble && textSize(marker.chatBubble)
    // 消息和用户名是上下两个独立框，连同框间距一起参与避让。
    const size = chatSize ? { width: Math.max(nameSize.width, chatSize.width),
      height: nameSize.height + chatSize.height + 8 } : nameSize
    const bottom = point.y - (Number(marker.height) || 26) - GAP
    const rect = { left: point.x - size.width / 2, right: point.x + size.width / 2,
      top: bottom - size.height, bottom }
    let anchorY = 0
    while (true) {
      const collisions = occupied.filter(other => intersects(rect, other))
      if (!collisions.length) break
      const shift = Math.ceil(rect.bottom - Math.min(...collisions.map(other => other.top)) + GAP) + 1
      rect.top -= shift
      rect.bottom -= shift
      anchorY -= shift
    }
    offsets.set(marker.id, { anchorX: 0, anchorY: Math.floor(anchorY) })
    occupied.push(rect)
  })
  return markers.map(marker => ({ ...marker,
    collision: '', collisionRelation: 'alone', joinCluster: false,
    ...(marker.callout ? { callout: { ...marker.callout, display: 'ALWAYS', collision: '',
      ...(offsets.get(marker.id) || { anchorX: 0, anchorY: 0 }) } } : {}),
    ...(marker.chatBubble ? {
      chatBubble: { ...marker.chatBubble, width: textSize(marker.chatBubble).width,
        groupWidth: Math.max(textSize(marker.callout).width, textSize(marker.chatBubble).width) },
      // map 在存在 customCallout 时忽略普通 callout；两个框的样式由模板分别控制。
      customCallout: { display: 'ALWAYS', ...(offsets.get(marker.id) || { anchorX: 0, anchorY: 0 }) },
    } : {}),
  }))
}

module.exports = { layoutMarkerLabels }

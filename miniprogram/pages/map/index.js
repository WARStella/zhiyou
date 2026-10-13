/**
 * 地图与集合页面。
 *
 * 目的（2026-10-13 建立）：
 *   ① 为地理位置接口申请提供**真实的使用场景截图**；
 *   ② 作为「位置接口拿不到」时降级路径的载体；
 *   ③ 作为 A 的正式地图页面的骨架。
 *
 * ── 两个刻意的设计选择 ──────────────────────────────────────
 *
 * 1. **不调用任何受限的地理位置接口。**
 *    `wx.getLocation` / `wx.chooseLocation` 权限尚未获批，调用会直接失败。
 *    因此"标记我的位置"用 `map` 组件的 `bindtap`（点击地图取坐标）——
 *    这不属于受限接口，今天就能用。
 *    位置来源因此是 `manual`，与 docs/01 §0 决定 3 的设计一致：
 *    **集合推荐算法不感知来源**，所以拿到 GPS 后只需换一个入口，算法与数据结构都不用改。
 *
 * 2. **卡片放在地图下方，不叠在地图上。**
 *    计划书附录 B 第 15 条待复核："小程序原生 map 为原生组件、层级最高，cover-view 限制多"。
 *    用普通流水布局直接绕开这个限制，**不需要验证 cover-view**。
 */

const api = require('../../utils/api')

/** 与后端 lib/geo.js 保持一致，避免同一段路算出两个时间 */
const DETOUR_FACTOR = 1.3
const WALK_SPEED_M_PER_MIN = 75
const MAX_WALK_METERS = 3000

const EARTH_R = 6371008.8
const toRad = (d) => (d * Math.PI) / 180

function haversineMeters(a, b) {
  const dLat = toRad(b.latitude - a.latitude)
  const dLng = toRad(b.longitude - a.longitude)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.sqrt(h))
}

function walkEstimate(a, b) {
  const straight = haversineMeters(a, b)
  const meters = Math.round(straight * DETOUR_FACTOR)
  return { meters, minutes: Math.max(1, Math.ceil(meters / WALK_SPEED_M_PER_MIN)) }
}

/** 集合点候选类别（与后端 MEET_CATEGORIES 对齐） */
const MEET_CATEGORIES = ['meeting', 'entrance', 'exit', 'spot', 'rest']

Page({
  data: {
    // 中心点：哈尔滨中央大街。地点数据由后端下发，这里是加载前的默认视角
    center: { latitude: 45.7756, longitude: 126.6175 },
    scale: 15,
    markers: [],
    polyline: [],
    places: [],
    myPoint: null,
    mySource: null,
    pickMode: false,
    meetingPoint: null,
    nearby: [],
    loading: true,
    loadError: '',
    note: '',
  },

  onLoad() {
    this.loadPlaces()
  },

  loadPlaces() {
    const that = this
    api
      .callApi('place.list', {})
      .then(function (res) {
        if (!res || res.ok !== true) {
          that.setData({ loading: false, loadError: (res && res.error && res.error.message) || '加载失败' })
          return
        }
        const places = (res.data.places || []).map(function (p) {
          return {
            placeId: p.placeId,
            name: p.name,
            category: p.category,
            latitude: p.location.latitude,
            longitude: p.location.longitude,
            // 准入分级：能游览 ≠ 能集合。地图上两者都要能看到，标注不同
            tripNodeAllowed: p.tripNodeAllowed,
            meetingPointAllowed: p.meetingPointAllowed,
            verified: p.verified,
          }
        })
        that.setData({ places, loading: false, loadError: '' })
        that.refreshMarkers()
      })
      .catch(function (err) {
        that.setData({ loading: false, loadError: (err && err.errMsg) || '加载失败' })
      })
  },

  /** 进入取点模式：提示用户点击地图 */
  startPick() {
    this.setData({
      pickMode: true,
      note: '请在地图上点击你当前所在的位置',
    })
  },

  /**
   * 使用定位接口获取位置。
   *
   * `type: 'gcj02'` 与全库坐标系一致（docs/01 §4）——混用会产生 50–500 米偏移，
   * 在"景区内集合"这个尺度上足以让人走到马路对面。
   *
   * 失败时不报错了事：明确给出原因并提供手动选点的退路。
   * 这正是 docs/01 §0 决定 3 的落地 —— 定位来源可替换，算法不感知来源。
   */
  useGps() {
    const that = this
    wx.getLocation({
      type: 'gcj02',
      isHighAccuracy: true,
      highAccuracyExpireTime: 4000,
      success(res) {
        that.setData({
          myPoint: { latitude: res.latitude, longitude: res.longitude },
          mySource: 'gps',
          myAccuracyM: res.accuracy,
          pickMode: false,
          note: '已通过定位接口获取位置（位置来源：定位接口）',
        })
        that.refreshMarkers()
        that.computeNearby()
      },
      fail(err) {
        const msg = (err && err.errMsg) || '未知原因'
        const denied = /auth deny|authorize|permission/i.test(msg)
        that.setData({
          mySource: null,
          note: denied
            ? '定位权限被拒绝，可点击地图手动选点，或在小程序设置里重新授权'
            : '定位失败：' + msg + '（可点击地图手动选点）',
        })
        console.error('[useGps] 获取位置失败', err)
      },
    })
  },

  onMapTap(e) {
    if (!this.data.pickMode) return
    const myPoint = { latitude: e.detail.latitude, longitude: e.detail.longitude }
    this.setData({
      myPoint,
      mySource: 'manual', // 手动选点；拿到定位权限后此处会变成 'gps'
      pickMode: false,
      note: '已按手动选点标记位置（位置来源：手动）',
    })
    this.refreshMarkers()
    this.computeNearby()
  },

  /** 计算到各集合点候选的步行估算，按最耗时的成员（此处即本人）排序 */
  computeNearby() {
    const my = this.data.myPoint
    if (!my) return

    const rows = this.data.places
      .filter((p) => MEET_CATEGORIES.indexOf(p.category) >= 0)
      .map((p) => {
        const est = walkEstimate(my, p)
        return {
          placeId: p.placeId,
          name: p.name,
          category: p.category,
          meters: est.meters,
          minutes: est.minutes,
          reachable: est.meters <= MAX_WALK_METERS,
        }
      })
      .filter((r) => r.reachable)
      .sort((a, b) => a.minutes - b.minutes)
      .slice(0, 3)

    this.setData({ nearby: rows })
  },

  selectMeeting(e) {
    const placeId = e.currentTarget.dataset.placeid
    const place = this.data.places.find((p) => p.placeId === placeId)
    if (!place) return
    this.setData({ meetingPoint: place })
    this.refreshMarkers()
  },

  refreshMarkers() {
    const markers = []
    const meetingId = this.data.meetingPoint && this.data.meetingPoint.placeId

    this.data.places.forEach((p, i) => {
      markers.push({
        id: i,
        latitude: p.latitude,
        longitude: p.longitude,
        iconPath: p.placeId === meetingId ? '/assets/pin-meeting.png' : '/assets/pin-place.png',
        width: p.placeId === meetingId ? 34 : 28,
        height: p.placeId === meetingId ? 42 : 35,
        callout: {
          content: p.name + (p.verified ? '' : '（未核验）'),
          color: '#1F2933',
          fontSize: 12,
          borderRadius: 6,
          bgColor: '#FFFFFF',
          padding: 6,
          display: p.placeId === meetingId ? 'ALWAYS' : 'BYCLICK',
        },
      })
    })

    if (this.data.myPoint) {
      markers.push({
        id: 999,
        latitude: this.data.myPoint.latitude,
        longitude: this.data.myPoint.longitude,
        iconPath: '/assets/dot-me.png',
        width: 26,
        height: 26,
        callout: {
          content: '我（' + (this.data.mySource === 'gps' ? '定位接口' : '手动选点') + '）',
          color: '#0F5132',
          fontSize: 12,
          borderRadius: 6,
          bgColor: '#FFFFFF',
          padding: 6,
          display: 'ALWAYS',
        },
      })
    }

    // 从"我"到所选集合点的连线（正式版将替换为后端返回的步行路径）
    const polyline =
      this.data.myPoint && this.data.meetingPoint
        ? [
            {
              points: [
                this.data.myPoint,
                { latitude: this.data.meetingPoint.latitude, longitude: this.data.meetingPoint.longitude },
              ],
              color: '#0FA98A',
              width: 4,
              dottedLine: true,
              arrowLine: true,
            },
          ]
        : []

    this.setData({ markers, polyline })
  },
})

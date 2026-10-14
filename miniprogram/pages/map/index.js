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
    /**
     * 照片：`{ [placeId]: { photos, note, level, verification } }`。
     *
     * 为什么按 placeId 存而不是直接塞进 places：照片是**按需取**的，
     * 一次只给一个地点取。塞进 places 会让"哪些取过、哪些没取"变得难以分辨，
     * 而列表每次刷新都会重建。
     */
    photos: {},
    /** `{ [markerId]: tempFileURL }` —— marker 的 iconPath 只吃本地/网络路径 */
    photoUrls: {},
    /**
     * `{ [markerId]: placeId }` —— 点图钉时用来反查是哪个地点。
     *
     * 不靠 `places` 的下标：图钉里还混着"我"、队员、团队集合点，
     * 下标一旦错位就是"点 A 选中 B"，而且**不报错**。
     */
    markerPlaceIndex: {},
    /**
     * 当前路线（从 `zhiyou-active-trip` 读回，见 `loadActiveTrip`）。
     *
     * `{ name, points, nodeNames }` —— 只留画线要用的坐标与名字。
     */
    route: null,
    photoBusy: false,
    photoNote: '',
    loading: true,
    loadError: '',
    note: '',
  },

  onLoad() {
    this.loadPlaces()
  },

  /**
   * 每次显示都读一次"当前路线"。
   *
   * ── 为什么必须是 onShow 而不是 onLoad（2026-10-14）──────────
   *
   * `onLoad` 只在页面**第一次**创建时跑。而地图是 tab 页：
   * 用户在行程页生成一条路线、再切到地图页时，页面实例早就存在了，
   * `onLoad` 不会再触发 —— 于是地图**永远不知道有一条路线**，
   * 但 `onLoad` 里设的默认中心点还留在那儿，结果就是
   * "路线看不见，视野还偏到别的地方去了"（用户报的原话）。
   *
   * 行程页每次生成/更新路线都会写 `zhiyou-active-trip`（同
   * `team-panel` 的 `zhiyou-active-crew` 那套约定），这里读回来即可。
   */
  onShow() {
    this.loadActiveTrip()
  },

  /**
   * 读回当前路线并画在地图上。
   *
   * ⚠️ 路线**必须重新取一次** `trip.get`，不能只靠 storage 里的坐标：
   * 调整（`trip.adjust`）会改节点的顺序与停留时长，storage 那份会过期。
   * storage 只用来回答"现在有没有路线、是哪一个"。
   *
   * 失败一律静默降级（路线画不出来不影响选集合点），但**要留下 note** ——
   * 静默失败正是这次这个 bug 的特征，不能再复制一遍。
   */
  loadActiveTrip() {
    const that = this
    let saved = null
    try {
      saved = wx.getStorageSync('zhiyou-active-trip') || null
    } catch (e) {
      saved = null
    }

    if (!saved || !saved.tripId) {
      // 没有路线时清掉上一次的残留，避免换成"上一条路线的线"
      if (this.data.route) this.setData({ route: null })
      this.refreshMarkers()
      return
    }

    api
      .callApi('trip.get', { tripId: saved.tripId })
      .then(function (res) {
        if (!res || res.ok !== true) {
          that.setData({ note: '当前路线读取失败：' + ((res && res.error && res.error.message) || '未知原因') })
          return
        }
        const trip = (res.data && res.data.trip) || null
        const nodes = (trip && trip.nodes) || []
        const points = nodes
          .filter(function (n) {
            return n.location && typeof n.location.latitude === 'number'
          })
          .map(function (n) {
            return { latitude: n.location.latitude, longitude: n.location.longitude }
          })

        if (points.length < 2) {
          that.setData({ route: null, note: '当前路线可定位的节点少于 2 个，无法在地图上连线' })
          that.refreshMarkers()
          return
        }

        that.setData({
          route: {
            tripId: saved.tripId,
            name: trip.title || '当前路线',
            points: points,
            nodeNames: nodes.map(function (n) {
              return n.placeName || n.name || n.placeId
            }),
          },
          note: '',
        })
        that.fitRoute()
        that.refreshMarkers()
      })
      .catch(function (err) {
        that.setData({ note: (err && err.errMsg) || '当前路线读取失败' })
      })
  },

  /**
   * 把视野落到整条路线上。
   *
   * 用 `includePoints` 而不是自己算中心点：它是地图组件自己实现的，
   * 会连缩放级别一起算好，比自己写一套经纬度包围盒可靠。
   *
   * ⚠️ 必须等**渲染完成**再调用 —— 地图组件此时才真正存在
   * （行程页的 `fitRouteMap` 踩过同一个坑，这里沿用同样的做法）。
   */
  fitRoute() {
    const points = (this.data.route && this.data.route.points) || []
    if (!points.length) return
    const that = this
    this.setData({}, function () {
      const ctx = wx.createMapContext('tripmap')
      if (ctx && typeof ctx.includePoints === 'function') {
        ctx.includePoints({
          points: points,
          padding: [60, 40, 60, 40],
          fail: function (err) {
            /**
             * 失败不阻断 —— 但要说出来。
             * `includePoints` 失败时地图会停在旧视野上，看起来就是"偏到别的地方去了"，
             * 而那正是用户在报的现象，所以不能再让它无声发生。
             */
            that.setData({ note: '视野缩放失败：' + ((err && err.errMsg) || '未知原因') })
          },
        })
      }
    })
  },

  onTeamState(e) {
    this.teamLocations = e.detail.locations || []
    this.teamMeeting = e.detail.meeting || null
    this.refreshMarkers()
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

  /**
   * 点击图钉 —— 选中那个地点。
   *
   * ── 为什么必须有它（2026-10-14）──────────────────────────
   *
   * 首版 `map` 上只绑了 `bindtap="onMapTap"`，**没有 `bindmarkertap`**，
   * 而 `onMapTap` 第一句是 `if (!this.data.pickMode) return`。
   * 结果：点图钉完全没反应 —— 既没提示、也没报错，就是"死的"。
   * 用户的第一反应是"坏了"，而其实只是没接这个事件。
   *
   * ── 为什么用显式映射而不是下标 ────────────────────────────
   *
   * marker 的 id 来自 `refreshMarkers()`，那里除了地点图钉还会 push
   * "我"(999)、队员(2000+)、团队集合点(3000)。用 `places` 的下标当 id
   * 本来是对的，但**一旦图钉集合与 places 的对应关系有任何变动就会静默错位**
   * ——点 A 选中 B，而且不报错。
   *
   * 所以 `refreshMarkers()` 同时产出 `markerPlaceIndex`（id → placeId），
   * 这里只做查表。错位在构造时就能看出来，而不是等用户点到错的地点。
   */
  onMarkerTap(e) {
    const markerId = e && e.detail ? e.detail.markerId : undefined
    if (markerId === undefined || markerId === null) return

    const placeId = (this.data.markerPlaceIndex || {})[markerId]
    // 不是地点图钉（我／队员／团队集合点）→ 安静返回，不抛错
    if (!placeId) return

    this.selectPlace(placeId)
  },

  /**
   * 选中一个地点作为集合点 —— **点图钉与点列表共用这一条路径**。
   *
   * 分开写两份的话，"点图钉"和"点列表项"迟早会在某个细节上不一致
   * （比如其中一处忘了清 `photoNote`），而那种不一致很难被发现。
   */
  selectPlace(placeId) {
    const place = this.data.places.find(function (p) {
      return p.placeId === placeId
    })
    if (!place) return false

    this.setData({ meetingPoint: place, photoNote: '' })
    this.refreshMarkers()
    return true
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
    this.selectPlace(e.currentTarget.dataset.placeid)
  },

  /**
   * 取该地点的照片（走 `place.fetchPhotos`）。
   *
   * **按需、单点**，不随列表批量取：高德是月配额（个人认证 5,000/月），
   * 而"顺手给每个候选都拉一张图"会让一次进页面就烧掉几次配额。
   *
   * 拿到 `cloud://` fileID 之后还要换一次临时 URL ——
   * marker 的 `iconPath` 与 `<image>` 需要的是本地路径或网络路径，
   * 直接喂 `cloud://` 在真机上不会显示（且**不报错**，只是空着）。
   */
  fetchPhotos() {
    const place = this.data.meetingPoint
    if (!place || this.data.photoBusy) return
    const that = this

    this.setData({ photoBusy: true, photoNote: '正在取照片…' })

    api
      .callApi('place.fetchPhotos', { placeId: place.placeId })
      .then(function (res) {
        if (!res || res.ok !== true) {
          that.setData({
            photoBusy: false,
            photoNote: (res && res.error && res.error.message) || '取照片失败',
          })
          return
        }
        const d = res.data || {}
        const photos = d.photos || []
        const verification = d.verification || null

        const patch = {}
        patch['photos.' + place.placeId] = { photos, verification, note: d.notice || '' }
        patch.photoNote = that.describePhotos(photos, d, verification)
        that.setData(patch)

        // 有 fileID 才需要换临时 URL；没有的话 marker 继续用本地图标
        const fileIDs = photos.map((p) => p.fileID).filter(Boolean)
        if (!fileIDs.length) {
          that.setData({ photoBusy: false })
          return
        }
        that.resolveTempUrls(place.placeId, fileIDs)
      })
      .catch(function (err) {
        that.setData({ photoBusy: false, photoNote: (err && err.errMsg) || '取照片失败' })
      })
  },

  /**
   * `cloud://` fileID → 临时 HTTPS 地址。
   *
   * 失败时**保留本地图标**而不是留一个空图钉：空图钉在真机上就是"什么都没有"，
   * 比一个普通图标更难理解。同时把原因写进 note —— 静默降级会让人以为
   * "这个地点本来就没有照片"。
   */
  resolveTempUrls(placeId, fileIDs) {
    const that = this
    wx.cloud.getTempFileURL({
      fileList: fileIDs,
      success(res) {
        const urls = {}
        ;((res && res.fileList) || []).forEach(function (f) {
          if (f && f.tempFileURL) urls[f.fileID] = f.tempFileURL
        })
        const patch = {}
        patch['photoUrls.' + placeId] = urls
        patch.photoBusy = false
        const okCount = Object.keys(urls).length
        patch.photoNote =
          okCount > 0
            ? that.describePhotos(((that.data.photos || {})[placeId] || {}).photos, {}, null)
            : '照片地址获取失败，图钉已退回普通图标'
        that.setData(patch)
        that.refreshMarkers()
      },
      fail() {
        that.setData({ photoBusy: false, photoNote: '照片地址获取失败，图钉已退回普通图标' })
        that.refreshMarkers()
      },
    })
  },

  /**
   * 把照片结果翻成一句人话。
   *
   * 刻意把**未核验**说出来：联网抓来的照片只提供辨识度辅助，
   * 不构成对可达性、入口位置等物理属性的核验（见 code 里 `place.survey` 的说明）。
   * 吞掉这句话，界面就会把网图当成"这个点确认过了"。
   */
  describePhotos(photos, data, verification) {
    if (!photos || !photos.length) {
      const why = (data && data.emptyReason) || (verification && verification.reason) || null
      const MAP = {
        PROVIDER_NOT_CONFIGURED: '尚未配置照片服务（云函数缺 AMAP_KEY）',
        UPSTREAM_FAILED: '照片服务暂时不可用',
        NO_POI_MATCHED: '上游没有匹配到这个地点',
        POI_HAS_NO_PHOTO: '上游这个地点没有照片',
        NO_PHOTOS: '没有取到照片',
      }
      return MAP[why] || '没有取到照片'
    }
    const persisted = photos.filter((p) => p.fileID).length
    if (!persisted) return '照片取到了，但保存到云存储失败，暂时无法显示'
    return (
      '已取到 ' +
      persisted +
      ' 张照片（来自网络，**未实地核验**）。它只用于辨认地点，不代表可达性或入口位置已确认。'
    )
  },

  refreshMarkers() {
    const markers = []
    const markerPlaceIndex = {}
    const meetingId = this.data.meetingPoint && this.data.meetingPoint.placeId

    this.data.places.forEach((p, i) => {
      const isMeeting = p.placeId === meetingId
      /** 点图钉时靠它反查地点；后 push 的"我"/队员/集合点不会进这张表 */
      markerPlaceIndex[i] = p.placeId
      /**
       * 图钉用照片还是内置图标。
       *
       * 只有**已取到照片的集合点**才换成照片 —— 两个理由：
       *   ① 高德是月配额，不可能给每个地点都取；
       *   ② 满屏照片图钉会盖住路网，反而看不清"集合点在哪儿"。
       * 照片是"确认这个点长什么样"用的，不是背景装饰。
       */
      const photoUrl = isMeeting ? (this.data.photoUrls || {})[p.placeId] : null
      const firstUrl = photoUrl ? Object.keys(photoUrl).map((k) => photoUrl[k])[0] : null

      markers.push({
        id: i,
        latitude: p.latitude,
        longitude: p.longitude,
        /**
         * ⚠️ 照片图钉必须**显式给 width/height**。
         * 网络图不写尺寸时，真机上的测量时机不确定，会出现忽大忽小或干脆不显示。
         * 即使用本地图标也一直显式写着（见下面那行），这里保持一致。
         */
        iconPath: firstUrl || (isMeeting ? '/assets/pin-meeting.png' : '/assets/pin-place.png'),
        width: firstUrl ? 48 : isMeeting ? 34 : 28,
        height: firstUrl ? 48 : isMeeting ? 42 : 35,
        callout: {
          content: p.name + (p.verified ? '' : '（未核验）') + (firstUrl ? ' · 网络照片，未实地核验' : ''),
          color: '#1F2933',
          fontSize: 12,
          borderRadius: 6,
          bgColor: '#FFFFFF',
          padding: 6,
          display: isMeeting ? 'ALWAYS' : 'BYCLICK',
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

    /**
     * 折线有两条，来源不同、含义不同，**都要画**：
     *
     *   ① 当前路线（`route.points`）—— 已经生成的那条行程，蓝色实线。
     *      ⚠️ 这是可以画直线的**占位**：真实步行路径要逐段调
     *      `trip.legRoute`（会消耗地图配额），等到演示需要时再按段取。
     *      用它先把"路线在哪儿"表达出来，比什么都不画强得多 ——
     *      用户报的 bug 正是"看不到生成的路线"。
     *   ② 我 → 所选集合点 —— 青色虚线，表示"我要往那儿走"。
     */
    const polyline = []

    const routePoints = (this.data.route && this.data.route.points) || []
    if (routePoints.length >= 2) {
      polyline.push({
        points: routePoints,
        color: '#0B3C6E',
        width: 5,
        arrowLine: true,
      })
    }

    if (this.data.myPoint && this.data.meetingPoint) {
      polyline.push({
        points: [
          this.data.myPoint,
          { latitude: this.data.meetingPoint.latitude, longitude: this.data.meetingPoint.longitude },
        ],
        color: '#0FA98A',
        width: 4,
        dottedLine: true,
        arrowLine: true,
      })
    }

    ;(this.teamLocations || []).forEach((m, i) => markers.push({
      id: 2000 + i, latitude: m.point.latitude, longitude: m.point.longitude,
      iconPath: '/assets/dot-me.png', width: 24, height: 24,
      callout: { content: '队员 ' + (i + 1) + (m.source === 'gps' ? ' · 定位' : ' · 手动'), display: 'BYCLICK' },
    }))
    if (this.teamMeeting) markers.push({ id: 3000, latitude: this.teamMeeting.point.latitude,
      longitude: this.teamMeeting.point.longitude, iconPath: '/assets/pin-meeting.png', width: 34, height: 42,
      callout: { content: this.teamMeeting.name, display: 'ALWAYS' } })
    this.setData({ markers, polyline, markerPlaceIndex })
  },
})

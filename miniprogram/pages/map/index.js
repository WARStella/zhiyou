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

/**
 * 单次最多取几段真实路径。
 *
 * 每段消耗 1 次地图配额。一条 6 站的路线有 5 段，一次进页面就是 5 次调用；
 * 有了按段缓存，切回地图页不会再花 —— 但首次仍要有上限，
 * 否则长途路线会一口气把月配额吃掉一大块。
 */
const MAX_LEGS = 6

/**
 * 精度超过这个值（米），基于该位置算出的步行时间就不可信了，界面要显眼提示。
 *
 * GB/T 官方对"室外定位"的说法是 10 米量级；500 米已经跨了好几个街区，
 * 而本项目用 `DETOUR_FACTOR` 把直线换算成步行距离、误差在这个量级上会放大。
 */
const MAX_TRUSTED_ACCURACY_M = 500

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
    /**
     * ⚠️ `myAccuracyM` 必须**在这里声明**（2026-10-14 修）。
     *
     * 它原先只在 `setData` 里被赋值，没进 `data`。模板里
     * `wx:if="{{myAccuracyM}}"` 读的是初始渲染那份 data —— 一直是 undefined，
     * 于是"精度约 X 米"从来没显示过。
     *
     * 而**精度是判断"这次定位能不能信"的唯一依据**：
     * 精度 30 米和精度 2000 米，界面上长得一模一样。
     * 少了它，用户只能说"定位不准"，而没法说清有多不准。
     */
    myAccuracyM: null,
    /**
     * 精度是否差到"算出来的步行时间不可信"（> `MAX_TRUSTED_ACCURACY_M`）。
     *
     * 刻意**在 JS 里算好再给模板**，而不是在 WXML 里写 `myAccuracyM > 500`：
     * 属性值里出现未转义的 `>` 是模板编译器的雷，而模板一旦编译不过
     * 就是**整页不渲染** —— 2026-10-14 已经因此白屏过一次（"我的位置"卡片整个没了）。
     */
    myAccuracyBad: false,
    /** 定位时刻（HH:MM:SS）—— 用来分辨"刚取的"还是"拿了一份旧的" */
    myLocatedAt: '',
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
    /**
     * 当前选中地点的照片列表 —— **在 JS 里算好，模板不做数组索引**。
     *
     * ⚠️ 模板原来写的是 `photos[meetingPoint.placeId].photos`。
     * 有 `wx:if` 守卫时能跑，但同一行里取两次、其中一次在守卫之外 ——
     * 以后有人改条件就很容易漏掉守卫。
     *
     * 这类错的后果很重：「我的」页就因为同样的写法
     * （`travelModeOptions[travelModeIndex].label`，而数组首帧为空）
     * 抛了 `Cannot read properties of undefined`，**整页白屏**。
     */
    currentPhotos: [],
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
    /**
     * 真实步行路径：`{ ['<起点nodeId>|<终点nodeId>']: { points, distanceMeters, durationMinutes, steps, decoded } }`。
     *
     * 来自 `trip.legRoute`（每次消耗 1 次地图配额），所以**按段缓存、不重复请求**。
     * 键用两个 nodeId 而不是序号：调整路线会改节点顺序，用序号会让缓存错位到别的段上。
     */
    legRoutes: {},
    legsLoading: false,
    legsNote: '',
    /** 本次已取回的段数 —— 界面要能说清"还有几段没画" */
    legsLoaded: 0,
    legsTotal: 0,
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
    /**
     * 默认不选中任何集合点 —— **选中必须是用户动作的结果**。
     *
     * 唯一例外是"已经存在一场进行中的集合"：那种情况下把它显示出来
     * 是用户要的信息，而不是我们替他做的选择（`onTeamState` 会把它填回来）。
     */
    if (!(this.teamMeeting && this.teamMeeting.name)) {
      this.setData({ meetingPoint: null, photoNote: '', currentPhotos: [] })
    }

    /**
     * 顺序是有意的：**先把我自己放上去，再读路线**。
     *
     * `loadActiveTrip()` 在没有定位可用时会退而把视野收到路线上
     * （见 `recenterOnMe` 的分工说明）。反过来先读路线的话，
     * 定位回调回来再挪镜头，用户会看到地图先跳到路线、再跳回自己身上。
     */
    this.autoLocate()
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
            /**
             * 逐段取真实路径要用**节点本身**（nodeId + 坐标），
             * 而 `points` 只是可定位节点的坐标、丢掉了 nodeId。
             * 两者都留着：`points` 给"把整条路线收进视野"用，`nodes` 给逐段取路径用。
             */
            nodes: nodes
              .filter(function (n) {
                return n.location && typeof n.location.latitude === 'number'
              })
              .map(function (n) {
                return { nodeId: n.nodeId, placeName: n.placeName || n.name, location: n.location }
              }),
            nodeNames: nodes.map(function (n) {
              return n.placeName || n.name || n.placeId
            }),
          },
          note: '',
        })
        /**
         * 镜头优先跟人。`recenterOnMe()` 返回 false 表示地图上下文不可用
         * （基础库过低等），此时退而把整条路线收进视野 ——
         * 总比停在一个与用户无关的默认点上强。
         */
        if (!that.recenterOnMe()) that.fitRoute()
        that.refreshMarkers()
        /** 路线画出来之后再去取真实步行路径（那是逐段的、要花配额，慢一点没关系） */
        that.loadLegRoutes()
      })
      .catch(function (err) {
        that.setData({ note: (err && err.errMsg) || '当前路线读取失败' })
      })
  },

  /**
   * 取回各段的**真实步行路径**（沿街道的那种，不是两点直连）。
   *
   * ── 为什么必须做这件事（2026-10-14）──────────────────────
   *
   * 用户报："路径规划功能好像没做。"——服务端其实**全做好了**
   * （`trip.legRoute` 返回解码后的折线 + 上游原话的转向指引），
   * 缺的只是地图页从没调它，画的是一条节点直连的占位线。
   *
   * 而那条占位线正好违反项目自己定下的纪律，行程页的注释写得很清楚：
   *
   *   「`decoded: false` 时**什么都不画**，并如实说明 ——
   *     宁可没有线，也不能拿示意图冒充真实路线。」
   *
   * 所以这里改成逐段取真实路径；取不到的那一段不画。
   *
   * ── 配额纪律 ──────────────────────────────────────────────
   *
   * 每段消耗 1 次地图配额，所以：
   *   · 结果**按段缓存**（键是起终点 nodeId），切回地图页不重复请求；
   *   · 段数超过 `MAX_LEGS` 时**只取前若干段并如实说明**，不闷头烧配额。
   */
  loadLegRoutes() {
    const that = this
    const route = this.data.route
    if (!route || !route.tripId) return

    const nodes = route.nodes || []
    if (nodes.length < 2) return

    /** 待取的所有段（相邻两节点之间） */
    const pending = []
    for (let i = 1; i < nodes.length; i++) {
      const key = nodes[i - 1].nodeId + '|' + nodes[i].nodeId
      if (!this.data.legRoutes[key]) pending.push({ key: key, from: nodes[i - 1], to: nodes[i], index: i })
    }

    if (!pending.length) return // 全部命中缓存

    const todo = pending.slice(0, MAX_LEGS)
    const skipped = pending.length - todo.length

    this.setData({
      legsLoading: true,
      legsTotal: nodes.length - 1,
      legsNote: skipped > 0 ? `本次只取前 ${MAX_LEGS} 段真实路径（每段消耗 1 次地图配额）` : '',
    })

    /**
     * **串行**取，不并发：地图接口有 QPS 限制，而且串行能让第一段先画出来
     * ——用户最想看的就是脚下这一段。
     */
    let chain = Promise.resolve()
    todo.forEach(function (leg) {
      chain = chain.then(function () {
        return api
          .callApi('trip.legRoute', {
            tripId: route.tripId,
            nodeId: leg.to.nodeId,
            fromPoint: leg.from.location,
          })
          .then(function (res) {
            const patch = {}
            if (res && res.ok === true && res.data && res.data.ok !== false) {
              const d = res.data
              const decoded = Boolean(d.route && d.route.decoded)
              patch['legRoutes.' + leg.key] = {
                points: (d.route && d.route.points) || [],
                decoded: decoded,
                distanceMeters: d.distanceMeters,
                durationMinutes: d.durationMinutes,
                steps: (d.route && d.route.steps) || [],
              }
            } else {
              /**
               * 取不到就**记下失败**，不画线。
               * 记下来是为了"不再重复请求同一段" —— 否则每次切回地图页
               * 都会对同一个失败段再烧一次配额，而且用户看不出区别。
               */
              patch['legRoutes.' + leg.key] = {
                points: [],
                decoded: false,
                failed: true,
                reason: (res && res.data && res.data.reason) || (res && res.error && res.error.code) || 'UNKNOWN',
                message:
                  (res && res.data && res.data.message) || (res && res.error && res.error.message) || '取路径失败',
              }
            }
            patch.legsLoaded = that.data.legsLoaded + 1
            that.setData(patch)
            that.refreshMarkers()
          })
      })
    })

    chain
      .then(function () {
        that.setData({ legsLoading: false })
        that.refreshMarkers()
      })
      .catch(function (err) {
        that.setData({ legsLoading: false, legsNote: (err && err.errMsg) || '取路径失败' })
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

  /**
   * 把镜头回到"我"身上。
   *
   * ── 与 `fitRoute` 的分工（2026-10-14 用户要求）────────────
   *
   * 用户说："应该默认镜头是自己的当前位置啊。" 这是对的 ——
   * **"我在哪"是每一刻都要用的信息，路线一眼看全就够了。**
   *
   * 所以两者不并列，而是有优先级：
   *   · 定位可用        → 镜头跟我（`moveToLocation`）；
   *   · 定位不可用但有路线 → 退而求其次，镜头收到路线上（`fitRoute`）。
   *
   * 刻意**不**用 `includePoints([我, ...路线])` 把两者一起框进去：
   * 人在离路线很远处时，这个盒子会大到什么都看不清 ——
   * 那等于两个都没照顾到。空间关系用蓝色折线自己表达就够了。
   *
   * `moveToLocation` 不动缩放级别，所以不会把用户刚调好的比例尺冲掉；
   * 这也是它比 `includePoints` 更适合"回到我"的原因。
   */
  recenterOnMe() {
    const that = this
    const ctx = wx.createMapContext('tripmap')
    if (!ctx || typeof ctx.moveToLocation !== 'function') return false
    ctx.moveToLocation({
      fail(err) {
        that.setData({ note: '镜头回到我的位置失败：' + ((err && err.errMsg) || '未知原因') })
      },
    })
    return true
  },

  /**
   * 打开地图时静默取一次当前位置。
   *
   * ── 为什么用 `getSetting` 先探一下权限（2026-10-14）────────
   *
   * 直接调 `wx.getLocation` 在**未授权**时会弹权限框。而地图是个 tab ——
   * 用户每次点进来都弹一次，那是骚扰，不是功能。
   *
   * 所以先问 `getSetting`：只有**已经授权过**才取位置；没授权就什么都不做，
   * 把主动权留给用户点「获取我的位置」那一下。
   */
  autoLocate() {
    const that = this
    wx.getSetting({
      success(setting) {
        if (!setting || !setting.authSetting || !setting.authSetting['scope.userLocation']) return
        wx.getLocation({
          type: 'gcj02',
          success(res) {
            that.setData({
              myPoint: { latitude: res.latitude, longitude: res.longitude },
              mySource: 'gps',
              myAccuracyM: res.accuracy,
              myAccuracyBad: typeof res.accuracy === 'number' && res.accuracy > MAX_TRUSTED_ACCURACY_M,
              myLocatedAt: new Date().toLocaleTimeString(),
            })
            that.refreshMarkers()
            /**
             * ⚠️ 这里**刻意不调 `recenterOnMe()`**（2026-10-14）。
             *
             * `onShow` 里紧接着会跑 `loadActiveTrip()`，它结尾也会重定位一次。
             * 两处都调会让镜头动两下 —— 用户看到的是地图先跳一下、再跳一下。
             *
             * 而"用户主动点「获取我的位置」"那条路径（`useGps`）**必须**调：
             * 那时用户明确要位置，镜头就该立刻落过去。
             */
          },
          /**
           * 失败**不写 note**：这是页面自动触发的，用户没提要求。
           * 写提示只会让一个正常打开的页面看起来像出了问题。
           * 真正需要提示的是用户主动点「获取我的位置」的那条路径（`useGps`）。
           */
          fail() {},
        })
      },
      fail() {},
    })
  },

  onTeamState(e) {
    this.teamLocations = e.detail.locations || []
    this.teamMeeting = e.detail.meeting || null
    this.syncMeetingSelection()
    this.refreshMarkers()
  },

  /**
   * 把"进行中的集合"反映到选中状态上 —— 但**不覆盖用户自己的选择**。
   *
   * 两条纪律：
   *   ① 只在"还没有选中"时替用户填上。用户点过的地方优先，
   *      否则他点开一个地点的照片、一刷新就被会议地点顶掉。
   *   ② 只在**真的变了**的时候写 —— 否则 `onTeamState → setData → render`
   *      会绕成一个环。
   */
  syncMeetingSelection() {
    const meeting = this.teamMeeting
    const meetingName = meeting && meeting.name
    if (!meetingName || this.data.meetingPoint) return
    if (this.__autoPickedMeetingName === meetingName) return
    this.__autoPickedMeetingName = meetingName

    const that = this
    const matched = this.data.places.find(function (p) {
      return p.name === meetingName
    })
    if (matched) {
      this.selectPlace(matched.placeId)
      return
    }
    /**
     * 集合点可能**不在 places 库里**（手动选点时坐标由用户在地图上点出来，
     * 并不对应任何一条地点记录）。这种情况也要能在地图上标出来，
     * 否则"我们约在哪儿"这件事就看不见了。
     */
    this.setData({
      meetingPoint: {
        placeId: '__team_meeting__',
        name: meetingName,
        latitude: meeting.point.latitude,
        longitude: meeting.point.longitude,
        verified: true,
        fromTeamTask: true,
      },
    })
    that.refreshMarkers()
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
          myAccuracyBad: typeof res.accuracy === 'number' && res.accuracy > MAX_TRUSTED_ACCURACY_M,
          myLocatedAt: new Date().toLocaleTimeString(),
          pickMode: false,
          note: '已通过定位接口获取位置（位置来源：定位接口）',
        })
        that.refreshMarkers()
        that.computeNearby()
        /** 用户刚给了位置，镜头就该落到他身上 —— 否则还得自己拖地图去找 */
        that.recenterOnMe()
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

    this.setData({ meetingPoint: place, photoNote: '', currentPhotos: this.photosOf(place) })
    this.refreshMarkers()
    return true
  },

  /**
   * 取消选中 —— 让地图回到"只显示地点、不显示集合点"的默认样子。
   *
   * 没有这个出口的话，用户点错一个地点就再也退不回默认视图了，
   * 而且会以为"地图上本来就有一个集合点"。
   */
  clearMeeting() {
    this.setData({ meetingPoint: null, photoNote: '', currentPhotos: [] })
    this.refreshMarkers()
  },

  /**
   * 取某个地点已保存的照片列表（模板不做数组索引，见 `currentPhotos` 的说明）。
   *
   * 取不到时一律回空数组 —— 让模板拿到一个**能安全 `.length`** 的值，
   * 而不是 undefined。
   */
  photosOf(place) {
    const id = place && place.placeId
    if (!id) return []
    const rec = (this.data.photos || {})[id]
    return (rec && Array.isArray(rec.photos)) ? rec.photos : []
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
        /**
         * ⚠️ 刚取回的照片要立刻反映到 `currentPhotos`。
         *
         * `currentPhotos` 是"算好给模板用的"（模板不做数组索引），
         * 所以每次照片变化都必须重算 —— 漏了的话照片取回来了、
         * 界面上却什么都不显示，而且不报错。
         */
        if (that.data.meetingPoint && that.data.meetingPoint.placeId === place.placeId) {
          patch.currentPhotos = photos
        }
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

    /**
     * 集合点**不在 places 库里**时，上面的循环画不到它。
     *
     * 这不是边角情况：`team-panel` 手动选点时，坐标是用户在地图上点出来的，
     * 不对应任何一条地点记录；而"进行中的集合"也常常是那种点。
     * 少了这一段，地图上就**看不到"我们约在哪儿"** ——
     * 而集合页最该回答的就是这个问题。
     */
    const mp = this.data.meetingPoint
    const meetingInLibrary =
      mp &&
      this.data.places.some(function (p) {
        return p.placeId === mp.placeId
      })
    if (mp && !meetingInLibrary) {
      const photoUrl = (this.data.photoUrls || {})[mp.placeId] || {}
      const firstUrl = Object.keys(photoUrl).map(function (k) {
        return photoUrl[k]
      })[0]
      markers.push({
        id: 3000,
        latitude: mp.latitude,
        longitude: mp.longitude,
        iconPath: firstUrl || '/assets/pin-meeting.png',
        width: firstUrl ? 48 : 34,
        height: firstUrl ? 48 : 42,
        callout: {
          content: mp.name + (mp.fromTeamTask ? ' · 队里定的集合点' : ''),
          color: '#1F2933',
          fontSize: 12,
          borderRadius: 6,
          bgColor: '#FFFFFF',
          padding: 6,
          display: 'ALWAYS',
        },
      })
    }

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
     * 折线只画**真实步行路径**，不画两点直连。
     *
     * ── 为什么不留占位线（2026-10-14）────────────────────────
     *
     * 第一版画的是"节点直连"的蓝线，本意是先把"路线在哪儿"表达出来。
     * 但那条线正是**项目自己明确拒绝过的东西** —— 行程页的注释：
     *
     *   「`decoded: false` 时什么都不画，并如实说明 ——
     *     宁可没有线，也不能拿示意图冒充真实路线。」
     *
     * 理由很实在：两点直连在城市里会横穿街区与建筑，
     * 用户照着走会走进死路或围墙。**一条会把人带错的线，比没有线更糟。**
     *
     * 所以现在：有真实路径就画，没有就不画，并把"还差几段"说清楚。
     */
    const polyline = []
    const legRoutes = this.data.legRoutes || {}
    const legNodes = (this.data.route && this.data.route.nodes) || []

    for (let i = 1; i < legNodes.length; i++) {
      const leg = legRoutes[legNodes[i - 1].nodeId + '|' + legNodes[i].nodeId]
      if (!leg || !leg.decoded || !leg.points || leg.points.length < 2) continue
      polyline.push({
        points: leg.points,
        color: '#0B3C6E',
        width: 6,
        arrowLine: true,
        borderColor: '#FFFFFF',
        borderWidth: 2,
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
    /**
     * ⚠️ 这里**不再**单独为 `teamMeeting` 画一个图钉（2026-10-14 去掉）。
     *
     * 原因：进行中的集合现在会通过 `syncMeetingSelection()` 变成
     * `meetingPoint`，再由上面那段画出"选中"的针。
     * 两处都画会在同一坐标上叠两个针 —— 看起来像一个画重了的 bug，
     * 而且下面的针永远点不到。
     */
    this.setData({ markers, polyline, markerPlaceIndex })
  },
})

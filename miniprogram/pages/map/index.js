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
 *    位置来源因此是 `manual`，与 docs/项目计划书.md#data-model §0 决定 3 的设计一致：
 *    **集合推荐算法不感知来源**，所以拿到 GPS 后只需换一个入口，算法与数据结构都不用改。
 *
 * 2. **卡片放在地图下方，不叠在地图上。**
 *    计划书附录 B 第 15 条待复核："小程序原生 map 为原生组件、层级最高，cover-view 限制多"。
 *    用普通流水布局直接绕开这个限制，**不需要验证 cover-view**。
 */

const api = require('../../utils/api')
const { isValidPoint } = require('../../utils/coordinates')
const { layoutMarkerLabels } = require('../../utils/map-marker-labels')
const { createMemberLabels } = require('../../utils/member-labels')
const { POLICY_VERSION } = require('../../utils/location-consent')
const { createMapChatPreview } = require('../../utils/map-chat-preview')
const { createMapChatCallouts } = require('../../utils/map-chat-callouts')
const currentClock = () => {
  const now = new Date()
  return String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
}

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
    memberChatCallouts: [],
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
    /**
     * 聚焦到的景点（2026-10-14 用户要求：行程页点「到了」跳到地图并放大）。
     *
     * ⚠️ 要在初始 data 里声明。只在 setData 时赋值的话，
     * 模板首帧读 `undefined.placeName` 会抛异常并**把整页打白** ——
     * 「我的」页刚因为同一类问题白过一次。
     */
    focusPlace: null,
    nearby: [],

    /**
     * ══════════ 队伍（2026-10-14 用户重新划分职责）══════════════
     *
     * 用户原话："我的的小队面板只管组队和解散小队，你说的推荐一个集合点
     *           也在地图界面，并且把地图界面的名字改为队伍"
     *
     * 所以职责分成两块：
     *   「我的」的小队面板 —— **只管组队与解散**（建队、邀请码、加入、退出）
     *   「队伍」（本页）   —— **组队之后的一切**：队员位置、集合、出发
     *
     * 这条界线比原来清楚：面板在「我的」里，而集合是"看着地图商量去哪碰头"
     * 的事 —— 放在没有地图的页面上本来就别扭。
     */
    crewId: '',
    chatPreview: [],
    chatPreviewReady: false,
    chatPreviewAvailable: true,
    chatPreviewNote: '',
    /**
     * 订阅提醒（2026-10-17）：
     *   · `notifyRows` 三类提醒的当前状态，`templateId` 来自服务端（不在这里写死）；
     *   · `notifyNote` 只用来说明"点了之后发生了什么"，不当作发送成功的证据；
     *   · `notifyBusy` 防止用户连点导致重复上报。
     */
    notifyPanelOpen: false,
    notifyRows: [],
    /** 刚才那次点击的结果（点击后才有值） */
    notifyNote: '',
    noticeLandingNote: '',
    notifyLoading: false,
    notifyLoadError: '',
    notifySettingsNeeded: false,
    /** 服务端关于"已同意 ≠ 一定送达"的说明（面板常显） */
    notifyPolicyNote: '',
    /** 从通知落地但目标队伍已不可访问 —— 界面据此给一个明确的返回入口 */
    notifyLandingFailed: false,
    notifyBusy: false,
    crew: null,
    /** 是不是发起人 —— 决定能不能发起/取消集合 */
    isOwner: false,
    members: [],
    /** 进行中的集合任务（`meet.get` 的结果） */
    meetTask: null,
    /** 我有没有开启位置共享 */
    sharing: false,
    isInitiator: false,
    /** 集合时间输入（HH:MM） */
    meetTime: currentClock(),
    /** 集合点名称 */
    pointName: '',
    /** 出发检查结果（`meet.prepareDepart`） */
    departureCheck: null,
    /** 本页自己的操作提示与错误 —— 不复用 team-panel 的 */
    teamNote: '',
    teamError: '',
    locationError: '',
    coordinateError: '',
    autoLocationError: '',
    teamTripId: null,
    teamBusy: false,
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
     * ⚠️ 路线相关的 state 已全部删除（2026-10-14 用户要求：
     * "队伍页面地图上显示的路线也删了"）。
     *
     * 删掉的：`route` / `legRoutes` / `legsLoading` / `legsNote` /
     * `legsLoaded` / `legsTotal` / `markerPlaceIndex`，
     * 以及配套的 `loadActiveTrip` / `loadLegRoutes` / `fitRoute` / `onMarkerTap`。
     *
     * 路线在**行程页**看（那里有地图卡、目的地图钉与逐段真实路径）。
     * 本页是「队伍」：只看人 —— 我的位置、集合点、队员。
     */
    photoBusy: false,
    photoNote: '',
    loading: true,
    loadError: '',
    note: '',
  },

  onLoad(query) {
    this.noticeLoadQuery = query && query.crewId ? query : null
    // 用于确认开发者工具确实运行了本次修复；定位图钉统一由 refreshMarkers 绘制。
    console.info('[team-map:coordinate-guard-v2] 已关闭组件内置定位图钉')
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
  onShow(options) {
    this.chatPreviewVisible = true
    /**
     * 从订阅通知点进来时，`options.query` 里带着落地参数（`crewId`、`meetId`）。
     * 页面 `onShow` 拿不到时（冷启动路径不同），读 `app` 写入的 storage 兜底；
     * 两者都只用定位线索，正文由落地后鉴权通过的接口重新取。
     */
    const landing = this.readNoticeLanding() || (options && options.query) || this.noticeLoadQuery
    this.noticeLoadQuery = null
    const landed = this.applyNoticeLanding(landing)
    this.startChatPreview(this.readCrewId())
    if (!this.meetTimeEdited) this.setData({ meetTime: currentClock() })
    const sharingService = this.sharingService()
    /**
     * 默认不选中任何集合点 —— **选中必须是用户动作的结果**。
     *
     * 唯一例外是"已经存在一场进行中的集合"：那种情况下把它显示出来
     * 是用户要的信息，而不是我们替他做的选择。
     *
     * ⚠️ 判断依据从 `teamMeeting`（面板事件）改成 `meetTask`（自己取的）——
     * 见 `syncMeetingSelection` 的说明。用旧字段的话这里会恒为假，
     * 于是每次进页面都把进行中的集合点**清掉**。
     */
    const activeMeeting = this.data.meetTask
    if (!(activeMeeting && (activeMeeting.placeName || activeMeeting.name))) {
      this.setData({ meetingPoint: null, photoNote: '', currentPhotos: [] })
    }

    /**
     * 顺序是有意的：**先处理"要聚焦的景点"，再走默认逻辑**。
     *
     * 聚焦是用户刚在行程页明确表达的动作（点「到了」或点站名），
     * 它必须**赢过**"回到我的位置"这个默认行为 ——
     * 否则用户点了「到了」，跳过来看到的却是自己脚下，会以为没生效。
     *
     * `applyPendingFocus()` 返回 true 表示这次确实有聚焦请求，
     * 那就**跳过 autoLocate 与 fitRoute**（它们都会抢镜头）。
     */
    const focused = this.applyPendingFocus()
    /**
     * 推荐的集合点（2026-10-14 用户要求："点击集合后**先自动生成集合点**，
     * 然后再用这个装置能拖动选点"）。
     *
     * ⚠️ 与聚焦**分开处理**：聚焦是"看某个景点"，这是"把集合点定在某个位置"。
     *    两者语义不同，混在一起以后改一处会碰到另一处。
     */
    this.applyMeetSuggestion()
    /**
     * 读一次队伍状态（2026-10-14 职责重划后）。
     *
     * ⚠️ **不再依赖 team-panel 的事件** —— 本页自己取成员、集合任务与共享开关。
     *    原来队员位置与集合点是面板抛上来的，于是"面板必须在场"成了一条
     *    隐式依赖：谁把面板从本页挪走，地图上的队员就消失了（还真发生过）。
     */
    const guideCrewRequest = landed ? this.noticeLandingLoad : this.loadCrew()
    if (guideCrewRequest) guideCrewRequest.then(() => { if (this.chatPreviewVisible && !this.data.teamError) this.applyGuideMeeting() })
    /**
     * 队员位置也要自己拉一次 —— 它原来来自面板的 `teamstate` 事件，
     * 而面板已从本页删掉（2026-10-14）。
     *
     * ⚠️ 漏了这一步地图上就**看不到同伴**，而且**不报错**：
     *    `teamLocations` 恒为空数组，`refreshMarkers` 少画几个图钉而已。
     *    这类"少画了东西但不报错"的错最难发现。
     */
    this.refreshTeamLocations()
    this.stopTeamRefresh()
    this.teamRefreshTimer = setInterval(() => {
      this.loadCrew()
      this.refreshTeamLocations()
    }, 15000)
    if (this.teamRefreshTimer.unref) this.teamRefreshTimer.unref()
    // 队伍页显示"提醒是否已开启"，只在面板打开时拉（默认不打扰）。
    if (this.data.notifyPanelOpen) this.loadNotifyStatus()
    if (!focused && !sharingService) {
      /**
       * ⚠️ 这里原来还会调 `loadActiveTrip()` 读回路线并画在地图上，
       * 以及 `refreshTeamLocations()` 之外的路线相关逻辑 —— 都已删除
       * （2026-10-14 用户要求："队伍页面地图上显示的路线也删了"）。
       *
       * 本页现在**完全不读路线**，只看人：我的位置、集合点、队员。
       * 路线在行程页看。
       */
      this.autoLocate()
    }
    if (sharingService) return this.watchAutomaticLocation(sharingService, !focused)
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
    const point = this.data.myPoint
    if (!isValidPoint(point)) return false
    const that = this
    // 不让组件自行重新定位：镜头与“我的位置”图钉必须使用同一份已校验坐标。
    this.setData({ center: { latitude: point.latitude, longitude: point.longitude } })
    const ctx = wx.createMapContext('tripmap', this)
    if (!ctx || typeof ctx.moveToLocation !== 'function') return false
    ctx.moveToLocation({
      latitude: point.latitude,
      longitude: point.longitude,
      fail(err) {
        that.setData({ note: '镜头回到我的位置失败：' + ((err && err.errMsg) || '未知原因') })
      },
    })
    return true
  },

  /**
   * ── 聚焦到某个景点（2026-10-14 用户要求）──────────────────
   *
   * 用户在行程页点「到了」或点站名 → 跳到这里并放大到那一站。
   *
   * ── 为什么走 storage 而不是 URL 参数 ──────────────────────
   *
   * 地图是 **tab 页**，`wx.switchTab` **不支持 URL 参数** ——
   * 传了会被静默忽略。所以按项目里的既有约定
   * （`zhiyou-active-trip` / `zhiyou-active-crew`）走 storage。
   *
   * ⚠️ **读完立刻清掉**。不清的话：
   *   · 用户下次自己切到地图页，镜头又飞到那个景点上，而他没要求；
   *   · 那时行程可能已经变了，这个"聚焦"是过期的。
   *   与 `rememberActiveTrip` 的"只存是哪一个、不存内容"同一条纪律。
   *
   * @returns {boolean} 是否成功聚焦（供 `onShow` 决定要不要抢镜头）
   */
  applyPendingFocus() {
    let focus = null
    try {
      focus = wx.getStorageSync('zhiyou-focus-place') || null
      /** 不管后续成不成功，**先清掉** —— 见上面的说明 */
      if (focus) wx.removeStorageSync('zhiyou-focus-place')
    } catch (e) {
      return false
    }
    if (!isValidPoint(focus)) {
      return false
    }

    /**
     * ⚠️ 过期判断：超过 2 分钟的聚焦请求不再执行。
     *
     * 为什么需要：storage 是持久的，若某次写完就再没打开过地图页
     * （比如用户跳转失败），这个值会一直躺着 —— 几天后他切到地图页，
     * 镜头突然飞到一个早就去过的景点。那是"过期的数据比没有更糟"。
     */
    if (focus.at && Date.now() - focus.at > 2 * 60 * 1000) return false

    const scale = typeof focus.scale === 'number' ? focus.scale : 16
    this.setData({
      focusPlace: {
        placeName: focus.placeName || '这一站',
        latitude: focus.latitude,
        longitude: focus.longitude,
        scale: scale,
      },
      /**
       * 地图是**受控组件**：`center` 与 `scale` 是它的属性
       * （见 wxml 里的 `longitude="{{center.longitude}}"`）。
       * 改这两个值镜头就会移过去 —— 不需要再调 MapContext。
       */
      center: { latitude: focus.latitude, longitude: focus.longitude },
      scale: scale,
    })
    return true
  },

  /** 关掉聚焦提示条（不改变镜头位置） */
  clearFocusPlace() {
    this.setData({ focusPlace: null })
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
            if (!isValidPoint(res)) {
              that.setData({ note: '定位返回的坐标异常，请重新定位' })
              return
            }
            that.setData({
              myPoint: { latitude: res.latitude, longitude: res.longitude },
              mySource: 'gps',
              myAccuracyM: res.accuracy,
              myAccuracyBad: typeof res.accuracy === 'number' && res.accuracy > MAX_TRUSTED_ACCURACY_M,
              myLocatedAt: new Date().toLocaleTimeString(),
            })
            that.refreshMarkers()
            /**
             * ⚠️⚠️ **现在必须在这里调 `recenterOnMe()`**（2026-10-14）。
             *
             * 原来这里刻意不调，理由是"`onShow` 紧接着会跑 `loadActiveTrip()`，
             * 它结尾也会重定位一次，两处都调会让镜头跳两下"。
             *
             * 而路线已从本页删除（用户要求："队伍页面地图上显示的路线也删了"），
             * `loadActiveTrip` 随之删掉 —— **那个"后面会重定位"的承诺没有了**，
             * 于是自动定位之后镜头根本不动。
             *
             * 这个回归是测试抓出来的（两条"镜头必须回到我"同时失败）。
             * 教训：**"别处会做这件事"是一句会失效的注释** ——
             * 删除那一处的人不会记得回来改这里。
             */
            that.recenterOnMe()
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

  /**
   * ══════════ 队伍：组队之后的一切（2026-10-14）══════════════
   *
   * 用户把职责重新划过：
   *   「我的」的小队面板 —— 管组队与解散（建队、邀请码、加入、退出）
   *   「队伍」（本页）   —— 管组队之后的事（位置、集合、出发）
   *
   * ⚠️ 本页**不再挂 `team-panel` 组件**（2026-10-14 用户要求：
   *    "在地图页面删掉与同伴一起游览信息卡"）。
   *    于是原来从它的事件里来的 `teamLocations` / `teamMeeting` 都失去了来源：
   *      · `teamLocations` → 改由 `refreshTeamLocations()` 调 `loc.list` 填
   *      · `teamMeeting`   → 改读 `meetTask`（`loadCrew()` 调 `meet.get` 填）
   *    两个都改完了，本页才真正**不依赖面板的存在**。
   */

  /** 页面隐藏后停止轮询。 */
  stopTeamRefresh() {
    if (this.teamRefreshTimer) clearInterval(this.teamRefreshTimer)
    this.teamRefreshTimer = null
  },

  holdChatTap() {}, // 气泡只展示消息，不跳页，也不触发地图选点。

  startChatPreview(crewId) {
    if (!this.chatPreviewVisible) return
    if (this.chatCalloutCrewId !== crewId) {
      if (this.chatCallouts) this.chatCallouts.clear()
      this.chatCalloutCrewId = crewId
    }
    if (!this.chatCallouts) this.chatCallouts = createMapChatCallouts({ onChange: () => this.refreshMarkers() })
    if (!this.mapChat) this.mapChat = createMapChatPreview({ wx,
      callApi: api.callApi, getCrewId: () => this.readCrewId(),
      onMessages: (messages, serverTime) => this.showMemberChatMessages(messages, serverTime),
      onState: patch => {
        this.setData(patch)
        if (patch.chatPreviewAvailable === false && this.chatCallouts) this.chatCallouts.clear()
        /**
         * 消息**真的显示出来之后**才推进本人已读游标。
         *
         * `chatPreviewLatestSeq` 由 preview 在"已渲染这一批"时给出；
         * 页面前台可见才算看到（隐藏时 `chatPreviewVisible` 为 false，
         * preview 也已停止，不会走到这里）。
         */
        if (this.chatPreviewVisible && patch.chatPreviewLatestSeq) {
          this.markChatRead(patch.chatPreviewLatestSeq)
        }
      } })
    return this.mapChat.start(crewId)
  },
  showMemberChatMessages(messages, serverTime) {
    if (this.chatPreviewVisible && this.chatCallouts && this.data.crewId === this.readCrewId()) {
      this.chatCallouts.receive(messages, serverTime)
    }
  },
  stopChatPreview() {
    this.chatPreviewVisible = false
    this.markerAvatarGeneration = (this.markerAvatarGeneration || 0) + 1
    if (this.mapChat) this.mapChat.stop()
    if (this.chatCallouts) this.chatCallouts.clear()
    this.chatCalloutCrewId = ''
  },
  chatAvatarError(e) {
    if (this.mapChat) this.mapChat.imageError(e.currentTarget.dataset.messageId)
  },
  onMapChatSent(e) {
    if (e && e.detail && e.detail.message) this.showMemberChatMessages([e.detail.message], e.detail.serverTime)
    if (this.chatPreviewVisible && this.mapChat) return this.mapChat.refresh()
  },
  onMapChatDenied() {
    if (this.mapChat) this.mapChat.stop()
    if (this.chatCallouts) this.chatCallouts.clear()
    this.setData({ chatPreviewAvailable: false })
  },

  onHide() { this.stopTeamRefresh(); this.stopWatchingAutomaticLocation(); this.stopChatPreview() },
  onUnload() { this.stopTeamRefresh(); this.stopWatchingAutomaticLocation(); this.stopChatPreview() },

  sharingService() {
    const app = getApp()
    return app && typeof app.getLocationSharing === 'function' ? app.getLocationSharing() : null
  },

  watchAutomaticLocation(service, recenter) {
    this.stopWatchingAutomaticLocation()
    this.lastSharedSampleAt = null
    this.unsubscribeSharing = service.subscribe(state => {
      if (state.crewId !== this.readCrewId()) return
      this.setData({ sharing: state.sharing, autoLocationError: state.error })
      if (!state.active || !isValidPoint(state.point) || state.sampledAt === this.lastSharedSampleAt) return
      this.lastSharedSampleAt = state.sampledAt
      this.setData({ myPoint: state.point, mySource: 'gps', myAccuracyM: state.accuracyM })
      if (recenter) { this.setData({ center: state.point }); recenter = false }
      this.refreshMarkers()
    })
    // 每次进入队伍立即定位/上传；共享关闭时 refresh 不会开启或上报。
    return service.refresh().then(() => {
      if (this.unsubscribeSharing) return this.refreshTeamLocations()
    })
  },

  stopWatchingAutomaticLocation() {
    if (this.unsubscribeSharing) this.unsubscribeSharing()
    this.unsubscribeSharing = null
  },

  async refreshSharedLocation() {
    const service = this.sharingService()
    if (!service) return
    const state = await service.refresh()
    // 手动更新时同时重读已公布的集合，集合点不依赖本机共享位置是否开启。
    await this.loadCrew()
    if (!state.sharing) {
      this.setData({ autoLocationError: '请先在「我的 → 设置」开启自动共享位置' })
      return
    }
    await this.refreshTeamLocations()
  },

  openSharingSettings() { wx.switchTab({ url: '/pages/profile/index' }) },

  /** 去「我的」页处理队伍（订阅提醒落地失败时给用户的返回入口）。 */
  openTeamSettings() { wx.switchTab({ url: '/pages/profile/index' }) },

  /**
   * ══════════ 订阅提醒（2026-10-17）══════════════════════
   *
   * 为什么入口放在这里而不是「我的」：
   * 提醒的对象是**这支队伍**的集合与消息，用户在「队伍」页看到界面上下文
   * 才明白"订阅的是谁的提醒"。入队时不弹窗、不静默替用户勾选 ——
   * 微信的一次性订阅必须由用户主动点，否则属于违规获取授权。
   *
   * 模板 ID **不在这里写死**：从 `subscribe.status` 拿，避免前后端各存一份
   * 常量后漂移（漂移的表现是订阅"点了没反应"）。
   */
  loadNotifyStatus() {
    const crewId = this.data.crewId
    if (!crewId) return Promise.resolve(null)
    const request = this.notifyStatusRequest = (this.notifyStatusRequest || 0) + 1
    this.setData({ notifyLoading: true, notifyLoadError: '' })
    const current = () => this.data.crewId === crewId && this.notifyStatusRequest === request
    return api.callApi('subscribe.status', { crewId }).then(res => {
      if (!current()) return null
      if (!res || res.ok !== true) throw new Error((res && res.error && res.error.message) || '提醒设置读取失败')
      const intents = (res.data && res.data.intents) || []
      this.setData({
        notifyLoading: false,
        notifyRows: intents.map(row => ({
          kind: row.kind,
          label: row.label,
          templateId: row.templateId,
          subscribed: row.subscribed === true,
          acceptedCount: row.acceptedCount || 0,
          /** 次数用完/被撤销时也能再点一次（一次订阅就是一次额度） */
          canRequest: Boolean(row.templateId),
        })),
        /**
         * 服务端的"已同意 ≠ 一定送达"说明放**单独字段**，不要塞进 `notifyNote`：
         * `notifyNote` 是"刚才那次点击的结果"，会被下一次状态刷新覆盖 ——
         * 用户点了开启，提示一闪就变成政策说明，看起来像没成功。
         */
        notifyPolicyNote: (res.data && res.data.note) || '',
      })
      return res.data
    }).catch(err => {
      if (current()) this.setData({ notifyLoading: false, notifyLoadError: err.message || '提醒设置读取失败，请重试' })
      return null
    })
  },

  toggleNotifyPanel() {
    const next = !this.data.notifyPanelOpen
    this.setData({ notifyPanelOpen: next })
    if (next) this.loadNotifyStatus()
  },

  /**
   * 点某类提醒：走 `wx.requestSubscribeMessage`，把**逐模板**结果回报服务端。
   *
   * ⚠️ 三个边界：
   *   · 只有 `'accept'` 才算同意，`reject/ban/filter` 一律按未同意上报；
   *   · 用户点拒绝**不是错误**，不弹报错，只更新状态；
   *   · 客户端的结果只是"用户表达过同意"，**不能**当成微信可无限发送的凭证。
   */
  requestNotify(e) {
    const kind = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.kind
    const row = (this.data.notifyRows || []).find(r => r.kind === kind)
    if (this.data.notifyBusy) return
    if (!row || !row.templateId) {
      this.setData({ notifyNote: '这类提醒的模板尚未就绪，请刷新提醒设置后再点开启。' })
      return
    }
    const crewId = this.data.crewId
    if (!crewId) return
    if (typeof wx.requestSubscribeMessage !== 'function') {
      this.setData({ notifyNote: '当前微信版本不支持订阅提醒，请更新微信后重试。' })
      return
    }
    this.setData({ notifyBusy: true, notifySettingsNeeded: false, notifyNote: '正在请求微信授权，请留意授权提示…' })
    const finish = (status, message) => {
      if (this.data.crewId !== crewId) return
      this.setData({ notifyNote: status === 'accept' ? '已获微信授权，正在保存提醒设置…' : message })
      /**
       * 无论 accept 还是 reject 都要上报：拒绝也要记下来，
       * 否则下次还会再问同一个用户（微信允许，但体验上很烦）。
       */
      api.callApi('subscribe.report', {
        crewId, source: 'team-page',
        results: [{ kind, status }],
      }).then(res => {
        if (this.data.crewId !== crewId) return
        if (!res || !res.ok) throw new Error((res && res.error && res.error.message) || '保存失败')
        this.setData({ notifyNote: message })
        return this.loadNotifyStatus()
      }).catch(() => {
        if (this.data.crewId === crewId) this.setData({ notifyNote: status === 'accept'
          ? '微信已授权，但提醒设置未保存成功，请检查网络后重新开启。' : message })
      }).finally(() => {
        if (this.data.crewId === crewId) this.setData({ notifyBusy: false })
      })
    }
    try { wx.requestSubscribeMessage({
      tmplIds: [row.templateId],
      success: (res) => {
        const status = res && res[row.templateId]
        const accepted = status === 'accept'
        finish(accepted ? 'accept' : (status || 'reject'),
          accepted ? '已开启「' + row.label + '」提醒（每次同意大约可用一次）'
            : '没有开启「' + row.label + '」提醒')
      },
      fail: (err) => {
        if (this.data.crewId !== crewId) return
        /**
         * 常见失败：用户以前永久拒绝过模板（errCode 20004）、
         * 或还没在小程序后台启用模板。如实说，不假装成功。
         */
        const code = Number(err && err.errCode)
        this.setData({ notifySettingsNeeded: code === 20004 })
        const hint = code === 20004 ? '你之前关闭过订阅提醒，需要到小程序设置里重新允许'
          : code === 20001 ? '订阅模板不可用，请检查小程序后台是否已启用该模板'
            : '订阅没有成功，请稍后再试' + (Number.isFinite(code) ? '（' + code + '）' : '')
        finish('reject', hint)
      },
    }) } catch (_) {
      this.setData({ notifyBusy: false, notifyNote: '无法打开微信订阅授权，请更新微信或稍后重试。' })
    }
  },

  openNotifySettings() {
    if (typeof wx.openSetting === 'function') wx.openSetting({ withSubscriptions: true })
  },

  showNoticeLanding(message, failed) {
    this.setData({ noticeLandingNote: message, notifyNote: message, notifyLandingFailed: Boolean(failed) })
    if (typeof wx.showToast === 'function') wx.showToast({ title: message, icon: 'none', duration: 2500 })
  },

  dismissNoticeLanding() { this.setData({ noticeLandingNote: '', notifyLandingFailed: false }) },

  /** 关掉某类提醒（本次不再发送，不删除历史记录）。 */
  revokeNotify(e) {
    const kind = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.kind
    const crewId = this.data.crewId
    if (!kind || !crewId || this.data.notifyBusy) return
    this.setData({ notifyBusy: true })
    api.callApi('subscribe.revoke', { crewId, kind })
      .then(() => this.loadNotifyStatus())
      .then(() => this.setData({ notifyBusy: false, notifyNote: '已关闭这类提醒' }))
      .catch(() => this.setData({ notifyBusy: false, notifyNote: '关闭失败，请稍后再试' }))
  },

  /**
   * 通知点击落地：**恢复目标队伍上下文，再做重新鉴权**。
   *
   * 交接文档第 3 节第 7 条要求两件事，缺一件都会出错：
   *
   *   ① 恢复上下文 —— 用户点提醒就是要去那个队伍看，落在别的队伍等于没恢复；
   *   ② **不能直接相信通知携带的队伍 ID** 去取内容。
   *
   * 所以顺序是**先 `crew.get` 鉴权、通过后才切换活动队伍**：
   *   · 鉴权通过 → 把 `zhiyou-active-crew` 写为目标队伍（tab 页不能带 URL 参数，
   *     按项目既有约定走 storage），再按新队伍重新拉成员、集合与消息；
   *   · 已被移出/队伍解散 → **不切换**，如实说"这条提醒所属的队伍已不可访问"，
   *     并明确告诉用户回哪里去 —— 失效的推送不该把一个空页面甩给用户。
   *
   * 落地页只带 `crewId`/`meetId` 这类定位线索，不带消息正文；正文永远由
   * 鉴权通过的接口重新取。
   */
  applyNoticeLanding(query) {
    if (!query) return false
    const options = typeof query === 'string' ? this.parseLandingQuery(query) : query
    const targetCrewId = options.crewId
    if (!targetCrewId) return false
    /**
     * 同一次落地只处理一次：`onShow` 可能被重复触发（切 tab 回来），
     * 反复切换会打断用户刚做的操作。
     */
    const signature = targetCrewId + '|' + (options.meetId || '') + '|' + (options.at || '')
    if (this._noticeLandingSignature === signature) return true
    this._noticeLandingSignature = signature

    const mine = this.readCrewId()
    if (targetCrewId === mine) {
      // 已经在这支队伍里：只要刷新一次（loadCrew 内部会重新鉴权）
      this.showNoticeLanding('已从提醒回到队伍')
      this.noticeLandingLoad = this.loadCrew().then(() => {
        if (this.crewAccessError) this.showNoticeLanding('这条提醒所属的队伍暂时不可访问，请切换队伍重试', true)
        else this.confirmNoticeMeetLanding(options.meetId)
      })
      return true
    }
    this.noticeLandingLoad = this.resumeCrewFromNotice(targetCrewId, options.meetId)
    return true
  },

  parseLandingQuery(query) {
    const options = {}
    String(query).split('&').forEach(pair => {
      const idx = pair.indexOf('=')
      if (idx > 0) options[pair.slice(0, idx)] = decodeURIComponent(pair.slice(idx + 1))
    })
    return options
  },

  /**
   * 切到提醒对应的队伍。
   *
   * 先鉴权（`crew.get`）再改活动队伍 —— 顺序不能反：
   * 先写 storage 再鉴权，就会出现"页面已经按新队伍取数、随后鉴权失败"的空窗，
   * 那一瞬间的请求会带着一个用户已无权访问的 crewId 发出去。
   */
  resumeCrewFromNotice(targetCrewId, meetId) {
    const mine = this.readCrewId()
    return api.callApi('crew.get', { crewId: targetCrewId }).then(res => {
      if (!res || res.ok !== true) {
        const code = res && res.error && res.error.code
        const message = code === 'FORBIDDEN_NOT_MEMBER' || code === 'NOT_FOUND'
          ? '这条提醒所属的队伍已不可访问（你可能已退出或被移除），已留在当前队伍'
          : '这条提醒所属的队伍暂时读不到，已留在当前队伍'
        /**
         * 失效时**不改写**活动队伍：用户仍留在原来的队伍里，
         * 并告诉他入口在哪，而不是把他甩到一个打不开的页面。
         */
        this.showNoticeLanding(message, true)
        return false
      }
      /**
       * 鉴权通过：按项目既有约定用 storage 交接活动队伍，
       * 并清掉只属于旧队伍的内存态（位置、标注、已读游标、消息计时器）。
       */
      try { wx.setStorageSync('zhiyou-active-crew', targetCrewId) } catch (e) { /* storage 失败则放弃切换 */ }
      this.teamLocations = []
      this.locationMembers = null
      this.invalidTeamLocations = 0
      this._lastMarkedReadSeq = 0
      this.notifyLandingMeetId = meetId || ''
      this.setData({
        crewId: '',
        members: [],
        meetTask: null,
        teamTripId: null,
        departureCheck: null,
        meetId: null,
        meetingPoint: null,
        photoNote: '',
        currentPhotos: [],
        notifyNote: mine
          ? '已切换到提醒对应的队伍'
          : '已从提醒进入队伍',
        notifyLandingFailed: false,
      })
      this.showNoticeLanding(mine ? '已切换到提醒对应的队伍' : '已从提醒进入队伍')
      this.refreshMarkers()
      this.stopChatPreview()
      this.chatPreviewVisible = true
      this.startChatPreview(targetCrewId)
      const reload = this.loadCrew()
      this.refreshTeamLocations()
      // 集合通知还要说清"这次集合还在不在"——不然用户只看到队伍切换了。
      if (reload && typeof reload.then === 'function') {
        reload.then(() => this.confirmNoticeMeetLanding(meetId)).catch(() => {})
      } else {
        this.confirmNoticeMeetLanding(meetId)
      }
      return true
    }).catch(() => {
      this.showNoticeLanding('这条提醒暂时打不开，已留在当前队伍', true)
      return false
    })
  },

  /**
   * 集合通知落地后的交代。
   *
   * 推送的集合可能已经结束（取消/出发）—— 那就不再画到地图上，
   * 但也不能假装"什么都没发生"：如实说这次集合已结束，用户才知道
   * 为什么点进来没看到约好的地点。
   */
  confirmNoticeMeetLanding(meetId) {
    if (!meetId) return
    const current = this.data.meetTask
    if (current && current.meetTaskId === meetId) {
      this.showNoticeLanding('已从提醒回到队伍，已定位到这次集合')
      return
    }
    this.showNoticeLanding('这条提醒对应的集合已结束或已取消')
  },

  /**
   * 推进本人已读游标。
   *
   * 只在这个页面**真的把消息显示出来之后**调用（`chatPreview` 更新时），
   * 拉取接口与地图预取都不算 —— 那正是交接文档点名的缺口。
   * 用 `_lastMarkedReadSeq` 去重，避免每 3 秒轮询都写一次库。
   */
  markChatRead(seq) {
    const crewId = this.data.crewId
    if (!crewId || !Number.isSafeInteger(seq) || seq <= 0) return
    if (seq <= (this._lastMarkedReadSeq || 0)) return
    this._lastMarkedReadSeq = seq
    api.callApi('chat.markRead', { crewId, seq }).catch(() => {
      // 失败就允许下次重试（不推进本地去重值）
      if (this._lastMarkedReadSeq === seq) this._lastMarkedReadSeq = 0
    })
  },

  applyGuideMeeting() {
    const pending = wx.getStorageSync('zhiyou-guide-meeting')
    if (!pending) return false
    wx.removeStorageSync('zhiyou-guide-meeting')
    const age = Date.now() - pending.at
    if (!isValidPoint(pending) || !Number.isFinite(age) || age < 0 || age > 120000 ||
      pending.crewId !== this.data.crewId || pending.crewId !== this.readCrewId()) return false
    if (this.data.meetTask) {
      this.setData({ teamNote: '已有进行中的集合，本次助手选点没有覆盖原集合。' }); return false
    }
    this.setAutoMeetingPoint({ placeId: 'map_guide_' + Date.now(), name: pending.name,
      latitude: pending.latitude, longitude: pending.longitude, address: pending.address, fromGuide: true })
    this.setData({ pointName: String(pending.name || '').slice(0, 20), center: {
      latitude: pending.latitude, longitude: pending.longitude }, scale: 17, pickMode: false,
      teamNote: '已选定助手确认的地点，请设置集合时间，再手动发起集合。' })
    return true
  },

  /** 读取成员、个人共享开关及当前集合。 */
  loadCrew() {
    const crewId = this.readCrewId()
    const generation = this.crewLoadGeneration = (this.crewLoadGeneration || 0) + 1
    // 轮询、发起集合后的刷新可能并发；迟到的旧响应不能清除或覆盖新集合。
    const current = () => this.crewLoadGeneration === generation && this.readCrewId() === crewId && this.data.crewId === crewId
    this.startChatPreview(crewId)
    if (!crewId) {
      this.locationMembers = null
      this.invalidTeamLocations = 0
      this.setData({ crewId: '', crew: null, members: [], meetTask: null, sharing: false, teamTripId: null, me: '', isOwner: false, isInitiator: false })
      this.teamLocations = []
      this.refreshMarkers()
      return
    }
    if (this.data.crewId !== crewId) {
      this.locationMembers = null
      this.invalidTeamLocations = 0
      this.teamLocations = []
      this.setData({ members: [], meetTask: null, teamTripId: null, departureCheck: null, me: '',
        notifyRows: [], notifyBusy: false, notifyLoading: false, notifyLoadError: '', notifySettingsNeeded: false })
      this.refreshMarkers()
    }
    this.setData({ crewId: crewId })
    const that = this
    const infoRequest = api
      .callApi('crew.get', { crewId: crewId })
      .then(function (res) {
        if (!current()) return
        if (!res || res.ok !== true) {
          that.crewAccessError = (res && res.error && res.error.message) || '队伍信息读取失败'
          /**
           * ⚠️ 读不到就说读不到，**不编空队伍** ——
           * 空队伍会让用户以为自己被踢出去了。
           */
          that.setData({ teamError: (res && res.error && res.error.message) || '队伍信息读取失败' })
          return
        }
        const d = res.data || {}
        that.crewAccessError = ''
        const me = (d.members || []).find(m => m.userId === d.me)
        const memberLabels = createMemberLabels(d.members, d.me)
        that.setData({
          crew: d.crew || null,
          me: d.me || '',
          isOwner: d.myRole === 'owner',
          members: (d.members || []).map(m => Object.assign({}, m, { label: memberLabels.get(m.userId) })),
          sharing: Boolean(me && me.locationSharing !== false),
          teamError: '',
        })
        that.refreshMarkers()
      })
      .catch(function (err) {
        if (!current()) return
        that.crewAccessError = (err && err.errMsg) || '队伍信息读取失败'
        that.setData({ teamError: (err && err.errMsg) || '队伍信息读取失败' })
      })
    /** 集合任务单独取 —— 它可能不存在，不该让整块队伍信息跟着失败 */
    const meetingRequest = api
      .callApi('team.current', { crewId: crewId })
      .then(function (res) {
        if (!current()) return null
        if (!res || !res.ok) throw new Error((res && res.error && res.error.message) || '集合读取失败')
        that.setData({ teamTripId: res.data.tripId || null })
        return res.data.meetTaskId
          ? api.callApi('meet.get', { meetTaskId: res.data.meetTaskId })
          : { ok: true, data: { meetTask: null } }
      })
      .then(async function (res) {
        await infoRequest
        if (!current()) return
        if (res && res.ok === true) {
          let t = res.data && res.data.meetTask
          if (t && ['cancelled', 'departed', 'completed'].includes(t.status)) t = null
          if (t) {
            const localClock = value => {
              if (!value) return '--:--'
              const d = new Date(value)
              return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
            }
            t.timeLabel = localClock(t.plannedMeetAt)
            t.arrivedLabel = localClock(t.allArrivedAt)
            t.departedLabel = localClock(t.departedAt)
            const labels = { proposed: '等待确认', confirmed: '已确认', active: '集合中', arrived_all: '全员到齐', invited: '待确认', arrived: '已到达', declined: '暂不参加' }
            t.statusLabel = labels[t.status] || t.status
            const memberLabels = createMemberLabels(that.data.members, that.data.me)
            t.participants = (t.participants || []).map(m => Object.assign({}, m, {
              label: memberLabels.get(m.userId) || '已退出队员',
              statusLabel: labels[m.status] || m.status,
            }))
            t.arrivedCount = t.participants.filter(m => m.status === 'arrived').length
            t.expectedCount = t.participants.filter(m => m.status !== 'declined').length
          }
          that.setData({ meetTask: t || null })
          that.setData({ isInitiator: Boolean(t && t.initiatorUserId === that.data.me) })
          if (!t && that.data.meetingPoint && that.data.meetingPoint.fromTeamTask) {
            that.setData({ meetingPoint: null })
            that.refreshMarkers()
          }
          /** 已有集合点时把它画到地图上，用户才知道"我们约在哪儿" */
          if (t) that.syncMeetingSelection()
        } else if (res) {
          throw new Error((res.error && res.error.message) || '集合读取失败')
        }
      })
      .catch(function (err) {
        if (!current()) return
        that.setData({ teamError: err.message || '集合读取失败，请刷新重试' })
      })
    return Promise.all([infoRequest, meetingRequest])
  },

  /** 从本地读 crewId —— 与 team-panel 用同一个 key（组队处写的） */
  readCrewId() {
    try {
      return wx.getStorageSync('zhiyou-active-crew') || ''
    } catch (e) {
      return ''
    }
  },

  /**
   * 读订阅通知的落地参数（`app` 写入的兜底），**读完立刻清掉**。
   *
   * 不清的话：用户过一会儿自己切到队伍页，又被带到那条旧提醒的队伍里去 ——
   * 与 `applyPendingFocus` 那次踩的坑同一种。超过 2 分钟的也丢掉。
   */
  readNoticeLanding() {
    try {
      const saved = wx.getStorageSync('zhiyou-notice-landing')
      if (!saved) return null
      wx.removeStorageSync('zhiyou-notice-landing')
      const age = Date.now() - saved.at
      if (!Number.isFinite(age) || age < 0 || age > 120000) return null
      return { crewId: saved.crewId, meetId: saved.meetId, at: saved.at }
    } catch (e) {
      return null
    }
  },

  /** 开关位置共享 */
  toggleSharing() {
    this.openSharingSettings()
  },

  /**
   * 共享一次当前位置。
   *
   * 新版统一走自动共享服务；保留旧调用入口兼容联调工具。
   */
  reportMyLocation() {
    if (this.sharingService()) return this.refreshSharedLocation()
    if (!isValidPoint(this.data.myPoint)) {
      this.setData({ teamError: '还没有你的位置：先点 ◎ 获取当前位置' })
      return
    }
    const that = this
    if (!this.data.sharing) {
      return this.doTeam('loc.stopSharing', { sharing: true, policyVersion: POLICY_VERSION }, '', function () {
        that.setData({ sharing: true })
        return that.reportMyLocation()
      })
    }
    return this.doTeam(
      'loc.report',
      { point: this.data.myPoint, source: this.data.mySource || 'manual' },
      '位置已共享给队伍',
      function () {
        /** 上报成功后刷新队员位置，用户立刻能看到自己出现在图上 */
        that.refreshTeamLocations()
      }
    )
  },

  /** 拉一次队员位置（地图据此画图钉） */
  refreshTeamLocations() {
    const crewId = this.data.crewId
    if (!crewId) return
    const that = this
    return api
      .callApi('loc.list', { crewId: crewId })
      .then(function (res) {
        if (that.data.crewId !== crewId) return
        if (!res || res.ok !== true) {
          that.teamLocations = []
          that.refreshMarkers()
          that.setData({ locationError: (res && res.error && res.error.message) || '队员位置读取失败' })
          return
        }
        const list = (res.data && res.data.members) || []
        // 保留完整名册的昵称，关闭共享、尚无坐标的成员仍有显示名称。
        that.locationMembers = list
        that.logInvalidCoordinates('loc.list', list.filter(m => m.hasLocation && !m.sharingOff).map(m => m.point))
        that.invalidTeamLocations = list.filter(m => m.invalidLocation ||
          (m.hasLocation && !m.sharingOff && !isValidPoint(m.point))).length
        /**
         * 地图只认 `this.teamLocations` 这一个字段 —— 面板已从本页删掉，
         * 现在只有这一条写入路径（见本段开头对 `teamMeeting` 的说明）。
         */
        that.teamLocations = list.filter(function (m) {
          return m.hasLocation && isValidPoint(m.point) && !m.sharingOff
        })
        that.setData({ locationError: '' })
        that.refreshMarkers()
        that.resolveMemberAvatars(list)
      })
      .catch(function () {
        that.setData({ locationError: '队员位置读取失败，请刷新重试' })
      })
  },

  showTeamOnMap() {
    const points = (this.teamLocations || []).map(m => m.point).filter(isValidPoint)
    if (isValidPoint(this.data.myPoint)) points.push(this.data.myPoint)
    if (isValidPoint(this.data.meetingPoint)) points.push(this.data.meetingPoint)
    if (!points.length) {
      this.setData({ locationError: '还没有可显示的位置，请先在「我的 → 设置」开启自动共享，再更新位置' })
      return
    }
    wx.createMapContext('tripmap', this).includePoints({ points, padding: [60, 40, 60, 40] })
  },

  onMeetTimeChange(e) {
    this.meetTimeEdited = true
    this.setData({ meetTime: e.detail.value })
  },

  onPointNameInput(e) {
    this.setData({ pointName: e.detail.value })
  },

  /**
   * ── ① 推荐一个集合点（2026-10-14 用户要求搬到这里）──────────
   *
   * 流程：本按钮 → `meet.recommend`（平均中心周围 1 公里搜索，选最近地点）
   *       → 取第一名落成集合点 → 用户「✛」拖动微调
   *
   * ⚠️ 原来这个按钮在小队面板里，而面板在「我的」页面 ——
   *    **一个没有地图的地方让你选集合点**，本来就别扭。
   *    现在它就在地图上方，推荐出来立刻能看见、能拖。
   */
  recommendMeetingPoint() {
    const that = this
    if (!this.data.crewId) {
      this.setData({ teamError: '还没有队伍：先去「我的」创建或加入一个小队' })
      return
    }
    this.setData({ teamBusy: true, teamError: '', teamNote: '正在按各成员位置推荐…' })
    return api
      .callApi('meet.recommend', { crewId: this.data.crewId })
      .then(function (res) {
        if (!res || res.ok !== true) {
          that.setData({
            teamBusy: false,
            teamError: (res && res.error && res.error.message) || '推荐失败',
          })
          return
        }
        const d = res.data || {}
        const top = (d.candidates || [])[0] || null
        if (top && !isValidPoint(top.point)) {
          that.setData({ teamBusy: false, teamError: '推荐集合点的坐标异常，请重新推荐或手动选点' })
          return
        }
        if (!top || !top.point) {
          /**
           * ⚠️ 推荐不出来时**说清为什么**，不给一个编出来的点。
           *
           * 排名第一的原因不是"没有候选"，而是**同伴还没共享位置** ——
           * 不知道各人在哪，就算不出"对谁都近"。
           * 第二类是地图服务本身不可用（Key 没配／配额用尽），
           * 那要去控制台处理，与"换个地方碰头"是两回事，必须分开说。
           */
          const excluded = (d.excluded || []).find(e => e.message) || {}
          const reason = d.reason || excluded.reason || ''
          const why =
            reason === 'LOCATION_SHARING_OFF'
              ? '有成员关闭了位置共享，请该成员到「我的 → 设置」开启自动共享位置'
              : reason === 'LOCATION_STALE'
                ? '有成员的位置已过期，请该成员保持小程序在前台，并点「立即更新位置」重试'
                : reason === 'MEMBER_NO_LOCATION'
                  ? '有成员没有可用位置，请该成员到「我的 → 设置」开启自动共享位置，或点「立即更新位置」重试'
              : reason === 'NO_LOCATION_AVAILABLE'
                ? '还拿不到任何成员的位置'
                : reason === 'MAP_KEY_NOT_CONFIGURED'
                  ? '地图服务没配好（云函数缺 MAP_KEY），这个要去云开发控制台加'
                  : reason === 'UPSTREAM_FAILED' || reason.indexOf('UPSTREAM_STATUS') === 0
                    ? '地图服务暂时不可用' + (d.message ? '（' + d.message + '）' : '')
                    : reason === 'NO_VERIFIED_PLACE' || reason === 'NO_POI_FOUND'
                      ? '这附近没检索到能当集合点的地方'
                      : d.message || excluded.message || '暂时没有满足条件的候选点'
          that.setData({
            teamBusy: false,
            teamNote: '',
            teamError: '推荐不出集合点：' + why + '。也可以直接拖 ✛ 自己选一个。',
          })
          return
        }
        that.setAutoMeetingPoint({
          placeId: top.placeId,
          name: top.placeName || '推荐集合点',
          latitude: top.point.latitude,
          longitude: top.point.longitude,
          fromSuggestion: true,
          fromGeometricCenter: d.candidateSource === 'geometric-center',
        })
        /** 镜头挪过去 —— 用户接着就在这儿拖动微调 */
        that.setData({
          center: { latitude: top.point.latitude, longitude: top.point.longitude },
          scale: 16,
          pointName: that.data.pointName || top.placeName || '',
        })
        that.setData({
          teamBusy: false,
          teamNote:
            '已推荐「' +
            (top.placeName || '集合点') +
            '」' +
            (typeof top.maxWalkMin === 'number' ? '：最远成员步行估算约 ' + top.maxWalkMin + ' 分钟' : '') +
            '。' +
            (d.candidateNote || (d.candidateSource === 'geometric-center'
              ? '此点按成员平均位置生成。'
              : '已选择中心周围 1 公里内搜索到的最近地点。')) +
            '拖动 ✛ 可以微调，确认后点「② 发起集合」。',
        })
      })
      .catch(function (err) {
        that.setData({ teamBusy: false, teamError: (err && err.errMsg) || '推荐失败' })
      })
  },

  /**
   * ② 发起集合。
   *
   * ⚠️ 三个必填项缺一不可，且**都要给出可行动的提示**：
   *    集合点（拖 ✛ 选）、名称（便于辨认，如"南门指示牌旁"）、未来时间。
   */
  createMeeting() {
    const that = this
    if (!isValidPoint(this.data.meetingPoint)) {
      this.setData({ teamError: '还没有集合点：点「推荐」或拖 ✛ 自己选一个' })
      return
    }
    const name = String(this.data.pointName || '').trim()
    if (!name) {
      this.setData({ teamError: '请填一个便于辨认的集合点名称，如「南门指示牌旁」' })
      return
    }
    const text = String(this.data.meetTime || '')
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) {
      this.setData({ teamError: '请选择有效的集合时间' })
      return
    }
    const parts = text.split(':').map(Number)
    const at = new Date()
    at.setHours(parts[0] || 0, parts[1] || 0, 0, 0)
    if (at <= new Date()) {
      this.setData({ teamError: '集合时间要选今天还没到的时间' })
      return
    }
    this.doTeam(
      'meet.create',
      {
        // 只关联本队共同路线，个人路线不能挂到集合任务上。
        tripId: this.data.teamTripId || null,
        point: {
          latitude: this.data.meetingPoint.latitude,
          longitude: this.data.meetingPoint.longitude,
        },
        /**
         * ⚠️ `placeId` 只在**确实来自库里地点**时传。
         *    拖动选点出来的点没有 placeId，传一个假的会让后端
         *    去库核验一个不存在的记录。
         */
        placeId: this.data.meetingPoint.placeId && String(this.data.meetingPoint.placeId).indexOf('map_') !== 0
          ? this.data.meetingPoint.placeId
          : undefined,
        placeName: name,
        method: this.data.meetingPoint.fromMapPick || this.data.meetingPoint.fromPhoto || this.data.meetingPoint.fromGuide ? 'manual' : 'recommended',
        plannedMeetAt: at.toISOString(),
      },
      '已发起集合，等同伴确认'
    )
  },

  /** 集合任务上的动作：确认 / 暂不参加 / 我已到达 / 取消 */
  meetAction(e) {
    const kind = e.currentTarget.dataset.kind
    const task = this.data.meetTask
    if (!task) return
    if (kind === 'cancel') {
      this.doTeam('team.cancelMeeting', { meetTaskId: task.meetTaskId }, '已取消本次集合')
      return
    }
    const payload = { meetTaskId: task.meetTaskId }
    if (kind === 'confirm' || kind === 'decline') payload.decision = kind
    const labels = { confirm: '已确认集合', decline: '已回复暂不参加', arrive: '已记录：你到了' }
    this.doTeam('meet.' + (kind === 'decline' ? 'confirm' : kind), payload, labels[kind] || '已提交')
  },

  /** 准备出发：先检查后续行程会不会受影响 */
  prepareDepart() {
    const task = this.data.meetTask
    if (!task) return
    const that = this
    this.doTeam('meet.prepareDepart', { meetTaskId: task.meetTaskId }, '', function (d) {
      that.setData({
        departureCheck: d || null,
        teamNote: (d && d.message) || '检查完成',
      })
    })
  },

  /** 确认现在出发（需要先检查过 —— checkId 是服务端给的凭据） */
  confirmDepart() {
    const chk = this.data.departureCheck
    if (!chk || !chk.canDepart) {
      this.setData({ teamError: '请先点「准备出发 · 检查后续行程」' })
      return
    }
    this.doTeam(
      'meet.depart',
      { meetTaskId: this.data.meetTask.meetTaskId, checkId: chk.checkId },
      '已确认出发'
    )
  },

  /**
   * 队伍操作的统一入口。
   *
   * ⚠️ 抽出来是为了让"忙状态、错误提示、成功提示、刷新"**只有一份** ——
   *    上面六个动作各写一遍必然出现某个忘了清 `teamBusy` 的情况。
   */
  doTeam(action, payload, okMessage, onData) {
    const that = this
    const full = Object.assign({ crewId: this.data.crewId }, payload || {})
    this.setData({ teamBusy: true, teamError: '' })
    const task = this.data.meetTask
    const needsVersion = ['meet.confirm', 'meet.arrive', 'meet.prepareDepart', 'meet.depart', 'team.cancelMeeting'].includes(action)
    return api
      .callApi(action, full, needsVersion && task ? { expectedVersion: task.version } : undefined)
      .then(async function (res) {
        if (!res || res.ok !== true) {
          that.setData({
            teamBusy: false,
            teamError: (res && res.error && res.error.message) || '操作失败',
          })
          if (res && res.error && res.error.code === 'VERSION_CONFLICT') that.loadCrew()
          return
        }
        that.setData({ teamBusy: false, teamNote: okMessage || '' })
        /** 动作完成后重读状态 —— 服务端才是权威 */
        await Promise.all([that.loadCrew(), that.refreshTeamLocations()])
        if (typeof onData === 'function') return onData(res.data)
      })
      .catch(function (err) {
        that.setData({ teamBusy: false, teamError: (err && err.errMsg) || '操作失败' })
      })
  },

  /**
   * 集合发起后，两端只使用服务端集合任务中的点；本地选点仅用于发起前的草稿。
   */
  hasActiveMeeting() {
    const task = this.data.meetTask
    return Boolean(task && !['cancelled', 'departed', 'completed'].includes(task.status))
  },

  sharedMeetingPoint() {
    const task = this.data.meetTask
    if (!this.hasActiveMeeting() || !isValidPoint(task.point)) return null
    const matched = (this.data.places || []).find(p => p.name === (task.placeName || task.name))
    return { placeId: task.placeId || (matched && matched.placeId) || (task.meetTaskId ? 'meet_' + task.meetTaskId : '__team_meeting__'),
      name: task.placeName || task.name || '集合点',
      latitude: task.point.latitude, longitude: task.point.longitude, fromTeamTask: true }
  },

  syncMeetingSelection() {
    /**
     * ⚠️ 数据来源从 `this.teamMeeting`（面板事件）改成 `meetTask`（自己取的）。
     *
     * 2026-10-14 删掉本页的 `team-panel` 之后，`teamMeeting` 再没有任何写入点 ——
     * 若继续读它，进行中的集合**永远不会被自动选中**，而且不报错
     * （`meeting` 恒为 null，函数静默 return）。
     *
     * `meetTask` 由 `loadCrew()` 调 `meet.get` 填上，字段名不同：
     * 面板事件给的是 `{ name, point }`，而 `meet.get` 给的是
     * `{ placeName, point }` —— 这里统一读 `placeName`。
     */
    if (!this.hasActiveMeeting()) return false
    const point = this.sharedMeetingPoint()
    if (!point) {
      this.refreshMarkers()
      this.setData({ coordinateError: '集合点坐标异常，请刷新队伍信息；暂不显示其他选点代替。' })
      return false
    }
    return this.setAutoMeetingPoint(point)
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

  /**
   * ── 进入"拖动选点"模式（2026-10-14 用户要求改造）──────────────
   *
   * 用户原话："手动选点同样改为小控件，但是点击后**只需拖动地图**即可
   * 确定图钉的位置，图钉在拖动时**保持在屏幕中心不动**，
   * 再次点击控件退出模式时才会随地图拖动一起移动"
   *
   * 随后澄清用途："我是想把这个选点**当作集合点**用"
   * —— 所以选出来的点写进 `meetingPoint`（见 `confirmPick`）。
   *
   * ── 与旧实现的区别 ──────────────────────────────────────
   *
   * 旧的是"点地图上的某一点"（`onMapTap`）。那个在手机上很难点准：
   * 手指按下去就遮住了目标位置，而景区里 20 米的偏差就足以让人
   * 站到马路对面。拖动对中心图钉则天然精确 —— 手指在屏幕任何地方，
   * 图钉始终在正中间。
   *
   * ── 中心图钉为什么"不动" ────────────────────────────────
   *
   * 它是**固定在容器正中的覆盖层**（见 wxml 的 `.center-pin`），
   * 地图在它下面滚。退出模式后覆盖层不再渲染，位置改由 `meetingPoint`
   * 对应的 marker 表示 —— 那是地图坐标，会随地图一起动。
   */
  onPhotoMeetingSelected(e) {
    const point = e && e.detail
    if (!this.data.crewId || this.data.meetTask || !isValidPoint(point)) return
    this.setAutoMeetingPoint({ placeId: 'map_photo_' + Date.now(), name: point.name,
      latitude: point.latitude, longitude: point.longitude, address: point.address, fromPhoto: true })
    this.setData({ pointName: String(point.name || '').slice(0, 20), center: {
      latitude: point.latitude, longitude: point.longitude }, scale: 17, pickMode: false,
      teamNote: '已选定照片辅助找到的地点。请核对集合时间，再点击“发起集合”。' })
  },

  startPick() {
    if (this.hasActiveMeeting()) {
      this.syncMeetingSelection()
      this.setData({ note: '已有进行中的集合，地图显示队伍公布的集合点；如需更换，请取消本次集合后重新发起。' })
      return false
    }
    this.setData({
      pickMode: true,
      note: '拖动地图，把中间的图钉对准集合点',
    })
    /**
     * 进入模式时**先取一次地图中心**：用户可能什么都没拖就直接点「好了」。
     * 不取的话读到的还是进来前的位置，而他以为已经选好了。
     */
    this.readCenter()
  },

  /**
   * 退出拖动模式，把当前中心**定为集合点**（2026-10-14 用户澄清）。
   *
   * ⚠️⚠️ **写的是 `meetingPoint`，不是 `myPoint`** —— 这是本次改动的核心。
   *
   * 用户原话："还是不对，我是想把这个选点**当作集合点**用"
   *
   * 我第一版写成了 `myPoint` + `mySource: 'manual'`，那是"**我在哪**"；
   * 而集合点是"**大家在哪碰头**" —— 两个完全不同的东西：
   *
   *   `myPoint`      我的位置：算"我要走多久"、画蓝点、作为集合候选的排序基准
   *   `meetingPoint` 集合点：画集合点图钉、与我的位置连虚线、
   *                  传给 `team-panel` 发起集合
   *
   * ⚠️ 退出前必须再读一次中心：拖动过程中 `bindregionchange` 是连续触发的，
   *    我们只更新提示用的坐标；真正落库要等用户说"就这儿"。
   *    以最后一次读到的为准，避免"拖完立刻点好了"时用到上一帧的值。
   */
  confirmPick() {
    const that = this
    this.readCenter(function (loc) {
      if (that.hasActiveMeeting()) { that.syncMeetingSelection(); return }
      if (!loc) {
        that.setData({ pickMode: false, note: '没能读到地图中心，请重试或点「◎」用定位' })
        return
      }
      /**
       * 落成与"点地点卡片选中的集合点"**同一个形状** ——
       * 这样地图上的集合点图钉、与我的位置之间的虚线、
       * 以及传给 `team-panel` 的那份数据都不用改。
       *
       * ⚠️ `placeId` 用 `map_` 前缀标出来：这不是库里的地点，
       *    而是用户在图上拖出来的一个点。
       *    `refreshMarkers` 靠"是否在 places 里"判断该画哪种图钉，
       *    这个前缀让判断更明确，也便于排障时分辨。
       */
      that.setAutoMeetingPoint({
        placeId: 'map_' + Date.now(),
        name: '地图选点',
        latitude: loc.latitude,
        longitude: loc.longitude,
        /** 标记来源：用户在地图上拖出来的，**未经过任何核验** */
        fromMapPick: true,
      })
      that.setData({
        pickMode: false,
        note: '已选为集合点，可在本页发起集合。',
      })
    })
  },

  /**
   * 设置集合点（自动选中与拖动选点共用一条路）。
   *
   * ⚠️ 抽出这个方法是为了让两条路**一定写入同一个字段** ——
   *    我第一版两条路写的是不同字段（一条 `meetingPoint`、
   *    一条 `myPoint`），于是"集合点"这个概念在页面里有了两个来源。
   */
  setAutoMeetingPoint(point) {
    const shared = this.hasActiveMeeting()
    if (shared) point = this.sharedMeetingPoint()
    if (!isValidPoint(point)) {
      this.setData({ coordinateError: '集合点坐标异常，请重新选择集合点' })
      return false
    }
    this.setData({
      meetingPoint: point,
      photoNote: '',
      currentPhotos: [],
      ...(shared ? { pickMode: false } : {}),
    })
    this.refreshMarkers()
    this.computeNearby()
  },

  /**
   * ── 读回"推荐的集合点"（2026-10-14 用户要求）────────────────
   *
   * 流程：小队面板点「推荐一个集合点」→ 后端搜索成员平均中心周围的地点 →
   * 写进 storage → 切到本页 → 这里读出来落成集合点，**用户可以接着拖动微调**。
   *
   * ⚠️ 与 `applyPendingFocus` 同一套约定：**读完立刻清掉**（一次性），
   *    并且**判过期**（超过 2 分钟不执行）—— storage 是持久的，
   *    否则用户半小时后切到地图页，会突然看到一个早就过期的集合点。
   */
  applyMeetSuggestion() {
    let s = null
    try {
      s = wx.getStorageSync('zhiyou-meet-suggest') || null
      if (s) wx.removeStorageSync('zhiyou-meet-suggest')
    } catch (e) {
      return false
    }
    if (!isValidPoint(s)) return false
    if (s.at && Date.now() - s.at > 2 * 60 * 1000) return false

    this.setAutoMeetingPoint({
      placeId: s.placeId || null,
      name: s.name || '推荐集合点',
      latitude: s.latitude,
      longitude: s.longitude,
      /** 标记来源：算法推荐的，**未实地核验** —— 界面要能区分 */
      fromSuggestion: true,
      fromGeometricCenter: s.candidateSource === 'geometric-center',
    })
    /**
     * 镜头挪到推荐的集合点 —— 用户接着就要在这儿拖动微调，
     * 镜头不在那儿的话他得先找一圈。
     */
    this.setData({ center: { latitude: s.latitude, longitude: s.longitude }, scale: 16 })
    /**
     * 理由要说出来（不做黑箱）：算法只知道"对所有人都近"，
     * 不知道"南门还是北门"—— 那句话正是让用户知道**为什么还要他确认**。
     */
    this.setData({
      note:
        '已自动生成集合点（' +
        (s.name || '推荐点') +
        '）' +
        (typeof s.maxWalkMin === 'number' ? '：走得最远的成员约 ' + s.maxWalkMin + ' 分钟' : '') +
        '。拖动右下角 ✛ 可以微调。',
    })
    return true
  },

  /** 取消拖动选点，不改变已有的位置 */
  cancelPick() {
    this.setData({ pickMode: false, note: '已取消手动选点' })
  },

  /**
   * 读当前地图中心。
   *
   * ⚠️ 用 `MapContext.getCenterLocation()` 而不是自己算 ——
   *    `center` 是我们**传给**地图的初始值，用户拖动之后它并不会自动更新。
   *    拿它当"当前中心"会一直读到进来时的那个点。
   */
  readCenter(cb) {
    try {
      const ctx = wx.createMapContext('tripmap', this)
      if (!ctx || typeof ctx.getCenterLocation !== 'function') {
        if (cb) cb(null)
        return
      }
      ctx.getCenterLocation({
        success(res) {
          if (isValidPoint(res)) {
            if (cb) cb({ latitude: res.latitude, longitude: res.longitude })
          } else if (cb) cb(null)
        },
        fail() {
          if (cb) cb(null)
        },
      })
    } catch (e) {
      if (cb) cb(null)
    }
  },

  /**
   * 地图视野变了（拖动 / 缩放）。
   *
   * 只在视野变化结束且缩放级别改变时重排标签；拖动每帧不刷新。
   */
  onMapRegionChange(event) {
    const detail = (event && event.detail) || {}
    const phase = event && (event.type === 'begin' || event.type === 'end') ? event.type : detail.type
    const scale = detail.scale
    if (phase === 'end' && Number.isFinite(scale) && scale >= 3 && scale <= 20 && scale !== this.markerLayoutScale) {
      this.markerLayoutScale = scale
      this.refreshMarkers()
    }
    if (!this.data.pickMode) return
    /**
     * 拖动时**不做任何 setData**：`regionchange` 每秒能触发几十次，
     * 每次都 setData 会让界面发涩，而拖动中最不需要的就是界面更新
     * （图钉本来就不动）。真正的坐标在「好了」那一下读。
     */
  },

  /**
   * 使用定位接口获取位置。
   *
   * `type: 'gcj02'` 与全库坐标系一致（docs/项目计划书.md#data-model §4）——混用会产生 50–500 米偏移，
   * 在"景区内集合"这个尺度上足以让人走到马路对面。
   *
   * 失败时不报错了事：明确给出原因并提供手动选点的退路。
   * 这正是 docs/项目计划书.md#data-model §0 决定 3 的落地 —— 定位来源可替换，算法不感知来源。
   */
  useGps() {
    const that = this
    wx.getLocation({
      type: 'gcj02',
      isHighAccuracy: true,
      highAccuracyExpireTime: 4000,
      success(res) {
        if (!isValidPoint(res)) {
          that.setData({ note: '定位返回的坐标异常，请重新定位' })
          return
        }
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
        /**
         * 镜头挪到当前位置（2026-10-14 用户要求：
         * "点击会获取位置并将镜头挪到当前位置"）。
         *
         * 除了 `moveToLocation`（那是"回到我的位置"），还要把
         * **受控属性 `center` 也更新** —— 否则用户之后拖动地图、
         * 页面因别的原因重渲染时，镜头会弹回进来时的旧中心。
         */
        that.setData({
          center: { latitude: res.latitude, longitude: res.longitude },
        })
        that.recenterOnMe()
      },
      fail(err) {
        const msg = (err && err.errMsg) || '未知原因'
        const denied = /auth deny|authorize|permission/i.test(msg)
        that.setData({
          mySource: null,
          note: denied
            ? '定位权限被拒绝，可用地图右下角的 ✛ 拖动选点，或在小程序设置里重新授权'
            : '定位失败：' + msg + '（可用地图右下角的 ✛ 拖动选点）',
        })
        console.error('[useGps] 获取位置失败', err)
      },
    })
  },

  /**
   * 点击地图 —— **只在非选点模式下**用来选中地点。
   *
   * ⚠️ 选点模式改成了"拖动对中心图钉"（见 `startPick`），
   *    所以这里不再处理选点。但**保留**它做另一件事：
   *    选中地图上现有的地点（与点 marker 同效），方便用户点一片区域。
   */
  onMapTap(e) {
    if (this.data.pickMode) return
    /** 非选点模式下的地图点击暂不做事 —— 避免误触改变"我的位置" */
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
  /**
   * ⚠️ **`onMarkerTap` 已删除**（2026-10-14）。
   *
   * 它原来做"点地点图钉 → 选中那个地点"，而本页已不再画地点图钉
   * （用户要求："地图上还没确定路线又出现了一堆图钉，干脆把图钉删了吧"）。
   *
   * 删掉是**因为它的前提消失了**，不是因为"没人调用所以删"：
   *   · `markerPlaceIndex` 恒为空 → 它永远静默返回，什么也不做；
   *   · 地图上现在只剩"我 / 队员 / 集合点"三类图钉，点它们都没有
   *     "要切换的选中项"（集合点已经是选中的那个）。
   *
   * 选中地点仍然要走**列表**那条路（`selectMeeting`）——
   * 那里还有名字与步行时间，比一个光秃秃的图钉有用。
   *
   * ⚠️ 若将来本页重新画地点图钉，**必须同时把绑定与这张映射表加回来** ——
   *    首版就是"绑了事件但没有映射表"，图钉点上去毫无反应（已修过一次）。
   */

  /**
   * 选中一个地点作为集合点 —— **点图钉与点列表共用这一条路径**。
   *
   * 分开写两份的话，"点图钉"和"点列表项"迟早会在某个细节上不一致
   * （比如其中一处忘了清 `photoNote`），而那种不一致很难被发现。
   */
  selectPlace(placeId) {
    if (this.hasActiveMeeting()) {
      this.syncMeetingSelection()
      this.setData({ note: '已有进行中的集合，集合点以队伍公布的位置为准。' })
      return false
    }
    const place = this.data.places.find(function (p) {
      return p.placeId === placeId
    })
    if (!place) return false
    if (!isValidPoint(place)) {
      this.setData({ coordinateError: '集合点坐标异常，请重新选择集合点' })
      return false
    }

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
    if (this.hasActiveMeeting()) {
      this.syncMeetingSelection()
      this.setData({ note: '进行中的集合点会向全队显示，请使用“取消本次集合”结束集合。' })
      return false
    }
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
    if (!isValidPoint(my)) return

    const rows = this.data.places
      .filter((p) => MEET_CATEGORIES.indexOf(p.category) >= 0 && isValidPoint(p))
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

  resolveMemberAvatars(members) {
    if (!wx.cloud || !wx.cloud.getTempFileURL) return
    const crewId = this.data.crewId
    const generation = this.markerAvatarGeneration || 0
    const cache = this.memberAvatarCache || (this.memberAvatarCache = {})
    const fileList = [...new Set(members.map(m => m.avatarFileId).filter(id =>
      typeof id === 'string' && id.startsWith('cloud://') &&
      (!cache[id] || cache[id].until <= Date.now())))]
    if (!fileList.length) return
    // 失败稍后重试，避免位置轮询不断重复请求头像。
    fileList.forEach(id => { cache[id] = { url: '', until: Date.now() + 60000 } })
    wx.cloud.getTempFileURL({ fileList,
      success: res => {
        if (this.data.crewId !== crewId || (this.markerAvatarGeneration || 0) !== generation) return
        ;(res.fileList || []).forEach(file => {
          if (/^https:\/\//.test(file.tempFileURL || '') && (!file.status || file.status === 0)) {
            cache[file.fileID] = { url: file.tempFileURL, until: Date.now() + 50 * 60 * 1000 }
          }
        })
        this.refreshMarkers()
      },
      fail() {},
    })
  },

  memberAvatar(member) {    const cached = member && (this.memberAvatarCache || {})[member.avatarFileId]
    return (cached && cached.url) || '/assets/avatar-default.png'
  },

  refreshMarkers() {
    const shared = this.hasActiveMeeting()
    const mp = shared ? this.sharedMeetingPoint() : this.data.meetingPoint
    this.logInvalidCoordinates('myPoint', this.data.myPoint ? [this.data.myPoint] : [])
    this.logInvalidCoordinates('meetingPoint', this.data.meetingPoint ? [this.data.meetingPoint] : [])
    this.logInvalidCoordinates('teamLocations', (this.teamLocations || []).map(m => m.point))
    const markers = []
    const markerMembers = new Map()
    const roster = this.locationMembers || (this.data.members.length ? this.data.members :
      (this.teamLocations || []).concat(this.data.me ? [{ userId: this.data.me }] : []))
    const memberLabels = new Map(roster.map(m => [m.userId, (m.nickname || '').trim() || '未命名']))
    /**
     * ⚠️ **不再画库里的地点图钉**（2026-10-14 用户要求）。
     *
     * 用户原话："我这地图上还没有确定路线又出现了一堆图钉，干脆把图钉删了吧"
     *
     * 那些图钉是 `data.places`（库里所有地点）无差别铺上来的 ——
     * 用户还没定路线，它们既不是他要去的、也不是约好的，
     * 只是**挡住路网的噪音**。
     *
     * 现在地图上只留"**关于人**"的三类：
     *   · 我的位置（蓝点）
     *   · 集合点（我们约在哪儿）
     *   · 队员位置（同伴到了哪）
     *
     * 这正是「队伍」页该回答的问题。地点本身在「集合点候选」列表里，
     * 需要时从那里选 —— 那里还有名字与步行时间，比一个光秃秃的图钉有用。
     *
     * ⚠️ `markerPlaceIndex` 随之作废（它本来用于"点图钉反查地点"）。
     *    保留一个空对象是为了让 `onMarkerTap` 的兜底分支仍然能跑。
     */
    const markerPlaceIndex = {}
    const meetingId = this.data.meetingPoint && this.data.meetingPoint.placeId

    /**
     * 集合点图钉。
     *
     * ⚠️⚠️ **这里原来是 `if (mp && !meetingInLibrary)`** —— 也就是
     * "**不在库里**的集合点才画"，因为在库里的那些由上面那个
     * `places.forEach` 循环画。
     *
     * 循环删掉之后这个条件就成了 bug：**在库里的集合点没人画了**，
     * 地图上完全看不到"我们约在哪儿" —— 而这是「队伍」页最该回答的问题。
     * （三条测试同时报"集合点必须画出来"才把它抓出来。）
     *
     * 现在无论它在不在库里，**都画**。
     */
    if (isValidPoint(mp)) {
      const photoUrl = (this.data.photoUrls || {})[mp.placeId] || {}
      // 已公布的集合点两端统一用内置图钉，不受各自照片缓存或临时地址失效影响。
      const firstUrl = mp.fromTeamTask ? '' : Object.keys(photoUrl).map(function (k) {
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
          /** 来源要如实说：队里定的 / 算法推荐的 / 我在地图上拖的 */
          content:
            (mp.name || '集合点') +
            (mp.fromTeamTask ? ' · 队里定的' : '') +
            (mp.fromSuggestion ? ' · 算法推荐' : '') +
            (mp.fromMapPick ? ' · 我在图上选的' : '') +
            (mp.fromPhoto ? ' · 照片辅助选点' : '') +
            (mp.fromGuide ? ' · 助手确认选点' : ''),
          color: '#1F2933',
          fontSize: 12,
          borderRadius: 6,
          bgColor: '#FFFFFF',
          padding: 6,
          display: 'ALWAYS',
        },
      })
    }

    if (isValidPoint(this.data.myPoint)) {
      const own = (this.locationMembers || this.teamLocations || []).find(m => m.userId === this.data.me)
      if (own && own.memberKey && own.hasLocation && !own.stale && !own.sharingOff && isValidPoint(own.point)) {
        markerMembers.set(999, own.memberKey)
      }
      markers.push({
        id: 999,
        latitude: this.data.myPoint.latitude,
        longitude: this.data.myPoint.longitude,
        iconPath: this.memberAvatar(own || roster.find(m => m.userId === this.data.me)),
        width: 40,
        height: 40,
        callout: {
          content: memberLabels.get(this.data.me) || '我',
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
    /**
     * ⚠️ **本页不再画路线折线**（2026-10-14 用户要求："队伍页面地图上显示的
     * 路线也删了"）。
     *
     * 于是整段"逐段取真实步行路径"的逻辑（`loadLegRoutes` + `legRoutes`
     * 缓存 + 越界说明）跟着删掉了 —— 它存在的唯一目的就是画那条线。
     *
     * 路线在**行程页**看（那里有地图卡与目的地连线）。
     * 本页是「队伍」：只看人 —— 我的位置、集合点、队员。
     *
     * ⚠️ 下面那条**集合点虚线要保留**：它不是路线，而是
     *    "从这里走到集合点"的直线示意，属于集合功能的一部分。
     */
    const polyline = []

    if (isValidPoint(this.data.myPoint) && isValidPoint(mp)) {
      polyline.push({
        points: [
          this.data.myPoint,
          { latitude: mp.latitude, longitude: mp.longitude },
        ],
        color: '#0FA98A',
        width: 4,
        dottedLine: true,
        arrowLine: true,
      })
    }

    ;(this.teamLocations || []).filter(m => m.userId !== this.data.me && isValidPoint(m.point))
      .sort((a, b) => a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0).forEach((m, i) => {
        const markerId = 2000 + i
        if (m.memberKey && !m.stale && !m.sharingOff) markerMembers.set(markerId, m.memberKey)
        markers.push({
          id: markerId, latitude: m.point.latitude, longitude: m.point.longitude,
          iconPath: this.memberAvatar(m), width: 40, height: 40,
          alpha: m.stale ? 0.25 : 1,
          callout: { content: (memberLabels.get(m.userId) || '未命名') + (m.stale ? '\n上次位置（已过期）' : ''),
            display: 'ALWAYS', color: '#1F2933', fontSize: 12, borderRadius: 6, bgColor: '#FFFFFF', padding: 6 },
        })
      })
    if (this.chatCallouts) for (const marker of markers) {
      // 本机图钉已由 myPoint 定位；本人消息不再等待云端位置上报/成员列表同步。
      // 队友仍须用稳定成员键匹配有效共享位置，不能按昵称或相邻坐标推断。
      const message = (marker.id === 999 && this.chatCallouts.getOwn()) ||
        this.chatCallouts.get(markerMembers.get(marker.id))
      // 用户名始终独立保存；消息通过自定义气泡展示，不能把两者拼入同一个 callout。
      if (message && marker.callout) marker.chatBubble = { content: message.text,
        fontSize: 12, padding: 8 }
    }
    /**
     * ⚠️ 这里**不再**单独为 `teamMeeting` 画一个图钉（2026-10-14 去掉）。
     *
     * 原因：进行中的集合现在会通过 `syncMeetingSelection()` 变成
     * `meetingPoint`，再由上面那段画出"选中"的针。
     * 两处都画会在同一坐标上叠两个针 —— 看起来像一个画重了的 bug，
     * 而且下面的针永远点不到。
     */
    const invalid = [this.data.myPoint, this.data.meetingPoint].filter(p => p && !isValidPoint(p)).length +
      (this.teamLocations || []).filter(m => !isValidPoint(m.point)).length + (this.invalidTeamLocations || 0)
    const laidOutMarkers = layoutMarkerLabels(markers, this.markerLayoutScale || this.data.scale)
    const memberChatCallouts = laidOutMarkers.filter(marker => marker.chatBubble).map(marker => ({
      id: marker.id, name: marker.callout.content, nameColor: marker.callout.color,
      lines: marker.chatBubble.content.split('\n'),
      width: marker.chatBubble.width,
      groupWidth: marker.chatBubble.groupWidth,
    }))
    this.setData({ markers: laidOutMarkers, memberChatCallouts, polyline, markerPlaceIndex,
      ...(shared ? { meetingPoint: mp, pickMode: false } : {}),
      coordinateError: shared && !mp ? '集合点坐标异常，请刷新队伍信息；暂不显示其他选点代替。'
        : invalid ? '部分位置坐标异常，已跳过显示，请重新定位或选择集合点' : '',
    })
  },

  /** 仅在异常变化时记录来源与坏坐标，不输出成员身份或完整位置列表。 */
  logInvalidCoordinates(source, points) {
    const invalid = points.filter(p => !isValidPoint(p)).map(p => ({
      latitude: p && p.latitude,
      longitude: p && p.longitude,
    }))
    const signature = JSON.stringify(invalid)
    this.coordinateIssueSignatures = this.coordinateIssueSignatures || {}
    if (this.coordinateIssueSignatures[source] === signature) return
    this.coordinateIssueSignatures[source] = signature
    if (invalid.length) console.warn('[team-map:coordinate-guard-v2] 已拦截异常坐标', {
      source, count: invalid.length, points: invalid.slice(0, 5),
    })
  },
})

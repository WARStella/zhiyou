/**
 * 行程页面 —— 计划书 §5.1。
 *
 * 节点展示要求（§5.1）：
 *   地点与预计到达时间 · 建议停留时间 · 前往下一站的预计时间 ·
 *   已完成/当前/待游览状态 · **与计划相比发生的变化**
 *
 * 调整候选的展示规则（§5.2）—— **两条是展示上限，不是必须凑齐的配额**：
 *   两条不同可行方案 → 展示差异与取舍
 *   两种策略结论一致 → **合并为一条**，说明结论一致
 *   只有一条可行方案 → 展示一条，并说明限制条件
 *   没有可行方案     → **指出冲突所在，请用户选择调整哪个条件**
 *
 * ── 输入方式（2026-10-13 补）──────────────────────────────
 * 本页是**手动模式**：搜索/浏览地点 → 勾选 → 生成路线 → 快捷调整。
 *
 * 10/15 之后 AI 解析接进来时，只需把"输入关键词"换成"说一句话"，
 * 调用的接口完全不变（`place.search` / `trip.plan` / `trip.adjust`）。
 * 这也是计划书 §十 的 P0／P1 分界所在。
 */

const api = require('../../utils/api')
const { requestMinutes } = require('../../utils/stay-duration')
const { suggestOrder } = require('../../utils/route-order')
const { isValidPoint } = require('../../utils/coordinates')
const { appendSpeech } = require('../../utils/speech-input')
const { greetingView, buildTripDisplay } = require('../../utils/trip-display')

/**
 * 用户可以选的出行方式 —— **与后端 `lib/mode-choice.js` 的 MODE_OPTIONS 同一份口径**。
 *
 * ⚠️ 前端不能自己另编一套名字：两处漂移之后，
 * 界面显示"公交地铁"而后端只认 `transit`，排查起来很费劲。
 * （这里仍是前端的一份拷贝，因为小程序页面不方便直接 require 云函数代码；
 *   `test/trip-page.test.js` 有一条断言守着两边一致。）
 */
const MODE_OPTIONS = [
  { value: 'auto', label: '自动（按最快）' },
  { value: 'walking', label: '步行' },
  { value: 'bicycling', label: '骑行' },
  { value: 'driving', label: '驾车' },
  { value: 'transit', label: '公交地铁' },
  { value: 'subway', label: '地铁优先' },
]

const MODE_HINT = {
  auto: '按各方式的真实耗时自动挑最快的',
  walking: '尽量步行走过去 —— 太远的段会改用别的可行方式，并说明原因',
  bicycling: '优先骑行 —— 雨雪天可能不适合',
  driving: '优先驾车 —— 打车或自驾',
  transit: '优先公交地铁 —— 需要高德 Key 已配置',
  subway: '优先选择含地铁的路线，可能需要公交接驳',
}

const STATUS_LABEL = {
  pending: '待游览',
  arrived: '已到达',
  done: '已完成',
  skipped: '已跳过',
}

/**
 * 出行方式的中文名与图标。
 *
 * ⚠️ 在此之前时间轴上是这么写的：
 *
 *     mode: next.travelMode === 'walking' ? '步行' : ''
 *
 * —— **除步行以外全渲染成空白**。而哈尔滨的景点跨区，公交与驾车是常态，
 * 于是界面上会出现"两个站之间什么都不显示"。那是我在接入多种方式时漏掉的。
 *
 * 名字与后端 `lib/mode-choice.js` 的 MODE_LABEL 保持一致口径。
 *
 * `icon` 是 emoji（出行方式选择区仍在用，测试也断言了这些值）；
 * `art` 是 2026-10-20 新增的**线性图标**（48px、4px 描边），
 * 只用在时间轴与进度卡的路程文字前 —— 一屏四段路，emoji 太花，
 * 线性图更干净，也能和整体细线条的界面融为一体。
 */
const MODE_LABEL = {
  walking: { name: '步行', icon: '🚶', art: '/assets/mode/walk.png' },
  bicycling: { name: '骑行', icon: '🚲', art: '/assets/mode/bike.png' },
  driving: { name: '驾车', icon: '🚗', art: '/assets/mode/car.png' },
  transit: { name: '公交', icon: '🚇', art: '/assets/mode/bus.png' },
  subway: { name: '地铁', icon: '🚇', art: '/assets/mode/subway.png' },
}

/**
 * 「为什么选这个方式」这句要不要上屏 —— **白名单**，只放两种。
 *
 *   · 没按用户选的来：`你想用步行，但……已改为驾车（13 分钟）`
 *   · 雨雪天安全：`雨雪天以安全为主：……`
 *
 * 其余一律不显示（2026-10-22 用户两次要求删掉这类文字）：
 *   · `骑行最快：3.4 分钟，比步行（9 分钟）省 5.6 分钟`
 *   · `按你选的骑行：21.3 分钟，比驾车（13 分钟）多 8.3 分钟`
 *   · `你选的步行：8 分钟（同时也是最快的方式）`
 *   · `只取到了步行：13 分钟`
 * 方式、分钟数、距离在路段同一行已经显示过；"最快"用 `（最快）` 小标记表达。
 * 数据里的 `reason` 原样保留（测试与诊断要用），这里只决定渲染。
 */
function showReason(reason) {
  const text = String(reason || '')
  return /^你想用/.test(text) || /^雨雪天/.test(text)
}

/**
 * 这一段的方式是不是"最快"的那个。
 *
 * 后端在自动选方式时会回「X最快：…」；既然那句比较文案不再上屏，
 * 就把其中唯一有用的信息——**这就是最快的方式**——压缩成一个小标记显示。
 * 用户选了一个更慢的方式时不会命中（那时理由是「按你选的…多 N 分钟」）。
 */
const isFastestReason = (reason) => /最快[：:]/.test(String(reason || ''))

/** 换算成人能读的出行方式说明；取不到就如实说"未知"，不留空 */
function modeInfo(mode, transit) {
  if ((mode === 'transit' || mode === 'subway') && transit && transit.hasSubway) {
    return {
      name: transit.hasBus ? '公交＋地铁' : '地铁',
      icon: '🚇',
      art: transit.hasBus ? '/assets/mode/bus.png' : '/assets/mode/subway.png',
    }
  }
  return MODE_LABEL[mode] || { name: '', icon: '', art: '' }
}

/**
 * 这个数可不可信 —— 与"怎么走"是**两个维度**，必须分开显示。
 *
 *   survey    踏勘实测，最可信
 *   upstream  地图接口返回的真实路线（**预测**，不是实测）
 *   estimated 直线估算 —— 短距离下与真实路线能差 7 倍
 */
const SOURCE_LABEL = {
  survey: '踏勘实测',
  upstream: '地图计算',
  estimated: '直线估算',
  none: '',
}

/** 公共交通摘要：保留线路号与总票价，省略方向、站点和出入口。 */
function describeTransit(t) {
  if (!t) return ''
  const parts = []
  if (t.lineNames && t.lineNames.length) {
    parts.push(t.lineNames.map(name => String(name).replace(/[（(].*$/, '').replace(/路$/, '').trim()).filter(Boolean).join('/'))
  }
  parts.push(typeof t.costYuan === 'number' ? `总价${t.costYuan}元` : '票价未知')
  return parts.join(' ')
}

/**
 * 进度操作 —— **记录事实**，不重新规划。
 *
 * 与 `多停/少停/不去了` 那组（走 trip.adjust，会重新规划行程）是两回事：
 *   · 进度：我到了 / 我逛完了 / 我其实没去   → 记录实际发生的事
 *   · 调整：多待一会儿 / 不去了             → 改计划，要重算后续
 *
 * 混在一起会让人以为"标记已到达"也会改路线 —— 那是两件不同的事。
 */
/**
 * 「到过」= 真的去过。`skipped` **不算** —— 跳过就是没去。
 *
 * ⚠️ 这个区分踩过两次坑，都记在这里：
 *   ① 地图上把 skipped 也算成走过，绿线会画到一个没去过的地方；
 *   ② 时间轴上用"**本节点**走完了"来判定"**本节点→下一节点**这段走过了" ——
 *      **位置反了**。点完 1 号的「逛完了」，你还没走到 2 号，那一段当然没走过。
 *      正确判据是**下一站到了没有**：到了下一站，才说明这一段走完了。
 */
const isReached = (status) => status === 'arrived' || status === 'done'
const navigationKey = (trip, leg) => trip && leg ? JSON.stringify([trip.tripId, trip.version,
  leg.toNodeId, leg.rawMode, leg.toLocation.latitude, leg.toLocation.longitude]) : ''

const PROGRESS_ACTIONS = {
  pending: [{ status: 'arrived', label: '到了' }],
  arrived: [{ status: 'done', label: '逛完了' }],
  // 允许撤销：点错了要能改回来，否则只能重新生成行程
  done: [{ status: 'pending', label: '撤销' }],
  skipped: [{ status: 'pending', label: '撤销' }],
}

function hhmm(value) {
  if (!value) return '--:--'
  const d = new Date(value)
  if (isNaN(d.getTime())) return '--:--'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function timeText(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 把 HH:mm 落到今天的时间点 */
function todayAt(text) {
  const d = new Date()
  const [hh, mm] = text.split(':')
  d.setHours(Number(hh), Number(mm), 0, 0)
  return d
}

/**
 * 把候选转成"已选"。
 *
 * ⚠️ **必须带上完整的地点数据**（2026-10-13 改）。
 *
 * 检索结果**不入库**（用户决定：全从腾讯地图实时搜），所以
 * `trip.plan` 不能再靠 `placeIds` 回库读 —— 它接受内嵌的 `places`。
 * 于是这里要把规划需要的字段一并带着走；`placeId` 只是"库里有这条
 * （踏勘过）"的标记，**没有它照样能规划**。
 *
 * 身份键是 `itemId`（稳定，与是否入库无关，见 lib/place-id.js）。
 */
function selectedOf(c, reason) {
  return {
    itemId: c.itemId,
    visitId: api.newRequestId(),
    /** 库里踏勘过的地点才有；没有就是 null */
    placeId: c.placeId || null,
    poiId: c.poiId || null,
    name: c.name,
    category: c.category,
    location: c.location,
    verified: c.verified,
    visitDurationMin: c.visitDurationMin || null,
    reason: reason || '',
  }
}

Page({
  data: {
    // ── 需求输入 ──
    keyword: '',
    greeting: { dateLabel: '', title: '你好' },
    viewerNickname: '',
    tripDisplay: null,
    sourcePanelOpen: false,
    changePanelOpen: false,
    planningVoiceActive: false,
    /** 「时间与停留」折叠区：默认收起，标题行直接显示当前值 */
    planningAdvancedOpen: false,
    changeVoiceActive: false,
    /** 意图解析结果（解释 + 待确认项）—— 界面要让人看见"系统理解成了什么" */
    intent: null,
    startAtText: '',
    startAt: '',
    /**
     * 出发时间是否是用户（或解析结果）明确指定的。
     *
     * ⚠️ 实测踩到的坑：`onLoad` 把出发时间设成"页面打开的那一刻"，
     * 用户如果在页面上停留了十几分钟再生成路线，**行程会从过去开始算** ——
     * 到达时间比当前时间还早。
     * 所以：没人手动指定时，生成路线的那一刻重新取"现在"。
     */
    startAtManual: false,
    /** 「逛一小时」→ 60；null 表示用地点自带默认值 */
    stayMin: null,
    /** 每个地点时长不同时按地点给：{"哈工大": 60, "冰雪大世界": 120} */
    stayByText: null,
    /**
     * **当前出行段**：从已经走到的地方，到下一站 —— 出行方式、时长、距离、目的地坐标。
     * 不是"站的顺序"，而是行走时真正要看的东西，也是导航需要的全部输入。
     */
    currentLeg: null,
    /** 应用内导航取到的这一段真实路线（含转向指引）；null 表示没在导航 */
    navLeg: null,
    navLoading: false,
    navError: '',
    navHint: '',
    endAtText: '',
    endAt: '', // 空字符串 = 不限
    /** 结束时间是从解析结果填进来的（不是用户手选的）—— 要标明 */
    endAtFromParse: false,
    enrichWalk: false,
  /**
   * 出行方式偏好（2026-10-14）。
   *
   * 缺省 `auto` = 让系统按真实耗时挑最快的 —— 与接入之前的行为一致，
   * 所以老用户不会因为这次改动感到变化。
   *
   * `modeIndex` 是 picker 用的下标；`preferredMode` 是发给后端的值。
   * 两个都要存：picker 只认下标，而后端只认值。
   */
  modeOptions: MODE_OPTIONS,
  modeIndex: 0,
  preferredMode: 'auto',
  modeHint: MODE_HINT.auto,
  /**
   * 出行方式的**显示文案** —— 在 JS 里算好，模板只做插值。
   *
   * ⚠️ 原来模板里写的是 `{{modeOptions[modeIndex].label}}`。
   * 它**当时没炸**，只因为 `modeOptions` 的初始值不是空数组（有 5 项）。
   * 这是**侥幸**：顺序发号那批我在「我的」页写了同样的写法，
   * 而那里的数组初始是空的 —— 首帧直接抛
   * `Cannot read properties of undefined (reading '0')`，整页白屏。
   *
   * 现在两处都算在 JS 里，模板不做数组索引。
   */
  modeLabel: MODE_OPTIONS[0].label,

  /**
   * 出行方式是**用户手动点出来的**（2026-10-14 加）。
   *
   * ⚠️ 只有真的动过 picker 才算。`intent.parse` 从"我想骑车去哈工大"
   *    解析出的方式**不算** —— 用户只是说了一句要去哪儿，并没有逐段确认。
   *    把它也算成 manual，会让每段方式选择器**再也不弹**：
   *    用户换了目的地、重新生成路线，系统仍用着上次的方式，而他没机会重选。
   */
  modeManual: false,
  /** 当前这个方式是**从那句话解析来的**（界面上要给个小标注） */
  modeFromParse: false,

  /**
   * 逐段出行方式选择器（2026-10-14）。
   *
   * `legPickerOpen`：新路线的集中选择；关闭后从时间轴的具体路段修改。
   * `legEditor`：单段修改草稿，独立于集中选择，取消时不影响已保存行程。
   */
  legPicker: [],
  legPickerUsingRecommended: true,
  legPickerOpen: false,
  legEditor: null,
  startLegEditable: false,
  legPickerSeen: false,
  legOptionsCount: 0,
  rawLegOptions: [],
  legModes: {},
  /**
   * 用户在某句话里**按目的地**说过的出行方式：
   * `{ '哈工大': 'bicycling' }`（2026-10-14 用户要求）。
   *
   * ⚠️ 与 `preferredMode`（一个全局值）不同：那是"整趟都这样"，
   *    这是"**到那个地方**这样"。用户说「我想骑车去哈工大，再去冰雪大世界」
   *    时，骑车只属于哈工大那一程 —— 冰雪大世界那程留给他自己选。
   */
  parsedLegModes: {},
  /** 那个方式是"整趟的默认"（用户说了方式但没说是去哪） */
  modeIsGlobal: false,

    // ── 候选（搜索结果或已知地点）──
    mode: 'browse', // browse | search
    candidates: [],
    unselectedCandidateCount: 0,
    autoCandidates: false,
    otherCandidatesExpanded: false,
    rankingNote: '',
    locating: false,

    // ── 已选（勾选顺序即游览顺序）──
    selected: [],

    // ── 行程 ──
    trip: null,
    /** 后端原样的节点数组 —— 记录进度后要拿它重建界面 */
    rawNodes: [],
    timeline: [],
    summary: null,
    routeMap: null,
    routeMapOpen: true,
    walkTimes: null,
    startPoint: null,
    startLeg: null,
    currentNodeIndex: 0,
    unverifiedNotice: null,

    // ── 调整候选 ──
    proposal: null,
    proposalMode: null,
    proposalNote: '',
    proposalCandidates: [],
    changeText: '',
    changeDraftId: '',
    changeQuestions: [],
    changeAnswers: {},
    changeInterpretation: null,
    changeSummary: [],
    changeTurns: [],
    changeError: '',
    changeNeedsRewrite: false,

    // ── 状态 ──
    loading: false,
    busy: '',
    error: '',
    note: '',
    conflicts: [],
    planRejected: false,
  },

  async onShow() {
    this.navigationVisible = true
    this.refreshGreeting()
    this.loadGreetingProfile()
    const created = wx.getStorageSync('zhiyou-guide-created-trip')
    if (created && created.tripId) {
      const token = (this.tripLoadToken || 0) + 1
      this.tripLoadToken = token
      this.setData({ loading: true, error: '' })
      try {
        const res = await api.callApi('trip.get', { tripId: created.tripId })
        if (token !== this.tripLoadToken || this.navigationVisible === false) return
        if (!res || !res.ok) throw new Error(res && res.error && res.error.message || '无法读取助手生成的行程，请重试')
        const latest = wx.getStorageSync('zhiyou-guide-created-trip')
        if (!latest || latest.tripId !== created.tripId) return
        this.applyFetchedTrip(res.data.trip, created.tripId, '已载入助手生成的行程', null)
        wx.removeStorageSync('zhiyou-guide-created-trip')
      } catch (e) {
        if (token === this.tripLoadToken && this.navigationVisible !== false) this.setData({ loading: false, error: e.message || '读取行程失败，请重新进入行程页' })
      }
    }
    const pending = wx.getStorageSync('zhiyou-guide-trip-refresh')
    if (pending && this.data.trip && pending.tripId === this.data.trip.tripId) {
      wx.removeStorageSync('zhiyou-guide-trip-refresh')
      if (pending.version > this.data.trip.version) await this.refreshTextTrip(pending.tripId, '已同步助手确认的新行程')
    }
    if (this.data.trip) this.rebuildFromNodes()
    /**
     * 2026-10-24：冷启动 / 页面重建后恢复“当前行程”。
     *
     * 之前只在内存里保留 trip：小程序被系统回收、或页面重建后，`data.trip`
     * 是空的，而这里又从来不读 `zhiyou-active-trip`，于是用户会觉得
     * “我的行程没了”（退队、切后台、重启都会触发）。
     * 指针一直在 storage 里，补一次 `trip.get` 就能恢复。
     */
    if (!this.data.trip) this.restoreActiveTrip()
  },

  /**
   * 从 `zhiyou-active-trip` 恢复当前行程。
   *
   * 指针无效（行程被删、退队后无权访问）时清掉指针并回到“今天想去哪”，
   * 但**不把错误糊在页面上** —— 没有行程是正常状态。
   */
  restoreActiveTrip() {
    let saved = null
    try { saved = wx.getStorageSync('zhiyou-active-trip') } catch (e) { saved = null }
    const tripId = saved && (typeof saved === 'object' ? saved.tripId : saved)
    if (!tripId || this.restoringTrip) return
    this.restoringTrip = true
    const token = (this.tripLoadToken || 0) + 1
    this.tripLoadToken = token
    this.setData({ loading: true, error: '' })
    const done = () => { this.restoringTrip = false }
    api.callApi('trip.get', { tripId }).then(res => {
      if (token !== this.tripLoadToken || this.navigationVisible === false) { done(); return }
      if (!res || !res.ok) {
        const code = res && res.error && res.error.code
        if (['NOT_FOUND', 'FORBIDDEN', 'FORBIDDEN_NOT_MEMBER', 'AUTH_REQUIRED'].includes(code)) {
          try { wx.removeStorageSync('zhiyou-active-trip') } catch (e) { /* 忽略 */ }
          done()
          this.setData({ loading: false, trip: null })
          return
        }
        throw new Error((res && res.error && res.error.message) || '读取当前行程失败')
      }
      if (this.data.trip && this.data.trip.tripId === res.data.trip.tripId) {
        done()
        this.setData({ loading: false })
        return
      }
      done()
      this.applyFetchedTrip(res.data.trip, tripId, '', null)
    }).catch(e => {
      done()
      if (token === this.tripLoadToken && this.navigationVisible !== false) {
        this.setData({ loading: false, error: (e && e.message) || '读取当前行程失败，请重新进入行程页' })
      }
    })
  },
  onHide() {
    this.navigationVisible = false
    this.greetingToken = (this.greetingToken || 0) + 1
    this.tripLoadToken = (this.tripLoadToken || 0) + 1
    this.cancelNavigationRequest()
    this.setData({ navLoading: false })
  },
  onUnload() { this.navigationVisible = false; this.greetingToken = (this.greetingToken || 0) + 1; this.tripLoadToken = (this.tripLoadToken || 0) + 1; this.navigationRequested = false; this.cancelNavigationRequest() },

  onLoad() {
    const now = new Date()
    this.refreshGreeting(now)
    this.setData({ startAtText: timeText(now), startAt: now.toISOString() })
    this.restoreModePreference()
    this.loadKnown()
  },

  refreshGreeting(now = new Date()) {
    this.setData({ greeting: greetingView(this.data.viewerNickname, now) })
  },

  /** 昵称只读真实资料，失败显示普通问候，不影响行程。 */
  loadGreetingProfile() {
    const app = getApp()
    if (!app.globalData || !app.globalData.cloudReady) return
    const token = (this.greetingToken || 0) + 1
    this.greetingToken = token
    return api.callApi('user.getProfile', {}).then(res => {
      if (token !== this.greetingToken || this.navigationVisible === false || !res || !res.ok) return
      const profile = res.data && res.data.profile
      this.setData({ viewerNickname: profile && typeof profile.nickname === 'string' ? profile.nickname : '' })
      this.refreshGreeting()
    }).catch(() => {})
  },

  focusRouteMap() {
    if (!this.data.routeMap) return
    this.setData({ routeMapOpen: true }, () => {
      this.fitRouteMap()
      this.scrollToRouteMap()
    })
  },

  toggleRouteMap() {
    if (this.data.routeMapOpen) this.setData({ routeMapOpen: false })
    else this.focusRouteMap()
  },

  viewCurrentRoute() {
    if (this.data.navLoading) return
    this.focusRouteMap()
    if (!this.data.navLeg || this.data.navError) return this.startNavigation()
  },

  toggleSourcePanel() { this.setData({ sourcePanelOpen: !this.data.sourcePanelOpen }) },

  /**
   * 读**默认出行方式**（2026-10-14 改）。
   *
   * ── 为什么读本地缓存而不是每次调接口 ──────────────────────
   *
   * 唯一入口是「我的 → 默认出行方式」，那一页保存时会把值
   * **镜像**到本地（`zhiyou-preferred-mode`），本页只读它。
   * 本页 `onLoad` 需要同步拿到值来渲染，走接口会先显示一帧错的。
   *
   * ⚠️⚠️ **本页不再写这个 key**。以前 `onModeChange` 会写 ——
   *    于是"默认出行方式"有了**两份真相**：
   *      · 「我的」写服务端字段（跨设备有效）
   *      · 本页写本地（只在这台设备上）
   *    用户在「我的」改成步行，回行程页又被本地那份覆盖回去。
   *    现在本页**只读不写**，写入方只有「我的」。
   *
   * ⚠️ 认不出的值一律退回 `auto`，**不要报错**：
   * 这个值存在本地，可能来自旧版本（比如以后删掉某个选项）。
   * 为一个显示用的偏好让整个页面打不开是不值得的。
   */
  restoreModePreference() {
    let saved = ''
    try {
      saved = wx.getStorageSync('zhiyou-preferred-mode') || ''
    } catch (err) {
      saved = ''
    }
    const idx = MODE_OPTIONS.findIndex((o) => o.value === saved)
    if (idx < 0) return
    this.setData({
      modeIndex: idx,
      preferredMode: MODE_OPTIONS[idx].value,
      modeHint: MODE_HINT[MODE_OPTIONS[idx].value] || '',
      modeLabel: MODE_OPTIONS[idx].label,
    })
  },

  // ══════════ 候选来源 ══════════

  /** 浏览模式：列出已知地点（含踏勘核验过的） */
  loadKnown() {
    const that = this
    this.setData({ loading: true, error: '' })
    api
      .callApi('place.list', {})
      .then(function (res) {
        if (!res || res.ok !== true) {
          that.setData({ loading: false, error: (res && res.error && res.error.message) || '地点加载失败' })
          return
        }
        that.setCandidates(
          (res.data.places || []).filter(p => !/^PLACEHOLDER(?:_|$)/i.test(p.dataSource || '') && !/[（(]占位[）)]/.test(p.name || '')).map(function (p) {
            return {
              itemId: p.placeId,
              placeId: p.placeId,
              poiId: p.poiId || null,
              location: p.location,
              visitDurationMin: p.visitDurationMin || null,
              name: p.name,
              category: p.category,
              verified: p.verified,
              tripNodeAllowed: p.tripNodeAllowed,
              meetingPointAllowed: p.meetingPointAllowed,
              distanceText: '',
              durationText: '',
            }
          }),
          'browse',
          ''
        )
        that.setData({ loading: false })
      })
      .catch(function (err) {
        that.setData({ loading: false, error: (err && err.errMsg) || '地点加载失败' })
      })
  },

  /**
   * 尝试取当前位置，用于按"离我多远"排序。
   * **失败不阻断搜索** —— 退回后端默认中心（哈尔滨），并在界面上说明。
   */
  tryLocate() {
    return new Promise(function (resolve) {
      wx.getLocation({
        type: 'gcj02',
        isHighAccuracy: true,
        highAccuracyExpireTime: 4000,
        success: function (res) {
          resolve(isValidPoint(res) ? { latitude: res.latitude, longitude: res.longitude } : null)
        },
        fail: function () {
          resolve(null)
        },
      })
    })
  },

  // ══════════ 需求输入 ══════════

  onKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },

  /** 展开 / 收起「时间与停留」的可选微调 */
  togglePlanningAdvanced() {
    this.setData({ planningAdvancedOpen: !this.data.planningAdvancedOpen })
  },

  usePlanningExample(e) {
    if (!this.data.loading && !this.data.busy) this.setData({ keyword: e.currentTarget.dataset.text })
  },

  toggleChangePanel(e) {
    if (this.data.changeVoiceActive || this.data.busy) return
    const focus = e && e.currentTarget.dataset.focus
    this.setData({ changePanelOpen: focus ? true : !this.data.changePanelOpen }, () => {
      if (focus) wx.pageScrollTo({ selector: '#trip-change-panel', duration: 250, fail: () => {} })
    })
  },

  onPlanningVoiceState(e) { this.setData({ planningVoiceActive: Boolean(e.detail.active) }) },
  onChangeVoiceState(e) { this.setData({ changeVoiceActive: Boolean(e.detail.active) }) },

  onKeywordVoice(e) {
    if (this.data.trip || this.data.loading || this.data.busy) return
    if (e.detail.contextKey !== undefined && e.detail.contextKey !== 'planning') return
    const value = appendSpeech(this.data.keyword, e.detail.text, 1000)
    if (value === null) { wx.showToast({ title: '语音为空或合并后超过1000字，请分段输入', icon: 'none' }); return }
    this.onKeyword({ detail: { value } })
  },

  onEnrichChange(e) {
    this.setData({ enrichWalk: e.detail.value })
  },

  /**
   * ⚠️ `onModeChange` **已删除**（2026-10-14 用户要求）。
   *
   * 用户原话："在行程页面把那个出行方式默认为最快的那条给删了，
   *            **这个本应在【我的】页面的【设置】里**"
   *
   * 他说得对：本页那个 picker 与「我的 → 默认出行方式」是**重复的真相** ——
   * 那一个写服务端字段（跨设备有效），这一个写本地 storage，
   * 用户在「我的」改成步行、回本页又被本地那份覆盖回去。
   *
   * 现在唯一入口是「我的」。本页 `restoreModePreference()` **只读不写**，
   * 读到的值作为规划的默认偏好发给后端。
   *
   * ⚠️ **逐段选择器仍然在本页**（`onLegModeTap` / `applyLegModes`）——
   *    那不是"默认偏好"，而是"这一趟每一段怎么走"的行程内决定。
   */

  /**
   * 统一的输入入口：**先理解意图，再检索地点**。
   *
   * 这样用户既可以输入一句话（"我下午想去中央大街附近逛逛，五点前结束"），
   * 也可以只输入一个词（"教堂"）—— 后者会被识别成类别词，效果与普通搜索一致。
   *
   * 解析出来的约束**不会自动生效**：明确的才填进表单，含糊的进 uncertainties
   * 让用户选（§6.2）。
   */
  doSearch() {
    if (this.data.loading || this.data.busy || this.data.planningVoiceActive) return
    const that = this
    const text = (this.data.keyword || '').trim()
    if (!text) {
      this.setData({ note: '请输入一句话，或一个地点名称' })
      return
    }

    this.setData({ loading: true, error: '', note: '正在理解你的需求…', intent: null })

    api
      .callApi('intent.parse', { text: text })
      .then(function (res) {
        const d = res && res.ok === true ? res.data : null

        // 解析失败不阻断：退化成"直接当地点搜"，并说明发生了什么
        if (!d || d.ok !== true) {
          that.setData({
            intent: null,
            note: '需求理解不可用（' + ((d && d.message) || '未知原因') + '），已按地点名称直接搜索',
          })
          return that.runPlaceSearch(text)
        }

        const patch = {
          intent: {
            parserLabel:
              d.parser === 'http'
                ? '模型理解' + (d.model ? '（' + d.model + '）' : '')
                : '规则理解',
            degraded: d.degraded === true,
            /**
             * 降级提示的措辞要**准确而不吓人**：
             * 没配模型不是故障，规则解析同样是设计内的正式路径（§6.5）。
             * 说成"模型不可用"会让人以为系统坏了。
             */
            degradationNote:
              d.degraded === true && d.attempts && d.attempts.length
                ? '未配置大模型，当前用规则解析（结果可复现，功能完整）'
                : '',
            explanation: d.explanation || [],
            uncertainties: d.uncertainties || [],
            searchKeyword: d.searchKeyword || null,
          },
        }

        // 解析出的时间填进表单 —— 但要让用户看得见它是解析来的
        patch.startAtManual = false
        if (d.structured && d.structured.startAt) {
          const st = new Date(d.structured.startAt)
          patch.startAtText = timeText(st)
          patch.startAt = st.toISOString()
          patch.startAtManual = true
        }
        if (d.structured && d.structured.endAt) {
          const end = new Date(d.structured.endAt)
          patch.endAtText = timeText(end)
          patch.endAt = end.toISOString()
          patch.endAtFromParse = true
        }
        // 「逛一小时」→ 每站停留 60 分钟（不给则用地点自带默认值）
        patch.stayMin = (d.structured && d.structured.stayMin) || null
        /**
         * 每个地点时长不同时按地点给：`{"哈工大": 60, "冰雪大世界": 120}`。
         * 规划器按地点名匹配，匹配不上才回落到 stayMin。
         */
        patch.stayByText = (d.structured && d.structured.stayByText) || null

        /**
         * ── 出行方式：**按目的地分别记**（2026-10-14 用户要求）──────
         *
         * 用户原话：
         *   "若多个地名则**只自动选择用户说过出行方式的目的地**
         *    （我想骑车去哈工大，再去冰雪大世界 —— 只是去哈工大的出行方式
         *      选择为骑车，**冰雪大世界依旧需要用户自己选择**）"
         *
         * ⚠️ 出行方式是"**到某个目的地**"的属性，不是整句话的属性。
         *
         *   用户这句话里对某个地方说了方式 → **那一程**用它
         *   说了方式但没说是去哪（"我想骑车去"）→ 当整趟的默认
         *   什么都没说                        → 用「我的」里设的默认值
         *
         * ⚠️ `preferredModeByText` 的键是**用户原话里的地名**，
         *    与 `selected[].name` 是对得上的（都是检索命中的那个名字）。
         *    对不上就不硬套 —— 宁可让用户自己选，也不要张冠李戴。
         */
        const parsedMode = d.structured && d.structured.preferredMode
        if (parsedMode) {
          const idx = MODE_OPTIONS.findIndex(function (o) {
            return o.value === parsedMode
          })
          if (idx >= 0) {
            patch.preferredMode = MODE_OPTIONS[idx].value
            patch.travelModeIndex = idx
            patch.modeLabel = MODE_OPTIONS[idx].label
            patch.modeFromParse = true
          }
        }
        /** 按地名生效的那一份 —— 逐段选择器用它预选 */
        patch.parsedLegModes = (d.structured && d.structured.preferredModeByText) || {}
        patch.modeIsGlobal = Boolean(d.structured && d.structured.modeIsGlobal)

        that.setData(patch)

        const kw = d.searchKeyword
        /**
         * ⚠️ **多关键词检索**（2026-10-13 实测修正）。
         *
         * 用户说「先去哈工大玩一小时再去冰雪大世界玩3小时」，
         * 而首版只拿 `searchKeyword` 一个词去搜 —— 冰雪大世界根本没进候选，
         * 用户看到的全是哈工大的各种门。
         *
         * **用户说了几个地方，就要搜几次。**
         */
        const kws = (d.searchKeywords || []).length ? d.searchKeywords : kw ? [kw] : []
        if (!kws.length) {
          that.setData({
            loading: false,
            note: '没能从这句话里认出要去的地方，请补充一个地名，或直接输入地点名称',
          })
          return null
        }
        // 传 d 进去 → 检索完会**自动预选**，用户可以直接生成路线
        return that.runPlaceSearch(kws, d)
      })
      .catch(function (err) {
        that.setData({ note: '理解失败，已按地点名称直接搜索' })
        that.runPlaceSearch(text)
        if (err && err.errMsg) console.warn(err)
      })
  },

  /**
   * 按解析出的需求**预选**地点。
   *
   * ⚠️ 规则本身在**服务端**（`place.search` 的 `autoPick`），不在这里。
   * 这里是业务规则（节奏决定选几个、必去必选、不自动选公交站），
   * 而小程序端没有测试环境 —— 规则写在这儿等于没测过。
   * 这里只负责把结果渲染出来。
   */
  applyAutoSelect(candidates, picked) {
    if (!picked || !picked.itemIds || !picked.itemIds.length) {
      this.setData({
        selected: [],
        autoCandidates: true,
        otherCandidatesExpanded: false,
        candidates: candidates.map((x) => Object.assign({}, x, { selected: false })),
        unselectedCandidateCount: candidates.length,
        note: (picked && picked.note) || '按你的需求没找到合适的地点，请换个说法或直接搜索',
      })
      return
    }

    const ids = picked.itemIds
    /** 预选理由 —— 直接显示在游览顺序里，用户一眼能看出"为什么是它" */
    const reasonOf = {}
    ;(picked.items || []).forEach(function (x) {
      reasonOf[x.itemId] = x.reason
    })

    const selected = ids.map(id => candidates.find(x => x.itemId === id)).filter(Boolean)
      .map((x) => selectedOf(x, reasonOf[x.itemId] || ''))

    const missingNote = (picked.keywordsMissing || []).length
      ? `；**没找到**：${picked.keywordsMissing.join('、')}`
      : ''

    this.setData({
      selected: selected,
      autoCandidates: true,
      otherCandidatesExpanded: false,
      unselectedCandidateCount: candidates.filter(x => !ids.includes(x.itemId)).length,
      candidates: candidates.map((x) =>
        Object.assign({}, x, { selected: ids.indexOf(x.itemId) >= 0 })
      ),
      note: picked.note + missingNote + '。可以直接生成路线，也可以自己增减。',
    })
  },

  /** 用关键词检索外部地点。`autoFrom` 给出解析结果时，检索完会**自动预选**。 */
  runPlaceSearch(keywordOrList, autoFrom) {
    const that = this
    this.setData({ loading: true, error: '' })

    /**
     * 支持**多个**检索词。用户一次说几个地方，就搜几次 ——
     * 只发第一个词会让后面的地方完全搜不到（实测踩过）。
     */
    const keywords = (Array.isArray(keywordOrList) ? keywordOrList : [keywordOrList])
      .map((x) => String(x == null ? '' : x).trim())
      .filter(Boolean)

    return this.tryLocate().then(function (center) {
      return api
        .callApi('place.search', {
          keyword: keywords[0],
          keywords: keywords,
          center: center || undefined,
          radius: 5000,
          enrichWalk: that.data.enrichWalk,
          // 自动预选交给服务端做 —— 规则在那儿才测得到
          autoPick: autoFrom
            ? {
                pace: autoFrom.parsed && autoFrom.parsed.pace,
                mustVisitTexts: (autoFrom.parsed && autoFrom.parsed.mustVisitTexts) || [],
                // 每个检索词至少选一个 —— 用户提到的地方不该被名额挤掉
                keywords: keywords,
                /**
                 * ⚠️ 锚点决定**要不要替他补地点**：
                 *   · 有锚点（「中央大街**附近**逛逛」）→ 区域漫游 → 按节奏补足；
                 *   · 没有锚点（「先去 A 再去 B」）→ 他已经排好了 → 只选他说的。
                 * 不加这个，系统会在用户已排好的行程上多塞 8 个地方。
                 */
                anchorText: (autoFrom.parsed && autoFrom.parsed.anchorText) || null,
              }
            : undefined,
        })
        .then(function (res) {
          if (!res || res.ok !== true) {
            that.setData({ loading: false, error: (res && res.error && res.error.message) || '搜索失败' })
            return
          }
          const d = res.data
          if (d.ok === false) {
            // 上游失败（缺 Key、配额、范围）—— 如实展示，不用缓存或估算冒充
            that.setData({
              loading: false,
              error: d.message || '检索失败',
              note: d.hint || '',
              candidates: [],
              unselectedCandidateCount: 0, autoCandidates: false, otherCandidatesExpanded: false,
            })
            return
          }

          const mapped = (d.candidates || []).map(function (c) {
            return {
              /** 稳定身份键（与是否入库无关，见 lib/place-id.js） */
              itemId: c.itemId,
              /** 库里踏勘过的才有；没有就是 null */
              placeId: c.placeId || null,
              poiId: c.poiId || null,
              name: c.name,
              category: c.category,
              location: c.location,
              visitDurationMin: c.visitDurationMin || null,
              verified: c.verified,
              /** 交通设施等不可游览项 —— 系统不自动选它 */
              visitable: c.visitable !== false,
              /**
               * 能不能排进行程。
               * ⚠️ 2026-10-13 起**不再要求入库** —— 检索结果不入库，
               * 规划时随请求带上地点数据即可（有名称与坐标就够）。
               */
              tripNodeAllowed: Boolean(c.name && c.location),
              meetingPointAllowed: c.meetingPointAllowed !== false && Boolean(c.name && c.location),
              /** 数据来自实地踏勘还是检索 —— 界面要能区分可信与未核验 */
              matchedSurveyed: Boolean(c.matchedSurveyed),
              distanceText:
                typeof c.straightLineMeters === 'number' ? `直线 ${c.straightLineMeters} 米` : '',
              durationText:
                typeof c.walkMinutes === 'number'
                  ? `步行 ${c.walkMinutes} 分钟`
                  : c.walkSource === 'unavailable'
                    ? '步行时间未取到'
                    : '',
            }
          })

          that.setCandidates(mapped, 'search', d.ranking ? d.ranking.note : '')
          that.setData({
            loading: false,
            note: center || that.data.intent ? '' : '未取得当前位置，按默认中心（哈尔滨）排序',
          })

          // 来自"理解"的检索 → 用服务端给的预选结果，让用户可以直接生成路线
          if (autoFrom) that.applyAutoSelect(mapped, d.picked)
        })
        .catch(function (err) {
          that.setData({ loading: false, error: (err && err.errMsg) || '搜索失败' })
        })
    })
  },

  /** 用户点了待确认项的某个候选（§6.2：提供选项，而不是替他决定） */
  pickUncertainty(e) {
    const { field, value } = e.currentTarget.dataset
    if (field !== 'endAt') return
    const d = todayAt(value)
    this.setData({
      endAtText: value,
      endAt: d.toISOString(),
      endAtFromParse: false,
      note: '已按你的选择设定结束时间 ' + value,
    })
  },

  /** 写入候选列表，并同步已选状态 */
  setCandidates(list, mode, rankingNote) {
    const selectedIds = this.data.selected.map((x) => x.itemId)
    const marked = list.map((x) =>
      Object.assign({}, x, { selected: selectedIds.indexOf(x.itemId) >= 0 })
    )
    this.setData({ candidates: marked, mode: mode, rankingNote: rankingNote || '',
      unselectedCandidateCount: marked.filter(x => !x.selected).length,
      autoCandidates: false, otherCandidatesExpanded: false })
  },

  // ══════════ 选择 ══════════

  toggleOtherCandidates() {
    this.setData({ otherCandidatesExpanded: !this.data.otherCandidatesExpanded })
  },

  /** 点候选项：加入 / 移出已选。**勾选顺序即游览顺序。** */
  toggleCandidate(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.candidates.find((x) => x.itemId === id)
    if (!item) return

    if (!item.tripNodeAllowed) {
      this.setData({ note: '该地点缺少坐标，无法计算步行时间，不能安排进路线' })
      return
    }

    let selected = this.data.selected.slice()
    const at = selected.findIndex((x) => x.itemId === id)

    if (at >= 0) {
      selected = selected.filter(x => x.itemId !== id)
    } else {
      selected.push(selectedOf(item, ''))
    }

    this.updateSelection(selected, { note: '' })
  },

  removeSelected(e) {
    const id = e.currentTarget.dataset.id
    const visitId = e.currentTarget.dataset.visitid
    this.updateSelection(this.data.selected.filter(x => visitId ? x.visitId !== visitId : x.itemId !== id))
  },

  updateSelection(selected, extra) {
    const ids = new Set(selected.map(x => x.itemId))
    const candidates = this.data.candidates.map(x => ({ ...x, selected: ids.has(x.itemId) }))
    this.setData({ ...extra, selected, candidates, unselectedCandidateCount: candidates.filter(x => !x.selected).length })
  },

  appendVisit(e) {
    if (this.data.loading || this.data.busy) return
    const item = this.data.selected[Number(e.currentTarget.dataset.index)]
    if (!item) return
    this.updateSelection(this.data.selected.concat(selectedOf(item, '再次前往')), { note: '已在末尾增加一次到访，按当前顺序规划。' })
  },

  // ══════════ 需求条件 ══════════

  onStartTimeChange(e) {
    this.setData({
      startAtText: e.detail.value,
      startAt: todayAt(e.detail.value).toISOString(),
      startAtManual: true,
    })
  },

  onEndTimeChange(e) {
    this.setData({ endAtText: e.detail.value, endAt: todayAt(e.detail.value).toISOString() })
  },

  clearEndAt() {
    this.setData({ endAtText: '', endAt: '' })
  },

  /**
   * 组装约束。
   *
   * ⚠️ `confirmedAt` 必须给值 —— 服务端只把"已确认的硬约束"计入可行性判定
   * （§6.2）。用户在界面上明确设了结束时间，就是一次确认。
   * 少了这个字段，约束会被静默忽略，规划器永远返回"可行"。
   */
  buildConstraints() {
    if (!this.data.endAt) return []
    return [
      {
        key: 'endAt',
        value: this.data.endAt,
        hardness: 'hard',
        confirmedAt: new Date().toISOString(),
        confirmedBy: 'user',
      },
    ]
  },

  // ══════════ 行程 ══════════

  chooseRouteOrder(startPoint) {
    const requested = this.data.selected.slice()
    // 返回曾到访的地点是明确的路线顺序，不能把两次到访挪到一起。
    if (new Set(requested.map(x => x.itemId)).size !== requested.length) return Promise.resolve(requested)
    const optimized = suggestOrder(requested, startPoint)
    if (optimized.every((x, i) => x.itemId === requested[i].itemId)) return Promise.resolve(requested)
    return new Promise(resolve => {
      wx.showModal({
        title: '请选择游览顺序',
        content: '你的顺序：' + requested.map(x => x.name).join(' → ') +
          '\n少绕路顺序：' + optimized.map(x => x.name).join(' → ') +
          '\n少绕路方案按地点距离估算，实际交通耗时以生成结果为准。',
        confirmText: '需求顺序',
        cancelText: '优化顺序',
        success: r => resolve(r.confirm ? requested : r.cancel ? optimized : null),
        fail: () => resolve(null),
      })
    })
  },

  createTrip() {
    const that = this
    const ids = this.data.selected.map((x) => x.itemId)
    if (!ids.length) return

    this.setData({ loading: true, error: '', note: '正在定位出发位置…', proposal: null, planRejected: false })

    // 行程默认从**当前位置**出发。
    // 不给起点的话，行程会假装人已经在第一个景点门口 ——
    // 计划出发时间、总步行量与"能不能赶上结束时间"都会偏乐观。
    return this.tryLocate().then(async function (startPoint) {
      const selected = await that.chooseRouteOrder(startPoint)
      if (!selected) {
        that.setData({ loading: false, note: '未选择游览顺序，请重新生成' })
        return
      }
      /**
       * 出发时间：用户（或解析结果）指定过就用它；否则用**此刻**。
       * 不能用 onLoad 时的那个"现在" —— 页面开着十分钟，行程就从十分钟前开始了。
       */
      const startAt = that.data.startAtManual ? that.data.startAt : new Date().toISOString()

      that.setData({
        startAt: startAt,
        startAtText: timeText(new Date(startAt)),
        note: startPoint ? '' : '未取得当前位置，行程将从第一个地点开始计时（总时间会偏乐观）',
      })

      return api
        .callApi('trip.plan', {
          /**
           * ⚠️ **传内嵌的地点数据，而不是 placeIds**（2026-10-13 改）。
           *
           * 检索结果不入库（用户决定：全从腾讯地图实时搜），所以
           * 回库按 placeId 读是读不到的。有 `placeId` 的（踏勘过的）
           * 一并带上 —— 服务端会用库里那份覆盖，从而获得核验待遇。
           */
          places: selected.map(function (x) {
            return {
              placeId: x.placeId || undefined,
              poiId: x.poiId || undefined,
              name: x.name,
              category: x.category,
              location: x.location,
              visitDurationMin: x.visitDurationMin || undefined,
            }
          }),
          startAt: startAt,
          constraints: that.buildConstraints(),
          startPoint: startPoint || undefined,
          /**
           * 出行方式偏好（2026-10-14）。后端会把它当**偏好**处理：
           * 可用就用它（哪怕不是最快），不可用就给最快的并说明原因。
           *
           * ⚠️⚠️ **只有在"方式是整趟的"时才发它**（`modeIsGlobal`）。
           *
           * 用户要求："若多个地名则**只自动选择用户说过出行方式的目的地**
           * （我想骑车去哈工大，再去冰雪大世界 —— 只是去哈工大的方式选为骑车，
           *  **冰雪大世界依旧需要用户自己选择**）"
           *
           * `preferredMode` 在后端是**全局偏好**，会把"骑车"套到所有段上 ——
           * 包括用户根本没这么说的冰雪大世界那 14 公里。
           * 所以说了具体目的地时**不发全局偏好**，改走下面那条按段的路。
           */
          preferredMode:
            that.data.modeIsGlobal && that.data.preferredMode
              ? that.data.preferredMode
              : undefined,
          /**
           * 逐段指定的出行方式 `{ [toPlaceId]: mode }`（2026-10-14）。
           *
           * 逐段选择的**应用方式**就是再规划一次 —— 不是发一个新接口。
           * 因为"换一种方式"要改的不只是那一行文字：后续每站的到达时间、
           * 总步行量、硬约束检查全都跟着变，而这些都在 `trip.plan` 里算。
           *
           * 候选耗时已在第一次规划时取到，所以这次基本不消耗新配额。
           */
          legModes: (that.data.legModes && Object.keys(that.data.legModes).length)
            ? that.data.legModes
            : undefined,
          // 「逛一小时」→ 每站 60 分钟；null 时后端用地点自带默认值
          stayMin: that.data.stayMin || undefined,
          // 每个地点时长不同时按地点给（优先级高于 stayMin）
          stayByText: that.data.stayByText || undefined,
        })
        .then(function (res) {
          if (!res || res.ok !== true) {
            that.setData({ loading: false, error: (res && res.error && res.error.message) || '生成失败' })
            return
          }
          const d = res.data

          // 规划判定不可行 —— 这不是错误，要如实展示冲突（§5.2 最后一行）
          if (!d.saved) {
            that.setData({
              loading: false,
              trip: null,
              error: '',
              planRejected: true,
              conflicts: (d.conflicts || []).map((c) => c.message),
              note: '当前条件下无法生成路线',
            })
            return
          }

          that.applyTrip(d, '路线已生成')
        })
        .catch(function (err) {
          that.setData({ loading: false, error: (err && err.errMsg) || '生成失败' })
        })
    })
  },

  /**
   * ── 逐段出行方式选择器（2026-10-14 用户要求）────────────────
   *
   * "点击生成路径后出现界面，让用户分别选择每段路径的出行方式"，
   * 并在推荐的方式边上打"推荐"字样。
   *
   * ── 两条设计决定 ────────────────────────────────────────
   *
   * ① **选择器复用候选耗时作为参考**。
   *    后端规划时已经把四种方式的耗时都拿到了（`legOptions`），
   *    应用选择时在原行程上重新查询、计算并生成确认方案。
   *
   * ② **改完要点「应用」才生效**，不是选一下就重排。
   *    逐段选择会改整条行程的时间线（后面每站的到达时间都跟着变），
   *    边选边重排会让界面一直跳，用户看不清自己在改什么。
   */
  buildLegPicker(d, opts) {
    const legs = (d && d.legOptions) || []
    if (!legs.length) return []

    /**
     * 用户之前在界面上选过的（按到达的地点索引），保持选中态。
     *
     * ⚠️ `ignorePicked` 用于「恢复推荐」：那时要**忽略**用户的选择、
     * 回到系统挑的（`chosenMode` / `recommendedMode`）。
     * 否则清空了 `legModes` 也还是把 `this.data.legModes` 读回来 ——
     * 恢复就失效了（我第一版正是这个 bug）。
     */
    const picked = (opts && opts.ignorePicked) ? {} : (this.data.legModes || {})

    /**
     * 用户**在那一句话里**对某个目的地说了出行方式（2026-10-14）。
     *
     * 用户要求："若多个地名则**只自动选择用户说过出行方式的目的地**"。
     *
     * `{ '哈工大': 'bicycling' }` —— 键是用户原话里的地名，
     * 而这里是按 `toPlaceId` 索引，所以要靠**地点名**对上。
     * 匹配优先全等，再退到互相包含（"哈工大" ↔ "哈工大科技园"）。
     *
     * ⚠️ 对不上就**不套** —— 宁可让用户自己在选择器里选，
     *    也不要张冠李戴：把"骑车"套到冰雪大世界那 14 公里上，
     *    用户会以为系统乱来。
     */
    const byText = (opts && opts.ignorePicked) ? {} : (this.data.parsedLegModes || {})
    const modeForName = function (name) {
      const n = String(name == null ? '' : name).trim()
      if (!n) return null
      if (byText[n]) return byText[n]
      /**
       * 退一步：**用户说的词是地点名的一部分**就算同一个地方 ——
       * 用户说「哈工大」，而库里那条叫「哈工大科技园」。
       *
       * ⚠️ 方向**只有一个**（`n.indexOf(key)`），不能反着也判一次。
       *    反着判会让**长的键命中短的名字**：
       *      键「哈尔滨工业大学」 vs 地点名「哈工大」→ 也算命中 ❌
       *    那两段就被同一个键一起套上了，而用户只对其中一个说了方式。
       *    （我第一版写成双向，测试立刻抓出来了。）
       *
       * ⚠️ 至少两个字才算包含，避免一个单字键匹配到一大片。
       */
      for (const key of Object.keys(byText)) {
        const k = String(key == null ? '' : key).trim()
        if (k.length >= 2 && n.indexOf(k) >= 0) return byText[k]
      }
      return null
    }

    /**
     * 用户有没有**明确表达过**出行方式偏好。
     *
     * 判据是"当前生效的偏好不是 `auto`" —— `auto` 的意思是"系统按最快挑"，
     * 那是**没有偏好**，不是一种偏好。
     *
     * ⚠️ 这个区分正是用户要求的落点：
     *    有偏好 → 系统按它预选，界面标"按你的默认"
     *    没偏好 → 界面标"**待你选择**"，即用户说的
     *            "其余**依旧需要用户自己选择**"
     */
    const hasDefaultMode = Boolean(this.data.preferredMode) && this.data.preferredMode !== 'auto'

    return legs.map(function (leg, i) {
      const legKey = leg.toNodeId && legs.filter(x => x.toPlaceId === leg.toPlaceId).length > 1 ? leg.toNodeId : leg.toPlaceId
      /**
       * 选择优先级（从高到低）：
       *   ① 用户在**逐段选择器里点过的**（最具体，且是最近的意图）
       *   ② 用户在**那句话里对这个目的地说的**（"我想骑车去哈工大"）
       *   ③ 后端按偏好／天气／最快算出来的（`chosenMode`）
       */
      const fromUserWords = modeForName(leg.toPlaceName)
      const chosen =
        picked[legKey] || fromUserWords || leg.chosenMode || leg.recommendedMode

      /**
       * 这一段的来源，界面据此说清"这是谁定的"：
       *   `'user'`    —— 用户在这个选择器里点过
       *   `'words'`   —— 用户在那句话里对这一站说过方式
       *   `'default'` —— 用了「我的 → 默认出行方式」设的偏好
       *   `'auto'`    —— 系统按最快挑的（用户没说，也没有默认值）
       *
       * ⚠️ 有 `'default'` 这一档是为了回答用户的要求：
       *    "**多个地名则只自动选择用户说过出行方式的目的地**，
       *     其余**依旧需要用户自己选择**"。
       *    所以"需要你选"的判据是**有没有明确偏好**：
       *      · 有默认偏好 → 系统按它预选，标成"按你的默认"（可以改）
       *      · 没有任何偏好（偏好是"自动"）→ 标成"待你选择"
       */
      const source = picked[legKey]
        ? 'user'
        : fromUserWords
          ? 'words'
          : hasDefaultMode
            ? 'default'
            : 'auto'
      return {
        index: i + 1,
        toPlaceId: leg.toPlaceId,
        legKey,
        toNodeId: leg.toNodeId,
        toName: leg.toPlaceName || '这一站',
        fromName: leg.isFirstLeg ? '我的位置' : leg.fromPlaceName || '上一站',
        selected: chosen,
        selectedLabel: modeInfo(chosen, ((leg.options || []).find(o => o.mode === chosen) || {}).transit).name || '',
        options: (leg.options || []).map(function (o) {
          return {
            mode: o.mode,
            name: modeInfo(o.mode, o.transit).name || o.mode,
            icon: modeInfo(o.mode, o.transit).icon,
            minutes: o.minutes,
            transit: o.transit || null,
            /** ⚠️ 系统的推荐（不受用户偏好影响）—— 界面据此打"推荐"字样 */
            recommended: o.isRecommended === true,
            isCurrent: o.mode === chosen,
            /** 公交的换乘细节，让用户能据以比较（"地铁2号线 1号口进"） */
            transitText: describeTransit(o.transit),
          }
        }),
        /** 这一段取不到的方式（如公交没配 Key）—— 要说清为什么不能选 */
        unavailable: leg.unavailable || [],
        changed: Boolean(picked[legKey] && picked[legKey] !== leg.chosenMode),
        /** 这一段的方式是怎么定下来的 —— 界面据此标注来源（见上面 source 的说明） */
        source: source,
        sourceNote:
          source === 'words'
            ? '按你那句话里说的'
            : source === 'default'
              ? '按你在「我的」设的默认方式'
              : source === 'user'
                ? '你选的'
                : '系统按最快挑的',
        /**
         * ⚠️ **这一段需要用户自己选**。
         *
         * 用户要求："若多个地名则只自动选择用户说过出行方式的目的地，
         *             **其余依旧需要用户自己选择**"
         *
         * 判据：既没说方式、也没有默认偏好（偏好是"自动"）——
         * 此时系统挑的只是一个"最快的"建议，不该假装成用户的决定。
         */
        needsChoice: source === 'auto',
      }
    })
  },

  /** 展开 / 收起逐段选择面板 */
  toggleLegPicker() {
    if (this.data.busy || this.data.loading) return
    this.setData({ legPickerOpen: !this.data.legPickerOpen })
  },

  /**
   * 当前生效的逐段方式是否**都还是系统推荐**。
   *
   * 只影响选择器底部「继续」按钮的叫法：
   *   · 新生成、没改过 → 「按推荐方式继续」
   *   · 已经应用过别的方式（从折叠卡重新打开）→ 「按当前方式继续」
   * ⚠️ 只看**已保存**的 selected，不看未提交的草稿 ——
   *    「继续」本来就是"不改，按现在的来"，草稿不该影响它的名字。
   */
  pickerUsesRecommended(rows) {
    return (rows || []).every((row) => {
      if (!row || !row.options || !row.options.length) return true
      const rec = row.options.find((o) => o.recommended)
      return !rec || row.selected === rec.mode
    })
  },

  finishInitialLegPicker() {
    if (this.data.busy || this.data.loading) return
    const rows = this.buildLegPicker({ legOptions: this.data.rawLegOptions }, { ignorePicked: true })
    this.setData({ legPickerOpen: false, legModes: {}, legEditor: null,
      legPicker: rows, legPickerUsingRecommended: this.pickerUsesRecommended(rows) },
    () => wx.pageScrollTo({ selector: '#trip-timeline', duration: 250, fail: () => {} }))
  },

  /** 用节点 ID 定位到达该站的路段，避免重复游览同一地点时串段。 */
  openLegEditor(e) {
    if (this.data.busy || this.data.loading) return
    const nodeId = e.currentTarget.dataset.nodeid
    const nodes = this.data.rawNodes || []
    const index = nodes.findIndex(n => n.nodeId === nodeId)
    const target = nodes[index]
    if (!target || target.status !== 'pending' || (index === 0 && !this.data.startLeg)) return
    if (this.data.legEditor && this.data.legEditor.toNodeId === nodeId) return this.cancelLegEditor()
    const rows = this.buildLegPicker({ legOptions: this.data.rawLegOptions }, { ignorePicked: true })
    const reference = rows.find(row => row.toNodeId ? row.toNodeId === nodeId
      : row.toPlaceId === target.placeId && nodes.filter(n => n.placeId === target.placeId).length === 1)
    const selected = index === 0 ? this.data.startLeg.rawMode : target.travelMode
    // 恢复行程或调整顺序后可能没有候选耗时，仍可请求修改，但不编造时间。
    const options = reference && reference.options.length ? reference.options
      : MODE_OPTIONS.filter(o => o.value !== 'auto').map(o => ({ mode: o.value,
        name: modeInfo(o.value).name, icon: modeInfo(o.value).icon, minutes: null }))
    this.setData({ legPickerOpen: false, legModes: {}, legPicker: rows,
      legEditor: { toNodeId: nodeId, toPlaceId: target.placeId, legKey: nodeId,
        tripId: this.data.trip && this.data.trip.tripId, version: this.data.trip && this.data.trip.version,
        fromName: index ? nodes[index - 1].placeName : this.data.startLeg.label,
        toName: target.placeName, selected, changed: false,
        options: options.map(o => Object.assign({}, o, { isCurrent: o.mode === selected })),
        unavailable: reference ? reference.unavailable : [],
      } })
  },

  cancelLegEditor() {
    if (this.data.busy || this.data.loading) return
    this.setData({ legEditor: null })
  },

  onInlineLegModeTap(e) {
    if (this.data.busy || this.data.loading) return
    const editor = this.data.legEditor
    const mode = e.currentTarget.dataset.mode
    if (!editor || (e.currentTarget.dataset.legkey && e.currentTarget.dataset.legkey !== editor.legKey) ||
      !editor.options.some(o => o.mode === mode)) return
    const target = (this.data.rawNodes || []).find(n => n.nodeId === editor.toNodeId)
    if (!target || target.status !== 'pending') return
    const currentMode = this.data.rawNodes.indexOf(target) === 0 ? this.data.startLeg.rawMode : target.travelMode
    this.setData({ legEditor: Object.assign({}, editor, { selected: mode, changed: mode !== currentMode,
      options: editor.options.map(o => Object.assign({}, o, { isCurrent: o.mode === mode })) }) })
  },

  applyInlineLegMode() {
    const editor = this.data.legEditor
    if (!editor || !editor.changed) return
    if (!this.data.trip || editor.tripId !== this.data.trip.tripId || editor.version !== this.data.trip.version) {
      this.setData({ legEditor: null, error: '行程已更新，请重新选择本段的出行方式' })
      return
    }
    return this.submitLegModeChanges([editor])
  },

  /**
   * 用户在某一**段**里换了出行方式。
   *
   * ⚠️ 只改本地选中态，**不发请求** —— 见 `buildLegPicker` 的说明②。
   */
  onLegModeTap(e) {
    if (this.data.busy || this.data.loading) return
    if (e.currentTarget.dataset.inline === true || e.currentTarget.dataset.inline === 'true') return this.onInlineLegModeTap(e)
    const toPlaceId = e.currentTarget.dataset.legkey || e.currentTarget.dataset.placeid
    const mode = e.currentTarget.dataset.mode
    if (!toPlaceId || !mode) return

    const legModes = Object.assign({}, this.data.legModes)
    legModes[toPlaceId] = mode
    /** 就地更新选中态，避免整块重建导致列表跳动 */
    const picker = (this.data.legPicker || []).map(function (row) {
      if ((row.legKey || row.toPlaceId) !== toPlaceId) return row
      return Object.assign({}, row, {
        selected: mode,
        selectedLabel: modeInfo(mode, (row.options.find(o => o.mode === mode) || {}).transit).name || '',
        changed: true,
        /**
         * ⚠️ 来源也要跟着改成 `'user'`（2026-10-14 补）。
         *
         * 只改 `selected` 的话，用户点完之后那一行仍然写着
         * "按你那句话里说的"或"系统按最快挑的" —— 而他刚刚亲手定了它。
         * 界面上写着错的来源，比不写来源更糟。
         */
        source: 'user',
        sourceNote: '你选的',
        needsChoice: false,
        options: row.options.map(function (o) {
          return Object.assign({}, o, { isCurrent: o.mode === mode })
        }),
      })
    })
    this.setData({ legModes: legModes, legPicker: picker })
  },

  /**
   * 把逐段选择恢复成系统推荐（改乱了想重来）。
   *
   * `ignorePicked: true` 是必须的 —— 否则会从 `this.data.legModes`
   * 把用户的选择又读回来，"恢复"等于没做。
   */
  resetLegModes() {
    if (this.data.busy || this.data.loading) return
    const rows = this.buildLegPicker({ legOptions: this.data.rawLegOptions }, { ignorePicked: true })
    this.setData({
      legModes: {},
      legPicker: rows,
      legPickerUsingRecommended: this.pickerUsesRecommended(rows),
    })
  },

  /**
   * 集中选择与时间轴单段修改共用原行程调整、确认流程。
   * 查询新的路线耗时，确认前只展示方案，不覆盖进度或已保存的方式。
   */
  applyLegModes() {
    return this.submitLegModeChanges(this.data.legPicker || [])
  },

  submitLegModeChanges(rows) {
    if (this.data.busy || this.data.loading) return
    if (!this.data.trip) return this.createTrip()
    const tripId = this.data.trip.tripId, version = this.data.trip.version
    const nodes = this.data.rawNodes || []
    const operations = []
    for (const row of rows) {
      if (!row.changed) continue
      const matches = nodes.filter(n => row.toNodeId ? n.nodeId === row.toNodeId : n.placeId === row.toPlaceId)
      if (matches.length !== 1) continue
      const target = matches[0]
      if (target.status !== 'pending') continue
      const currentMode = nodes.indexOf(target) === 0 && this.data.startLeg ? this.data.startLeg.rawMode : target.travelMode
      if (row.selected && row.selected !== currentMode) operations.push({ type: 'change_travel_mode', payload: { nodeId: target.nodeId, mode: row.selected } })
    }
    if (!operations.length) { this.finishInitialLegPicker(); return }
    if (operations.length > 10) { this.setData({ error: '一次最多修改 10 段，请分批应用选择' }); return }
    this.setData({ busy: 'adjust', error: '' })
    const current = () => this.data.trip && this.data.trip.tripId === tripId && this.data.trip.version === version
    /**
     * 不再强制 `autoApply: 'never'`（2026-10-22 用户反馈）。
     *
     * 原来是"应用本段修改 → 后端返回候选 → 再点一次『选择这个方案』"，
     * 但用户点「应用本段修改 / 确认出行方式」本身就已经是明确的决定，
     * 再来一次确认只是多一次点击。
     *
     * 后端本来就有"无取舍时自动生效"的策略（`trip.adjust` 里 2026-10-13 的约定）：
     *   · 只有一条可行方案、且没有牺牲任何安排 → 直接生效；
     *   · 有取舍 / 多条方案 / 队伍行程 → 仍然返回候选，交给用户选。
     * 这里去掉 `never` 就是回到那条策略，不新增旁路。
     */
    return api.callApi('trip.adjust', { tripId, trigger: { type: 'batch', payload: { operations } } }, { expectedVersion: version })
      .then(res => {
        if (!current()) return
        if (!res || !res.ok) { this.setData({ busy: '', error: res && res.error && res.error.message || '调整失败，请重试' }); return }
        const rows = this.buildLegPicker({ legOptions: this.data.rawLegOptions }, { ignorePicked: true })
        this.setData({ legPickerOpen: false, legEditor: null, legModes: {},
          legPicker: rows, legPickerUsingRecommended: this.pickerUsesRecommended(rows) })
        if (res.data.applied) this.applyTrip(res.data, '出行方式与到达时间已更新')
        else this.applyProposal(res.data)
      }).catch(err => { if (current()) this.setData({ busy: '', error: err && err.errMsg || '调整失败，请重试' }) })
  },

  /** 当前节点 = 第一个未走完的节点 */
  currentIndexOf(nodes) {
    const i = (nodes || []).findIndex((n) => n.status !== 'done' && n.status !== 'skipped')
    return i < 0 ? Math.max(0, (nodes || []).length - 1) : i
  },

  /**
   * 由后端节点数组构建时间轴视图。
   *
   * ⚠️ 路段的位置很要紧（2026-10-13 修正）：
   *   后端给的 `travelFromPrevMin` 是**从上一节点到本节点**的时间，
   *   首版把它渲染在**本节点的卡片里**，读起来像"到了这里之后要走 8 分钟"，
   *   而实际意思是"从上一站走过来要 8 分钟"。
   *
   *   所以这里把它挪到**两个节点之间**：`legToNext` 表示"本节点 → 下一节点"。
   *
   * 抽成独立方法是为了让"记录进度"也能重算它 —— 那条路径只回传 nodes。
   */
  buildTimelineView(nodes) {
    const currentIndex = this.currentIndexOf(nodes)
    return (nodes || []).map((n, i) => {
      const next = nodes[i + 1] || null
      const reached = isReached(n.status)
      return {
        nodeId: n.nodeId,
        seq: i + 1,
        placeName: n.placeName,
        /**
         * 坐标 —— 点这一站要能全屏看它在哪（`focusNodeOnMap`）。
         *
         * ⚠️ 之前没带这个字段。`focusNodeOnMap` 我原本写的是去 `rawNodes` 里找，
         * 但那样等于绕开时间线自己再查一次；带上它更直接，也少一个出错点。
         */
        location: n.location || null,
        arrive: hhmm(n.plannedArriveAt),
        leave: hhmm(n.plannedLeaveAt),
        stayMin: n.plannedStayMin,
        verified: n.verified,
        statusLabel: i === currentIndex && n.status === 'arrived' ? '游览中'
          : i === currentIndex && n.status === 'pending' ? '当前' : STATUS_LABEL[n.status] || n.status,
        status: n.status,
        canAdjust: n.status === 'pending' || n.status === 'arrived',
        /** 已到过 —— 时间轴上也变绿，与地图一致。跳过的**不算** */
        visited: reached,
        skipped: n.status === 'skipped',
        isCurrent: i === currentIndex && (n.status === 'pending' || n.status === 'arrived'),
        isLast: i === nodes.length - 1,
        /** 该站可做的进度操作（记录事实，不重新规划） */
        progressActions: PROGRESS_ACTIONS[n.status] || PROGRESS_ACTIONS.pending,
        /** 本节点 → 下一节点之间的出行段；末节点为 null */
        legToNext: next
          ? {
              toNodeId: next.nodeId,
              fromName: n.placeName,
              toName: next.placeName,
              editable: next.status === 'pending',
              mode: next.travelMode || '',
              modeName: modeInfo(next.travelMode, next.travelTransit).name,
              modeIcon: modeInfo(next.travelMode, next.travelTransit).icon,
              modeArt: modeInfo(next.travelMode, next.travelTransit).art,
              minutes: next.travelFromPrevMin,
              meters: next.travelFromPrevMeters,
              // 只有"直线估算"需要提醒 —— 它与真实路线在短距离下能差 7 倍
              warn: next.travelSource === 'estimated' ? '估算' : '',
              source: next.travelSource,
              /** 这个数可不可信（与"怎么走"是两个维度） */
              sourceLabel: SOURCE_LABEL[next.travelSource] || '',
              /**
               * 为什么选这个方式 —— 后端 `mode-choice` 给的，可直接展示。
               * 如「公交比步行省 78 分钟」。这是"改得清楚"的一部分：
               * 只给结论不给理由，用户没法判断该不该接受。
               */
              reason: next.travelReason || '',
              /** 只决定要不要上屏：比较类文案不显示，见 showReason */
              reasonShow: showReason(next.travelReason),
              fastest: isFastestReason(next.travelReason),
              /**
               * 有没有按用户选的来（2026-10-14）。
               *
               * ⚠️ `false` 时界面要**突出显示** reason —— 里面写着
               * "你想用步行，但……已改为驾车"。用户选了却被改掉，
               * 如果和普通说明一个样式，他会以为系统没理他。
               * `null` 表示用户没选（自动），不需要特别提示。
               */
              matchedPreference: next.travelMatchedPreference,
              /** 用户当初选的是哪个方式（未选为 null） */
              preferredModeName: next.travelPreferredMode
                ? modeInfo(next.travelPreferredMode).name
                : '',
              /** 公交的换乘细节：几号线、哪个口 */
              transit: next.travelTransit || null,
              transitText: describeTransit(next.travelTransit),
              /**
               * ⚠️ 判据是**下一站到了没有**，不是"本站走完了"。
               * 点完 1 号的「逛完了」，你还没走到 2 号 —— 这一段没走过。
               * 到了 2 号（arrived/done），才说明 1→2 这段走完了。
               */
              visited: isReached(next.status),
            }
          : null,
      }
    })
  },

  /**
   * 从 `rawNodes` 重建时间轴与地图。
   *
   * `trip.progress` 只回传 nodes（不含 summary / walkTimes / startLeg），
   * 所以这里**只重算随状态变化的部分**，其余保持不动 ——
   * 否则记录一次进度会把总步行时间、出发段这些信息清掉。
   */
  rebuildFromNodes(options = {}) {
    const nodes = this.data.rawNodes || []
    const currentLeg = this.buildCurrentLeg(nodes, this.data.startLeg)
    const key = navigationKey(this.data.trip, currentLeg)
    const stale = this.data.navLeg && this.data.navLeg.routeKey !== key
    const staleRequest = this.navigationRequestKey && this.navigationRequestKey !== key
    if (this.data.navLeg || this.data.navLoading) this.navigationRequested = true
    if (stale || staleRequest || !currentLeg) this.cancelNavigationRequest()
    if (!currentLeg) this.navigationRequested = false
    const navLeg = stale || !currentLeg ? null : this.data.navLeg
    const editor = this.data.legEditor
    const keepEditor = editor && this.data.trip && editor.tripId === this.data.trip.tripId &&
      editor.version === this.data.trip.version && nodes.some(n => n.nodeId === editor.toNodeId && n.status === 'pending')
    this.setData(
      {
        timeline: this.buildTimelineView(nodes),
        tripDisplay: buildTripDisplay(nodes, this.data.startLeg),
        legEditor: keepEditor ? editor : null,
        startLegEditable: Boolean(this.data.startLeg && nodes[0] && nodes[0].status === 'pending'),
        currentNodeIndex: this.currentIndexOf(nodes),
        routeMap: this.buildRouteMap(nodes, this.data.startPoint, navLeg),
        // 当前出行段随进度变化：走完一站，这一段就换成"从这一站去下一站"
        currentLeg, navLeg,
        ...((stale || staleRequest || !currentLeg) ? { navLoading: false, navError: '', navHint: currentLeg ? '已更新下一站，正在同步导航路线。' : '' } : {}),
      },
      () => { this.fitRouteMap(); if (options.refreshNavigation !== false) this.resumeNavigation() }
    )
  },
  cancelNavigationRequest() { this.navigationToken = (this.navigationToken || 0) + 1; this.navigationRequestKey = '' },
  resumeNavigation() {
    if (!this.data.currentLeg) { this.navigationRequested = false; return }
    if (this.navigationVisible !== false && this.navigationRequested && !this.data.navLeg && !this.data.navLoading) return this.startNavigation()
  },

  /**
   * 一批地点的**指纹**（2026-10-14 加）—— 用来判断"这次是不是换地方了"。
   *
   * ── 为什么需要它 ──────────────────────────────────────────
   *
   * 用户报："搜完哈工大再重新选择路径选冰雪大世界后还是骑行，
   *          **没有让我选择出行方式**"
   *
   * 每段方式选择器该在"换了目的地"时重新弹 —— 但**不能每次生成都弹**：
   * 记录进度（到了/逛完了）、多停一会儿都会重排，每次都弹会把人烦死。
   *
   * 所以判据就是**地点集合变了没有**：
   *   · 换了目的地 → 出行方式的答案完全不同 → 必须重新问；
   *   · 同一批地点内部重排 → 保持用户上次的选择。
   *
   * ⚠️ **排序后再拼**：调换顺序不该算"变了"——
   *    那只是优化路线，不是换了地方。
   */
  placesFingerprint(d) {
    const nodes = (d && d.nodes) || []
    return nodes
      .map(function (n) {
        return n.placeId || n.itemId || n.placeName || n.nodeId || ''
      })
      .filter(Boolean)
      .sort()
      .join('|')
  },

  /**
   * 用后端返回的行程刷新界面（生成与确认变更都走这里）
   */
  applyTrip(d, note, options = {}) {
    const newTrip = !this.data.trip || this.data.trip.tripId !== d.tripId
    if (newTrip) this.setData({ legModes: {} })
    // 确认调整可能不带候选；只复用起终点未改变的候选参考值。
    if (d.legOptions === undefined && this.data.trip && this.data.trip.tripId === d.tripId) {
      const oldNodes = this.data.rawNodes || [], newNodes = d.nodes || []
      const legOptions = (this.data.rawLegOptions || []).filter(leg => {
        const old = oldNodes.filter(n => leg.toNodeId ? n.nodeId === leg.toNodeId : n.placeId === leg.toPlaceId)
        if (old.length !== 1) return false
        const oi = oldNodes.indexOf(old[0]), ni = newNodes.findIndex(n => n.nodeId === old[0].nodeId && n.placeId === old[0].placeId)
        return ni >= 0 && (oi === 0 ? ni === 0 : ni > 0 && oldNodes[oi - 1].nodeId === newNodes[ni - 1].nodeId && oldNodes[oi - 1].placeId === newNodes[ni - 1].placeId)
      }).map(leg => {
        const n = newNodes.find(n => leg.toNodeId ? n.nodeId === leg.toNodeId : n.placeId === leg.toPlaceId)
        const chosenMode = n.travelMode && n.travelMode !== 'none' ? n.travelMode : (d.startLeg && d.startLeg.mode || leg.chosenMode)
        return Object.assign({}, leg, { chosenMode, options: (leg.options || []).map(o => o.mode === chosenMode && Number.isFinite(n.travelFromPrevMin)
          ? Object.assign({}, o, { minutes: n.travelFromPrevMin, transit: n.travelTransit || null }) : o) })
      })
      d = Object.assign({}, d, { legOptions })
      this.setData({ legModes: {} })
    }
    this.tripLoadToken = (this.tripLoadToken || 0) + 1
    const keepNavigation = Boolean(this.data.trip && this.data.trip.tripId === d.tripId &&
      (this.navigationRequested || this.data.navLeg || this.data.navLoading))
    this.cancelNavigationRequest()
    this.navigationRequested = keepNavigation
    if (!this.data.trip || this.data.trip.tripId !== d.tripId) this.textChangeToken = (this.textChangeToken || 0) + 1
    const nodes = d.nodes || []
    // 首次生成或更换地点时，完整展示所有路段供确认；日常浏览才折叠。
    const chooseLegModes = !options.skipModeChoice && nodes.some(n => n.status === 'pending') &&
      (newTrip || this.placesFingerprint(d) !== this.__legPickerFingerprint)
    const currentIndex = Math.max(
      0,
      nodes.findIndex((n) => n.status !== 'done' && n.status !== 'skipped')
    )

    /**
     * 时间轴数据。
     *
     * ⚠️ 路段的位置很要紧（2026-10-13 修正）：
     *   后端给的 `travelFromPrevMin` 是**从上一节点到本节点**的时间，
     *   首版把它渲染在**本节点的卡片里**，读起来像"到了这里之后要走 8 分钟"，
     *   而实际意思是"从上一站走过来要 8 分钟"。
     *
     *   所以这里把它挪到**两个节点之间**：`legToNext` 表示"本节点 → 下一节点"。
     */
    const timeline = this.buildTimelineView(nodes)

    /**
     * 出发段先算出来 —— 同一个 `setData` 里读不到新写入的 `this.data.startLeg`，
     * 而 `currentLeg`（当前出行段）要用它。
     *
     * ⚠️⚠️ 这个对象是**显式挑字段**拼的，所以新字段不写进来就会被**静默丢掉**
     * （2026-10-14 踩过）：我加了 `mode` / `modeIcon` / `reason` / `transitText`，
     * 却漏在这个列表里，于是时间轴上"我的位置"那一段的方式是空的、
     * 卡片上则显示写死的"步行"——**用户看到的就是这个**。
     *
     * 加字段时要同时看三处：这里、`index.wxml` 的 startLeg 段、
     * 以及 `buildCurrentLeg` 的返回。
     */
    const startLegView = d.startLeg
      ? {
          label: (d.startPoint && d.startPoint.label) || '我的位置',
          /** 出行方式 —— 与"这个数可不可信"是两个维度 */
          mode: modeInfo(d.startLeg.mode, d.startLeg.transit).name,
          rawMode: d.startLeg.mode,
          modeIcon: modeInfo(d.startLeg.mode, d.startLeg.transit).icon,
          modeArt: modeInfo(d.startLeg.mode, d.startLeg.transit).art,
          minutes: d.startLeg.minutes,
          meters: d.startLeg.meters,
          warn: d.startLeg.source === 'estimated' ? '（估算）' : '',
          source: d.startLeg.source,
          sourceLabel: SOURCE_LABEL[d.startLeg.source] || '',
          /** 为什么选这个方式 / 为什么没有方案 */
          reason: d.startLeg.reason || '',
          reasonShow: showReason(d.startLeg.reason),
          fastest: isFastestReason(d.startLeg.reason),
          /** 公交换乘细节（几号线、几号口） */
          transitText: describeTransit(d.startLeg.transit),
          transit: d.startLeg.transit || null,
          provider: d.startLeg.provider || null,
          toName: d.startLeg.toPlaceName,
          toNodeId: nodes[0] && nodes[0].nodeId,
        }
      : null

    this.refreshGreeting()
    const pickerRows = this.buildLegPicker(d)
    this.setData({
      loading: false,
      busy: '',
      trip: d.tripId ? { tripId: d.tripId, version: d.version } : this.data.trip,
      /** 保留原始节点 —— 记录进度时只回传 nodes，要拿它重建界面 */
      rawNodes: nodes,
      tripDisplay: buildTripDisplay(nodes, startLegView),
      ...(newTrip ? { sourcePanelOpen: false, routeMapOpen: true } : {}),
      legEditor: null,
      startLegEditable: Boolean(startLegView && nodes[0] && nodes[0].status === 'pending'),
      timeline,
      currentNodeIndex: this.currentIndexOf(nodes),
      // ⚠️ 后端给的是 ISO 字符串，这里必须格式化 —— 否则界面会显示
      //    「预计结束 2026-10-14T03:37:41.233Z」这种没法看的东西
      summary: d.summary
        ? {
            nodeCount: timeline.length,
            endAt: hhmm(d.summary.endAt),
            totalWalkMin: d.summary.totalWalkMin,
            totalStayMin: d.summary.totalStayMin,
            totalWalkMeters: d.summary.totalWalkMeters,
          }
        : null,
      routeMap: this.buildRouteMap(nodes, d.startPoint, null),
      navLeg: null, navLoading: false, navError: '', navHint: '',
      walkTimes: d.walkTimes || null,
      startPoint: d.startPoint || null,
      startLeg: startLegView,
      /** 当前这一段怎么走、多远 —— 也是将来接导航的输入 */
      currentLeg: this.buildCurrentLeg(nodes, startLegView),
      unverifiedNotice: d.unverifiedNotice || null,
      warnings: d.warnings || [],
      proposal: null,
      proposalMode: null,
      proposalCandidates: [],
      planRejected: false,
      changeDraftId: '', changeQuestions: [], changeAnswers: {}, changeNeedsRewrite: false,
      note: note || '',
      error: '',
      /**
       * ── 逐段出行方式选择器（2026-10-14 用户要求）────────────────
       *
       * "点击生成路径后出现界面，让用户分别选择每段路径的出行方式"，
       * 并在推荐的方式边上打"推荐"字样。
       *
       * 所以把后端给的 `legOptions` 整理成界面能直接渲染的形态：
       * 每段一行，行内是各方式的耗时，系统推荐的那个带 `recommended: true`。
       *
       * ⚠️ `selected` 是**当前生效的**方式（用户之前选过就保持，
       * 没选过就是系统挑的）—— 否则用户选完再生成一次，
       * 界面会显示成"没选"，用户会以为自己的选择丢了。
       */
      legPicker: pickerRows,
      legPickerUsingRecommended: this.pickerUsesRecommended(pickerRows),
      /**
       * 后端给的逐段候选**原文**（不是整理过的 `legPicker`）。
       * 「恢复推荐」要按它重建 —— 整理过的版本已经带上了用户的选中态，
       * 用它重建等于什么也没恢复。
       */
      rawLegOptions: d.legOptions || [],
      /**
       * 后端回传了几段逐段候选。
       *
       * ⚠️ 单独存一个数（而不是让模板去读 `rawLegOptions.length`）是为了
       * 区分两种"选择器为空"：**后端没返回这个字段**（八成是云函数没重新部署）
       * 与**返回了但每段都没候选**（地图接口没配或配额用尽）。
       * 两者修法完全不同，界面要说清是哪一种。
       */
      legOptionsCount: (d.legOptions || []).length,
      /**
       * ══════════ 每段方式选择器：**换了地方就要重新弹** ══════════
       *
       * 用户要求过："点击生成路径后会出现界面让用户**分别选择每段路径的
       * 出行方式**"。而用户随后报（2026-10-14）：
       *
       *   "搜完哈工大再重新选择路径选冰雪大世界后还是骑行，
       *     **没有让我选择出行方式**"
       *
       * ── 为什么"每次生成都弹"是错的 ──────────────────────────
       *
       * 同一个目的地也会有多次生成：记录进度（到了/逛完了）、
       * 多停一会儿、少停一会儿都会重排。每次都弹会把用户烦死，
       * 而且他刚调好的方式会被顶掉。
       *
       * ── 正确的判据：**地点集合变了没有** ─────────────────────
       *
       * 换了目的地 → 出行方式的答案完全不同（骑车去哈工大合适，
       * 骑车去 14 公里外的冰雪大世界就不合适了）→ **必须重新问**。
       * 同一批地点内部重排 → 保持用户上次的选择。
       *
       * 指纹用排序后的 itemId 拼成：与顺序无关（调序不该重弹），
       * 与集合有关（换地点必须重弹）。
       */
      legPickerOpen: chooseLegModes,
      legPickerSeen: true,
    }, () => {
      /**
       * setData 的回调在**渲染完成之后**触发 —— 此时地图组件才真正存在，
       * 才能对它调用 includePoints（见 fitRouteMap 的说明）。
       */
      this.fitRouteMap()
      /**
       * 记下这一批地点 —— 下一次生成靠它判断"**换了地方没有**"。
       *
       * ⚠️ 要在**渲染之后**才赋值：`legPickerOpen` 是在 `setData` 里
       *    用**旧**指纹算出来的，早赋值就把这次也一起算成"没变"了。
       */
      this.__legPickerFingerprint = this.placesFingerprint(d)
      // 待确认时直接进入完整的方式选择；普通更新保持阅读位置。
      if (this.data.legPickerOpen) wx.pageScrollTo({ selector: '#initial-leg-picker', duration: 300, fail: () => {} })
      else if (newTrip) wx.pageScrollTo({ scrollTop: 0, duration: 300, fail: () => {} })
      this.rememberActiveTrip(d.tripId, d.version)
      this.resumeNavigation()
    })
  },

  /**
   * 把"当前路线"写到 storage，供**地图页**读取。
   *
   * ── 为什么需要它（2026-10-14）────────────────────────────
   *
   * 用户在行程页生成路线、再切到地图页选集合点时，地图页完全不知道
   * 有一条路线 —— 于是"路线看不见"，而且地图还停在默认中心点上，
   * 看起来就是"偏到别的地方去了"。
   *
   * 约定与 `team-panel` 的 `zhiyou-active-crew` 一致：**只存"是哪一个"**，
   * 不存内容。路线内容由地图页现取 `trip.get` ——
   * 因为 `trip.adjust` 会改节点顺序与停留时长，存下来的副本会过期，
   * 而**过期的路线画在地图上比不画更糟**（用户会按错的线找路）。
   */
  rememberActiveTrip(tripId, version) {
    if (!tripId) return
    try {
      wx.setStorageSync('zhiyou-active-trip', { tripId: tripId, version: version || null })
    } catch (e) {
      // storage 写失败不该影响行程页本身；但要说出来，否则地图页会"无缘无故"没有路线
      console.error('[rememberActiveTrip] 写入失败，地图页将看不到这条路线', e)
      this.setData({ note: '当前路线未能记到本地，地图页可能看不到它（' + ((e && e.errMsg) || '存储失败') + '）' })
    }
  },

  /**
   * 把地图视野缩放到能容纳整条路线。
   *
   * ⚠️ 为什么要显式调用，而不是只靠 `include-points` 属性：
   *   微信 `map` 组件的 `include-points` **在首次渲染时经常不生效** ——
   *   地图会先按 `latitude`/`longitude`/`scale` 初始化，把 include-points 吃掉。
   *   属性仍然保留（它是声明式的，在部分路径下有效），
   *   但真正可靠的路径是渲染完成后调 `MapContext.includePoints()`。
   *
   * 顺带解决了 padding：属性形式没法控制留白，导致标记贴着边缘；
   * 显式调用可以给四边留出空间，序号气泡才不会被裁掉。
   */
  fitRouteMap() {
    if (!this.data.routeMapOpen) return
    const pts = this.data.routeMap && this.data.routeMap.includePoints
    if (!pts || !pts.length) return

    try {
      const ctx = wx.createMapContext('routeMap', this)
      ctx.includePoints({
        points: pts,
        // 上边留得更多：marker 的序号气泡画在图标上方，贴边会被裁掉
        padding: [64, 48, 48, 48],
      })
    } catch (e) {
      // 地图还没渲染出来就跳过 —— include-points 属性会兜住
      console.warn('[trip] includePoints 失败，回落到 include-points 属性', e)
    }
  },

  /**
   * 用户主动查看地图时，把展开后的卡片滚到视野居中。
   * 地图默认展开，用户仍可手动折叠；后台同步路线时保持当前阅读位置。
   *
   * ── 为什么不是一句 `pageScrollTo({selector, offsetTop})` ──────
   *
   * `offsetTop` 的语义在各版本里不好确认（"往上偏多少"还是"往下留多少"），
   * 而 `selector` 形式本身也不会帮你居中 —— 它只保证元素进入视野。
   *
   * 所以这里**自己量、自己算**：
   *     目标滚动位置 = 卡片顶部位置 − (视口高 − 卡片高) / 2
   * 这样卡片正好落在屏幕中间，与 offsetTop 的解释无关。
   *
   * ⚠️ 必须用 `boundingClientRect` 而不是 `offsetTop`：
   *    我们要的是"相对视口的位置"，而 `scrollTop` 量的是"相对文档"。
   */
  scrollToRouteMap() {
    if (!this.data.routeMapOpen) return
    const that = this
    try {
      wx.createSelectorQuery()
        .select('.map-card')
        .boundingClientRect(function (rect) {
          /**
           * 量不到就回落到 selector 形式 —— 有总比没有好，
           * 而且失败是静默的（用户自己滑一下也能看到地图）。
           */
          if (!rect || typeof rect.top !== 'number') {
            wx.pageScrollTo({ selector: '.map-card', duration: 300, fail: () => {} })
            return
          }
          const viewportH = (wx.getSystemInfoSync() || {}).windowHeight || 0
          const rectH = rect.height || 0
          /** 当前滚动量 —— `rect.top` 是相对视口的，换算成文档坐标要加上它 */
          const docTop = rect.top + (that.__scrollTop || 0)
          const centered = docTop - Math.max(0, (viewportH - rectH) / 2)
          wx.pageScrollTo({
            scrollTop: Math.max(0, Math.round(centered)),
            duration: 300,
            fail: () => {
              /** 滚不动不影响路线本身 —— 不弹错、不写 error */
            },
          })
        })
        .exec()
    } catch (e) {
      /** 查询本身失败（极旧的基础库）也要能继续，同上 */
      wx.pageScrollTo({ selector: '.map-card', duration: 300, fail: () => {} })
    }
  },

  /**
   * ── 跳到地图页并聚焦某站（2026-10-14 用户要求）──────────────
   *
   * 用户先说要"展开占据全屏"，随后更正："应该是点击到了以后**跳转到
   * 地图页面**，然后地图放大" —— 那就是真实页面跳转，不是覆盖层。
   *
   * ⚠️ 地图是 **tab 页**，`wx.switchTab` **不支持 URL 参数**
   *    （传了会被忽略，而且不报错）。所以按项目里已有的约定
   *    （`zhiyou-active-trip` / `zhiyou-active-crew`）走 storage 传值：
   *    这里写"要聚焦哪一站"，地图页 `onShow` 读一次。
   *
   * @param {object} node 时间线节点（要有 location 与 placeName）
   */
  goToMapFocus(node) {
    const loc = node && node.location
    if (!isValidPoint(loc)) {
      /**
       * 没有坐标就不跳 —— 跳过去看到一个没聚焦的地图，
       * 用户会以为按钮坏了。
       */
      this.setData({ note: '这一站没有坐标，地图上定位不了' })
      return
    }
    try {
      wx.setStorageSync('zhiyou-focus-place', {
        placeName: node.placeName || '这一站',
        latitude: loc.latitude,
        longitude: loc.longitude,
        /** 16 是步行导航常用层级：街道名与路口看得清，又不至于只剩几栋楼 */
        scale: 16,
        at: Date.now(),
      })
    } catch (e) {
      /**
       * ⚠️ 写不进去就**如实说不跳**，而不是照跳 ——
       * 跳过去地图不知道要聚焦哪里，用户看到的是一个普通地图，
       * 会以为"点到了没用"。见 `rememberActiveTrip` 的同一条纪律。
       */
      this.setData({ note: '本地存不下聚焦位置，地图可能不会放大到这一站' })
    }
    wx.switchTab({
      url: '/pages/map/index',
      fail: () => this.setData({ note: '地图页打开失败，请手动切到「地图」' }),
    })
  },

  /**
   * 点时间线上的某一站 → 去地图上放大看它。
   *
   * ⚠️ 这个动作**只改变视图，不改变任何进度**。
   *    "到了"才是记录事实；看一眼地图不该被记成到达。
   */
  focusNodeOnMap(e) {
    const nodeId = e.currentTarget.dataset.nodeid
    /** 时间线里已经带了 location（见 `buildTimelineView`），不必回查 rawNodes */
    const node = (this.data.timeline || []).find((n) => n.nodeId === nodeId)
    if (node) this.goToMapFocus(node)
  },

  /**
   * 把节点连成一条线，画在地图上。
   *
   * ── 走到哪了要看得见（2026-10-13 用户要求）──────────────
   *   · **路线在游玩全程保留**，不会因为"走过了"就消失；
   *   · 已到过的部分变**绿色**（marker 与连线同时变），
   *     这样一眼能看出"还剩几站、现在在哪"；
   *   · 未走的部分是深蓝，当前站橙色。
   *
   * ⚠️ 连线是**游览顺序示意**，不是逐段真实步行路径。
   * 腾讯返回的 `polyline` 是差分压缩格式（首对绝对坐标、其后为相对增量），
   * 解码规则需以官方文档为准，不靠观察猜。
   */
  buildRouteMap(nodes, startPoint, navLeg) {
    const located = (nodes || []).filter(n => isValidPoint(n.location))
    if (!located.length) return null

    /**
     * ── 导航模式：画**真实路径** ──────────────────────────────
     *
     * 进来的是 `trip.legRoute` 解出来的折线（几十到几百个点）。
     * 这时候不再画"游览顺序示意" —— 那是一条直线，会让人以为要走直线。
     * `decoded: false` 时**什么都不画**，并如实说明 —— 宁可没有线，
     * 也不能拿示意图冒充真实路线。
     */
    if (navLeg) {
      const route = navLeg.route || {}
      const parts = Array.isArray(route.polylines) ? route.polylines : [{ mode: navLeg.mode, points: route.points || [] }]
      const lines = parts.filter(p => Array.isArray(p.points) && p.points.length >= 2 && p.points.every(isValidPoint))
        .map(p => ({ points: p.points, color: p.mode === 'walking' && (navLeg.mode === 'transit' || navLeg.mode === 'subway') ? '#708090' : '#0B3C6E',
          dottedLine: p.mode === 'walking' && (navLeg.mode === 'transit' || navLeg.mode === 'subway'), width: 6, arrowLine: true, borderColor: '#FFFFFF', borderWidth: 2 }))
      const path = [].concat(...lines.map(p => p.points))
      const origin = navLeg.fromLocation || startPoint
      const endpoints = [origin, navLeg.toLocation].filter(isValidPoint)
      const reachedCount = located.filter((n) => isReached(n.status)).length
      return {
        center: path[0] || endpoints[0] || located[0].location,
        includePoints: path.concat(endpoints),
        polyline: lines,
        markers: [origin, navLeg.toLocation]
          .map((p, i) => ({ p, i }))
          .filter(({ p }) => isValidPoint(p))
          .map(({ p, i }) => ({
            id: i,
            latitude: p.latitude,
            longitude: p.longitude,
            iconPath: i === 0 ? '/assets/dot-me.png' : '/assets/pin-place.png',
            width: i === 0 ? 22 : 28,
            height: i === 0 ? 22 : 35,
            callout: {
              content: i === 0 ? '我' : navLeg.placeName || '终点',
              color: '#FFFFFF',
              bgColor: i === 0 ? '#FF7A45' : '#0B3C6E',
              fontSize: 11,
              borderRadius: 10,
              padding: 4,
              display: 'ALWAYS',
              textAlign: 'center',
            },
          })),
        reachedCount: reachedCount,
        totalCount: located.length,
        /** 概览进度条宽度（0–100）。在 JS 里算好，模板只做插值 —— 模板里除法遇 0 会出 NaN */
        progressPct: located.length ? Math.round((reachedCount / located.length) * 100) : 0,
        nextName: navLeg.placeName || null,
        navMode: true,
        legend: !path.length ? '路径坐标缺失或坐标异常，仅显示起终点；请查看指引或重新获取路线' :
          (navLeg.modeLabel || '步行') + '路线 · ' + (route.partial ? '部分分段缺失，详见指引；' : '') + ((navLeg.mode === 'transit' || navLeg.mode === 'subway') ? '灰色虚线为步行接驳，蓝色为乘车路段' : '路径来自地图服务'),
      };
    }

    const startPt = isValidPoint(startPoint) ? startPoint : null

    /**
     * 已走过 = 最后一个**真正到过**的节点（含）之前的部分。
     * `skipped` 不算 —— 跳过就是没去，绿线不该画到那里。
     */
    let lastReachedIdx = -1
    located.forEach((n, i) => {
      if (isReached(n.status)) lastReachedIdx = i
    })
    const reachedCount = located.filter((n) => isReached(n.status)).length

    const header = startPt ? [startPt] : []
    const full = header.concat(
      located.map((n) => ({ latitude: n.location.latitude, longitude: n.location.longitude }))
    )
    const splitAt = header.length + lastReachedIdx

    // 绿线：起点 → 最后一个到过的节点
    // 蓝线：从那个节点继续往后（**与绿线首尾相接**，视觉上是连续的一条路）
    const donePts = lastReachedIdx >= 0 ? full.slice(0, splitAt + 1) : []
    const restPts = lastReachedIdx >= 0 ? full.slice(splitAt) : full

    const lines = []
    if (donePts.length >= 2) {
      lines.push({
        points: donePts,
        color: '#0F9D58',
        width: 5,
        borderColor: '#FFFFFF',
        borderWidth: 2,
      })
    }
    if (restPts.length >= 2) {
      lines.push({
        points: restPts,
        color: '#0B3C6E',
        width: 4,
        arrowLine: true, // 未走的部分带方向箭头
        borderColor: '#FFFFFF',
        borderWidth: 2,
      })
    }

    const markers = located.map((n, i) => {
      const reached = isReached(n.status)
      const skipped = n.status === 'skipped'
      const arrived = n.status === 'arrived'
      return {
        id: i + 1,
        latitude: n.location.latitude,
        longitude: n.location.longitude,
        // 到过 → 绿色图标；**跳过的仍是蓝的**（没去过就不该显示成去过）
        iconPath: reached ? '/assets/pin-done.png' : '/assets/pin-place.png',
        width: 28,
        height: 35,
        callout: {
          content: String(i + 1),
          color: '#FFFFFF',
          bgColor: reached ? '#0F9D58' : skipped ? '#9AA5B1' : arrived ? '#FF7A45' : '#0B3C6E',
          fontSize: 11,
          borderRadius: 10,
          padding: 5,
          display: 'ALWAYS',
          textAlign: 'center',
        },
      }
    })

    if (startPt) {
      markers.unshift({
        id: 0,
        latitude: startPt.latitude,
        longitude: startPt.longitude,
        iconPath: '/assets/dot-me.png',
        width: 22,
        height: 22,
        callout: {
          content: '我',
          color: '#FFFFFF',
          bgColor: '#FF7A45',
          fontSize: 11,
          borderRadius: 10,
          padding: 4,
          display: 'ALWAYS',
          textAlign: 'center',
        },
      })
    }

    return {
      center: full[0],
      includePoints: full,
      polyline: lines,
      markers: markers,
      /** 进度，界面直接显示，不用自己数 */
      reachedCount: reachedCount,
      totalCount: located.length,
      /** 概览进度条宽度（0–100）。在 JS 里算好，模板只做插值 —— 模板里除法遇 0 会出 NaN */
      progressPct: located.length ? Math.round((reachedCount / located.length) * 100) : 0,
      /**
       * "是不是全走完了" —— **在 JS 里算好给模板**（2026-10-14）。
       *
       * 不在模板里写 `reachedCount >= totalCount`：WXML 不把 `&gt;` 当转义符解码
       * （编译器直接报 ``unexpected '&'``），而写原始 `>` 又依赖解析器的容忍度。
       * 与其在两个都不稳的写法之间挑，不如把判断挪到能测的地方。
       */
      allReached: located.length > 0 && reachedCount >= located.length,
      /** 下一站的名字 —— 概览里显示"当前该去哪"，不用自己去时间轴上找 */
      nextName:
        lastReachedIdx + 1 < located.length ? located[lastReachedIdx + 1].placeName : null,
      legend:
        located.length >= 2
          ? '绿线为已走过的部分，蓝线为剩余路线；连线是顺序示意，不是逐段真实路径'
          : '只有一个目的地，暂无可连的路线',
    }
  },

  // ══════════ 进度 ══════════

  /**
   * **当前出行段** —— 从"已经走到的地方"到"下一站"。
   *
   *     · 还没出发     → 我的位置 → 第 1 站（出发段）
   *     · 走到第 k 站  → 第 k 站  → 第 k+1 站
   *     · 全部走完     → null
   *
   * ⚠️ 这块**不是**"站的顺序"，而是"**这一段怎么走、多远、多久**"。
   * 顺序是计划，出行方式与距离才是行走时真正要看的东西 ——
   * 也**正是导航需要的全部输入**（我在哪、下一步去哪、怎么走、多远）。
   *
   * 所以这里刻意把 `to` 的坐标一起带出来：将来接导航时
   * `wx.openLocation` / 步行路线规划直接用得上，不必再回查一遍。
   */
  buildCurrentLeg(nodes, startLeg) {
    const located = (nodes || []).filter(n => n.status !== 'skipped' && isValidPoint(n.location)).slice().sort((a, b) => a.seq - b.seq)
    if (!located.length) return null
    const targetIndex = located.findIndex(n => n.status === 'pending')
    if (targetIndex < 0) return null

    let lastReached = -1
    located.forEach((n, i) => {
      if (i < targetIndex && isReached(n.status)) lastReached = i
    })

    const totalLegs = located.length

    // ① 还没出发：我的位置 → 第 1 站
    if (lastReached < 0) {
      const first = located[targetIndex]
      if ((nodes || [])[0].nodeId !== first.nodeId) startLeg = null
      /**
       * ⚠️ 这一段**也是**多方式接入的一部分，而我上一批只改了第三段。
       *
       * 原来这里 `mode: '步行'` 是**写死**的 —— 于是"我的位置 → 第一站"
       * 无论实际坐地铁还是公交，界面上都显示"步行"。
       *
       * 而用户最常看到的就是这一段（还没标记"到达"任何站时，当前路线
       * 显示的就是它）—— 所以只修第三段等于没修。
       *
       * 数据来自 `startLeg`（`trip.plan` 的起点段，由 `leg-times` 选出方式）。
       */
      const startMode = startLeg ? (startLeg.rawMode || 'walking') : (first.travelMode || 'walking')
      return {
        from: (startLeg && startLeg.label) || '我的位置',
        to: first.placeName,
        rawMode: startMode,
        mode: modeInfo(startMode, startLeg && startLeg.transit).name,
        modeIcon: modeInfo(startMode, startLeg && startLeg.transit).icon,
        modeArt: modeInfo(startMode, startLeg && startLeg.transit).art,
        reason: (startLeg && startLeg.reason) || '',
        reasonShow: showReason(startLeg && startLeg.reason),
        fastest: isFastestReason(startLeg && startLeg.reason),
        transitText: (startLeg && startLeg.transitText) || describeTransit(startLeg && startLeg.transit),
        provider: (startLeg && startLeg.provider) || null,
        candidateReason: (startLeg && startLeg.candidateReason) || null,
        minutes: startLeg ? startLeg.minutes : null,
        meters: startLeg ? startLeg.meters : null,
        source: startLeg ? startLeg.source : null,
        sourceLabel: SOURCE_LABEL[startLeg ? startLeg.source : null] || '',
        estimated: Boolean(startLeg && startLeg.source === 'estimated'),
        // 导航要用：目的地的坐标
        toLocation: first.location,
        toPlaceId: first.placeId,
        toNodeId: first.nodeId,
        legIndex: targetIndex + 1,
        totalLegs: totalLegs,
        isStart: true,
      }
    }

    // ② 全部走完
    // ③ 从刚走到的这一站，去下一站
    const fromNode = located[lastReached]
    const next = located[targetIndex]
    const adjacent = (nodes || []).findIndex(n => n.nodeId === next.nodeId) === (nodes || []).findIndex(n => n.nodeId === fromNode.nodeId) + 1
    return {
      from: fromNode.placeName,
      to: next.placeName,
      rawMode: next.travelMode || 'walking',
      /**
       * ⚠️ 这里原来是：
       *     next.travelMode === 'walking' ? '步行' : next.travelMode === 'none' ? '' : '步行'
       * —— **非步行的一律兜底成"步行"**。接入公交/驾车后那是错的：
       * 一段 63 分钟的 126 路会被显示成"步行 63 分钟"。
       */
      mode: !adjacent || next.travelMode === 'none' ? '' : modeInfo(next.travelMode, next.travelTransit).name,
      modeIcon: !adjacent || next.travelMode === 'none' ? '' : modeInfo(next.travelMode, next.travelTransit).icon,
      modeArt: !adjacent || next.travelMode === 'none' ? '' : modeInfo(next.travelMode, next.travelTransit).art,
      /** 为什么选这个方式（"公交比步行省 78 分钟"）—— 只给结论不给理由，用户没法判断 */
      reason: adjacent ? (next.travelReason || '') : '已跳过或改变中间站点，请获取新的导航路线。',
      reasonShow: adjacent ? showReason(next.travelReason) : true,
      fastest: adjacent && isFastestReason(next.travelReason),
      /** 公交的换乘细节 */
      transitText: adjacent ? describeTransit(next.travelTransit) : '',
      minutes: adjacent ? next.travelFromPrevMin : null,
      meters: adjacent ? next.travelFromPrevMeters : null,
      source: adjacent ? next.travelSource : null,
      sourceLabel: adjacent ? SOURCE_LABEL[next.travelSource] || '' : '',
      /**
       * 「直线估算」与真实路线在短距离下能差 7 倍（实测 10 米 → 76 米），
       * 必须标出来 —— 否则用户会以为所有时间一样可信。
       */
      estimated: adjacent && next.travelSource === 'estimated',
      toLocation: next.location,
      toPlaceId: next.placeId,
      toNodeId: next.nodeId,
      legIndex: targetIndex + 1,
      totalLegs: totalLegs,
      isStart: false,
    }
  },

  /**
   * **开始导航** —— 取这一段的真实路线与转向指引。
   *
   * 数据来自 `trip.legRoute`：解码后的真实步行路径 + **上游原话**的转向指引。
   * 每次调用消耗 1 次地图配额（响应里的 `mapApiCalls` 会如实计数）。
   *
   * ⚠️ 与「用微信地图打开」是两条路：
   *   · 这里 = **应用内导航**（把真实路径画在地图上 + 逐步指引）
   *   · 那里 = 交给微信内置地图（有语音，但要跳出小程序）
   * 两条都留着，因为各有各的用处：走路时看应用内，要语音播报时用系统地图。
   */
  startNavigation() {
    const that = this
    if (!this.data.trip || !this.data.currentLeg) {
      wx.showToast({ title: '还没有可以导航的路段', icon: 'none' })
      return
    }

    const tripId = this.data.trip.tripId, version = this.data.trip.version
    const mode = this.data.currentLeg.rawMode || 'walking'
    const nodeId = this.data.currentLeg.toNodeId, key = navigationKey(this.data.trip, this.data.currentLeg)
    this.navigationRequested = true
    this.cancelNavigationRequest()
    const token = this.navigationToken
    this.navigationRequestKey = key
    const current = () => token === this.navigationToken && this.navigationVisible !== false &&
      key === navigationKey(this.data.trip, this.data.currentLeg)
    this.setData({ navLoading: true, navError: '', navHint: '', navLeg: null,
      routeMap: this.buildRouteMap(this.data.rawNodes, this.data.startPoint, null) },
    () => this.fitRouteMap())

    /**
     * 传当前位置最准 —— 导航本来就该从"你在哪"算起，而不是从计划时的出发点。
     * 取不到位置就用行程里存的出发位置（服务端会依次回退）。
     */
    return this.tryLocate()
      .then(function (from) {
        if (!current()) return
        return api.callApi('trip.legRoute', {
          tripId, nodeId, mode,
          fromPoint: from || undefined,
        }, { expectedVersion: version })
      })
      .then(function (res) {
        if (!current()) return
        that.navigationRequestKey = ''
        if (!res || res.ok !== true) {
          that.setData({
            navLoading: false,
            navError: (res && res.error && res.error.message) || '取路线失败',
          })
          return
        }
        const d = res.data || {}
        if (d.mode && d.mode !== mode) { that.setData({ navLoading: false, navError: '返回路线与所选方式不一致，请重试' }); return }
        if (d.ok === false) {
          // 上游失败（配额、Key、起终点重合…）—— 如实展示，不画一条直线冒充
          that.setData({
            navLoading: false,
            navError: d.message || '取路线失败',
            navHint: d.hint || '',
          })
          return
        }

        that.setData(
          {
            navLoading: false,
            navLeg: {
              routeKey: key, nodeId, fromLocation: d.from,
              mode: d.mode || mode,
              modeLabel: modeInfo(d.mode || mode, d.transit).name,
              transitText: describeTransit(d.transit),
              summaryText: [Number.isFinite(d.distanceMeters) ? d.distanceMeters + ' 米' : '', Number.isFinite(d.durationMinutes) ? d.durationMinutes + ' 分钟' : ''].filter(Boolean).join(' · '),
              transitDetail: d.transit ? [Number.isFinite(d.transit.walkingMeters) ? '步行接驳 ' + d.transit.walkingMeters + ' 米' : '', Number.isFinite(d.transit.transferCount) ? '换乘 ' + d.transit.transferCount + ' 次' : '', Number.isFinite(d.transit.costYuan) ? '参考票价 ' + d.transit.costYuan + ' 元' : ''].filter(Boolean).join(' · ') : '',
              placeName: d.placeName,
              legIndex: d.legIndex,
              totalLegs: d.totalLegs,
              distanceMeters: d.distanceMeters,
              durationMinutes: d.durationMinutes,
              decoded: Boolean(d.route && d.route.decoded),
              pointCount: (d.route && d.route.pointCount) || 0,
              steps: (d.route && d.route.steps) || [],
              /** 真实路径 —— 地图直接画它（见 buildRouteMap 的导航模式分支） */
              route: d.route || null,
              toLocation: d.to,
            },
            navHint: d.route && d.route.partial ? '部分接驳段没有路径坐标，地图仅展示已返回的分段，请结合指引查看。' : '',
            navError:
              d.route && d.route.decoded
                ? ''
                : '地图服务未返回可用的路径点，仅展示起终点和已有指引，可重新获取路线。',
          },
          /**
           * 必须**重建地图**，不能只调 fitRouteMap ——
           * `routeMap` 是在 `buildRouteMap` 里按 navLeg 分支生成的，
           * 不重建就还是原来那条"顺序示意"的线。
           * `rebuildFromNodes` 内部会把 navLeg 传下去，并在之后重新框视野。
           */
          () => that.rebuildFromNodes({ refreshNavigation: false })
        )
      })
      .catch(function (err) {
        if (!current()) return
        that.navigationRequestKey = ''
        that.setData({ navLoading: false, navError: (err && err.errMsg) || '取路线失败' })
      })
  },

  /** 退出导航，地图回到"整条路线"的示意 */
  stopNavigation() {
    this.navigationRequested = false
    this.cancelNavigationRequest()
    this.setData({ navLeg: null, navLoading: false, navError: '', navHint: '' }, () => this.rebuildFromNodes({ refreshNavigation: false }))
  },

  /** 交给微信内置地图（有语音播报，但要跳出小程序） */
  openInWechatMap() {
    const leg = this.data.currentLeg
    if (!leg || !isValidPoint(leg.toLocation)) {
      wx.showToast({ title: '这一段还没有目的地坐标', icon: 'none' })
      return
    }
    wx.openLocation({
      latitude: leg.toLocation.latitude,
      longitude: leg.toLocation.longitude,
      name: leg.to,
      scale: 16,
      fail(err) {
        wx.showToast({ title: (err && err.errMsg) || '打开地图失败', icon: 'none' })
      },
    })
  },

  /**
   * 记录实际进度（到了 / 逛完了 / 撤销）。
   *
   * 这是**事实记录**，不重新规划 —— 已到过的节点在地图与时间轴上变绿，
   * 路线全程保留，让人一眼看出还剩几站。
   */
  nodeProgress(e) {
    const that = this
    const { nodeid: nodeId, status } = e.currentTarget.dataset
    if (!this.data.trip || !status) return
    const tripId = this.data.trip.tripId

    this.setData({ busy: 'progress', error: '' })

    return api
      /**
       * ⚠️ `expectedVersion` 必须放在**第三个参数**（信封层），不能写进 payload。
       *
       * 2026-10-13 发现的真实缺陷：三个写操作都把它写进了 payload，
       * 而 api.js 与后端都只从信封层读 → 它被静默忽略 →
       * 服务端回落到"当前版本" → **版本校验恒等于通过**。
       * 「旧版本确认不得使新方案生效」这条 11/5 验收项当时根本没生效。
       *
       * 现在后端改成必填了：传错位置会直接报错，不会再静默放行。
       */
      .callApi(
        'trip.progress',
        { tripId: this.data.trip.tripId, nodeId: nodeId, status: status },
        { expectedVersion: this.data.trip.version }
      )
      .then(function (res) {
        if (!that.data.trip || that.data.trip.tripId !== tripId) return
        if (!res || res.ok !== true) {
          const e2 = res && res.error
          that.setData({
            busy: '',
            error:
              e2 && e2.code === 'VERSION_CONFLICT'
                ? '行程已被更新，请重新生成后再标记进度'
                : (e2 && e2.message) || '记录进度失败',
          })
          return
        }
        const d = res.data
        // trip.progress 只回传 nodes —— 把它合并进 rawNodes，其余信息保持不动
        // ⚠️ 空数组也要当成"没给"：否则界面会被清空
        const freshNodes = d.nodes && d.nodes.length ? d.nodes : that.data.rawNodes
        that.setData(
          {
            busy: '',
            trip: Object.assign({}, that.data.trip, { version: d.version }),
            rawNodes: freshNodes,
          },
          () => {
            that.rebuildFromNodes({ refreshNavigation: status !== 'arrived' })
            /**
             * ── 点「到了」后跳到地图页并放大到这一站 ──────────────
             * （2026-10-14 用户要求："点击到了以后**跳转到地图页面**，
             *   然后地图放大"）
             *
             * ⚠️ 只在**真的记成功了**之后才跳（这里就是成功分支）。
             *    在 `setData` 之前跳的话，请求失败时用户已经在地图页了，
             *    而行程里的"到达"并没有记上 —— 他会以为自己到了。
             *
             * ⚠️ 只在 `arrived` 时跳，`done`/`skipped` 不跳：
             *    「逛完了」「不去了」都不需要"我在哪、怎么去"这个答案。
             */
            if (status === 'arrived') {
              const node = (freshNodes || []).find((n) => n.nodeId === nodeId)
              if (node) that.goToMapFocus(node)
            }
          }
        )
      })
      .catch(function (err) {
        that.setData({ busy: '', error: (err && err.errMsg) || '记录进度失败' })
      })
  },

  // ══════════ 调整 ══════════

  onChangeText(e) {
    this.setData({ changeText: e.detail.value, changeDraftId: '', changeQuestions: [],
      changeAnswers: {}, changeNeedsRewrite: false, changeError: '' })
  },

  onChangeVoice(e) {
    if (!this.data.trip || this.data.loading || this.data.busy) return
    if (e.detail.contextKey !== undefined && e.detail.contextKey !== this.data.trip.tripId + ':' + this.data.trip.version) return
    const value = appendSpeech(this.data.changeText, e.detail.text, 1000)
    if (value === null) { wx.showToast({ title: '语音为空或合并后超过1000字，请分段输入', icon: 'none' }); return }
    // 复用手动输入路径：使旧追问失效，保留尚未确认的方案供下一次合并。
    this.onChangeText({ detail: { value } })
  },

  answerChangeQuestion(e) {
    const key = e.currentTarget.dataset.key
    const value = e.currentTarget.dataset.value === undefined ? e.detail.value : e.currentTarget.dataset.value
    const answers = Object.assign({}, this.data.changeAnswers, { [key]: value })
    const questions = this.data.changeQuestions.map(q => q.key !== key ? q : Object.assign({}, q, { value,
      answerLabel: ((q.options || []).find(o => o.value === value) || {}).label || value }))
    this.setData({ changeAnswers: answers, changeQuestions: questions })
  },

  async submitTextChange() {
    const trip = this.data.trip
    if (!trip || this.data.busy || this.data.changeVoiceActive) return
    const text = this.data.changeText.trim()
    if (!text) { this.setData({ changeError: '请输入想怎样修改行程' }); return }
    const draftId = this.data.changeDraftId
    const token = this.textChangeToken = (this.textChangeToken || 0) + 1
    const previous = this.data.proposal && this.data.proposal.isText ? this.data.proposal.proposalId : null
    const payload = draftId ? { tripId: trip.tripId, draftId, answers: this.data.changeAnswers }
      : { tripId: trip.tripId, text, ...(previous ? { previousProposalId: previous } : {}) }
    this.setData({ busy: 'text-change', changeError: '', error: '' })
    try {
      const res = await api.callApi('trip.adjustText', payload, { expectedVersion: trip.version })
      if (!this.data.trip || this.data.trip.tripId !== trip.tripId || token !== this.textChangeToken) return
      if (this.data.trip.version !== trip.version) {
        this.setData({ changeDraftId: '', changeQuestions: [], changeAnswers: {}, changeError: '行程已更新，请基于当前行程重新提交修改。' })
        return
      }
      if (!res || !res.ok) {
        const err = (res && res.error) || {}
        if (err.code === 'VERSION_CONFLICT') {
          this.setData({ changeDraftId: '', changeQuestions: [], changeAnswers: {}, proposal: null,
            proposalMode: null, proposalCandidates: [] })
          await this.refreshTextTrip(trip.tripId)
        }
        this.setData({ changeError: err.code === 'VERSION_CONFLICT'
          ? '行程已更新，已尝试刷新；请核对当前行程后重新提交修改。' : err.message || '理解修改失败，请重试' })
        return
      }
      const d = res.data
      this.setData({ changeInterpretation: d.interpretation, changeSummary: (d.interpretation && d.interpretation.summary) || [],
        changeTurns: (d.interpretation && d.interpretation.turns) || [text] })
      if (d.needsClarification) {
        this.setData({ changeDraftId: d.draftId, changeQuestions: d.questions || [],
          changeNeedsRewrite: (d.questions || []).some(q => q.kind === 'rewrite'),
          note: '还需确认修改要求，原行程保持不变。' })
        return
      }
      this.setData({ changeDraftId: '', changeQuestions: [], changeAnswers: {}, changeNeedsRewrite: false, changeText: '' })
      this.applyProposal(d)
      this.setData({ 'proposal.isText': true })
    } catch (err) {
      if (token === this.textChangeToken) this.setData({ changeError: err.message || err.errMsg || '理解修改失败，请重试' })
    } finally {
      if (token === this.textChangeToken) this.setData({ busy: '' })
    }
  },

  async refreshTextTrip(tripId, note) {
    const res = await api.callApi('trip.get', { tripId })
    if (!res || !res.ok || !this.data.trip || this.data.trip.tripId !== tripId) return
    this.applyFetchedTrip(res.data.trip, tripId, note || '行程已刷新，请重新确认修改', this.data.startPoint, { skipModeChoice: true })
  },

  applyFetchedTrip(t, tripId, note, fallbackStart, options) {
    const nodes = (t.nodes || []).slice().sort((a, b) => a.seq - b.seq)
    const first = nodes[0] && nodes[0].status !== 'skipped' ? nodes[0] : null
    this.applyTrip({ tripId, version: t.version, nodes, startPoint: t.startPoint || fallbackStart || null,
      startLeg: first && first.travelFromStart ? { minutes: first.travelFromPrevMin, meters: first.travelFromPrevMeters,
        mode: first.travelMode, source: first.travelSource, provider: first.travelProvider,
        reason: first.travelReason, transit: first.travelTransit, toPlaceName: first.placeName } : null, summary: {
      endAt: t.plannedEndAt, totalStayMin: nodes.filter(n => n.status !== 'skipped').reduce((s, n) => s + (n.plannedStayMin || 0), 0),
      totalWalkMin: nodes.filter(n => n.status !== 'skipped' && n.travelMode === 'walking').reduce((s, n) => s + (n.travelFromPrevMin || 0), 0),
      totalWalkMeters: nodes.filter(n => n.status !== 'skipped' && n.travelMode === 'walking').reduce((s, n) => s + (n.travelFromPrevMeters || 0), 0),
    } }, note, options)
  },

  /**
   * 「调整时长」—— 把原来的「多停一会儿 / 少停一会儿」两个按钮合并成一个入口。
   *
   * 为什么合并：一屏四段行程，每段并排四个按钮（到了/多停/少停/不去了），
   * 手指在手机上极容易点到旁边那个 —— 而多停与少停本来就是同一件事的两个方向。
   * 合并后每段只剩三个动作，误触面小了一半。
   *
   * 实现刻意只做"换入口、不改逻辑"：选完仍然走 `nodeAction`，
   * 增量分钟数仍由原来的 `requestMinutes` 询问 —— 后端与测试都不受影响。
   */
  adjustStay(e) {
    const nodeId = e.currentTarget.dataset.nodeid
    if (!this.data.trip || this.data.busy) return
    wx.showActionSheet({
      itemList: ['多停一会儿', '少停一会儿'],
      success: (res) => {
        const key = res.tapIndex === 0 ? 'extend' : 'shorten'
        this.nodeAction({ currentTarget: { dataset: { nodeid: nodeId, key } } })
      },
      fail: () => {},
    })
  },

  /** 快捷调整：个人行程无额外取舍时直接生效，其余展示候选。 */
  async nodeAction(e) {
    const that = this
    const { nodeid: nodeId, key } = e.currentTarget.dataset
    if (!this.data.trip || this.data.busy) return
    let deltaMin
    if (key !== 'skip') {
      this.setData({ busy: 'duration', error: '' })
      try { deltaMin = await requestMinutes(key === 'shorten') }
      catch (err) { this.setData({ error: err.message }); return }
      finally { this.setData({ busy: '' }) }
      if (deltaMin == null) return
    }

    const trigger =
      key === 'skip'
        ? { type: 'skip_node', payload: { nodeId } }
        : {
            type: key === 'extend' ? 'extend_stay' : 'shorten_stay',
            payload: { nodeId, deltaMin },
          }

    this.setData({ busy: 'adjust', error: '' })

    return api
      // expectedVersion 走第三个参数（信封层），见 trip.progress 处的说明
      .callApi(
        'trip.adjust',
        { tripId: this.data.trip.tripId, trigger },
        { expectedVersion: this.data.trip.version }
      )
      .then(function (res) {
        if (!res || res.ok !== true) {
          that.setData({ busy: '', error: (res && res.error && res.error.message) || '调整失败' })
          return
        }
        const d = res.data
        /**
         * 没有取舍时后端**已经直接生效**了 —— 不必再让用户点一次确认。
         * 只有出现取舍（需要压缩或删除某个节点）时才弹候选卡片，
         * 因为那才是真正需要用户判断的地方。
         */
        if (d.applied) {
          that.applyTrip(d, d.note || '调整已生效')
          return
        }
        that.applyProposal(d)
      })
      .catch(function (err) {
        that.setData({ busy: '', error: (err && err.errMsg) || '调整失败' })
      })
  },

  /**
   * 按 §5.2 的四种情况决定展示方式。
   * **不凑数**：可行候选只有一条就显示一条；两种策略结论一致就合并说明。
   */
  applyProposal(d) {
    const candidates = d.candidates || []
    const feasible = candidates.filter((c) => c.feasible)
    const merged = (d.excludedReasons || []).some((r) => r.reason === 'DUPLICATE')

    let mode = 'none'
    let note = ''

    if (feasible.length >= 2) {
      mode = 'two'
      note = '两条方案各有取舍，请选择'
    } else if (feasible.length === 1 && merged) {
      mode = 'merged'
      note = '两种策略得到同一方案，已合并展示'
    } else if (feasible.length === 1) {
      mode = 'single'
      note = '当前条件下只有一条可行方案'
    } else {
      mode = 'none'
      note = '没有可行的调整方案，请选择要放宽的条件'
    }

    this.setData({
      busy: '',
      proposal: { proposalId: d.proposalId, baseVersion: d.baseVersion },
      proposalMode: mode,
      proposalNote: note,
      note: feasible.length ? '调整尚未生效，请查看下方方案并选择；也可以保持原计划。'
        : '调整尚未生效：没有可行方案，请调整条件后重试。',
      proposalCandidates: candidates.map((c) => ({
        candidateId: c.candidateId,
        label: c.strategyLabel,
        feasible: c.feasible,
        changes: (c.notes || []).map((n) => n.message),
        conflicts: (c.conflicts || []).map((x) => x.message),
        preserved: c.impact ? c.impact.preservedNodeCount : null,
        nodeCount: (c.nodes || []).length,
        endAt: c.impact ? hhmm(c.impact.changedEndAt) : '--:--',
        endShiftMin: c.impact ? c.impact.endShiftMin : null,
        walkDelta: c.impact ? c.impact.addedWalkMin : null,
        qualityOk: c.quality ? c.quality.meetsBasicQuality : true,
      })),
      error: '',
    }, () => wx.pageScrollTo({ selector: '#adjustment-proposals', duration: 250, fail: () => {} }))
  },

  discardProposal() {
    this.setData({
      proposal: null,
      proposalMode: null,
      proposalCandidates: [],
      changeDraftId: '', changeQuestions: [], changeAnswers: {}, changeNeedsRewrite: false,
      changeInterpretation: null, changeSummary: [], changeTurns: [],
      note: '已放弃本次调整',
    })
  },

  confirmCandidate(e) {
    const that = this
    const candidateId = e.currentTarget.dataset.cid
    const proposal = this.data.proposal
    if (!proposal) return

    this.setData({ busy: 'confirm', error: '' })

    return api
      // expectedVersion 走第三个参数（信封层）—— 传错位置会让版本校验静默失效
      .callApi(
        'trip.confirmChange',
        { proposalId: proposal.proposalId, candidateId: candidateId },
        { expectedVersion: proposal.baseVersion }
      )
      .then(function (res) {
        if (!res || res.ok !== true) {
          const e2 = res && res.error
          // 版本冲突是预期内的正常结果（§8.1 旧确认不得生效），要给出可执行的提示
          const hint =
            e2 && e2.code === 'VERSION_CONFLICT'
              ? '行程已被更新，该确认已失效，请重新调整'
              : (e2 && e2.message) || '确认失败'
          that.setData({ busy: '', error: hint })
          if (e2 && e2.code === 'VERSION_CONFLICT') {
            that.setData({ changeDraftId: '', changeQuestions: [], changeAnswers: {} })
            return that.refreshTextTrip(that.data.trip.tripId).then(() => that.setData({ error: hint }))
          }
          return
        }
        that.applyTrip(res.data, '已确认调整并生效')
      })
      .catch(function (err) {
        that.setData({ busy: '', error: (err && err.errMsg) || '确认失败' })
      })
  },

  cancelTrip() {
    if (!this.data.trip || this.data.busy || this.data.loading || this.data.changeVoiceActive) return
    const tripId = this.data.trip.tripId, version = this.data.trip.version
    wx.showModal({ title: '取消当前行程？', content: '取消后返回地点选择，已记录的到达信息仍会保留。',
      confirmText: '取消行程', cancelText: '继续游览',
      success: result => {
        if (!result.confirm || !this.data.trip || this.data.trip.tripId !== tripId ||
          this.data.trip.version !== version || this.data.busy || this.data.loading || this.data.changeVoiceActive) return
        this.resetTrip()
        this.setData({ note: '已取消当前行程，可重新确认地点' }, () => wx.pageScrollTo({ scrollTop: 0, duration: 250 }))
      },
    })
  },

  resetTrip() {
    const previousId = this.data.trip && this.data.trip.tripId
    const saved = wx.getStorageSync('zhiyou-active-trip')
    if (saved && saved.tripId === previousId) wx.removeStorageSync('zhiyou-active-trip')
    this.tripLoadToken = (this.tripLoadToken || 0) + 1
    this.navigationRequested = false
    this.cancelNavigationRequest()
    this.textChangeToken = (this.textChangeToken || 0) + 1
    this.setData({
      busy: '',
      trip: null,
      currentLeg: null, navLeg: null, navLoading: false, navError: '', navHint: '', routeMap: null, routeMapOpen: true,
      rawNodes: [],
      tripDisplay: null, sourcePanelOpen: false,
      legEditor: null, startLegEditable: false, legPicker: [], legPickerOpen: false, legModes: {}, rawLegOptions: [], legOptionsCount: 0,
      timeline: [],
      summary: null,
      unverifiedNotice: null,
      warnings: [],
      proposal: null,
      proposalMode: null,
      proposalCandidates: [],
      planRejected: false,
      conflicts: [],
      changeText: '', changeDraftId: '', changeQuestions: [], changeAnswers: {},
      changeInterpretation: null, changeSummary: [], changeTurns: [], changeError: '', changeNeedsRewrite: false,
      changePanelOpen: false,
      note: '已返回地点选择',
    })
  },
})

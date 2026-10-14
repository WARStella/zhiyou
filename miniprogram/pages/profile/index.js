/**
 * 「我的」页 —— 个人资料 + 小队与集合（2026-10-14 用户要求）。
 *
 * 用户原话：
 *   "把组队信息卡挪到我的界面，我的界面还需包含用户id与头像，
 *    用户名，默认出行方式等"
 *
 * ── 这个页面的定位 ────────────────────────────────────────
 *
 * 计划书 §5 要求三个页面：行程 / 地图 / 我的。
 * 前两个早已是产品形态，第三个此前是「自检」脚手架（联调工具）。
 * 这一页把它补上，自检挪到独立页面（从这一页进）。
 *
 * ── 三块内容 ──────────────────────────────────────────────
 *
 *   ① 个人资料：头像、昵称、用户 ID、默认出行方式
 *   ② 小队与集合：完整的小队面板（从行程/地图页挪过来）
 *   ③ 开发工具：进「联调自检」的入口
 *
 * ── 一条纪律：不编数据 ────────────────────────────────────
 *
 * 昵称未填就显示"未命名"，不拿 openid 截一段冒充名字；
 * 头像未设置就显示昵称首字生成的色块，不塞一个假头像图片。
 * 与项目里"宁可没有线，也不能拿示意图冒充真实路线"是同一条。
 */

const api = require('../../utils/api')

/** 头像底色：按用户 ID 稳定取一个 —— 同一个人每次进来颜色一致 */
const AVATAR_COLORS = ['#0B3C6E', '#1F7A5A', '#8A5A2B', '#6B3FA0', '#B24A3F', '#2A6E8A']

function avatarColor(seed) {
  const s = String(seed || '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

/**
 * 从选项表里取某个值的显示文案；取不到就回"自动"。
 *
 * ⚠️ 存在的理由是**模板里不能做数组索引**：
 * 选项表在首帧是空数组，`options[0].label` 会抛异常并把整页打白。
 * 算在这里，模板只做插值。
 */
function labelOfMode(options, value) {
  const hit = (options || []).find((o) => o && o.value === value)
  return (hit && hit.label) || '自动'
}

Page({
  data: {
    loading: true,
    error: '',

    /**
     * 用户 ID（28 位）—— 界面上显示的就是它（2026-10-14 用户要求）。
     *
     * 用途是**运维检索**：拿它在数据库、云函数日志里直接搜。
     * 所以要完整、可复制、可对照 —— 截断或换成短号都会让检索落空。
     *
     * （后端仍会算一个 6 位 `shortId` 存在用户记录里，但**界面不显示它**：
     *   它不在任何日志里，对检索没有帮助。用户明确说不需要编号。）
     */
    userId: '',
    /** 后端给的 6 位编号 —— 保留在 data 里以防将来要用，界面不渲染 */
    shortId: '',
    /**
     * 默认出行方式的**显示文案** —— 在 JS 里算好，模板只做插值。
     *
     * ⚠️ 不能让模板去写 `{{travelModeOptions[i].label}}`：
     * 选项表是 `user.getProfile` 回来之后才填的，首帧是**空数组**，
     * 于是 `[0]` 是 undefined、读 `.label` 直接抛
     * `Cannot read properties of undefined (reading '0')` —— 整页白屏。
     */
    travelModeLabel: '自动',
    nickname: '',
    /** 界面上显示的昵称：未填时为兜底文案 */
    nicknameDisplay: '未命名',
    /** 昵称首字，用于没有头像时的色块 */
    initial: '?',
    avatarColor: AVATAR_COLORS[0],
    /** 云存储 fileID → 换成的临时地址；没有头像时为 '' */
    avatarUrl: '',
    defaultTravelMode: 'auto',
    travelModeOptions: [],
    travelModeIndex: 0,

    /** 昵称编辑态：点进去才变成输入框，避免误改 */
    editingNickname: false,
    nicknameDraft: '',
    saving: false,
    savedAt: '',

    /**
     * 给 `team-panel` 的位置入参。
     *
     * ⚠️ 组件用 `point` + `source` 来表达"用哪个位置作为手动集合点"，
     * 而它自己**不定位**（定位要授权，属于页面的事）。
     *
     * 这里暂时是空的：发起集合时若没有位置，组件会提示
     * "去地图选取位置"（`openMap`），那条路是通的。
     * 也就是说——**这一页发起集合仍然可用**，只是要先去地图选点。
     * 把定位搬到这里是下一步的事（避免这一批改动太大）。
     */
    myPoint: null,
    mySource: '',

    /**
     * 当前个人行程的 ID —— 传给 team-panel，供"把当前个人路线复制为共同路线"。
     *
     * ⚠️ 这个值**原来由行程页直接传**（`personal-trip-id="{{trip.tripId}}"`）。
     * 面板挪到「我的」之后，这一页手上没有行程对象，所以从本地读
     * `zhiyou-active-trip`（行程页生成路线时写的，见 `rememberActiveTrip`）。
     *
     * 不读的话症状是：点"复制为共同路线"报**"请先在行程页生成个人路线"**，
     * 而用户明明刚生成过 —— 因为这一页传了个空串过去。
     */
    personalTripId: '',

    /** 小队状态（组件抛回来的）——这一页暂时只用来显示，不画地图 */
    teamLocations: [],
    teamMeeting: null,
  },

  onLoad() {
    /**
     * ⚠️ `loadActiveTripId` 必须**在装载时就调**，不能只放在 `onShow`。
     *
     * `onShow` 在**首次渲染之后**才触发，那时 team-panel 已经渲染过一遍 ——
     * 而"把当前个人路线复制为共同路线"那个按钮的显示条件是
     * `personalTripId` 非空。只靠 `onShow` 的话，用户会看到按钮
     * **闪一下才出现**（或干脆以为没有这个功能）。
     */
    this.loadActiveTripId()
    this.loadProfile()
  },

  /** 每次进来都刷新 —— 小队状态可能被同伴改了 */
  onShow() {
    this.loadProfile()
    this.loadActiveTripId()
  },

  /**
   * 从本地读"当前行程"的 ID。
   *
   * 约定与行程页的 `rememberActiveTrip` 一致：**只存"是哪一个"**，不存内容
   * （内容会因 `trip.adjust` 过期，过期的路线比没有路线更糟）。
   *
   * ⚠️ 读失败或没读过都要**如实留空**，不要编一个 ID ——
   * 空串时 team-panel 会给出"请先在行程页生成个人路线"的提示，
   * 那正是事实。
   */
  loadActiveTripId() {
    let id = ''
    try {
      const saved = wx.getStorageSync('zhiyou-active-trip')
      /** 存的是对象 `{tripId, version}`；容错处理旧格式（纯字符串） */
      if (saved && typeof saved === 'object') id = saved.tripId || ''
      else if (typeof saved === 'string') id = saved
    } catch (err) {
      id = ''
    }
    if (id !== this.data.personalTripId) this.setData({ personalTripId: id })
  },

  /**
   * 接收小队面板抛出的状态。
   *
   * ⚠️ 即使这一页目前不用它画地图，也**必须接住**：
   * 组件会 `triggerEvent('teamstate')`，没人接的话事件静默丢失，
   * 以后想在这一页显示"队员到齐情况"时会以为组件没抛。
   */
  onTeamState(e) {
    const d = (e && e.detail) || {}
    this.setData({
      teamLocations: d.locations || [],
      teamMeeting: d.meeting || null,
    })
  },

  loadProfile() {
    const that = this
    this.setData({ loading: true, error: '' })
    api
      .callApi('user.getProfile', {})
      .then(function (res) {
        if (!res || res.ok !== true) {
          that.setData({
            loading: false,
            error: (res && res.error && res.error.message) || '资料加载失败',
          })
          return
        }
        const p = (res.data && res.data.profile) || {}
        const options = (res.data && res.data.travelModeOptions) || []
        const idx = Math.max(
          0,
          options.findIndex((o) => o.value === p.defaultTravelMode)
        )
        const nickname = p.nickname || ''
        /**
         * ⚠️ 把默认出行方式**同步一份到本地 storage**（2026-10-14）。
         *
         * 行程页 `restoreModePreference()` **只读**这个 key，
         * 用来在 `onLoad` 里同步拿到值（走接口会先显示一帧错的）。
         *
         * ⚠️ **本页是唯一的写入方**（2026-10-14 用户要求把出行方式
         *    从行程页挪到「我的 → 设置」之后）。以前行程页那个 picker
         *    也写它，于是"默认出行方式"有了两份真相：
         *      这里写服务端字段（跨设备有效），行程页写本地（只在这台设备上）。
         *    用户在「我的」改成步行、回行程页又被本地那份覆盖回去。
         *    现在行程页**只读不写**。
         *
         * 不同步的话，「我的」里改了默认方式、行程页却还用旧值 ——
         * 用户会以为设置没生效。
         *
         * 两边都写是有意的：服务端那份是"账号级默认"（换设备也在），
         * 本地那份是"行程页上次选了什么"（可能被临时改过）。
         * 进「我的」时以服务端为准覆盖本地。
         */
        try {
          wx.setStorageSync('zhiyou-preferred-mode', p.defaultTravelMode || 'auto')
        } catch (err) {
          /** 写不下不影响功能，行程页会用旧值 —— 下次进来再同步 */
        }
        that.setData({
          loading: false,
          userId: p.userId || '',
          shortId: p.shortId || '',
          nickname: nickname,
          nicknameDisplay: nickname || '未命名',
          initial: nickname ? nickname.charAt(0) : '?',
          avatarColor: avatarColor(p.userId),
          avatarUrl: '',
          defaultTravelMode: p.defaultTravelMode || 'auto',
          travelModeOptions: options,
          travelModeIndex: idx,
          /**
           * ⚠️ **显示文案在 JS 里算好**，模板只做插值。
           *
           * 模板里写 `{{travelModeOptions[travelModeIndex].label}}` 会在
           * **首帧**崩掉：`travelModeOptions` 初始是空数组，`[0]` 是
           * undefined，读 `.label` 抛 `Cannot read properties of undefined`，
           * 整页白屏。`|| '自动'` 兜不住 —— 它在**取完属性之后**才生效。
           */
          travelModeLabel: (options[idx] && options[idx].label) || '自动',
        })
        /** 头像要换成临时地址才能显示（fileID 不能直接给 image 用） */
        if (p.avatarFileId) that.resolveAvatar(p.avatarFileId)
      })
      .catch(function (err) {
        that.setData({ loading: false, error: (err && err.errMsg) || '资料加载失败' })
      })
  },

  /**
   * 把云存储的 fileID 换成可显示的临时地址。
   *
   * ⚠️ 换失败**不能影响整页** —— 头像显示不出来是次要的，
   * 昵称、ID、小队面板都要照常能用。所以这里失败只清空 avatarUrl，
   * 让它回落到"昵称首字色块"。
   */
  resolveAvatar(fileId) {
    const that = this
    try {
      wx.cloud.getTempFileURL({
        fileList: [fileId],
        success(r) {
          const item = r && r.fileList && r.fileList[0]
          if (item && item.tempFileURL) that.setData({ avatarUrl: item.tempFileURL })
        },
        fail() {
          that.setData({ avatarUrl: '' })
        },
      })
    } catch (err) {
      this.setData({ avatarUrl: '' })
    }
  },

  // ── 昵称 ─────────────────────────────────────────────────

  startEditNickname() {
    this.setData({ editingNickname: true, nicknameDraft: this.data.nickname })
  },

  onNicknameInput(e) {
    this.setData({ nicknameDraft: e.detail.value })
  },

  cancelEditNickname() {
    this.setData({ editingNickname: false, nicknameDraft: '' })
  },

  saveNickname() {
    this.save({ nickname: this.data.nicknameDraft }, '昵称已保存')
    this.setData({ editingNickname: false })
  },

  // ── 头像 ─────────────────────────────────────────────────

  /**
   * 用户选了头像（`<button open-type="chooseAvatar">`）。
   *
   * ⚠️ 拿到的是**临时文件**（`avatarUrl` 形如 `wxfile://...`），
   * 直接存进库里，换台设备/过一段时间就失效了。所以必须先上传到云存储，
   * 拿永久 fileID 再存。
   *
   * ⚠️ 这个按钮的 `open-type` 是微信当前推荐的做法；
   * `wx.getUserProfile` 那条路已被微信收回（返回灰头像 + "微信用户"），
   * **不要改回去**。
   */
  onChooseAvatar(e) {
    const that = this
    const tempPath = e.detail && e.detail.avatarUrl
    if (!tempPath) return

    this.setData({ saving: true, error: '' })
    const ext = (tempPath.match(/\.(\w+)$/) || [])[1] || 'png'
    /** 路径里用 user ID 是为了同一个人多次上传能归到一起，不参与任何鉴权 */
    const cloudPath = 'avatars/' + (this.data.userId || 'anon') + '-' + Date.now() + '.' + ext

    wx.cloud.uploadFile({
      cloudPath: cloudPath,
      filePath: tempPath,
      success(uploadRes) {
        const fileId = uploadRes && uploadRes.fileID
        if (!fileId) {
          that.setData({ saving: false, error: '头像上传没有返回文件 ID' })
          return
        }
        that.save({ avatarFileId: fileId }, '头像已更新')
        /** 立刻用本地临时路径显示，不等下一次读库 —— 否则用户会觉得没生效 */
        that.setData({ avatarUrl: tempPath })
      },
      fail(err) {
        that.setData({
          saving: false,
          error: '头像上传失败：' + ((err && err.errMsg) || '未知原因'),
        })
      },
    })
  },

  // ── 默认出行方式 ─────────────────────────────────────────

  onTravelModeChange(e) {
    const idx = Number(e.detail.value) || 0
    const opt = this.data.travelModeOptions[idx]
    if (!opt) return
    this.setData({ travelModeIndex: idx, defaultTravelMode: opt.value, travelModeLabel: opt.label })
    this.save({ defaultTravelMode: opt.value }, '默认出行方式已保存')
  },

  // ── 存盘 ─────────────────────────────────────────────────

  /**
   * 统一的存盘入口。
   *
   * ⚠️ 用**服务端回读的结果**覆盖本地，而不是拿提交的值当结果：
   * 服务端会做 trim 与校验（昵称去空白、出行方式必须在值域内），
   * 拿提交值当结果会让界面显示一个库里并不存在的值。
   */
  save(patch, okMessage) {
    const that = this
    this.setData({ saving: true, error: '' })
    api
      .callApi('user.updateProfile', patch)
      .then(function (res) {
        if (!res || res.ok !== true) {
          that.setData({
            saving: false,
            error: (res && res.error && res.error.message) || '保存失败',
          })
          return
        }
        const p = (res.data && res.data.profile) || {}
        const nickname = p.nickname || ''
        /** 与 `loadProfile` 同理：同步给行程页只读的那份缓存 */
        try {
          wx.setStorageSync('zhiyou-preferred-mode', p.defaultTravelMode || 'auto')
        } catch (err) {
          /** 同上：写不下不影响功能 */
        }
        that.setData({
          saving: false,
          savedAt: '已保存',
          nickname: nickname,
          nicknameDisplay: nickname || '未命名',
          initial: nickname ? nickname.charAt(0) : '?',
          defaultTravelMode: p.defaultTravelMode || 'auto',
          /**
           * 同步显示文案 —— 服务端会做值域校验，
           * 界面要用**它回读的结果**而不是提交值（两者可能不同）。
           */
          travelModeLabel: labelOfMode(that.data.travelModeOptions, p.defaultTravelMode),
        })
      })
      .catch(function (err) {
        that.setData({ saving: false, error: (err && err.errMsg) || '保存失败' })
      })
  },

  /**
   * 复制用户 ID。
   *
   * ⚠️ 复制的是**完整 ID**（28 位），不是那个 6 位编号 ——
   * 用户的原话是"运维时出现问题可以检索"，而要检索的对象
   * （数据库 `_id`、云函数日志、与 `openid` 关联的那条记录）
   * **用的都是完整 ID**。复制一个日志里根本不会出现的短号没有用处。
   */
  copyUserId() {
    const v = this.data.userId
    if (!v) return
    wx.setClipboardData({ data: v })
  },

  /** 进联调自检页（开发工具，不是产品功能） */
  openSelfCheck() {
    wx.navigateTo({
      url: '/pages/index/index',
      fail: () => this.setData({ error: '自检页打开失败，请重新编译' }),
    })
  },
})

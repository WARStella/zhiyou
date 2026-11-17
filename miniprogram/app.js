/**
 * 小程序入口。
 *
 * ⚠️ 本文件目前是**联调脚手架**，由 B 建立用于验证后端连通性。
 * 正式的小程序结构（页面、组件、样式）由 A 接管并替换。
 *
 * 云开发初始化说明：
 *   - 不传 env 时，使用当前小程序的**默认云开发环境**。
 *     首版只建一个环境时就靠这个默认值，不必硬编码环境ID。
 *   - 若要同时连 dev / prod 两个环境，在下面 envId 里填其中一个，
 *     或者按需改成从配置读取。
 *   - 环境ID 形如 `zhiyou-dev-1g2h3j4k5l6m7n`，创建后不可修改。
 */

const api = require('./utils/api')
const { createLocationSharing } = require('./utils/location-sharing')

App({
  globalData: {
    /** 留空 = 使用默认环境。要指定环境时把环境ID填在这里。 */
    envId: '',
    cloudReady: false,
    cloudError: '',
  },

  getLocationSharing() {
    if (!this.globalData.cloudReady) return null
    if (!this.locationSharing) this.locationSharing = createLocationSharing({ wx, callApi: api.callApi })
    return this.locationSharing
  },

  /**
   * 订阅消息的**落地参数交接**（2026-10-17）。
   *
   * ── 为什么在 app 这层再存一次 ────────────────────────────
   *
   * 从订阅消息打开小程序时，落地参数（`crewId`/`meetId`）出现在
   * 启动/切前台的 `options.query` 里。但"哪个页面能拿到这份 query"
   * 依赖打开路径：冷启动直接进 tab 页、热启动从中转页跳转，
   * 两种情况下页面 `onShow(options)` 拿到的内容并不一致。
   *
   * 而队伍页是 **tab 页**，`wx.switchTab` 又不支持 URL 参数
   * （项目里已有同样教训：跨页传值统一走 storage）。
   *
   * 所以这里把 query 抄一份到 storage，页面 `onShow` 优先用自己的 query，
   * 拿不到再读这份兜底，**读完立刻清掉**（与 `zhiyou-focus-place` 同一纪律：
   * 一次性交接，不能留到用户下次自己打开时又被带过去）。
   *
   * 只存 `crewId`/`meetId` 这类定位线索，不存消息正文；正文永远由
   * 落地后鉴权通过的接口重新取。
   */
  rememberNoticeLanding(query) {
    const q = query || {}
    const crewId = q.crewId || q.crewid
    if (!crewId) return
    try {
      wx.setStorageSync('zhiyou-notice-landing', {
        crewId, meetId: q.meetId || q.meetid || '', at: Date.now(),
      })
    } catch (e) {
      // storage 写不进去只是少一层兜底，不影响页面自己那份 query
    }
  },

  onShow(options) {
    this.rememberNoticeLanding(options && options.query)
    const service = this.getLocationSharing()
    if (service) return service.setForeground(true)
  },

  onHide() {
    if (this.locationSharing) return this.locationSharing.setForeground(false)
  },

  onLaunch(launchOptions) {
    /**
     * 冷启动也可能是从订阅消息点进来的：同样把落地参数抄进 storage。
     * 放在云开发初始化之前 —— 它不依赖云端，早记下来更不容易漏。
     *
     * ⚠️ 形参必须叫 `launchOptions`：函数体内还有一个 `const options`（云初始化参数），
     * 同名会让整个文件 `SyntaxError: Identifier 'options' has already been declared`，
     * 表现为**小程序启动即失败**。`auto-location-sharing` 那条测试用 vm 直接执行
     * 本文件才把它暴露出来。
     */
    this.rememberNoticeLanding(launchOptions && launchOptions.query)
    // 云开发能力检测：基础库过低时 wx.cloud 不存在，报错要说清楚而不是静默失败
    if (!wx.cloud) {
      this.globalData.cloudError =
        '当前基础库不支持云开发。请在开发者工具「详情 → 本地设置」把调试基础库调到 2.2.3 以上。'
      console.error(this.globalData.cloudError)
      return
    }

    const options = { traceUser: true }
    if (this.globalData.envId) options.env = this.globalData.envId

    try {
      wx.cloud.init(options)
      this.globalData.cloudReady = true
    } catch (e) {
      this.globalData.cloudError = (e && (e.errMsg || e.message)) || String(e)
      console.error('[app] 云开发初始化失败', e)
    }
  },
})

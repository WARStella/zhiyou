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

App({
  globalData: {
    /** 留空 = 使用默认环境。要指定环境时把环境ID填在这里。 */
    envId: '',
    cloudReady: false,
    cloudError: '',
  },

  onLaunch() {
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

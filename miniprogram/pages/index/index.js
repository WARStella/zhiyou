/**
 * 后端联调自检页。
 *
 * 这是 B 的验收工具：把三类只能"从小程序发起"的操作做成按钮。
 *
 * ⚠️ 为什么不能从云开发控制台的「测试」里跑：
 *   控制台测试没有微信用户上下文，cloud.getWXContext().OPENID 为空，
 *   会被入口的 AUTH_REQUIRED 挡掉。必须从有 openid 的真实调用发起。
 *
 * ⚠️ 本页是**脚手架**，A 接管前端后可删除或替换。
 * 保留价值：真机联调或外场实测出问题时，先跑一次自检就能分清
 * "后端没通"还是"页面逻辑有问题"。
 */

const api = require('../../utils/api')

Page({
  data: {
    running: false,
    runningLabel: '',
    cloudReady: false,
    cloudError: '',
    result: null,
    pretty: '',
    callError: null,
    ranAt: '',
  },

  onLoad() {
    const app = getApp()
    this.setData({
      cloudReady: !!(app && app.globalData && app.globalData.cloudReady),
      cloudError: (app && app.globalData && app.globalData.cloudError) || '',
    })
    this.runHealth()
  },

  runHealth() {
    this.call('ops.health', {}, '后端自检')
  },

  /** 大模型接口探针 —— 配好 AI_API_KEY 后点这个确认通没通 */
  runAiProbe() {
    this.call('ai.probe', {}, '大模型接口探针')
  },

  /** 实测六种写入形态：决定嵌套对象/对象数组能否整体替换（见 docs/01 §0 决定 4） */
  runSelfTest() {
    this.call('ops.selfTest', {}, '写入形态自检')
  },

  /** 故意写重复数据，检验唯一索引是否真的生效（索引存在 ≠ 索引生效） */
  runVerifyIndexes() {
    this.call('ops.verifyIndexes', {}, '唯一索引校验')
  },

  /** 地图步行路线接口探针（10/14 验证用，会真实调用外部接口） */
  runMapProbe() {
    this.call('map.probe', {}, '地图接口探针')
  },

  /**
   * 创建 14 个集合。破坏性操作，先确认。
   *
   * ⚠️ **不再灌入任何地点**（2026-10-13 起）。
   * 原先灌 6 条"占位"地点，它们看起来像真数据、还会被当成"已知地点"
   * 喂给需求解析器 —— 而坐标是编的。地点现在只来自两处：
   * 上游检索与 10/16 踏勘录入。
   */
  initDb() {
    const that = this
    wx.showModal({
      title: '初始化数据库',
      content:
        '将创建全部 14 个集合。\n\n' +
        '**不会**灌入任何地点 —— 地点只来自上游检索与踏勘录入。\n仅用于开发环境。',
      confirmText: '执行',
      cancelText: '取消',
      success(res) {
        if (res.confirm) that.call('ops.initDb', { confirm: true }, '初始化数据库')
      },
    })
  },

  /**
   * 打开地图页面（用于截取位置接口申请的使用场景截图）。
   *
   * ⚠️ 必须带 fail 回调：`wx.navigateTo` 失败时不会抛异常，
   * 默认什么都不做 —— 表现为"点了没反应"，排查时毫无线索。
   * 这类静默失败在本项目里已经踩过多次（见 lib/invoke.js 的注释）。
   */
  openMap() {
    wx.navigateTo({
      url: '/pages/map/index',
      fail: (err) => {
        const msg = (err && err.errMsg) || '未知原因'
        console.error('[openMap] 跳转失败', err)

        // 最常见的原因单独给出可执行提示
        const isNotFound = /not found|not exist/i.test(msg)
        wx.showModal({
          title: '打开地图页面失败',
          content: isNotFound
            ? msg +
              '\n\n页面未注册。请确认 app.json 的 pages 里有 "pages/map/index"，' +
              '然后点工具栏「编译」重新构建（新增页面必须重新编译才会生效）。'
            : msg,
          showCancel: false,
        })
      },
    })
  },

  call(action, payload, label) {
    const that = this
    this.setData({ running: true, runningLabel: label, callError: null })

    api
      .callApi(action, payload)
      .then(function (res) {
        that.setData({
          result: res,
          pretty: JSON.stringify(res, null, 2),
          running: false,
          runningLabel: '',
          ranAt: new Date().toLocaleTimeString(),
        })
      })
      .catch(function (err) {
        that.setData({
          callError: { message: (err && (err.errMsg || err.message)) || String(err) },
          running: false,
          runningLabel: '',
        })
      })
  },

  copyResult() {
    if (!this.data.pretty) return
    wx.setClipboardData({ data: this.data.pretty })
  },
})

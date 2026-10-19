/**
 * 后端调用的统一封装。
 *
 * 所有页面都必须通过本文件调用后端，不要在页面里手写 wx.cloud.callFunction。
 * 原因：有两个字段漏了就会出问题，而且是"安静地出问题"：
 *
 *   requestId        幂等键。网络超时重试时**必须复用同一个**，
 *                    否则服务端会当成两次不同的操作重复执行。
 *   expectedVersion  版本号。写操作漏传会被服务端直接拒绝（这是刻意的），
 *                    防止"用旧版本确认让新方案生效"。
 *
 * 接口约定见 docs/项目计划书.md#api-contract。
 */

const { IMAGE_REQUEST_BUDGET_BYTES, cloudRequestBytes, isDataSizeError } = require('./cloud-request-size')
let requestSeq = 0

/** 生成请求ID。同一逻辑操作重试时，把首次生成的这个值传回来复用。 */
function newRequestId() {
  requestSeq += 1
  return (
    Date.now().toString(36) +
    '-' +
    requestSeq.toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 10)
  )
}

/**
 * 把云开发 SDK 的原始报错翻译成"下一步该做什么"。
 *
 * 这些错误码本身极难读懂，但成因高度集中（就那几种），所以值得逐一映射。
 * 用**子串匹配**而不是精确匹配错误码：SDK 的报错格式在不同版本间会变，
 * 精确匹配会在某次基础库升级后悄悄失效。
 */
const DIAGNOSES = [
  {
    match: ['-601034', '请先开通云开发', '没有权限，请先开通'],
    text:
      '云开发尚未开通。\n' +
      '① 点开发者工具工具栏的「云开发」按钮 → 开通 → 新建环境（如 zhiyou-dev）。\n' +
      '② 若点开通时报「请先完成小程序基本信息填写」，说明要先在 mp.weixin.qq.com\n' +
      '   把名称/头像/简介/服务类目填完并等它生效 —— 这是硬前置，绕不过去。',
  },
  {
    match: ['-501000', 'FunctionName', 'function not found', '云函数不存在', 'FUNCTION_NOT_FOUND'],
    text:
      '云函数 api 尚未部署到当前环境。\n' +
      '① 确认左上角「cloudfunctions」旁显示的是你想要的那个环境。\n' +
      '② 右键 cloudfunctions/api →「上传并部署：云端安装依赖」。',
  },
  {
    match: ['invalid env', 'env not exists', '环境不存在', 'env check invalid'],
    text:
      '环境不存在或当前小程序无权访问该环境。\n' +
      '检查 app.js 里 globalData.envId：留空表示用默认环境，填了就必须是真实存在的环境ID。',
  },
  {
    // 云函数的真实超时报错是 "Invoking task timed out after N seconds"，
    // 注意是 "timed out"（带空格）而不是 "timeout" —— 只写 timeout 会漏掉真实场景。
    match: ['-504002', 'timed out', 'timeout', 'TIME_LIMIT_EXCEEDED', '执行超时'],
    text:
      '云函数执行超时。\n' +
      '调用地图等外部接口时可能出现。检查云函数超时配置（启用游览助手后建议 60 秒），' +
      '以及外部接口是否卡住。',
  },
]

function diagnose(raw) {
  const text = String(raw || '')
  for (let i = 0; i < DIAGNOSES.length; i++) {
    const d = DIAGNOSES[i]
    for (let j = 0; j < d.match.length; j++) {
      if (text.indexOf(d.match[j]) >= 0) return d.text
    }
  }
  return (
    '未能自动识别原因。常见三种：\n' +
    '① 云开发环境未创建；② api 云函数未上传部署；③ 云函数名不是 api。'
  )
}

/**
 * 调用后端，返回**完整响应**（含 ok / error / meta）。
 * 需要读取 meta（比如 replayed、durationMs）时用这个。
 *
 * @param {string} action  接口名，形如 'trip.plan'
 * @param {object} payload 业务参数
 * @param {object} [options] { requestId, expectedVersion }
 */
function callApi(action, payload, options) {
  options = options || {}

  const data = {
    action: action,
    requestId: options.requestId || newRequestId(),
    payload: payload || {},
  }

  // 只在明确传入时才带上版本号，避免把 undefined 序列化成 null 传给服务端
  if (options.expectedVersion !== undefined && options.expectedVersion !== null) {
    data.expectedVersion = options.expectedVersion
  }

  if (typeof data.payload.imageBase64 === 'string' && cloudRequestBytes(data) > IMAGE_REQUEST_BUDGET_BYTES) {
    return Promise.resolve({ ok: false, error: { code: 'REQUEST_TOO_LARGE',
      message: '图片发送数据过大，请裁剪图片后重新选择，或改用文字输入' },
      meta: { requestId: data.requestId, durationMs: 0 } })
  }

  return wx.cloud
    .callFunction({ name: 'api', data: data })
    .then(function (res) {
      return res.result
    })
    .catch(function (err) {
      // 云函数本身没跑起来（未开通 / 未部署 / 超时），与业务失败要区分开
      const raw = (err && (err.errMsg || err.message)) || '云函数调用失败'
      if (isDataSizeError(raw)) return { ok: false, error: { code: 'REQUEST_TOO_LARGE',
        message: typeof data.payload.imageBase64 === 'string'
          ? '图片发送数据超过平台大小限制，请裁剪到需要识别的区域后重选，重复发送同一张图无法解决'
          : '请求数据超过平台大小限制，请减少本次提交的内容后重试' },
        meta: { requestId: data.requestId, durationMs: 0 } }
      return {
        ok: false,
        error: {
          code: 'CLOUD_CALL_FAILED',
          message: raw,
          details: { diagnosis: diagnose(raw) },
        },
        meta: { requestId: data.requestId, durationMs: 0 },
      }
    })
}

/** 把失败响应转成可 catch 的异常，附带错误码与 details。 */
function toError(res) {
  const err = res && res.error ? res.error : { code: 'INTERNAL', message: '空响应' }
  const e = new Error(err.message || err.code)
  e.code = err.code
  e.details = err.details || null
  e.meta = (res && res.meta) || null
  e.isApiError = true
  return e
}

/**
 * 调用后端，成功返回 data，失败抛异常。
 * 业务代码用这个：`const trip = await callApiStrict('trip.get', { tripId })`
 */
function callApiStrict(action, payload, options) {
  return callApi(action, payload, options).then(function (res) {
    if (!res || res.ok !== true) throw toError(res)
    return res.data
  })
}

/** 判断是否为"版本冲突"，客户端据此刷新后重试而不是弹通用错误。 */
function isVersionConflict(e) {
  return !!(e && e.code === 'VERSION_CONFLICT')
}

module.exports = {
  callApi: callApi,
  callApiStrict: callApiStrict,
  newRequestId: newRequestId,
  isVersionConflict: isVersionConflict,
  /** 导出供测试：错误码→诊断的映射必须可被验证，否则会在某次 SDK 升级后悄悄失效 */
  diagnose: diagnose,
}

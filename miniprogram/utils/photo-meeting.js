const { isValidPoint } = require('./coordinates')
const { readImageForRequest } = require('./request-image')
const initialState = () => ({ imagePath: '', stage: 'idle', busy: false, keyword: '', lines: [],
  candidates: [], error: '', note: '', blocked: false })
const invokeWx = (wx, method, args) => new Promise((resolve, reject) => {
  if (typeof wx[method] !== 'function') return reject(new Error('当前微信暂不支持此操作，请更新微信或手动选点'))
  wx[method](Object.assign({}, args, { success: resolve, fail: reject }))
})

function createPhotoMeeting(options) {
  const wx = options.wx
  let state = initialState(), generation = 0, alive = true, crewId = options.getCrewId()
  const publish = patch => { state = Object.assign({}, state, patch); if (alive) options.onState(patch) }
  const current = token => alive && token === generation && crewId && options.getCrewId() === crewId
  function reset() { generation++; crewId = options.getCrewId(); state = initialState(); if (alive) options.onState(state) }
  function fail(error, fallback) {
    const code = error && error.code
    if (['AUTH_REQUIRED', 'FORBIDDEN_NOT_MEMBER', 'NOT_FOUND'].includes(code)) {
      reset(); publish({ blocked: true, error: '队伍状态已变化，请返回队伍刷新后再试' }); return
    }
    publish({ busy: false, stage: 'idle', error: error && error.message || fallback })
  }
  async function call(action, payload) {
    const response = await options.callApi(action, Object.assign({ crewId }, payload))
    if (!response || !response.ok) {
      const e = new Error(response && response.error && response.error.message || '服务暂不可用，请稍后重试')
      e.code = response && response.error && response.error.code
      throw e
    }
    return response.data
  }
  const guard = () => alive && !state.busy && !state.blocked && options.getCrewId() === crewId && crewId
  async function choose() {
    if (!guard()) return
    const token = ++generation
    publish({ busy: true, stage: 'choosing', error: '' })
    try {
      const res = await invokeWx(wx, 'chooseMedia', { count: 1, mediaType: ['image'],
        sourceType: ['camera', 'album'], sizeType: ['compressed'], camera: 'back' })
      if (!current(token)) return
      const file = res.tempFiles && res.tempFiles[0]
      if (!file || !file.tempFilePath) throw new Error('未取得图片，请重新选择')
      publish({ imagePath: file.tempFilePath, busy: false, stage: 'idle', lines: [], candidates: [], keyword: '',
        note: '请确认照片。点击“识别这张照片”后，图片将发送至腾讯云提取文字。' })
    } catch (e) {
      if (!current(token)) return
      publish({ busy: false, stage: 'idle', error: /cancel/i.test(e && e.errMsg || '') ? '' : '无法选择图片，请检查相机/相册权限，或手动输入地点' })
    }
  }
  async function recognize() {
    if (!guard() || !state.imagePath) return
    const token = ++generation, originalPath = state.imagePath
    publish({ busy: true, stage: 'recognizing', error: '', lines: [], candidates: [], note: '' })
    try {
      const imageBase64 = await readImageForRequest(wx, originalPath, { action: 'ocr.recognize', payload: { crewId }, current: () => current(token) })
      if (!current(token)) return
      const result = await call('ocr.recognize', { imageBase64 })
      if (!current(token)) return
      const lines = (result.lines || []).slice(0, 100).map((row, index) => ({ id: String(index),
        text: String(row.text || '').trim().slice(0, 100),
        lowConfidence: row.confidence !== null && Number.isFinite(row.confidence) && row.confidence < 80 })).filter(row => row.text)
      const preferred = lines.find(row => /站|门|口|路|街|广场|公园|学院|大学|大厦|商场|中心/.test(row.text) && row.text.length <= 60)
        || lines.find(row => row.text.length >= 2 && row.text.length <= 60)
      publish({ busy: false, stage: 'idle', lines, keyword: preferred ? preferred.text : '',
        note: lines.length ? '点击识别文字可作为关键词；请核对错字，补充地点全名后搜索。' : '没有识别到文字，请重拍清晰的牌子，或直接输入地点名称。' })
    } catch (e) { if (current(token)) fail(e, '图片识别失败，请换张照片或手动输入地点') }
  }
  function keyword(value) {
    if (!guard()) return
    generation++
    publish({ keyword: String(value || '').slice(0, 60), candidates: [], error: '', note: '' })
  }
  async function search() {
    if (!guard()) return
    const center = options.getPoint(), text = state.keyword.trim()
    if (!isValidPoint(center)) { publish({ error: '请先点地图右下角 ◎ 获取当前位置，再搜索附近地点' }); return }
    if (text.length < 2) { publish({ error: '请补充至少两个字的地点名称，如“哈尔滨学院南门”' }); return }
    const token = ++generation
    publish({ busy: true, stage: 'searching', candidates: [], error: '', note: '' })
    try {
      const result = await call('ocr.searchMeeting', { keyword: text, center })
      if (!current(token)) return
      publish({ busy: false, stage: 'idle', candidates: (result.candidates || []).filter(row => isValidPoint(row.point)),
        note: (result.candidates || []).length ? '以下为当前位置 3 公里内的地图候选，距离为直线距离。请核对名称和入口。'
          : '附近 3 公里内未找到匹配地点。可补全名称、重新拍摄，或使用地图 ✛ 手动选点。' })
    } catch (e) { if (current(token)) fail(e, '地点搜索失败，请稍后重试') }
  }
  async function select(id) {
    if (!guard()) return
    const candidate = state.candidates.find(row => row.id === id)
    if (!candidate || !isValidPoint(candidate.point)) return
    const token = ++generation
    publish({ busy: true, stage: 'confirming', error: '' })
    try {
      const response = await invokeWx(wx, 'showModal', { title: '选为集合点？',
        content: candidate.name + '\n' + candidate.address + '\n地图地点未经实地核验，请确认入口；选定后仍需点击“发起集合”。',
        confirmText: '确认选点' })
      if (!current(token)) return
      publish({ busy: false, stage: 'idle' })
      if (response.confirm) options.onSelect({ name: candidate.name, address: candidate.address,
        latitude: candidate.point.latitude, longitude: candidate.point.longitude })
    } catch (e) { if (current(token)) fail(e, '未能确认集合点，请重试') }
  }
  function preview(id) {
    if (!guard()) return
    const row = state.candidates.find(item => item.id === id)
    if (!row) return
    const token = generation
    return invokeWx(wx, 'openLocation', { latitude: row.point.latitude, longitude: row.point.longitude,
      name: row.name, address: row.address, scale: 17 }).catch(() => { if (current(token)) publish({ error: '无法打开位置预览，请核对地址后选择' }) })
  }
  return { choose, recognize, search, keyword, select, preview, reset,
    hide() {
      // 微信相机/选图界面可能触发页面隐藏，保留本次本地选图；不在选图结束后自动上传。
      if (state.stage !== 'choosing') { generation++; publish({ busy: false, stage: 'idle' }) }
    },
    dispose() { generation++; alive = false; state = initialState() },
  }
}

module.exports = { createPhotoMeeting, initialState }

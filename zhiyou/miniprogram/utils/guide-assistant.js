const { isValidPoint } = require('./coordinates')
const { parseMinutes } = require('./stay-duration')
const { readImageForRequest } = require('./request-image')
const PLAN_MODES = [ { value: 'auto', label: '自动（按最快）' }, { value: 'walking', label: '步行' },
  { value: 'bicycling', label: '骑行' }, { value: 'driving', label: '驾车' },
  { value: 'transit', label: '公交地铁' }, { value: 'subway', label: '地铁优先' } ]
function displayResult(data) {
  const out = { ...data }
  for (const key of ['tripContext', 'meetingContext']) if (out[key]) {
    const date = new Date(out[key].serverTime), pad = n => String(n).padStart(2, '0')
    out[key] = { ...out[key], timeLabel: Number.isFinite(date.getTime()) ?
      (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) : '本次查询' }
  }
  return out
}
const initialGuideState = () => ({ text: '', busy: false, imagePath: '', result: null, error: '', center: null, choosing: false,
  planStayMin: '60', planModes: PLAN_MODES, planModeIndex: 0, planModeLabel: PLAN_MODES[0].label, createdTripId: '',
  tripChange: null, changeQuestions: [], changeAnswers: {}, changeCandidates: [], changeSummary: [], changeNeedsRewrite: false,
  crowdResult: null, crowdImagePath: '', crowdBoxes: [] })
const changeDisplay = (change, answers = {}) => ({ tripChange: change || null, changeAnswers: answers,
  changeQuestions: ((change && change.questions) || []).map(q => ({ ...q, value: answers[q.key] || '',
    answerLabel: (((q.options || []).find(o => o.value === answers[q.key])) || {}).label || answers[q.key] || '' })),
  changeNeedsRewrite: Boolean(change && (change.questions || []).some(q => q.kind === 'rewrite')),
  changeSummary: change && change.interpretation && change.interpretation.summary || [],
  changeCandidates: ((change && change.candidates) || []).map(c => ({ ...c,
    notes: (c.notes || []).map(n => typeof n === 'string' ? n : n.message),
    conflicts: (c.conflicts || []).map(n => typeof n === 'string' ? n : n.message),
    nodeSummary: (c.nodes || []).map(n => (n.name || n.placeName) + ' · ' + n.plannedStayMin + '分钟').join(' → ') })) })
const callWx = (wx, method, args) => new Promise((resolve, reject) => {
  if (typeof wx[method] !== 'function') return reject(new Error('当前微信不支持此操作，请使用文字提问'))
  wx[method](Object.assign({}, args, { success: resolve, fail: reject }))
})
const readPhoto = readImageForRequest
function createGuideAssistant(options) {
  const wx = options.wx
  const readTripId = () => options.getTripId ? options.getTripId() || null : null
  let state = initialGuideState(), crewId = options.getCrewId() || null, tripId = readTripId(), generation = 0, alive = true
  const confirmationIds = new Map()
  let planRequest = null, createdPlan = null
  const publish = patch => { state = Object.assign({}, state, patch); if (alive) options.onState(patch) }
  const current = token => alive && token === generation && (options.getCrewId() || null) === crewId && readTripId() === tripId
  const ready = () => current(generation) && !state.busy
  function reset(deleteRemote) {
    const previous = state.result
    generation++; confirmationIds.clear(); planRequest = null; createdPlan = null; crewId = options.getCrewId() || null; tripId = readTripId(); state = initialGuideState(); publish(state)
    if (deleteRemote && previous) return options.callApi('guide.close', { sessionId: previous.sessionId }).catch(() => {})
  }
  async function choose() {
    if (!ready()) return
    const token = ++generation
    publish({ busy: true, choosing: true, error: '' })
    try {
      const selected = await callWx(wx, 'chooseMedia', { count: 1, mediaType: ['image'], sourceType: ['camera', 'album'], sizeType: ['compressed'], camera: 'back' })
      if (current(token)) {
        const file = selected.tempFiles && selected.tempFiles[0]
        publish({ imagePath: file && file.tempFilePath || '', busy: false, choosing: false, crowdResult: null, crowdImagePath: '', crowdBoxes: [] })
      }
    } catch (e) { if (current(token)) publish({ busy: false, choosing: false, error: /cancel/i.test(e.errMsg || '') ? '' : '选图失败，请检查相机或相册权限，仍可文字提问' }) }
  }
  async function locate() {
    if (!ready()) return
    const token = ++generation
    publish({ busy: true, error: '' })
    try {
      const point = await callWx(wx, 'getLocation', { type: 'gcj02' })
      if (current(token)) publish(isValidPoint(point) ? { center: { latitude: point.latitude, longitude: point.longitude }, busy: false }
        : { busy: false, error: '位置坐标异常，仍可输入地点全名搜索' })
    } catch (_) { if (current(token)) publish({ busy: false, error: '未取得定位，可授权后重试，或输入完整地名搜索' }) }
  }
  async function chooseStart() {
    if (!ready()) return
    const token = ++generation
    publish({ busy: true, choosing: true, error: '' })
    try {
      const point = await callWx(wx, 'chooseLocation', state.center || {})
      if (current(token)) publish(isValidPoint(point)
        ? { center: { latitude: point.latitude, longitude: point.longitude, label: point.name || point.address || '出发位置' }, busy: false, choosing: false }
        : { error: '出发位置无效，请重新选点', busy: false, choosing: false })
    } catch (e) { if (current(token)) publish({ busy: false, choosing: false, error: /cancel/i.test(e.errMsg || '') ? '' : '无法选择出发位置，请重试或使用当前位置' }) }
  }
  async function ask(candidateId) {
    if (!ready()) return
    const previous = state.result, text = state.text.trim(), photo = candidateId ? '' : state.imagePath
    if (photo && /(?:多少|几个|几位).*人|人群.*(?:计数|人数)|人数/.test(text)) return countPeople()
    if (candidateId && (!previous || !previous.candidates.some(row => row.id === candidateId))) return
    if (!candidateId && !text && !photo) { publish({ error: '请输入问题或选择一张照片' }); return }
    const token = ++generation
    publish({ busy: true, error: '' })
    try {
      const payload = { crewId, tripId, scope: options.scope || 'trip', ...(previous ? { sessionId: previous.sessionId } : {}),
        ...(candidateId ? { candidateId } : { text }), ...(state.center ? { center: state.center } : {}) }
      const requestOptions = previous ? { expectedVersion: previous.version } : {}
      if (photo) payload.imageBase64 = await readPhoto(wx, photo, { action: 'guide.ask', payload, requestOptions, current: () => current(token) })
      if (!current(token)) return
      const response = await options.callApi('guide.ask', payload, requestOptions)
      if (!current(token)) return
      if (!response || !response.ok) {
        const error = response && response.error || {}
        if (error.code === 'FORBIDDEN_NOT_MEMBER' || error.code === 'AUTH_REQUIRED') { reset(false); publish({ error: '队伍权限已变化，请返回“我的”刷新队伍后再使用助手' }); return }
        if (error.code === 'NOT_FOUND') { publish({ result: null, error: '会话已过期，请重新发送问题', busy: false }); return }
        if (error.code === 'VERSION_CONFLICT' && previous) {
          const latest = await options.callApi('guide.get', { crewId, sessionId: previous.sessionId })
          if (!current(token)) return
          publish({ result: latest && latest.ok ? displayResult(latest.data) : null, ...changeDisplay(null), busy: false,
            error: '会话已更新，请检查当前地点后重新提交；本次没有自动重试识别' }); return
        }
        publish({ busy: false, error: error.message || '助手暂时无法响应，问题与照片已保留，请稍后重试' }); return
      }
      planRequest = null; createdPlan = null
      publish({ result: displayResult(response.data), ...changeDisplay(response.data.tripChange),
        planStayMin: String(response.data.tripPlan && response.data.tripPlan.stayMin || 60), planModeIndex: 0, planModeLabel: PLAN_MODES[0].label, createdTripId: '',
        busy: false, text: candidateId ? state.text : '', imagePath: candidateId ? state.imagePath : '' })
    } catch (e) { if (current(token)) publish({ busy: false, error: e.message || '助手暂时不可用，问题与照片已保留' }) }
  }
  async function useMeeting() {
    /* 2026-10-24：以前这里直接 return，用户只看到“点了没反应”。
       把每种不能用的原因说出来，下一次测试就能定位卡在哪一步。 */
    if (!state.result || !state.result.meetingDraft) {
      publish({ error: '还没有可用的集合点，请先确认地点再试一次' })
      return
    }
    if (!ready()) return
    const draft = state.result.meetingDraft, token = ++generation
    if (!crewId || draft.crewId !== crewId || !isValidPoint(draft.point)) { publish({ error: '请先加入有效队伍，再准备集合点' }); return }
    publish({ busy: true, error: '' })
    let failureMessage = '无法显示集合点确认，请重试'
    try {
      const choice = await callWx(wx, 'showModal', { title: '用作集合点？', content: draft.name + '\n' + draft.address + '\n确认后返回队伍页，设置时间并手动发起集合。', confirmText: '确认选点' })
      if (!current(token)) return
      if (choice.confirm) {
        failureMessage = '无法保存集合点，请重试'
        wx.setStorageSync('zhiyou-guide-meeting', { ...draft.point, name: draft.name, address: draft.address, crewId, at: Date.now() })
        failureMessage = '无法打开队伍页，请重试'
        await callWx(wx, 'switchTab', { url: '/pages/map/index' })
      }
      if (current(token)) publish({ busy: false })
    } catch (_) {
      if (current(token)) {
        publish({ busy: false, error: failureMessage })
        try { wx.showToast({ title: failureMessage, icon: 'none' }) } catch (e) { /* 提示失败不影响状态 */ }
      }
    }
  }
  const apiResult = async (action, payload, config) => {
    const response = await options.callApi(action, payload, config)
    if (!response || !response.ok) { const e = new Error(response && response.error && response.error.message || '请求失败，请重试'); e.code = response && response.error && response.error.code; throw e }
    return response.data
  }
  async function confirmPlan() {
    const draft = state.result && state.result.tripPlan
    if (!ready() || !draft || !draft.destination || !isValidPoint(draft.destination.point)) return
    const token = ++generation
    publish({ busy: true, error: '' })
    let failureMessage = ''
    try {
      if (!createdPlan) {
        if (!isValidPoint(state.center)) throw new Error('请先使用当前位置，或在地图中选择出发位置')
        const stayMin = parseMinutes(state.planStayMin), mode = PLAN_MODES[state.planModeIndex]
        const startPoint = { ...state.center, label: state.center.label || '我的位置' }, place = draft.destination
        const choice = await callWx(wx, 'showModal', { title: '确认生成个人行程？', confirmText: '确认生成',
          content: '从“' + (startPoint.label || '已选出发位置') + '”前往“' + place.name + '”\n现在出发，停留' + stayMin + '分钟\n出行方式：' + mode.label + '\n地点来自地图检索，尚未经过实地踏勘。' })
        if (!current(token)) return
        if (!choice.confirm) { publish({ busy: false }); return }
        const key = JSON.stringify([state.result.sessionId, state.result.version, place, startPoint, stayMin, mode.value])
        if (!planRequest || planRequest.key !== key) planRequest = { key,
          requestId: options.newRequestId ? options.newRequestId() : 'guide-plan-' + Date.now() + '-' + Math.random().toString(36).slice(2),
          payload: { places: [{ name: place.name, address: place.address, location: place.point }], startPoint,
            startAt: new Date().toISOString(), stayMin, preferredMode: mode.value, title: place.name + ' 游览行程' } }
        const request = planRequest
        const data = await apiResult('trip.plan', request.payload, { requestId: request.requestId })
        if (planRequest !== request) return
        if (!data.tripId || data.saved === false || data.feasible === false) {
          // A rejected plan is safe to retry as a fresh request after changing inputs.
          planRequest = null
          throw new Error((data.conflicts || []).map(row => row.message).filter(Boolean).join('；') || '当前条件下无法生成可行行程，请调整出发位置、停留时间或出行方式')
        }
        createdPlan = { tripId: data.tripId, version: data.version }
        if (!current(token)) return
        publish({ createdTripId: data.tripId })
      }
      failureMessage = '行程已生成，但无法保存页面交接信息，请重试打开行程'
      wx.setStorageSync('zhiyou-guide-created-trip', createdPlan)
      failureMessage = '行程已生成，但无法打开行程页，请点击“打开已生成行程”重试'
      await callWx(wx, 'switchTab', { url: '/pages/trip/index' })
      if (current(token)) publish({ busy: false })
    } catch (e) { if (current(token)) publish({ busy: false, error: failureMessage || e.message || '生成行程失败，请重试' }) }
  }
  async function continueChange() {
    const change = state.tripChange
    if (!ready() || !change || !change.needsClarification || state.changeNeedsRewrite) return
    const token = ++generation
    publish({ busy: true, error: '' })
    try {
      const data = await apiResult('trip.adjustText', { tripId: change.tripId, draftId: change.draftId, answers: state.changeAnswers }, { expectedVersion: change.baseVersion })
      if (current(token)) publish({ ...changeDisplay({ ...data, tripId: change.tripId }, state.changeAnswers), busy: false })
    } catch (e) { if (current(token)) publish({ busy: false, error: e.message, ...(e.code === 'VERSION_CONFLICT' || e.code === 'FORBIDDEN_NOT_MEMBER' ? changeDisplay(null) : {}) }) }
  }
  async function confirmChange(candidateId) {
    const change = state.tripChange, candidate = state.changeCandidates.find(c => c.candidateId === candidateId && c.feasible)
    if (!ready() || !change || !change.proposalId || !candidate) return
    const token = ++generation
    publish({ busy: true, error: '' })
    try {
      const choice = await callWx(wx, 'showModal', { title: '确认修改行程？', content: candidate.nodeSummary + '\n' + candidate.notes.join('\n') + '\n确认后将更新行程。', confirmText: '确认修改' })
      if (!current(token)) return
      if (!choice.confirm) { publish({ busy: false }); return }
      if (options.scope === 'team') {
        const latest = await apiResult('team.current', { crewId })
        if (!current(token)) return
        if (latest.tripId !== change.tripId) throw Object.assign(new Error('队伍当前路线已变化，请重新提交修改'), { code: 'VERSION_CONFLICT' })
      }
      const key = change.proposalId + ':' + candidateId
      if (!confirmationIds.has(key)) confirmationIds.set(key, options.newRequestId ? options.newRequestId() : 'guide-change-' + Date.now() + '-' + Math.random().toString(36).slice(2))
      const data = await apiResult('trip.confirmChange', { proposalId: change.proposalId, candidateId },
        { expectedVersion: change.baseVersion, requestId: confirmationIds.get(key) })
      try { wx.setStorageSync('zhiyou-guide-trip-refresh', { tripId: change.tripId, version: data.version, at: Date.now() }) } catch (_) {}
      if (!current(token)) return
      publish({ ...changeDisplay(null), busy: false, result: { ...state.result, tripChange: null, tripContext: null,
        answer: '行程修改已确认并生效（第' + data.version + '版）。可以继续问“下一站去哪？”查看新安排。', evidence: [], sources: [], meetingDraft: null } })
    } catch (e) { if (current(token)) publish({ busy: false, error: e.message, ...(e.code === 'VERSION_CONFLICT' || e.code === 'FORBIDDEN_NOT_MEMBER' ? changeDisplay(null) : {}) }) }
  }
  async function navigate(target) {
    if (!ready()) return
    const token = ++generation
    publish({ busy: true, error: '' })
    try {
      const data = await apiResult('guide.navigation', { crewId, tripId, scope: options.scope || 'trip', target,
        ...(state.result ? { sessionId: state.result.sessionId } : {}) })
      if (!current(token)) return
      if (!data.point || !isValidPoint(data.point)) throw new Error('目的地坐标无效，请重新确认地点')
      await callWx(wx, 'openLocation', { ...data.point, name: data.name, address: data.address || '', scale: 16 })
      if (current(token)) publish({ busy: false })
    } catch (e) {
      if (current(token)) {
        const message = e.message || '无法打开地图导航，请稍后重试'
        publish({ busy: false, error: message })
        /* 2026-10-24：导航失败原来只在卡片里写一行小字，用户以为按钮坏了；
           补一个 toast，至少能区分“没点到”和“打开了但失败”。 */
        try { wx.showToast({ title: message.length > 30 ? '无法打开地图导航' : message, icon: 'none' }) } catch (err) { /* 忽略 */ }
      }
    }
  }
  async function countPeople() {
    if (!ready()) return
    if (!state.imagePath) { publish({ error: '请先拍照或选择一张人群照片' }); return }
    const token = ++generation, path = state.imagePath
    publish({ busy: true, error: '', crowdResult: null, crowdImagePath: '', crowdBoxes: [] })
    try {
      const imageBase64 = await readPhoto(wx, path, { action: 'guide.countPeople', current: () => current(token) })
      if (!current(token)) return
      const data = await apiResult('guide.countPeople', { imageBase64 })
      if (!current(token)) return
      publish({ busy: false, crowdResult: data, crowdImagePath: path,
        crowdBoxes: (data.boxes || []).map(b => ({ style: 'left:' + b.x * 100 + '%;top:' + b.y * 100 + '%;width:' + b.width * 100 + '%;height:' + b.height * 100 + '%;' })) })
    } catch (e) { if (current(token)) publish({ busy: false, error: e.message || '人群计数暂不可用，请稍后重试' }) }
  }
  return { choose, locate, chooseStart, ask, useMeeting, continueChange, confirmChange, confirmPlan, navigate, countPeople,
    setPlanStay(value) { if (ready() && !createdPlan) publish({ planStayMin: String(value || '').slice(0, 4) }) },
    setPlanMode(value) { const index = Number(value); if (ready() && !createdPlan && Number.isInteger(index) && PLAN_MODES[index]) publish({ planModeIndex: index, planModeLabel: PLAN_MODES[index].label }) },
    answerChange(key, value) { if (ready() && state.tripChange && state.changeQuestions.some(q => q.key === key)) publish(changeDisplay(state.tripChange, { ...state.changeAnswers, [key]: value })) },
    discardChange() { if (ready()) publish({ ...changeDisplay(null), error: '', result: state.result ? { ...state.result, tripChange: null, answer: '已放弃本次修改，原行程未改变。' } : null }) },
    setText(text) { if (ready()) publish({ text: String(text || '').slice(0, 1000), error: '' }) },
    removeImage() { generation++; publish({ imagePath: '', busy: false, choosing: false }) },
    clear() { return reset(true) },
    show() { if ((options.getCrewId() || null) !== crewId || readTripId() !== tripId) reset(false); else if (createdPlan) publish({ createdTripId: createdPlan.tripId }) },
    hide() { if (!state.choosing) { generation++; publish({ busy: false }) } },
    dispose() { generation++; alive = false; state = initialGuideState() },
  }
}
module.exports = { createGuideAssistant, initialGuideState, readPhoto };

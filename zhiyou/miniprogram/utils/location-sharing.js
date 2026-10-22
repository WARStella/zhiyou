const { isValidPoint } = require('./coordinates')
const { POLICY_VERSION } = require('./location-consent')

const INTERVAL_MS = 15000
const HEARTBEAT_MS = 60000
const MOVEMENT_METERS = 20
const CREW_KEY = 'zhiyou-active-crew'

function distance(a, b) {
  const rad = value => value * Math.PI / 180
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2
  return 12742017.6 * Math.asin(Math.sqrt(Math.min(1, h)))
}

/** 一个 App 只创建一个实例；仅在前台且服务端共享已开启时定位。 */
function createLocationSharing(options) {
  const wx = options.wx
  const now = options.now || Date.now
  const timers = options.timers || { setInterval, clearInterval }
  const getCrewId = options.getCrewId || (() => wx.getStorageSync(CREW_KEY) || '')
  const listeners = new Set()
  const pendingLocationCalls = new Set()
  let state = { crewId: '', sharing: false, active: false, point: null, accuracyM: null,
    sampledAt: null, uploadedAt: null, error: '' }
  let foreground = false
  let revision = 0
  let timer = null
  let listener = null
  let latest = null
  let lastUpload = null
  let checkedAt = 0
  let controls = Promise.resolve()
  let working = null
  let locallyDisabledCrew = wx.getStorageSync('zhiyou-sharing-disabled-crew') || ''

  const snapshot = () => ({ ...state, point: state.point ? { ...state.point } : null })
  const emit = patch => {
    state = { ...state, ...patch }
    for (const callback of listeners) callback(snapshot())
  }
  const valid = (version, crewId) => foreground && version === revision && getCrewId() === crewId
  const call = async (action, payload) => {
    const result = await options.callApi(action, payload)
    if (!result || !result.ok) {
      const error = new Error(result && result.error ? result.error.message : '位置共享请求失败')
      error.code = result && result.error && result.error.code
      throw error
    }
    return result.data || {}
  }
  const wxCall = (name, args) => new Promise((resolve, reject) => {
    if (typeof wx[name] !== 'function') return reject(new Error('当前微信不支持自动定位，请升级后重试'))
    let settled = false
    const cancel = () => {
      if (settled) return
      settled = true
      pendingLocationCalls.delete(cancel)
      const error = new Error('定位已暂停')
      error.code = 'LOCATION_CANCELLED'
      reject(error)
    }
    pendingLocationCalls.add(cancel)
    wx[name]({ ...args, success: result => {
      if (settled) {
        // 后台停用后 SDK 才完成启动时，再次停止；不要停止随后已开启的新监听。
        if (name === 'startLocationUpdate' && !listener && wx.stopLocationUpdate) wx.stopLocationUpdate({})
        return
      }
      settled = true
      pendingLocationCalls.delete(cancel)
      resolve(result)
    }, fail: error => {
      if (settled) return
      settled = true
      pendingLocationCalls.delete(cancel)
      reject(new Error((error && error.errMsg) || '定位失败，请检查微信位置权限'))
    } })
  })
  const sample = result => {
    if (!isValidPoint(result)) throw new Error('定位坐标无效，请重新定位')
    latest = { point: { latitude: result.latitude, longitude: result.longitude },
      accuracyM: Number.isFinite(result.accuracy) ? result.accuracy : null, at: now() }
    return latest
  }
  function stop() {
    revision++
    for (const cancel of [...pendingLocationCalls]) cancel()
    if (timer !== null) timers.clearInterval(timer)
    timer = null
    if (listener) {
      if (wx.offLocationChange) wx.offLocationChange(listener)
      if (wx.stopLocationUpdate) wx.stopLocationUpdate({})
    }
    listener = null
    latest = null
    emit({ active: false })
  }
  function queue(task) {
    const result = controls.then(task)
    controls = result.catch(() => {})
    return result
  }
  async function update(force) {
    if (working) return working
    if (!foreground || !state.sharing || !state.active) return snapshot()
    const version = revision
    const crewId = state.crewId
    working = (async () => {
      try {
        let current = latest
        // 页面进入要求立即更新；持续定位已提供极新样本时直接使用，避免重复高频 getLocation。
        if (!current || now() - current.at > (force ? 3000 : INTERVAL_MS)) {
          if (!force && lastUpload && now() - lastUpload.at < HEARTBEAT_MS) return snapshot()
          const result = await wxCall('getLocation', { type: 'gcj02' })
          if (!valid(version, crewId)) return snapshot()
          current = sample(result)
        }
        if (!valid(version, crewId)) return snapshot()
        emit({ point: current.point, accuracyM: current.accuracyM, sampledAt: current.at })
        const shouldUpload = !lastUpload || (force && now() - lastUpload.at >= 2000) || distance(lastUpload.point, current.point) >= MOVEMENT_METERS ||
          now() - lastUpload.at >= HEARTBEAT_MS
        if (!shouldUpload) return snapshot()
        const result = await call('loc.report', { crewId, point: current.point, source: 'gps',
          accuracyM: current.accuracyM, clientAt: new Date(current.at).toISOString() })
        if (!valid(version, crewId)) return snapshot()
        lastUpload = { point: current.point, at: now() }
        emit({ uploadedAt: result.reportedAt || new Date(now()).toISOString(), error: '' })
      } catch (error) {
        if (valid(version, crewId)) {
          if (['LOCATION_SHARING_OFF', 'FORBIDDEN_NOT_MEMBER', 'NOT_FOUND'].includes(error.code)) {
            stop()
            emit({ sharing: false })
          }
          emit({ error: error.message })
        }
      }
      return snapshot()
    })()
    try { return await working } finally { working = null }
  }
  async function start(version, crewId, firstSample) {
    if (!valid(version, crewId)) return
    if (state.active) return update(true)
    listener = result => {
      if (!valid(version, crewId)) return
      try { sample(result) } catch (error) { emit({ error: error.message }) }
    }
    wx.onLocationChange(listener)
    try {
      await wxCall('startLocationUpdate', { type: 'gcj02' })
      if (!valid(version, crewId)) {
        if (wx.stopLocationUpdate) wx.stopLocationUpdate({})
        return
      }
      if (firstSample) latest = firstSample
      emit({ active: true, error: '' })
      timer = timers.setInterval(() => {
        if (getCrewId() !== state.crewId || now() - checkedAt >= HEARTBEAT_MS) sync(false)
        else update(false)
      }, INTERVAL_MS)
      if (timer && timer.unref) timer.unref()
      return update(true)
    } catch (error) {
      if (valid(version, crewId)) { stop(); emit({ error: error.message }) }
    }
  }
  function sync(force = false) {
    const currentCrew = getCrewId()
    if (currentCrew !== state.crewId) {
      stop()
      lastUpload = null
      emit({ crewId: currentCrew, sharing: false, point: null, sampledAt: null, uploadedAt: null, error: '' })
    }
    const requestedRevision = revision
    return queue(async () => {
      if (!foreground || requestedRevision !== revision) return snapshot()
      const crewId = getCrewId()
      if (crewId !== state.crewId) {
        stop()
        lastUpload = null
        emit({ crewId, sharing: false, point: null, sampledAt: null, uploadedAt: null, error: '' })
      }
      if (!crewId) return snapshot()
      const version = revision
      try {
        const info = await call('crew.get', { crewId })
        if (!valid(version, crewId)) return snapshot()
        checkedAt = now()
        const me = (info.members || []).find(member => member.userId === info.me)
        if (me && me.locationSharing !== false && locallyDisabledCrew === crewId) {
          try { await call('loc.stopSharing', { crewId, sharing: false }) }
          catch (error) { throw new Error('本机已停止上传，但云端关闭失败，请重试：' + error.message) }
          if (!valid(version, crewId)) return snapshot()
        }
        const sharing = Boolean(me && me.locationSharing !== false && locallyDisabledCrew !== crewId)
        emit({ sharing })
        if (!sharing) { stop(); emit({ error: '' }); return snapshot() }
        if (!state.active) {
          const setting = await wxCall('getSetting', {})
          if (!valid(version, crewId)) return snapshot()
          if (!setting.authSetting || !setting.authSetting['scope.userLocation']) {
            emit({ error: '请在「我的 → 设置」中开启定位权限后重试' })
            return snapshot()
          }
          await start(version, crewId)
        } else await update(force)
      } catch (error) {
        if (valid(version, crewId)) {
          if (['FORBIDDEN_NOT_MEMBER', 'NOT_FOUND'].includes(error.code)) { stop(); emit({ sharing: false }) }
          emit({ error: error.message })
        }
      }
      return snapshot()
    })
  }
  function setEnabled(enabled) {
    stop() // 关闭/切换过程中，先停止定位与后续上传；服务端设置按队列顺序写入。
    const version = revision
    const crewId = getCrewId()
    if (!enabled) {
      locallyDisabledCrew = crewId
      wx.setStorageSync('zhiyou-sharing-disabled-crew', crewId)
      emit({ sharing: false, error: '' })
    }
    return queue(async () => {
      if (!crewId) throw new Error('请先创建或加入小队')
      if (!enabled) {
        try { await call('loc.stopSharing', { crewId, sharing: false }) }
        catch (error) { emit({ error: '本机已停止上传，但云端关闭失败，请重试：' + error.message }); throw error }
        emit({ error: '' })
        return snapshot()
      }
      if (!valid(version, crewId)) return snapshot()
      try {
        const result = await wxCall('getLocation', { type: 'gcj02' })
        if (!valid(version, crewId)) return snapshot()
        const first = sample(result)
        await call('loc.stopSharing', { crewId, sharing: true, policyVersion: POLICY_VERSION })
        if (!valid(version, crewId)) return snapshot()
        locallyDisabledCrew = ''
        wx.removeStorageSync('zhiyou-sharing-disabled-crew')
        lastUpload = null
        emit({ crewId, sharing: true, point: first.point, sampledAt: first.at, error: '' })
        checkedAt = now()
        await start(version, crewId, first)
      } catch (error) {
        if (valid(version, crewId)) emit({ error: error.message })
        throw error
      }
      return snapshot()
    })
  }
  return {
    snapshot, sync, setEnabled,
    subscribe(callback) { listeners.add(callback); callback(snapshot()); return () => listeners.delete(callback) },
    setForeground(value) { foreground = value; if (!value) { stop(); return Promise.resolve(snapshot()) } return sync(true) },
    refresh() { return sync(true) },
  }
}

module.exports = { createLocationSharing, INTERVAL_MS, HEARTBEAT_MS, MOVEMENT_METERS }

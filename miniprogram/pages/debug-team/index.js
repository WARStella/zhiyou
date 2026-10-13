const api = require('../../utils/api')

Page({
  data: {
    ready: false, busy: false, env: '', envId: '', identity: '', error: '',
    inviteCode: '', crewId: '', taskInput: '', task: null, members: [],
    placeName: '', latitude: '', longitude: '', sharedRequestId: '',
    version: null, logs: [], pretty: '', lastWriteId: '',
    refreshedAt: '',
  },

  async onLoad() {
    const app = getApp()
    this.setData({ envId: app.globalData.envId || '默认环境（请在工具中核对）' })
    return this.run(async () => {
      const health = await this.send('ops.health', {})
      if (!health.ok) return
      this.setData({ env: health.data.env })
      if (health.data.env !== 'dev') {
        this.setData({ error: '此联调页仅在 ZY_ENV=dev 的开发环境启用。' })
        return
      }
      const login = await this.send('user.login', {})
      if (login.ok) this.setData({ ready: true, identity: login.data.openid })
    }, true)
  },

  input(e) {
    const field = e.currentTarget.dataset.field
    if (['inviteCode', 'taskInput', 'placeName', 'latitude', 'longitude', 'sharedRequestId'].includes(field)) {
      this.setData({ [field]: e.detail.value })
      if (field === 'taskInput') this.setData({ task: null, version: null, refreshedAt: '' })
    }
  },

  async run(fn, bootstrap) {
    if (this.data.busy) return
    if (!bootstrap && !this.data.ready) { this.setData({ error: '请先完成开发环境检查。' }); return }
    this.setData({ busy: true, error: '' })
    try { await fn() } catch (e) {
      this.setData({ error: e.message || String(e) })
    } finally { this.setData({ busy: false }) }
  },

  async send(action, payload, options, write) {
    const opts = Object.assign({ requestId: api.newRequestId() }, options || {})
    const request = { action, payload: JSON.parse(JSON.stringify(payload)), options: opts }
    if (write) {
      this.lastWrite = JSON.parse(JSON.stringify(request))
      this.setData({ lastWriteId: opts.requestId })
    }
    const startedAt = new Date().toISOString()
    let response
    try { response = await api.callApi(action, payload, opts) } catch (e) {
      response = { ok: false, error: { code: 'CLIENT_ERROR', message: e.message || String(e) } }
    }
    const entry = { startedAt, finishedAt: new Date().toISOString(), identity: this.data.identity, request, response }
    const logs = [entry].concat(this.data.logs).slice(0, 30)
    this.setData({ logs, pretty: JSON.stringify(logs, null, 2) })
    if (!response.ok) this.setData({ error: response.error.code + '：' + response.error.message })
    return response
  },

  createCrew() {
    return this.run(async () => {
      const r = await this.send('crew.create', { name: '三机联调-' + Date.now().toString().slice(-6), shareLocationDefault: false }, null, true)
      if (r.ok) { this.switchCrew(r.data); await this.readCrew() }
    })
  },
  joinCrew() {
    return this.run(async () => {
      const inviteCode = this.data.inviteCode.trim().toUpperCase()
      if (!inviteCode) throw new Error('请输入 A 手机上的邀请码。')
      const r = await this.send('crew.join', { inviteCode }, null, true)
      if (r.ok) { this.switchCrew(Object.assign({ inviteCode }, r.data)); await this.readCrew() }
    })
  },
  switchCrew(data) {
    this.setData({ crewId: data.crewId, inviteCode: data.inviteCode, members: [], taskInput: '', task: null, version: null, refreshedAt: '' })
  },
  async readCrew() {
    if (!this.data.crewId) return
    const r = await this.send('crew.get', { crewId: this.data.crewId })
    if (r.ok) this.setData({ members: r.data.members, inviteCode: r.data.crew.inviteCode })
  },
  createMeeting() {
    return this.run(async () => {
      if (!this.data.crewId) throw new Error('请先创建或加入小队。')
      const latitude = Number(this.data.latitude), longitude = Number(this.data.longitude)
      if (!this.data.latitude.trim() || !this.data.longitude.trim() || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        throw new Error('请填写集合点的有效纬度、经度。')
      }
      if (!this.data.placeName.trim()) throw new Error('请填写集合点名称。')
      // No tripId: these state tests must not generate travel labels or change an itinerary.
      const r = await this.send('meet.create', {
        crewId: this.data.crewId, method: 'manual', placeName: this.data.placeName.trim(),
        point: { latitude, longitude }, plannedMeetAt: new Date(Date.now() + 30 * 60000).toISOString(),
      }, null, true)
      if (r.ok) { this.setData({ taskInput: r.data.meetTaskId }); await this.readMeeting() }
    })
  },
  async readMeeting() {
    const meetTaskId = this.data.taskInput.trim()
    if (!meetTaskId) return
    const r = await this.send('meet.get', { meetTaskId })
    if (r.ok) this.setData({ task: r.data.meetTask, version: r.data.meetTask.version, crewId: r.data.meetTask.crewId, refreshedAt: r.data.serverTime })
    else this.setData({ task: null, version: null, refreshedAt: '' })
  },
  refresh() {
    return this.run(async () => { await this.readMeeting(); await this.readCrew() })
  },
  mutate(e) {
    const kind = e.currentTarget.dataset.kind
    return this.run(async () => {
      const task = this.data.task
      if (!task || task.meetTaskId !== this.data.taskInput.trim()) throw new Error('请先加载当前任务。')
      const payload = { meetTaskId: task.meetTaskId }
      let action = 'meet.confirm'
      const options = { expectedVersion: this.data.version }
      if (kind === 'confirm' || kind === 'old' || kind === 'shared') payload.decision = 'confirm'
      else if (kind === 'arrive') action = 'meet.arrive'
      else if (kind === 'depart' || kind === 'missing') action = 'meet.depart'
      else throw new Error('未知操作')
      if (kind === 'old') options.expectedVersion = this.data.version - 1
      if (kind === 'missing') delete options.expectedVersion
      if (kind === 'shared') {
        if (!this.data.sharedRequestId.trim()) throw new Error('请先填写共享 requestId。')
        options.requestId = this.data.sharedRequestId.trim()
      }
      await this.send(action, payload, options, true)
      await this.readMeeting()
    })
  },
  replay() {
    return this.run(async () => {
      if (!this.lastWrite) throw new Error('还没有可重试的写请求。')
      const r = this.lastWrite
      await this.send(r.action, r.payload, r.options, false)
      await this.readMeeting()
    })
  },
  copy(e) {
    const fields = { invite: 'inviteCode', task: 'taskInput', request: 'lastWriteId', logs: 'pretty' }
    const key = fields[e.currentTarget.dataset.kind]
    if (!key || !this.data[key]) return
    wx.setClipboardData({ data: this.data[key], fail: () => this.setData({ error: '复制失败，请重试。' }) })
  },
})

const api = require('../../utils/api')
const { requestMinutes } = require('../../utils/stay-duration')
const KEY = 'zhiyou-active-crew'
const labels = { cancelled: '已取消', proposed: '等待成员确认', confirmed: '集合已确认', active: '成员前往中', arrived_all: '全员已到齐', departed: '已出发', invited: '待确认', arrived: '已到达', declined: '已拒绝', pending: '待游览', done: '已完成', skipped: '已跳过' }
const clock = value => value ? new Date(value).toLocaleString() : '尚未发生'
Component({
  properties: { personalTripId: { type: String, value: '' }, point: { type: Object, value: null }, source: { type: String, value: '' } },
  data: { crewId: '', crew: null, owner: false, me: '', members: [], trip: null, task: null, invite: '', name: '', pointName: '', meetTime: '17:00', busy: false, error: '', message: '', sharing: false, refreshed: '', departureCheck: null, proposal: null },
  lifetimes: { attached() { this.restore() } },
  pageLifetimes: { show() { this.restore() } },
  methods: {
    async call(action, payload, options) {
      const r = await api.callApi(action, payload, options)
      if (!r || !r.ok) { const e = new Error(r && r.error ? r.error.message : '请求失败'); e.code = r && r.error && r.error.code; throw e }
      return r.data
    },
    async run(fn) {
      if (this.data.busy) return
      this.setData({ busy: true, error: '', message: '' })
      try { await fn() } catch (e) {
        this.setData({ error: e.message || '操作失败，请重试' })
      } finally { this.setData({ busy: false }) }
    },
    restore() {
      if (this.data.busy) return
      const crewId = wx.getStorageSync(KEY) || ''
      if (!crewId) { this.clear(); return }
      if (crewId !== this.data.crewId) this.clear()
      this.setData({ crewId })
      return this.refresh()
    },
    clear() {
      this.setData({ crewId: '', crew: null, trip: null, task: null, members: [], owner: false, sharing: false, proposal: null, refreshed: '' })
      this.triggerEvent('teamstate', { locations: [], meeting: null })
    },
    input(e) {
      const key = e.currentTarget.dataset.field
      if (['name','invite','pointName','meetTime'].includes(key)) this.setData({ [key]: e.detail.value })
    },
    async read() {
      this.setData({ departureCheck: null })
      if (!this.data.crewId) return
      const crewId = this.data.crewId
      let info
      try { info = await this.call('crew.get', { crewId }) } catch (e) {
        if (['FORBIDDEN_NOT_MEMBER','NOT_FOUND'].includes(e.code)) { wx.removeStorageSync(KEY); this.clear() }
        throw e
      }
      const user = await this.call('user.login', {})
      const current = await this.call('team.current', { crewId })
      const positions = await this.call('loc.list', { crewId })
      const members = info.members.map((m, i) => {
        const loc = positions.members.find(x => x.userId === m.userId) || {}
        return Object.assign({}, m, { label: m.userId === user.openid ? '我' : '队员 ' + (i + 1), locationText: loc.sharingOff ? '未共享位置' : !loc.hasLocation ? '尚未上报位置' : (loc.stale ? '位置已过期' : '位置有效') + ' · ' + (loc.source === 'gps' ? '定位' : '手动') + ' · ' + clock(loc.reportedAt) })
      })
      let trip = current.tripId ? (await this.call('trip.get', { tripId: current.tripId })).trip : null
      if (trip) trip.nodes = trip.nodes.map(n => Object.assign({}, n, { label: labels[n.status] || n.status, timeLabel: clock(n.plannedArriveAt) }))
      let task = current.meetTaskId ? (await this.call('meet.get', { meetTaskId: current.meetTaskId })).meetTask : null
      if (task) {
        task.label = labels[task.status] || task.status
        task.timeLabel = clock(task.plannedMeetAt)
        task.arrivedLabel = clock(task.allArrivedAt)
        task.departedLabel = clock(task.departedAt)
        task.isInitiator = task.initiatorUserId === user.openid
        task.participants = task.participants.map(p => Object.assign({}, p, { label: (members.find(m => m.userId === p.userId) || {}).label || '已退出队员', statusLabel: labels[p.status] || p.status }))
      }
      const me = info.members.find(m => m.userId === user.openid)
      this.setData({ crew: info.crew, me: user.openid, owner: info.myRole === 'owner', members, trip, task, proposal: current.proposal || null, sharing: !!me && me.locationSharing !== false, refreshed: clock(positions.serverTime) })
      this.triggerEvent('teamstate', { locations: positions.members.filter(m => m.hasLocation && !m.stale && !m.sharingOff), meeting: task && task.point ? { point: task.point, name: task.placeName } : null })
    },
    refresh() { return this.run(() => this.read()) },
    create() { return this.run(async () => {
      const r = await this.call('crew.create', { name: this.data.name.trim() || '一起游览', shareLocationDefault: false })
      wx.setStorageSync(KEY, r.crewId); this.setData({ crewId: r.crewId }); await this.read()
    }) },
    join() { return this.run(async () => {
      if (!this.data.invite.trim()) throw new Error('请输入同伴发来的邀请码')
      const r = await this.call('crew.join', { inviteCode: this.data.invite.trim().toUpperCase() })
      wx.setStorageSync(KEY, r.crewId); this.setData({ crewId: r.crewId }); await this.read()
    }) },
    copyInvite() { wx.setClipboardData({ data: this.data.crew.inviteCode }) },
    publish() { return this.run(async () => {
      if (!this.properties.personalTripId) throw new Error('请先在行程页生成个人路线')
      await this.call('team.publishTrip', { crewId: this.data.crewId, tripId: this.properties.personalTripId }); await this.read()
      this.setData({ message: '已复制为共同路线，个人路线保持独立。请与队员确认安排。' })
    }) },
    leave() {
      wx.showModal({ title: this.data.owner ? '解散小队' : '退出小队', content: this.data.owner ? '解散后所有成员将失去小队访问权限，个人路线保留。' : '退出后停止共享位置，个人路线保留。', success: r => {
        if (r.confirm) this.run(async () => { await this.call(this.data.owner ? 'team.close' : 'crew.leave', { crewId: this.data.crewId }); wx.removeStorageSync(KEY); this.clear() })
      } })
    },
    toggleSharing() { return this.run(async () => {
      await this.call('loc.stopSharing', { crewId: this.data.crewId, sharing: !this.data.sharing }); await this.read()
    }) },
    report() { return this.run(async () => {
      if (!this.properties.point) throw new Error('请在地图页获取位置或手动选点')
      await this.call('loc.report', { crewId: this.data.crewId, point: this.properties.point, source: this.properties.source || 'manual' }); await this.read()
    }) },
    createMeeting() { return this.run(async () => {
      if (!this.properties.point) throw new Error('请先在地图上选取集合位置')
      if (!this.data.pointName.trim()) throw new Error('请填写便于辨认的集合点名称')
      const at = new Date(); const parts = this.data.meetTime.split(':').map(Number)
      at.setHours(parts[0], parts[1], 0, 0)
      if (at <= new Date()) throw new Error('请选择今天尚未到达的集合时间')
      await this.call('meet.create', { crewId: this.data.crewId, tripId: this.data.trip ? this.data.trip.tripId : null, point: this.properties.point, placeName: this.data.pointName.trim(), method: 'manual', plannedMeetAt: at.toISOString() }); await this.read()
    }) },
    meetAction(e) { return this.run(async () => {
      const kind = e.currentTarget.dataset.kind, task = this.data.task
      if (!task) return
      const p = { meetTaskId: task.meetTaskId }
      if (kind === 'depart') {
        if (!this.data.departureCheck || !this.data.departureCheck.canDepart) throw new Error('请先检查后续行程')
        p.checkId = this.data.departureCheck.checkId
      }
      if (kind === 'confirm' || kind === 'decline') p.decision = kind
      const r = await this.call('meet.' + (kind === 'decline' ? 'confirm' : kind), p, { expectedVersion: task.version })
      await this.read()
      if (r.proposal) this.setData({ proposal: r.proposal, message: '后续安排需要调整，请选择可行方案。' })
    }) },
    prepareDepart() { return this.run(async () => {
      const r = await this.call('meet.prepareDepart', { meetTaskId: this.data.task.meetTaskId }, { expectedVersion: this.data.task.version })
      await this.read()
      this.setData({ departureCheck: r, message: r.message })
    }) },
    accept(e) { return this.run(async () => {
      await this.call('trip.confirmChange', { proposalId: this.data.proposal.proposalId, candidateId: e.currentTarget.dataset.id }, { expectedVersion: this.data.trip.version }); this.setData({ proposal: null }); await this.read()
    }) },
    cancelMeeting() {
      wx.showModal({ title: '取消本次集合', content: '原确认将失效。取消后可重新约定集合点与时间。', success: r => {
        if (r.confirm) this.run(async () => {
          await this.call('team.cancelMeeting', { meetTaskId: this.data.task.meetTaskId }, { expectedVersion: this.data.task.version }); await this.read()
        })
      } })
    },
    progress(e) { return this.run(async () => {
      await this.call('team.progress', { tripId: this.data.trip.tripId, nodeId: e.currentTarget.dataset.id, status: e.currentTarget.dataset.status }, { expectedVersion: this.data.trip.version }); await this.read()
    }) },
    adjust(e) { return this.run(async () => {
      const d = e.currentTarget.dataset
      const deltaMin = d.kind === 'skip' ? null : await requestMinutes(d.kind === 'shorten')
      if (d.kind !== 'skip' && deltaMin == null) return
      const r = await this.call('trip.adjust', { tripId: this.data.trip.tripId,
        trigger: { type: d.kind === 'skip' ? 'skip_node' : d.kind === 'shorten' ? 'shorten_stay' : 'extend_stay', payload: d.kind === 'skip' ? { nodeId: d.id } : { nodeId: d.id, deltaMin } },
      }, { expectedVersion: this.data.trip.version })
      await this.read()
      this.setData({ message: r.applied ? '共同路线已更新，请提醒队员刷新。' : '请查看候选方案；没有可行方案时需重新协商条件。' })
    }) },
    openMap() { wx.switchTab({ url: '/pages/map/index' }) },
  },
})

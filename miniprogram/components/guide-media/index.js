const api = require('../../utils/api')
const { readSettings } = require('../../utils/ai-settings')
const labels = { unknown: '状态待确认', pending: '排队中', running: '生成中', succeeded: '已生成', failed: '未能生成', expired: '已过期' }
function decorate(task) {
  return { ...task, stateLabel: labels[task.status] || '状态待确认', kindLabel: task.kind === 'image' ? '讲解配图' : '讲解短片',
    waiting: ['pending', 'running', 'unknown'].includes(task.status), completed: task.status === 'succeeded' && Boolean(task.url),
    tone: task.status === 'succeeded' ? 'success' : task.status === 'failed' ? 'failed' : 'waiting' }
}
Component({
  properties: { sessionId: String, version: Number, crewId: String, available: Boolean, preferredKind: String },
  data: { tasks: [], busy: false, refreshing: false, generatingKind: '', error: '', imageLabel: '生成配图', videoLabel: '生成短片', canRefresh: false, hasImageTask: false, hasVideoTask: false },
  observers: { 'sessionId, version, crewId': function () { if (this.readyForMedia) this.reset() } },
  lifetimes: {
    attached() { this.readyForMedia = true; this.visible = true; this.token = 0; this.reset() },
    detached() { this.visible = false; this.token++; clearTimeout(this.timer) },
  },
  pageLifetimes: { hide() { this.visible = false; this.token++; clearTimeout(this.timer); this.setData({ busy: false, refreshing: false }) }, show() { this.visible = true; this.reset() } },
  methods: {
    key() { return 'zhiyou-media-' + this.data.sessionId + '-' + this.data.version },
    notifyLayout() { if (this.visible && typeof this.triggerEvent === 'function') this.triggerEvent('layout') },
    updateTasks(tasks) {
      tasks = tasks.map(decorate)
      const image = tasks.find(t => t.kind === 'image'), video = tasks.find(t => t.kind === 'video')
      this.setData({ tasks, hasImageTask: Boolean(image), hasVideoTask: Boolean(video), imageLabel: image ? image.completed ? '查看配图' : '查看配图状态' : '生成配图',
        videoLabel: video ? video.completed ? '查看短片' : '查看短片状态' : '生成短片',
        canRefresh: tasks.some(t => ['pending', 'running', 'unknown'].includes(t.status)) })
    },
    reset() {
      this.token++; clearTimeout(this.timer)
      let tasks = []; try { tasks = wx.getStorageSync(this.key()) || [] } catch (_) {}
      tasks = Array.isArray(tasks) ? tasks.filter(t => t.optionId === 'aliyun-image' || t.optionId === 'aliyun-video') : []
      this.updateTasks(tasks)
      this.setData({ busy: false, refreshing: false, generatingKind: '', error: '' })
      if (this.visible && tasks.length) this.refresh()
    },
    store(key, task) {
      let tasks = []; try { tasks = wx.getStorageSync(key) || [] } catch (_) {}
      if (!Array.isArray(tasks)) tasks = []
      tasks = tasks.filter(t => t.taskId !== task.taskId).concat([task]).slice(-6)
      wx.setStorageSync(key, tasks.map(t => ({ taskId: t.taskId, kind: t.kind, status: t.status, optionId: t.optionId })))
      if (this.visible && this.key() === key) {
        this.updateTasks(this.data.tasks.filter(t => t.taskId !== task.taskId).concat([task]).slice(-6))
        this.notifyLayout()
      }
    },
    async generate(e) {
      if (this.data.busy || !this.data.available) return
      const kind = e.currentTarget.dataset.kind, token = this.token, key = this.key()
      const settings = readSettings(), crewId = this.data.crewId || null
      const existing = this.data.tasks.find(t => t.kind === kind && t.optionId === settings[kind])
      if (existing) {
        if (existing.completed && kind === 'image') return this.preview({ currentTarget: { dataset: { url: existing.url } } })
        this.notifyLayout()
        return this.refresh()
      }
      this.setData({ busy: true, generatingKind: kind, error: '' }); this.notifyLayout()
      try {
        const task = await api.callApiStrict('media.create', { kind, optionId: settings[kind], sessionId: this.data.sessionId, sessionVersion: this.data.version, crewId })
        this.store(key, task)
        if (token === this.token) this.schedule()
      } catch (e) {
        if (token === this.token) this.setData({ error: e.code === 'MEDIA_NOT_CONFIGURED' ? '所选生成服务尚未启用，可在偏好里查看或更换。' : e.message || '这次未能生成，文字讲解仍可继续查看。' })
      } finally { if (token === this.token) { this.setData({ busy: false, generatingKind: '' }); this.notifyLayout() } }
    },
    schedule() {
      clearTimeout(this.timer)
      if (this.visible && this.data.tasks.some(t => t.kind === 'video' && ['pending', 'running'].includes(t.status))) this.timer = setTimeout(() => this.refresh(), 15000)
    },
    async refresh() {
      if (!this.visible || this.data.refreshing) return
      const token = this.token, key = this.key(), crewId = this.data.crewId || null
      this.setData({ refreshing: true, error: '' })
      try {
        for (const old of this.data.tasks) {
          const task = await api.callApiStrict('media.get', { taskId: old.taskId, crewId })
          if (token !== this.token || !this.visible) return
          this.store(key, task)
        }
      } catch (e) { if (token === this.token) this.setData({ error: e.message || '状态暂时未能更新，稍后可再查询。' }) }
      finally { if (token === this.token) { this.setData({ refreshing: false }); this.schedule() } }
    },
    preview(e) { if (wx.previewImage) wx.previewImage({ urls: [e.currentTarget.dataset.url] }) },
    mediaLoaded() { this.notifyLayout() },
    mediaError() { this.setData({ error: '画面暂时无法打开，结果可能已过期；文字讲解仍可查看。' }); this.notifyLayout() },
    settings() { wx.navigateTo({ url: '/pages/ai-settings/index' }) },
  },
})

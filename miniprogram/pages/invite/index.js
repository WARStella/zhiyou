const api = require('../../utils/api')
const { invitationToken } = require('../../utils/invitation-link')
const KEY = 'zhiyou-active-crew'
const wxCall = (name, args) => new Promise((resolve, reject) => {
  if (typeof wx[name] !== 'function') return reject(new Error('当前微信不支持此操作，请更新微信后重试'))
  wx[name]({ ...args, success: resolve, fail: reject })
})
Page({
  data: { managing: false, crewId: '', token: '', name: '', canManage: false, invitation: null,
    preview: null, busy: false, loading: true, error: '', message: '', expiresLabel: '', qrPath: '', joinedCrewId: '' },
  onLoad(query) {
    this.visible = true; this.generation = 0
    const token = invitationToken(query)
    const managing = !token && query && typeof query.crewId === 'string' && query.crewId.length > 0 && query.crewId.length <= 100
    this.setData({ managing: Boolean(managing), crewId: managing ? query.crewId : '', token })
    if (typeof wx.hideShareMenu === 'function') wx.hideShareMenu()
    if (!managing && !token) this.setData({ loading: false, error: '邀请格式无效，请重新打开同伴的邀请卡或小程序码' })
  },
  onShow() {
    this.visible = true
    if (this.previewing) { this.previewing = false; this.scheduleExpiry(); return }
    if (this.data.token || this.data.managing) return this.refresh()
  },
  onHide() { this.visible = false; clearTimeout(this.expiryTimer); if (!this.previewing) { this.generation++; this.setData({ busy: false, loading: false }) } },
  onUnload() { this.visible = false; this.generation++; clearTimeout(this.expiryTimer); this.deleteQr() },
  current(token) { return this.visible && token === this.generation &&
    (!this.data.managing || wx.getStorageSync(KEY) === this.data.crewId) },
  async call(action, payload) {
    const res = await api.callApi(action, payload)
    if (!res || !res.ok) throw Object.assign(new Error(res && res.error && res.error.message || '网络请求失败，请重试'), { code: res && res.error && res.error.code })
    const stamp = res.meta && res.meta.serverTime || res.data && res.data.serverTime
    if (stamp && Number.isFinite(new Date(stamp).getTime())) this.serverOffset = new Date(stamp).getTime() - Date.now()
    return res.data
  },
  deleteQr() {
    if (this.data.qrPath) {
      try { wx.getFileSystemManager().unlink({ filePath: this.data.qrPath, success() {}, fail() {} }) } catch (_) {}
      this.setData({ qrPath: '' })
    }
  },
  setInvitation(invitation) {
    this.deleteQr()
    this.setData({ invitation: invitation || null, expiresLabel: invitation ? new Date(invitation.expiresAt).toLocaleString() : '' })
    if (invitation && typeof wx.showShareMenu === 'function') wx.showShareMenu({ menus: ['shareAppMessage'] })
    else if (typeof wx.hideShareMenu === 'function') wx.hideShareMenu()
    this.scheduleExpiry()
  },
  scheduleExpiry() {
    clearTimeout(this.expiryTimer)
    const invitation = this.data.invitation
    if (invitation) {
      const remaining = new Date(invitation.expiresAt).getTime() - Date.now() - (this.serverOffset || 0)
      this.expiryTimer = setTimeout(() => {
        this.setInvitation(null)
        this.setData({ message: '邀请已到期，请发起人创建新邀请。' })
      }, Math.max(1, Math.min(remaining + 50, 2147483647)))
      if (this.expiryTimer && typeof this.expiryTimer.unref === 'function') this.expiryTimer.unref()
    }
  },
  async refresh() {
    if (!this.data.managing && !this.data.token) return
    if (this.data.managing && wx.getStorageSync(KEY) !== this.data.crewId) {
      this.generation++; this.setInvitation(null)
      this.setData({ busy: false, loading: false, canManage: false, name: '', error: '当前队伍已变化，请返回“我的”重新打开邀请页' }); return
    }
    if (this.data.busy) return
    const token = ++this.generation
    if (!this.current(token)) {
      this.setInvitation(null); this.setData({ loading: false, error: '当前队伍已变化，请返回“我的”重新打开邀请页' }); return
    }
    this.setData({ busy: true, loading: true, error: '' })
    try {
      await this.call('user.login', {})
      if (!this.current(token)) return
      const data = await this.call(this.data.managing ? 'crew.inviteGet' : 'crew.invitePreview',
        this.data.managing ? { crewId: this.data.crewId } : { token: this.data.token })
      if (!this.current(token)) return
      if (this.data.managing) {
        this.setInvitation(data.invitation)
        this.setData({ name: data.name, canManage: data.canManage })
      } else this.setData({ preview: data, name: data.name, expiresLabel: new Date(data.expiresAt).toLocaleString() })
    } catch (e) {
      if (this.current(token)) { this.setInvitation(null); this.setData({ preview: null, error: e.message }) }
    } finally { if (this.current(token)) this.setData({ busy: false, loading: false }) }
  },
  async changeInvitation(event) {
    if (this.data.busy || !this.data.canManage) return
    const refresh = Boolean(event && event.currentTarget && event.currentTarget.dataset.refresh)
    const token = ++this.generation, previous = this.data.invitation
    if (!this.current(token)) return
    this.setData({ busy: true, error: '', message: '' })
    try {
      if (refresh) {
        const choice = await wxCall('showModal', { title: '更新邀请？', content: '旧邀请卡和小程序码将失效，请将新邀请发给同伴。已加入的成员不受影响。', confirmText: '确认更新' })
        if (!this.current(token) || !choice.confirm) return
      }
      const data = await this.call('crew.inviteCreate', { crewId: this.data.crewId, refresh,
        ...(refresh && previous ? { previousToken: previous.token } : {}) })
      if (!this.current(token)) return
      this.setInvitation(data.invitation)
      this.setData({ message: '邀请已准备好，可发送给同伴或生成小程序码。' })
    } catch (e) { if (this.current(token)) { this.setInvitation(null); this.setData({ error: e.message }) } }
    finally { if (this.current(token)) this.setData({ busy: false }) }
  },
  async revoke() {
    if (this.data.busy || !this.data.canManage || !this.data.invitation) return
    const token = ++this.generation, invitation = this.data.invitation
    if (!this.current(token)) return
    this.setData({ busy: true, error: '' })
    try {
      const choice = await wxCall('showModal', { title: '撤销邀请？', content: '该邀请卡和小程序码将不能再用于入队，已加入的成员不受影响。', confirmText: '确认撤销' })
      if (!this.current(token) || !choice.confirm) return
      await this.call('crew.inviteRevoke', { crewId: this.data.crewId, token: invitation.token })
      if (this.current(token)) { this.setInvitation(null); this.setData({ message: '邀请已撤销，可以重新创建。' }) }
    } catch (e) { if (this.current(token)) { this.setInvitation(null); this.setData({ error: e.message }) } }
    finally { if (this.current(token)) this.setData({ busy: false }) }
  },
  async generateQr() {
    const invitation = this.data.invitation
    if (this.data.busy || !invitation) return
    const token = ++this.generation
    if (!this.current(token)) return
    this.setData({ busy: true, error: '' }); this.deleteQr()
    let path = ''
    try {
      const data = await this.call('crew.inviteQr', { crewId: this.data.crewId, token: invitation.token })
      if (!this.current(token)) return
      if (typeof data.imageBase64 !== 'string' || data.imageBase64.length > 1398104 || !['image/png', 'image/jpeg'].includes(data.contentType)) throw new Error('小程序码图片异常，请重新生成')
      path = wx.env.USER_DATA_PATH + '/invite-' + Date.now() + '-' + token + (data.contentType === 'image/png' ? '.png' : '.jpg')
      await new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath: path, data: data.imageBase64, encoding: 'base64', success: resolve, fail: reject }))
      if (!this.current(token)) { try { wx.getFileSystemManager().unlink({ filePath: path, success() {}, fail() {} }) } catch (_) {}; return }
      this.setData({ qrPath: path })
    } catch (e) {
      if (path) { try { wx.getFileSystemManager().unlink({ filePath: path, success() {}, fail() {} }) } catch (_) {} }
      if (this.current(token)) { if (['NOT_FOUND', 'FORBIDDEN_NOT_MEMBER'].includes(e.code)) this.setInvitation(null); this.setData({ error: e.message || '生成失败，请重试' }) }
    }
    finally { if (this.current(token)) this.setData({ busy: false }) }
  },
  async saveQr() {
    if (this.data.busy || !this.data.qrPath) return
    const token = ++this.generation
    if (!this.current(token)) return
    this.previewing = true; this.setData({ busy: true, error: '' })
    try { await wxCall('saveImageToPhotosAlbum', { filePath: this.data.qrPath }); if (this.current(token)) this.setData({ message: '已保存小程序码，可发送给同伴。' }) }
    catch (_) { if (this.current(token)) this.setData({ error: '未能保存相册，可检查相册权限后重试' }) }
    finally { this.previewing = false; if (this.current(token)) this.setData({ busy: false }) }
  },
  async join() {
    if (this.data.busy || !this.data.preview) return
    if (this.data.joinedCrewId) return this.openTeam().catch(e => this.setData({ error: e.message }))
    const token = ++this.generation
    this.setData({ busy: true, error: '' })
    try {
      const data = await this.call('crew.inviteJoin', { token: this.data.token })
      if (!this.current(token)) return
      this.setData({ joinedCrewId: data.crewId })
      wx.setStorageSync(KEY, data.crewId)
      await this.openTeam()
    } catch (e) { if (this.current(token)) this.setData({ error: e.message || '加入失败，请重试' }) }
    finally { if (this.current(token)) this.setData({ busy: false }) }
  },
  async openTeam() {
    try {
      if (this.data.joinedCrewId) wx.setStorageSync(KEY, this.data.joinedCrewId)
      await wxCall('switchTab', { url: '/pages/map/index' })
    } catch (_) { throw new Error('已加入小队，打开队伍页失败，请点击“打开队伍”重试') }
  },
  onShareAppMessage() {
    const invitation = this.data.invitation
    if (this.data.managing && invitation && this.current(this.generation) && new Date(invitation.expiresAt).getTime() > Date.now() + (this.serverOffset || 0)) {
      return { title: '邀请你加入「' + this.data.name + '」，一起游览', path: invitation.path }
    }
    return { title: '智游·灵动，一起游览', path: '/pages/trip/index' }
  },
  home() { wx.switchTab({ url: '/pages/profile/index' }) },
})

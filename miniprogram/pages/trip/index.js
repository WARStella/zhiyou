/**
 * 行程页面 —— 计划书 §5.1。
 *
 * 节点展示要求（§5.1）：
 *   地点与预计到达时间 · 建议停留时间 · 前往下一站的预计时间 ·
 *   已完成/当前/待游览状态 · **与计划相比发生的变化**
 *
 * 调整候选的展示规则（§5.2）—— **两条是展示上限，不是必须凑齐的配额**：
 *   两条不同可行方案 → 展示差异与取舍
 *   两种策略结论一致 → **合并为一条**，说明结论一致
 *   只有一条可行方案 → 展示一条，并说明限制条件
 *   没有可行方案     → **指出冲突所在，请用户选择调整哪个条件**
 *
 * ⚠️ 本页当前是**手动模式**：从地点列表勾选生成路线。
 * 10/15 之后 AI 解析接进来时，只需把"勾选地点"换成"说一句话"，
 * 调用的接口完全不变（`req.submit` → `trip.plan`）。
 * 这也是计划书 §十 的 P0／P1 分界所在。
 */

const api = require('../../utils/api')

const STATUS_LABEL = {
  pending: '待游览',
  arrived: '已到达',
  done: '已完成',
  skipped: '已跳过',
}

/** 快捷调整操作（§5.1：提供"多停留一会儿""跳过下一站"等快捷操作） */
const QUICK_ACTIONS = [
  { key: 'extend', label: '多停 10 分钟' },
  { key: 'shorten', label: '少停 10 分钟' },
  { key: 'skip', label: '跳过这一站' },
]

function hhmm(value) {
  if (!value) return '--:--'
  const d = new Date(value)
  if (isNaN(d.getTime())) return '--:--'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function nowTimeText() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

Page({
  data: {
    // ── 输入 ──
    places: [],
    selectedIds: [],
    startAtText: '',
    startAt: '',

    // ── 行程 ──
    trip: null,
    timeline: [],
    summary: null,
    currentNodeIndex: 0,

    // ── 调整候选 ──
    proposal: null,
    proposalMode: null, // two | merged | single | none
    proposalNote: '',
    candidates: [],

    // ── 状态 ──
    loading: false,
    busy: '',
    error: '',
    note: '',
    unverifiedNotice: null,
    actions: QUICK_ACTIONS,
  },

  onLoad() {
    const t = nowTimeText()
    const d = new Date()
    const [hh, mm] = t.split(':')
    d.setHours(Number(hh), Number(mm), 0, 0)

    this.setData({ startAtText: t, startAt: d.toISOString() })
    this.loadPlaces()
  },

  loadPlaces() {
    const that = this
    this.setData({ loading: true, error: '' })
    api
      .callApi('place.list', {})
      .then(function (res) {
        if (!res || res.ok !== true) {
          that.setData({ loading: false, error: (res && res.error && res.error.message) || '地点加载失败' })
          return
        }
        const places = (res.data.places || []).map(function (p) {
          return {
            placeId: p.placeId,
            name: p.name,
            category: p.category,
            // 准入按用途分级（见 lib/authz.js）：能游览 ≠ 能集合
            tripNodeAllowed: p.tripNodeAllowed,
            meetingPointAllowed: p.meetingPointAllowed,
            verified: p.verified,
            dataSource: p.dataSource,
            selected: false,
            order: 0,
          }
        })
        that.setData({ places, loading: false })
      })
      .catch(function (err) {
        that.setData({ loading: false, error: (err && err.errMsg) || '地点加载失败' })
      })
  },

  onStartTimeChange(e) {
    const t = e.detail.value
    const d = new Date()
    const [hh, mm] = t.split(':')
    d.setHours(Number(hh), Number(mm), 0, 0)
    this.setData({ startAtText: t, startAt: d.toISOString() })
  },

  /** 勾选地点。勾选顺序即游览顺序 —— 界面上用序号体现 */
  togglePlace(e) {
    const id = e.currentTarget.dataset.id
    const places = this.data.places.map((p) => Object.assign({}, p))
    const target = places.find((p) => p.placeId === id)
    if (!target) return

    target.selected = !target.selected

    // 重排序号
    let order = 0
    places.forEach((p) => {
      p.order = p.selected ? ++order : 0
    })

    this.setData({
      places,
      selectedIds: places.filter((p) => p.selected).map((p) => p.placeId),
      note: '',
    })
  },

  createTrip() {
    const that = this
    const ids = this.data.selectedIds
    if (!ids.length) return

    this.setData({ loading: true, error: '', proposal: null, note: '' })

    api
      .callApi('trip.plan', {
        placeIds: ids,
        startAt: this.data.startAt,
        constraints: [],
      })
      .then(function (res) {
        if (!res || res.ok !== true) {
          that.setData({ loading: false, error: (res && res.error && res.error.message) || '生成失败' })
          return
        }
        const d = res.data

        // 规划本身可能判定不可行 —— 这不是错误，要如实展示冲突
        if (!d.saved) {
          that.setData({
            loading: false,
            trip: null,
            error: '',
            note: '',
            conflicts: d.conflicts || [],
            planRejected: true,
            rejectReason: d.reason || '',
          })
          return
        }

        that.applyTrip(d, '路线已生成')
      })
      .catch(function (err) {
        that.setData({ loading: false, error: (err && err.errMsg) || '生成失败' })
      })
  },

  /** 用后端返回的行程数据刷新界面（生成与确认变更都走这里） */
  applyTrip(d, note) {
    const nodes = d.nodes || []
    const currentIndex = Math.max(
      0,
      nodes.findIndex((n) => n.status !== 'done' && n.status !== 'skipped')
    )

    const timeline = nodes.map((n, i) => ({
      nodeId: n.nodeId,
      seq: i + 1,
      placeName: n.placeName,
      arrive: hhmm(n.plannedArriveAt),
      leave: hhmm(n.plannedLeaveAt),
      stayMin: n.plannedStayMin,
      travelMin: n.travelFromPrevMin,
      travelMeters: n.travelFromPrevMeters,
      statusLabel: STATUS_LABEL[n.status] || n.status,
      status: n.status,
      isCurrent: i === currentIndex,
      isLast: i === nodes.length - 1,
    }))

    this.setData({
      loading: false,
      trip: d.tripId ? { tripId: d.tripId, version: d.version } : this.data.trip,
      timeline,
      currentNodeIndex: currentIndex,
      summary: d.summary || null,
      unverifiedNotice: d.unverifiedNotice || null,
      proposal: null,
      proposalMode: null,
      candidates: [],
      planRejected: false,
      note: note || '',
      error: '',
    })
  },

  /** 快捷调整：生成候选（**不直接改行程** —— 生效必须走确认） */
  nodeAction(e) {
    const that = this
    const { nodeid: nodeId, key } = e.currentTarget.dataset
    if (!this.data.trip) return

    const trigger =
      key === 'skip'
        ? { type: 'skip_node', payload: { nodeId } }
        : {
            type: key === 'extend' ? 'extend_stay' : 'shorten_stay',
            payload: { nodeId, deltaMin: 10 },
          }

    this.setData({ busy: 'adjust', error: '' })

    api
      .callApi('trip.adjust', { tripId: this.data.trip.tripId, trigger })
      .then(function (res) {
        if (!res || res.ok !== true) {
          that.setData({ busy: '', error: (res && res.error && res.error.message) || '调整失败' })
          return
        }
        that.applyProposal(res.data)
      })
      .catch(function (err) {
        that.setData({ busy: '', error: (err && err.errMsg) || '调整失败' })
      })
  },

  /**
   * 按 §5.2 的四种情况决定展示方式。
   * **不凑数**：可行候选只有一条就显示一条；两种策略结论一致就合并说明。
   */
  applyProposal(d) {
    const candidates = d.candidates || []
    const feasible = candidates.filter((c) => c.feasible)
    const merged = (d.excludedReasons || []).some((r) => r.reason === 'DUPLICATE')

    let mode = 'none'
    let note = ''

    if (feasible.length >= 2) {
      mode = 'two'
      note = '两条方案各有取舍，请选择'
    } else if (feasible.length === 1 && merged) {
      mode = 'merged'
      note = '两种策略得到同一方案，已合并展示'
    } else if (feasible.length === 1) {
      mode = 'single'
      note = '当前条件下只有一条可行方案'
    } else {
      mode = 'none'
      note = '没有可行的调整方案，请选择要放宽的条件'
    }

    this.setData({
      busy: '',
      proposal: { proposalId: d.proposalId, baseVersion: d.baseVersion },
      proposalMode: mode,
      proposalNote: note,
      candidates: candidates.map((c) => ({
        candidateId: c.candidateId,
        label: c.strategyLabel,
        feasible: c.feasible,
        changes: (c.notes || []).map((n) => n.message),
        conflicts: (c.conflicts || []).map((x) => x.message),
        preserved: c.impact ? c.impact.preservedNodeCount : null,
        nodeCount: (c.nodes || []).length,
        endAt: c.impact ? hhmm(c.impact.changedEndAt) : '--:--',
        endShiftMin: c.impact ? c.impact.endShiftMin : null,
        walkDelta: c.impact ? c.impact.addedWalkMin : null,
        qualityOk: c.quality ? c.quality.meetsBasicQuality : true,
      })),
      error: '',
    })
  },

  discardProposal() {
    this.setData({ proposal: null, proposalMode: null, candidates: [], note: '已放弃本次调整' })
  },

  confirmCandidate(e) {
    const that = this
    const candidateId = e.currentTarget.dataset.cid
    const proposal = this.data.proposal
    if (!proposal) return

    this.setData({ busy: 'confirm', error: '' })

    api
      .callApi('trip.confirmChange', { proposalId: proposal.proposalId, candidateId })
      .then(function (res) {
        if (!res || res.ok !== true) {
          const e2 = res && res.error
          // 版本冲突是预期内的正常结果（§8.1 旧确认不得生效），要给出可执行的提示
          const hint =
            e2 && e2.code === 'VERSION_CONFLICT'
              ? '行程已被更新，该确认已失效，请重新调整'
              : (e2 && e2.message) || '确认失败'
          that.setData({ busy: '', error: hint })
          return
        }
        that.applyTrip(res.data, '已确认调整并生效')
      })
      .catch(function (err) {
        that.setData({ busy: '', error: (err && err.errMsg) || '确认失败' })
      })
  },

  resetTrip() {
    this.setData({
      trip: null,
      timeline: [],
      summary: null,
      unverifiedNotice: null,
      proposal: null,
      proposalMode: null,
      candidates: [],
      planRejected: false,
      note: '已返回地点选择',
    })
  },
})

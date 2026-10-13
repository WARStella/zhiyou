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
 * ── 输入方式（2026-10-13 补）──────────────────────────────
 * 本页是**手动模式**：搜索/浏览地点 → 勾选 → 生成路线 → 快捷调整。
 *
 * 10/15 之后 AI 解析接进来时，只需把"输入关键词"换成"说一句话"，
 * 调用的接口完全不变（`place.search` / `trip.plan` / `trip.adjust`）。
 * 这也是计划书 §十 的 P0／P1 分界所在。
 */

const api = require('../../utils/api')

const STATUS_LABEL = {
  pending: '待游览',
  arrived: '已到达',
  done: '已完成',
  skipped: '已跳过',
}

function hhmm(value) {
  if (!value) return '--:--'
  const d = new Date(value)
  if (isNaN(d.getTime())) return '--:--'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function timeText(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 把 HH:mm 落到今天的时间点 */
function todayAt(text) {
  const d = new Date()
  const [hh, mm] = text.split(':')
  d.setHours(Number(hh), Number(mm), 0, 0)
  return d
}

Page({
  data: {
    // ── 需求输入 ──
    keyword: '',
    /** 意图解析结果（解释 + 待确认项）—— 界面要让人看见"系统理解成了什么" */
    intent: null,
    startAtText: '',
    startAt: '',
    endAtText: '',
    endAt: '', // 空字符串 = 不限
    /** 结束时间是从解析结果填进来的（不是用户手选的）—— 要标明 */
    endAtFromParse: false,
    enrichWalk: false,

    // ── 候选（搜索结果或已知地点）──
    mode: 'browse', // browse | search
    candidates: [],
    rankingNote: '',
    locating: false,

    // ── 已选（勾选顺序即游览顺序）──
    selected: [],

    // ── 行程 ──
    trip: null,
    timeline: [],
    summary: null,
    routeMap: null,
    walkTimes: null,
    startPoint: null,
    startLeg: null,
    currentNodeIndex: 0,
    unverifiedNotice: null,

    // ── 调整候选 ──
    proposal: null,
    proposalMode: null,
    proposalNote: '',
    proposalCandidates: [],

    // ── 状态 ──
    loading: false,
    busy: '',
    error: '',
    note: '',
    conflicts: [],
    planRejected: false,
  },

  onLoad() {
    const now = new Date()
    this.setData({ startAtText: timeText(now), startAt: now.toISOString() })
    this.loadKnown()
  },

  // ══════════ 候选来源 ══════════

  /** 浏览模式：列出已知地点（含踏勘核验过的） */
  loadKnown() {
    const that = this
    this.setData({ loading: true, error: '' })
    api
      .callApi('place.list', {})
      .then(function (res) {
        if (!res || res.ok !== true) {
          that.setData({ loading: false, error: (res && res.error && res.error.message) || '地点加载失败' })
          return
        }
        that.setCandidates(
          (res.data.places || []).map(function (p) {
            return {
              placeId: p.placeId,
              name: p.name,
              category: p.category,
              verified: p.verified,
              tripNodeAllowed: p.tripNodeAllowed,
              meetingPointAllowed: p.meetingPointAllowed,
              distanceText: '',
              durationText: '',
            }
          }),
          'browse',
          ''
        )
        that.setData({ loading: false })
      })
      .catch(function (err) {
        that.setData({ loading: false, error: (err && err.errMsg) || '地点加载失败' })
      })
  },

  /**
   * 尝试取当前位置，用于按"离我多远"排序。
   * **失败不阻断搜索** —— 退回后端默认中心（哈尔滨），并在界面上说明。
   */
  tryLocate() {
    return new Promise(function (resolve) {
      wx.getLocation({
        type: 'gcj02',
        isHighAccuracy: true,
        highAccuracyExpireTime: 4000,
        success: function (res) {
          resolve({ latitude: res.latitude, longitude: res.longitude })
        },
        fail: function () {
          resolve(null)
        },
      })
    })
  },

  // ══════════ 需求输入 ══════════

  onKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },

  onEnrichChange(e) {
    this.setData({ enrichWalk: e.detail.value })
  },

  /**
   * 统一的输入入口：**先理解意图，再检索地点**。
   *
   * 这样用户既可以输入一句话（"我下午想去中央大街附近逛逛，五点前结束"），
   * 也可以只输入一个词（"教堂"）—— 后者会被识别成类别词，效果与普通搜索一致。
   *
   * 解析出来的约束**不会自动生效**：明确的才填进表单，含糊的进 uncertainties
   * 让用户选（§6.2）。
   */
  doSearch() {
    const that = this
    const text = (this.data.keyword || '').trim()
    if (!text) {
      this.setData({ note: '请输入一句话，或一个地点名称' })
      return
    }

    this.setData({ loading: true, error: '', note: '正在理解你的需求…', intent: null })

    api
      .callApi('intent.parse', { text: text })
      .then(function (res) {
        const d = res && res.ok === true ? res.data : null

        // 解析失败不阻断：退化成"直接当地点搜"，并说明发生了什么
        if (!d || d.ok !== true) {
          that.setData({
            intent: null,
            note: '需求理解不可用（' + ((d && d.message) || '未知原因') + '），已按地点名称直接搜索',
          })
          return that.runPlaceSearch(text)
        }

        const patch = {
          intent: {
            parserLabel:
              d.parser === 'http'
                ? '模型理解' + (d.model ? '（' + d.model + '）' : '')
                : '规则理解',
            degraded: d.degraded === true,
            /**
             * 降级提示的措辞要**准确而不吓人**：
             * 没配模型不是故障，规则解析同样是设计内的正式路径（§6.5）。
             * 说成"模型不可用"会让人以为系统坏了。
             */
            degradationNote:
              d.degraded === true && d.attempts && d.attempts.length
                ? '未配置大模型，当前用规则解析（结果可复现，功能完整）'
                : '',
            explanation: d.explanation || [],
            uncertainties: d.uncertainties || [],
            searchKeyword: d.searchKeyword || null,
          },
        }

        // 解析出的结束时间填进表单 —— 但要让用户看得见它是解析来的
        if (d.structured && d.structured.endAt) {
          const end = new Date(d.structured.endAt)
          patch.endAtText = timeText(end)
          patch.endAt = end.toISOString()
          patch.endAtFromParse = true
        }

        that.setData(patch)

        const kw = d.searchKeyword
        if (!kw) {
          that.setData({
            loading: false,
            note: '没能从这句话里认出要去的地方，请补充一个地名，或直接输入地点名称',
          })
          return null
        }
        return that.runPlaceSearch(kw)
      })
      .catch(function (err) {
        that.setData({ note: '理解失败，已按地点名称直接搜索' })
        that.runPlaceSearch(text)
        if (err && err.errMsg) console.warn(err)
      })
  },

  /** 用关键词检索外部地点（原来的搜索逻辑） */
  runPlaceSearch(keyword) {
    const that = this
    this.setData({ loading: true, error: '' })

    return this.tryLocate().then(function (center) {
      return api
        .callApi('place.search', {
          keyword: keyword,
          center: center || undefined,
          radius: 5000,
          enrichWalk: that.data.enrichWalk,
        })
        .then(function (res) {
          if (!res || res.ok !== true) {
            that.setData({ loading: false, error: (res && res.error && res.error.message) || '搜索失败' })
            return
          }
          const d = res.data
          if (d.ok === false) {
            // 上游失败（缺 Key、配额、范围）—— 如实展示，不用缓存或估算冒充
            that.setData({
              loading: false,
              error: d.message || '检索失败',
              note: d.hint || '',
              candidates: [],
            })
            return
          }

          that.setCandidates(
            (d.candidates || []).map(function (c) {
              return {
                placeId: c.placeId,
                name: c.name,
                category: c.category,
                verified: c.verified,
                tripNodeAllowed: c.placeId ? true : false,
                meetingPointAllowed: false,
                distanceText:
                  typeof c.straightLineMeters === 'number' ? `直线 ${c.straightLineMeters} 米` : '',
                durationText:
                  typeof c.walkMinutes === 'number'
                    ? `步行 ${c.walkMinutes} 分钟`
                    : c.walkSource === 'unavailable'
                      ? '步行时间未取到'
                      : '',
              }
            }),
            'search',
            d.ranking ? d.ranking.note : ''
          )
          that.setData({
            loading: false,
            note:
              center || that.data.intent
                ? ''
                : '未取得当前位置，按默认中心（哈尔滨）排序',
          })
        })
        .catch(function (err) {
          that.setData({ loading: false, error: (err && err.errMsg) || '搜索失败' })
        })
    })
  },

  /** 用户点了待确认项的某个候选（§6.2：提供选项，而不是替他决定） */
  pickUncertainty(e) {
    const { field, value } = e.currentTarget.dataset
    if (field !== 'endAt') return
    const d = todayAt(value)
    this.setData({
      endAtText: value,
      endAt: d.toISOString(),
      endAtFromParse: false,
      note: '已按你的选择设定结束时间 ' + value,
    })
  },

  /** 写入候选列表，并同步已选状态 */
  setCandidates(list, mode, rankingNote) {
    const selectedIds = this.data.selected.map((x) => x.placeId)
    const marked = list.map((x) =>
      Object.assign({}, x, { selected: selectedIds.indexOf(x.placeId) >= 0 })
    )
    this.setData({ candidates: marked, mode: mode, rankingNote: rankingNote || '' })
  },

  // ══════════ 选择 ══════════

  /** 点候选项：加入 / 移出已选。**勾选顺序即游览顺序。** */
  toggleCandidate(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.candidates.find((x) => x.placeId === id)
    if (!item) return

    if (!item.tripNodeAllowed) {
      this.setData({ note: '该地点缺少坐标，无法计算步行时间，不能安排进路线' })
      return
    }

    let selected = this.data.selected.slice()
    const at = selected.findIndex((x) => x.placeId === id)

    if (at >= 0) {
      selected.splice(at, 1)
    } else {
      selected.push({
        placeId: item.placeId,
        name: item.name,
        category: item.category,
        verified: item.verified,
      })
    }

    const selectedIds = selected.map((x) => x.placeId)
    this.setData({
      selected: selected,
      note: '',
      candidates: this.data.candidates.map((x) =>
        Object.assign({}, x, { selected: selectedIds.indexOf(x.placeId) >= 0 })
      ),
    })
  },

  removeSelected(e) {
    const id = e.currentTarget.dataset.id
    const selected = this.data.selected.filter((x) => x.placeId !== id)
    const selectedIds = selected.map((x) => x.placeId)
    this.setData({
      selected: selected,
      candidates: this.data.candidates.map((x) =>
        Object.assign({}, x, { selected: selectedIds.indexOf(x.placeId) >= 0 })
      ),
    })
  },

  // ══════════ 需求条件 ══════════

  onStartTimeChange(e) {
    this.setData({ startAtText: e.detail.value, startAt: todayAt(e.detail.value).toISOString() })
  },

  onEndTimeChange(e) {
    this.setData({ endAtText: e.detail.value, endAt: todayAt(e.detail.value).toISOString() })
  },

  clearEndAt() {
    this.setData({ endAtText: '', endAt: '' })
  },

  /**
   * 组装约束。
   *
   * ⚠️ `confirmedAt` 必须给值 —— 服务端只把"已确认的硬约束"计入可行性判定
   * （§6.2）。用户在界面上明确设了结束时间，就是一次确认。
   * 少了这个字段，约束会被静默忽略，规划器永远返回"可行"。
   */
  buildConstraints() {
    if (!this.data.endAt) return []
    return [
      {
        key: 'endAt',
        value: this.data.endAt,
        hardness: 'hard',
        confirmedAt: new Date().toISOString(),
        confirmedBy: 'user',
      },
    ]
  },

  // ══════════ 行程 ══════════

  createTrip() {
    const that = this
    const ids = this.data.selected.map((x) => x.placeId)
    if (!ids.length) return

    this.setData({ loading: true, error: '', note: '正在定位出发位置…', proposal: null, planRejected: false })

    // 行程默认从**当前位置**出发。
    // 不给起点的话，行程会假装人已经在第一个景点门口 ——
    // 计划出发时间、总步行量与"能不能赶上结束时间"都会偏乐观。
    this.tryLocate().then(function (startPoint) {
      that.setData({
        note: startPoint ? '' : '未取得当前位置，行程将从第一个地点开始计时（总时间会偏乐观）',
      })

      api
        .callApi('trip.plan', {
          placeIds: ids,
          startAt: that.data.startAt,
          constraints: that.buildConstraints(),
          startPoint: startPoint || undefined,
        })
        .then(function (res) {
          if (!res || res.ok !== true) {
            that.setData({ loading: false, error: (res && res.error && res.error.message) || '生成失败' })
            return
          }
          const d = res.data

          // 规划判定不可行 —— 这不是错误，要如实展示冲突（§5.2 最后一行）
          if (!d.saved) {
            that.setData({
              loading: false,
              trip: null,
              error: '',
              planRejected: true,
              conflicts: (d.conflicts || []).map((c) => c.message),
              note: '当前条件下无法生成路线',
            })
            return
          }

          that.applyTrip(d, '路线已生成')
        })
        .catch(function (err) {
          that.setData({ loading: false, error: (err && err.errMsg) || '生成失败' })
        })
    })
  },

  /** 用后端返回的行程刷新界面（生成与确认变更都走这里） */
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
      // 出行方式：首版只有步行，但字段已经下发 —— 显式标出来，
      // 而不是让用户从"约 8 分钟"里猜这是走路还是坐车
      travelModeLabel: n.travelMode === 'walking' ? '步行' : '',
      travelFromStart: n.travelFromStart === true,
      // 只有"直线估算"需要提醒 —— 它与真实路线在短距离下能差 7 倍
      travelWarn: n.travelSource === 'estimated' ? '（估算）' : '',
      verified: n.verified,
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
      // ⚠️ 后端给的是 ISO 字符串，这里必须格式化 —— 否则界面会显示
      //    「预计结束 2026-10-14T03:37:41.233Z」这种没法看的东西
      summary: d.summary
        ? {
            nodeCount: timeline.length,
            endAt: hhmm(d.summary.endAt),
            totalWalkMin: d.summary.totalWalkMin,
            totalStayMin: d.summary.totalStayMin,
            totalWalkMeters: d.summary.totalWalkMeters,
          }
        : null,
      routeMap: this.buildRouteMap(nodes, d.startPoint),
      walkTimes: d.walkTimes || null,
      startPoint: d.startPoint || null,
      startLeg: d.startLeg
        ? {
            label: (d.startPoint && d.startPoint.label) || '我的位置',
            minutes: d.startLeg.minutes,
            meters: d.startLeg.meters,
            warn: d.startLeg.source === 'estimated' ? '（估算）' : '',
            toName: d.startLeg.toPlaceName,
          }
        : null,
      unverifiedNotice: d.unverifiedNotice || null,
      warnings: d.warnings || [],
      proposal: null,
      proposalMode: null,
      proposalCandidates: [],
      planRejected: false,
      note: note || '',
      error: '',
    })
  },

  /**
   * 把节点连成一条线，画在地图上。
   *
   * ⚠️ 这是**游览顺序连线**，不是逐段真实步行路径。
   *
   * 腾讯步行路线接口返回的 `polyline` 是**差分压缩格式**：
   * 首对是绝对坐标，其后每对是相对前一点的增量。解码规则需以官方文档为准，
   * **不靠观察猜**（工作日志里记了这件事）。顺序连线已经能表达
   * "去哪几个地方、什么顺序、大概什么走向"，而真实路径留到有余力时再做。
   */
  buildRouteMap(nodes, startPoint) {
    const nodePts = nodes
      .map((n) => n.location)
      .filter((p) => p && typeof p.latitude === 'number' && typeof p.longitude === 'number')
    if (nodePts.length < 2) return null

    const startPt = startPoint && typeof startPoint.latitude === 'number' ? startPoint : null

    // 有出发位置就把它接到线头上 —— 这样地图上看到的是
    // 「我的位置 → 第一站 → 第二站 …」，而不是从第一个景点凭空开始
    const all = startPt ? [startPt].concat(nodePts) : nodePts
    const points = all.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))

    const markers = nodes
      .filter((n) => n.location)
      .map((n, i) => ({
        id: i + 1,
        latitude: n.location.latitude,
        longitude: n.location.longitude,
        iconPath: '/assets/pin-place.png',
        width: 28,
        height: 35,
        // 序号与下方时间轴一一对应
        callout: {
          content: String(i + 1),
          color: '#FFFFFF',
          bgColor: n.verified ? '#0B3C6E' : '#9AA5B1',
          fontSize: 11,
          borderRadius: 10,
          padding: 5,
          display: 'ALWAYS',
          textAlign: 'center',
        },
      }))

    if (startPt) {
      markers.unshift({
        id: 0,
        latitude: startPt.latitude,
        longitude: startPt.longitude,
        iconPath: '/assets/dot-me.png',
        width: 22,
        height: 22,
        callout: {
          content: '我',
          color: '#FFFFFF',
          bgColor: '#FF7A45',
          fontSize: 11,
          borderRadius: 10,
          padding: 4,
          display: 'ALWAYS',
          textAlign: 'center',
        },
      })
    }

    return {
      center: points[0],
      includePoints: points,
      polyline: [
        {
          points: points,
          color: '#0B3C6E',
          width: 4,
          arrowLine: true,
          borderColor: '#FFFFFF',
          borderWidth: 2,
        },
      ],
      markers: markers,
      note: '连线为游览顺序示意，不是逐段真实步行路径',
    }
  },

  // ══════════ 调整 ══════════

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
      .callApi('trip.adjust', {
        tripId: this.data.trip.tripId,
        expectedVersion: this.data.trip.version,
        trigger,
      })
      .then(function (res) {
        if (!res || res.ok !== true) {
          that.setData({ busy: '', error: (res && res.error && res.error.message) || '调整失败' })
          return
        }
        const d = res.data
        /**
         * 没有取舍时后端**已经直接生效**了 —— 不必再让用户点一次确认。
         * 只有出现取舍（需要压缩或删除某个节点）时才弹候选卡片，
         * 因为那才是真正需要用户判断的地方。
         */
        if (d.applied) {
          that.applyTrip(d, d.note || '调整已生效')
          return
        }
        that.applyProposal(d)
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
      proposalCandidates: candidates.map((c) => ({
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
    this.setData({
      proposal: null,
      proposalMode: null,
      proposalCandidates: [],
      note: '已放弃本次调整',
    })
  },

  confirmCandidate(e) {
    const that = this
    const candidateId = e.currentTarget.dataset.cid
    const proposal = this.data.proposal
    if (!proposal) return

    this.setData({ busy: 'confirm', error: '' })

    api
      .callApi('trip.confirmChange', {
        proposalId: proposal.proposalId,
        candidateId,
        expectedVersion: proposal.baseVersion,
      })
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
      warnings: [],
      proposal: null,
      proposalMode: null,
      proposalCandidates: [],
      planRejected: false,
      conflicts: [],
      note: '已返回地点选择',
    })
  },
})

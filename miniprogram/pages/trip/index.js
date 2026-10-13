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

/**
 * 进度操作 —— **记录事实**，不重新规划。
 *
 * 与 `多停/少停/不去了` 那组（走 trip.adjust，会重新规划行程）是两回事：
 *   · 进度：我到了 / 我逛完了 / 我其实没去   → 记录实际发生的事
 *   · 调整：多待一会儿 / 不去了             → 改计划，要重算后续
 *
 * 混在一起会让人以为"标记已到达"也会改路线 —— 那是两件不同的事。
 */
/**
 * 「到过」= 真的去过。`skipped` **不算** —— 跳过就是没去。
 *
 * ⚠️ 这个区分踩过两次坑，都记在这里：
 *   ① 地图上把 skipped 也算成走过，绿线会画到一个没去过的地方；
 *   ② 时间轴上用"**本节点**走完了"来判定"**本节点→下一节点**这段走过了" ——
 *      **位置反了**。点完 1 号的「逛完了」，你还没走到 2 号，那一段当然没走过。
 *      正确判据是**下一站到了没有**：到了下一站，才说明这一段走完了。
 */
const isReached = (status) => status === 'arrived' || status === 'done'

const PROGRESS_ACTIONS = {
  pending: [{ status: 'arrived', label: '到了' }],
  arrived: [{ status: 'done', label: '逛完了' }],
  // 允许撤销：点错了要能改回来，否则只能重新生成行程
  done: [{ status: 'pending', label: '撤销' }],
  skipped: [{ status: 'pending', label: '撤销' }],
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
    /**
     * 出发时间是否是用户（或解析结果）明确指定的。
     *
     * ⚠️ 实测踩到的坑：`onLoad` 把出发时间设成"页面打开的那一刻"，
     * 用户如果在页面上停留了十几分钟再生成路线，**行程会从过去开始算** ——
     * 到达时间比当前时间还早。
     * 所以：没人手动指定时，生成路线的那一刻重新取"现在"。
     */
    startAtManual: false,
    /** 「逛一小时」→ 60；null 表示用地点自带默认值 */
    stayMin: null,
    /** 每个地点时长不同时按地点给：{"哈工大": 60, "冰雪大世界": 120} */
    stayByText: null,
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
    /** 后端原样的节点数组 —— 记录进度后要拿它重建界面 */
    rawNodes: [],
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

        // 解析出的时间填进表单 —— 但要让用户看得见它是解析来的
        patch.startAtManual = false
        if (d.structured && d.structured.startAt) {
          const st = new Date(d.structured.startAt)
          patch.startAtText = timeText(st)
          patch.startAt = st.toISOString()
          patch.startAtManual = true
        }
        if (d.structured && d.structured.endAt) {
          const end = new Date(d.structured.endAt)
          patch.endAtText = timeText(end)
          patch.endAt = end.toISOString()
          patch.endAtFromParse = true
        }
        // 「逛一小时」→ 每站停留 60 分钟（不给则用地点自带默认值）
        patch.stayMin = (d.structured && d.structured.stayMin) || null
        /**
         * 每个地点时长不同时按地点给：`{"哈工大": 60, "冰雪大世界": 120}`。
         * 规划器按地点名匹配，匹配不上才回落到 stayMin。
         */
        patch.stayByText = (d.structured && d.structured.stayByText) || null

        that.setData(patch)

        const kw = d.searchKeyword
        /**
         * ⚠️ **多关键词检索**（2026-10-13 实测修正）。
         *
         * 用户说「先去哈工大玩一小时再去冰雪大世界玩3小时」，
         * 而首版只拿 `searchKeyword` 一个词去搜 —— 冰雪大世界根本没进候选，
         * 用户看到的全是哈工大的各种门。
         *
         * **用户说了几个地方，就要搜几次。**
         */
        const kws = (d.searchKeywords || []).length ? d.searchKeywords : kw ? [kw] : []
        if (!kws.length) {
          that.setData({
            loading: false,
            note: '没能从这句话里认出要去的地方，请补充一个地名，或直接输入地点名称',
          })
          return null
        }
        // 传 d 进去 → 检索完会**自动预选**，用户可以直接生成路线
        return that.runPlaceSearch(kws, d)
      })
      .catch(function (err) {
        that.setData({ note: '理解失败，已按地点名称直接搜索' })
        that.runPlaceSearch(text)
        if (err && err.errMsg) console.warn(err)
      })
  },

  /**
   * 按解析出的需求**预选**地点。
   *
   * ⚠️ 规则本身在**服务端**（`place.search` 的 `autoPick`），不在这里。
   * 这里是业务规则（节奏决定选几个、必去必选、不自动选公交站），
   * 而小程序端没有测试环境 —— 规则写在这儿等于没测过。
   * 这里只负责把结果渲染出来。
   */
  applyAutoSelect(candidates, picked) {
    if (!picked || !picked.placeIds || !picked.placeIds.length) {
      this.setData({
        selected: [],
        candidates: candidates.map((x) => Object.assign({}, x, { selected: false })),
        note: (picked && picked.note) || '按你的需求没找到合适的地点，请换个说法或直接搜索',
      })
      return
    }

    const ids = picked.placeIds
    /** 预选理由 —— 直接显示在游览顺序里，用户一眼能看出"为什么是它" */
    const reasonOf = {}
    ;(picked.items || []).forEach(function (x) {
      reasonOf[x.placeId] = x.reason
    })

    const selected = candidates
      .filter((x) => ids.indexOf(x.placeId) >= 0)
      .map((x) => ({
        placeId: x.placeId,
        name: x.name,
        category: x.category,
        verified: x.verified,
        reason: reasonOf[x.placeId] || '',
      }))

    const missingNote = (picked.keywordsMissing || []).length
      ? `；**没找到**：${picked.keywordsMissing.join('、')}`
      : ''

    this.setData({
      selected: selected,
      candidates: candidates.map((x) =>
        Object.assign({}, x, { selected: ids.indexOf(x.placeId) >= 0 })
      ),
      note: picked.note + missingNote + '。可以直接生成路线，也可以自己增减。',
    })
  },

  /** 用关键词检索外部地点。`autoFrom` 给出解析结果时，检索完会**自动预选**。 */
  runPlaceSearch(keywordOrList, autoFrom) {
    const that = this
    this.setData({ loading: true, error: '' })

    /**
     * 支持**多个**检索词。用户一次说几个地方，就搜几次 ——
     * 只发第一个词会让后面的地方完全搜不到（实测踩过）。
     */
    const keywords = (Array.isArray(keywordOrList) ? keywordOrList : [keywordOrList])
      .map((x) => String(x == null ? '' : x).trim())
      .filter(Boolean)

    return this.tryLocate().then(function (center) {
      return api
        .callApi('place.search', {
          keyword: keywords[0],
          keywords: keywords,
          center: center || undefined,
          radius: 5000,
          enrichWalk: that.data.enrichWalk,
          // 自动预选交给服务端做 —— 规则在那儿才测得到
          autoPick: autoFrom
            ? {
                pace: autoFrom.parsed && autoFrom.parsed.pace,
                mustVisitTexts: (autoFrom.parsed && autoFrom.parsed.mustVisitTexts) || [],
                // 每个检索词至少选一个 —— 用户提到的地方不该被名额挤掉
                keywords: keywords,
                /**
                 * ⚠️ 锚点决定**要不要替他补地点**：
                 *   · 有锚点（「中央大街**附近**逛逛」）→ 区域漫游 → 按节奏补足；
                 *   · 没有锚点（「先去 A 再去 B」）→ 他已经排好了 → 只选他说的。
                 * 不加这个，系统会在用户已排好的行程上多塞 8 个地方。
                 */
                anchorText: (autoFrom.parsed && autoFrom.parsed.anchorText) || null,
              }
            : undefined,
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

          const mapped = (d.candidates || []).map(function (c) {
            return {
              placeId: c.placeId,
              name: c.name,
              category: c.category,
              verified: c.verified,
              /** 交通设施等不可游览项 —— 系统不自动选它 */
              visitable: c.visitable !== false,
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
          })

          that.setCandidates(mapped, 'search', d.ranking ? d.ranking.note : '')
          that.setData({
            loading: false,
            note: center || that.data.intent ? '' : '未取得当前位置，按默认中心（哈尔滨）排序',
          })

          // 来自"理解"的检索 → 用服务端给的预选结果，让用户可以直接生成路线
          if (autoFrom) that.applyAutoSelect(mapped, d.picked)
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
    this.setData({
      startAtText: e.detail.value,
      startAt: todayAt(e.detail.value).toISOString(),
      startAtManual: true,
    })
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
      /**
       * 出发时间：用户（或解析结果）指定过就用它；否则用**此刻**。
       * 不能用 onLoad 时的那个"现在" —— 页面开着十分钟，行程就从十分钟前开始了。
       */
      const startAt = that.data.startAtManual ? that.data.startAt : new Date().toISOString()

      that.setData({
        startAt: startAt,
        startAtText: timeText(new Date(startAt)),
        note: startPoint ? '' : '未取得当前位置，行程将从第一个地点开始计时（总时间会偏乐观）',
      })

      api
        .callApi('trip.plan', {
          placeIds: ids,
          startAt: startAt,
          constraints: that.buildConstraints(),
          startPoint: startPoint || undefined,
          // 「逛一小时」→ 每站 60 分钟；null 时后端用地点自带默认值
          stayMin: that.data.stayMin || undefined,
          // 每个地点时长不同时按地点给（优先级高于 stayMin）
          stayByText: that.data.stayByText || undefined,
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

  /** 当前节点 = 第一个未走完的节点 */
  currentIndexOf(nodes) {
    const i = (nodes || []).findIndex((n) => n.status !== 'done' && n.status !== 'skipped')
    return i < 0 ? Math.max(0, (nodes || []).length - 1) : i
  },

  /**
   * 由后端节点数组构建时间轴视图。
   *
   * ⚠️ 路段的位置很要紧（2026-10-13 修正）：
   *   后端给的 `travelFromPrevMin` 是**从上一节点到本节点**的时间，
   *   首版把它渲染在**本节点的卡片里**，读起来像"到了这里之后要走 8 分钟"，
   *   而实际意思是"从上一站走过来要 8 分钟"。
   *
   *   所以这里把它挪到**两个节点之间**：`legToNext` 表示"本节点 → 下一节点"。
   *
   * 抽成独立方法是为了让"记录进度"也能重算它 —— 那条路径只回传 nodes。
   */
  buildTimelineView(nodes) {
    const currentIndex = this.currentIndexOf(nodes)
    return (nodes || []).map((n, i) => {
      const next = nodes[i + 1] || null
      const reached = isReached(n.status)
      return {
        nodeId: n.nodeId,
        seq: i + 1,
        placeName: n.placeName,
        arrive: hhmm(n.plannedArriveAt),
        leave: hhmm(n.plannedLeaveAt),
        stayMin: n.plannedStayMin,
        verified: n.verified,
        statusLabel: STATUS_LABEL[n.status] || n.status,
        status: n.status,
        /** 已到过 —— 时间轴上也变绿，与地图一致。跳过的**不算** */
        visited: reached,
        skipped: n.status === 'skipped',
        isCurrent: i === currentIndex,
        isLast: i === nodes.length - 1,
        /** 该站可做的进度操作（记录事实，不重新规划） */
        progressActions: PROGRESS_ACTIONS[n.status] || PROGRESS_ACTIONS.pending,
        /** 本节点 → 下一节点之间的出行段；末节点为 null */
        legToNext: next
          ? {
              mode: next.travelMode === 'walking' ? '步行' : '',
              minutes: next.travelFromPrevMin,
              meters: next.travelFromPrevMeters,
              // 只有"直线估算"需要提醒 —— 它与真实路线在短距离下能差 7 倍
              warn: next.travelSource === 'estimated' ? '估算' : '',
              source: next.travelSource,
              /**
               * ⚠️ 判据是**下一站到了没有**，不是"本站走完了"。
               * 点完 1 号的「逛完了」，你还没走到 2 号 —— 这一段没走过。
               * 到了 2 号（arrived/done），才说明 1→2 这段走完了。
               */
              visited: isReached(next.status),
            }
          : null,
      }
    })
  },

  /**
   * 从 `rawNodes` 重建时间轴与地图。
   *
   * `trip.progress` 只回传 nodes（不含 summary / walkTimes / startLeg），
   * 所以这里**只重算随状态变化的部分**，其余保持不动 ——
   * 否则记录一次进度会把总步行时间、出发段这些信息清掉。
   */
  rebuildFromNodes() {
    const nodes = this.data.rawNodes || []
    this.setData(
      {
        timeline: this.buildTimelineView(nodes),
        currentNodeIndex: this.currentIndexOf(nodes),
        routeMap: this.buildRouteMap(nodes, this.data.startPoint),
      },
      () => this.fitRouteMap()
    )
  },

  /** 用后端返回的行程刷新界面（生成与确认变更都走这里） */
  applyTrip(d, note) {
    const nodes = d.nodes || []
    const currentIndex = Math.max(
      0,
      nodes.findIndex((n) => n.status !== 'done' && n.status !== 'skipped')
    )

    /**
     * 时间轴数据。
     *
     * ⚠️ 路段的位置很要紧（2026-10-13 修正）：
     *   后端给的 `travelFromPrevMin` 是**从上一节点到本节点**的时间，
     *   首版把它渲染在**本节点的卡片里**，读起来像"到了这里之后要走 8 分钟"，
     *   而实际意思是"从上一站走过来要 8 分钟"。
     *
     *   所以这里把它挪到**两个节点之间**：`legToNext` 表示"本节点 → 下一节点"。
     */
    const timeline = this.buildTimelineView(nodes)

    this.setData({
      loading: false,
      trip: d.tripId ? { tripId: d.tripId, version: d.version } : this.data.trip,
      /** 保留原始节点 —— 记录进度时只回传 nodes，要拿它重建界面 */
      rawNodes: nodes,
      timeline,
      currentNodeIndex: this.currentIndexOf(nodes),
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
    }, () => {
      /**
       * setData 的回调在**渲染完成之后**触发 —— 此时地图组件才真正存在，
       * 才能对它调用 includePoints（见 fitRouteMap 的说明）。
       */
      this.fitRouteMap()
    })
  },

  /**
   * 把地图视野缩放到能容纳整条路线。
   *
   * ⚠️ 为什么要显式调用，而不是只靠 `include-points` 属性：
   *   微信 `map` 组件的 `include-points` **在首次渲染时经常不生效** ——
   *   地图会先按 `latitude`/`longitude`/`scale` 初始化，把 include-points 吃掉。
   *   属性仍然保留（它是声明式的，在部分路径下有效），
   *   但真正可靠的路径是渲染完成后调 `MapContext.includePoints()`。
   *
   * 顺带解决了 padding：属性形式没法控制留白，导致标记贴着边缘；
   * 显式调用可以给四边留出空间，序号气泡才不会被裁掉。
   */
  fitRouteMap() {
    const pts = this.data.routeMap && this.data.routeMap.includePoints
    if (!pts || !pts.length) return

    try {
      const ctx = wx.createMapContext('routeMap', this)
      ctx.includePoints({
        points: pts,
        // 上边留得更多：marker 的序号气泡画在图标上方，贴边会被裁掉
        padding: [64, 48, 48, 48],
      })
    } catch (e) {
      // 地图还没渲染出来就跳过 —— include-points 属性会兜住
      console.warn('[trip] includePoints 失败，回落到 include-points 属性', e)
    }
  },

  /**
   * 把节点连成一条线，画在地图上。
   *
   * ── 走到哪了要看得见（2026-10-13 用户要求）──────────────
   *   · **路线在游玩全程保留**，不会因为"走过了"就消失；
   *   · 已到过的部分变**绿色**（marker 与连线同时变），
   *     这样一眼能看出"还剩几站、现在在哪"；
   *   · 未走的部分是深蓝，当前站橙色。
   *
   * ⚠️ 连线是**游览顺序示意**，不是逐段真实步行路径。
   * 腾讯返回的 `polyline` 是差分压缩格式（首对绝对坐标、其后为相对增量），
   * 解码规则需以官方文档为准，不靠观察猜。
   */
  buildRouteMap(nodes, startPoint) {
    const located = (nodes || []).filter(
      (n) =>
        n.location &&
        typeof n.location.latitude === 'number' &&
        typeof n.location.longitude === 'number'
    )
    if (!located.length) return null

    const startPt = startPoint && typeof startPoint.latitude === 'number' ? startPoint : null

    /**
     * 已走过 = 最后一个**真正到过**的节点（含）之前的部分。
     * `skipped` 不算 —— 跳过就是没去，绿线不该画到那里。
     */
    let lastReachedIdx = -1
    located.forEach((n, i) => {
      if (isReached(n.status)) lastReachedIdx = i
    })
    const reachedCount = located.filter((n) => isReached(n.status)).length

    const header = startPt ? [startPt] : []
    const full = header.concat(
      located.map((n) => ({ latitude: n.location.latitude, longitude: n.location.longitude }))
    )
    const splitAt = header.length + lastReachedIdx

    // 绿线：起点 → 最后一个到过的节点
    // 蓝线：从那个节点继续往后（**与绿线首尾相接**，视觉上是连续的一条路）
    const donePts = lastReachedIdx >= 0 ? full.slice(0, splitAt + 1) : []
    const restPts = lastReachedIdx >= 0 ? full.slice(splitAt) : full

    const lines = []
    if (donePts.length >= 2) {
      lines.push({
        points: donePts,
        color: '#0F9D58',
        width: 5,
        borderColor: '#FFFFFF',
        borderWidth: 2,
      })
    }
    if (restPts.length >= 2) {
      lines.push({
        points: restPts,
        color: '#0B3C6E',
        width: 4,
        arrowLine: true, // 未走的部分带方向箭头
        borderColor: '#FFFFFF',
        borderWidth: 2,
      })
    }

    const markers = located.map((n, i) => {
      const reached = isReached(n.status)
      const skipped = n.status === 'skipped'
      const arrived = n.status === 'arrived'
      return {
        id: i + 1,
        latitude: n.location.latitude,
        longitude: n.location.longitude,
        // 到过 → 绿色图标；**跳过的仍是蓝的**（没去过就不该显示成去过）
        iconPath: reached ? '/assets/pin-done.png' : '/assets/pin-place.png',
        width: 28,
        height: 35,
        callout: {
          content: String(i + 1),
          color: '#FFFFFF',
          bgColor: reached ? '#0F9D58' : skipped ? '#9AA5B1' : arrived ? '#FF7A45' : '#0B3C6E',
          fontSize: 11,
          borderRadius: 10,
          padding: 5,
          display: 'ALWAYS',
          textAlign: 'center',
        },
      }
    })

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
      center: full[0],
      includePoints: full,
      polyline: lines,
      markers: markers,
      /** 进度，界面直接显示，不用自己数 */
      reachedCount: reachedCount,
      totalCount: located.length,
      /** 下一站的名字 —— 概览里显示"当前该去哪"，不用自己去时间轴上找 */
      nextName:
        lastReachedIdx + 1 < located.length ? located[lastReachedIdx + 1].placeName : null,
      legend:
        located.length >= 2
          ? '绿线为已走过的部分，蓝线为剩余路线；连线是顺序示意，不是逐段真实路径'
          : '只有一个目的地，暂无可连的路线',
    }
  },

  // ══════════ 进度 ══════════

  /** 点"当前路线"里的某一站 → 滚到时间轴上它的详情 */
  jumpToNode(e) {
    const nodeId = e.currentTarget.dataset.nodeid
    if (!nodeId) return
    // 用选择器滚动最稳：时间轴可能很长，算像素位置容易偏
    wx.pageScrollTo({ selector: `#node-${nodeId}`, duration: 300, offsetTop: -20 })
  },

  /**
   * 记录实际进度（到了 / 逛完了 / 撤销）。
   *
   * 这是**事实记录**，不重新规划 —— 已到过的节点在地图与时间轴上变绿，
   * 路线全程保留，让人一眼看出还剩几站。
   */
  nodeProgress(e) {
    const that = this
    const { nodeid: nodeId, status } = e.currentTarget.dataset
    if (!this.data.trip || !status) return

    this.setData({ busy: 'progress', error: '' })

    api
      /**
       * ⚠️ `expectedVersion` 必须放在**第三个参数**（信封层），不能写进 payload。
       *
       * 2026-10-13 发现的真实缺陷：三个写操作都把它写进了 payload，
       * 而 api.js 与后端都只从信封层读 → 它被静默忽略 →
       * 服务端回落到"当前版本" → **版本校验恒等于通过**。
       * 「旧版本确认不得使新方案生效」这条 11/5 验收项当时根本没生效。
       *
       * 现在后端改成必填了：传错位置会直接报错，不会再静默放行。
       */
      .callApi(
        'trip.progress',
        { tripId: this.data.trip.tripId, nodeId: nodeId, status: status },
        { expectedVersion: this.data.trip.version }
      )
      .then(function (res) {
        if (!res || res.ok !== true) {
          const e2 = res && res.error
          that.setData({
            busy: '',
            error:
              e2 && e2.code === 'VERSION_CONFLICT'
                ? '行程已被更新，请重新生成后再标记进度'
                : (e2 && e2.message) || '记录进度失败',
          })
          return
        }
        const d = res.data
        // trip.progress 只回传 nodes —— 把它合并进 rawNodes，其余信息保持不动
        // ⚠️ 空数组也要当成"没给"：否则界面会被清空
        const freshNodes = d.nodes && d.nodes.length ? d.nodes : that.data.rawNodes
        that.setData(
          {
            busy: '',
            trip: Object.assign({}, that.data.trip, { version: d.version }),
            rawNodes: freshNodes,
          },
          () => that.rebuildFromNodes()
        )
      })
      .catch(function (err) {
        that.setData({ busy: '', error: (err && err.errMsg) || '记录进度失败' })
      })
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
      // expectedVersion 走第三个参数（信封层），见 trip.progress 处的说明
      .callApi(
        'trip.adjust',
        { tripId: this.data.trip.tripId, trigger },
        { expectedVersion: this.data.trip.version }
      )
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
      // expectedVersion 走第三个参数（信封层）—— 传错位置会让版本校验静默失效
      .callApi(
        'trip.confirmChange',
        { proposalId: proposal.proposalId, candidateId: candidateId },
        { expectedVersion: proposal.baseVersion }
      )
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
      rawNodes: [],
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

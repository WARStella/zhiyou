const test = require('node:test')
const assert = require('node:assert/strict')
const { loadPage } = require('./page-harness')
const { choiceIndex, clarificationValue } = require('../miniprogram/utils/guide-conversation')
const pagePath = 'miniprogram/pages/guide/index.js'
const result = (version, extra = {}) => ({ sessionId: 's', version, answer: '回答' + version,
  candidates: [], sources: [], evidence: [], notices: [], ...extra })
const send = async (page, text) => { page.onText({ detail: { value: text } }); await page.ask() }

test('继续追问保留原回答的媒体来源会话和版本，新回答绑定自己的版本', async () => {
  let version = 0
  const p = loadPage(pagePath, { api: { 'guide.ask': () => ({ ok: true, data: result(++version, {
    requestedMediaKind: version === 1 ? 'image' : 'video', place: { name: '中央大街' }, evidence: [{ text: '历史资料', sourceNumber: 1 }], sources: [{ id: 'source', number: 1 }],
  }) }) } })
  try {
    p.onLoad(); await send(p, '讲讲中央大街'); const original = structuredClone(p.data.messages[1])
    await send(p, '再讲讲建筑')
    assert.equal(original.mediaPreferredKind, 'image'); assert.equal(p.data.messages[3].mediaPreferredKind, 'video');
    assert.equal(original.mediaAvailable, true); assert.equal(original.mediaSessionId, 's'); assert.equal(original.mediaVersion, 1)
    assert.deepEqual(p.data.messages[1], original)
    assert.equal(p.data.messages[3].mediaVersion, 2)
    assert.equal(p.data.activeReplyId, p.data.messages[3].id)
  } finally { p.onUnload(); p.restore() }
})

test('连续问答保留每轮正文与来源，失败不丢草稿；历史回答的操作不会重新激活', async () => {
  let n = 0
  const p = loadPage(pagePath, { api: { 'guide.ask': () => ++n === 3 ? { ok: false, error: { message: '网络中断' } } :
    { ok: true, data: result(n, n === 1 ? { answer: '关于景点，下面是讲解片段',
      evidence: [{ text: '真实的景点历史资料', sourceNumber: 1 }], sources: [{ id: 'source', title: '资料来源', number: 1 }] } : {}) } } })
  try {
    p.onLoad(); p.onShow(); await send(p, '讲讲景点'); await send(p, '还有什么？')
    assert.deepEqual(p.data.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant'])
    assert.match(p.data.messages[1].text, /真实的景点历史资料 \[1\]/)
    assert.equal(p.data.messages[1].sources.length, 1)
    assert.equal(p.data.activeReplyId, p.data.messages[3].id)
    await send(p, '继续讲'); assert.equal(p.data.text, '继续讲'); assert.equal(p.data.messages[5].failed, true)
    assert.ok(p.data.messages.every(m => !m.pending)); assert.equal(p.data.sending, false)
    assert.equal(p.data.scrollTarget, p.data.messages[5].id)
  } finally { p.onUnload(); p.restore() }
})

test('回复第二个沿用当前候选ID和会话版本，不把序号当成新的地点搜索', async () => {
  const requests = [], candidates = ['中央大街', '太阳岛'].map((name, i) => ({ id: 'c' + i, name, point: { latitude: 45.77, longitude: 126.62 } }))
  const p = loadPage(pagePath, { api: { 'guide.ask': (payload, options) => {
    requests.push({ payload, options }); return { ok: true, data: result(requests.length, requests.length === 1 ? { candidates } : { place: candidates[1] }) }
  } } })
  try {
    p.onLoad(); await send(p, '找地点'); await send(p, '第二个')
    assert.equal(requests[1].payload.candidateId, 'c1'); assert.equal(requests[1].payload.text, undefined)
    assert.equal(requests[1].options.expectedVersion, 1); assert.equal(p.data.text, '')
    assert.equal(p.data.messages[2].text, '第二个'); assert.equal(p.data.messages.length, 4)
  } finally { p.onUnload(); p.restore() }
})

test('用自然语言补充十分钟，走草稿回答接口；生成提案后仍不直接修改行程', async () => {
  const p = loadPage(pagePath, { api: {
    'guide.ask': () => ({ ok: true, data: result(1, { tripChange: { tripId: 't', baseVersion: 2, draftId: 'd',
      needsClarification: true, questions: [{ key: 'minutes', kind: 'minutes', prompt: '少待多少分钟？' }] } }) }),
    'trip.adjustText': (payload, options) => {
      assert.equal(payload.answers.minutes, 10); assert.equal(options.expectedVersion, 2)
      return { ok: true, data: { proposalId: 'proposal', candidates: [{ candidateId: 'c', feasible: true, nodes: [] }] } }
    },
  } })
  try {
    p.onLoad(); await send(p, '下一站少待一会儿'); await send(p, '十分钟')
    assert.equal(p.__calls.at(-1).action, 'trip.adjustText')
    assert.equal(p.__calls.some(c => c.action === 'trip.confirmChange'), false)
    assert.equal(p.data.changeCandidates[0].candidateId, 'c')
  } finally { p.onUnload(); p.restore() }
})

test('切页中断占位消息，切队清除旧对话，迟到回复不能污染新上下文', async () => {
  let resolve
  const p = loadPage(pagePath, { storage: { 'zhiyou-active-crew': 'one' },
    api: { 'guide.ask': () => new Promise(r => { resolve = r }) } })
  try {
    p.onLoad(); const pending = send(p, '下一站？'); p.onHide()
    assert.equal(p.data.messages[1].pending, false)
    p.__storage['zhiyou-active-crew'] = 'two'; p.onShow()
    resolve({ ok: true, data: result(1, { answer: '旧队伍的秘密' }) }); await pending
    assert.deepEqual(p.data.messages, []); assert.equal(p.data.sending, false)
    assert.ok(!JSON.stringify(p.data).includes('旧队伍的秘密'))
  } finally { p.onUnload(); p.restore() }
})

test('照片计数结果进入对话，零人有效，重复点击发送只产生一次请求', async () => {
  const photo = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII='
  let resolve
  const p = loadPage(pagePath, { wx: {
    chooseMedia: o => o.success({ tempFiles: [{ tempFilePath: '/photo.jpg' }] }),
    compressImage: o => o.success({ tempFilePath: '/photo.jpg' }),
    getFileSystemManager: () => ({ stat: o => o.success({ stats: { size: 68 } }), readFile: o => o.success({ data: photo }) }),
  }, api: { 'guide.countPeople': () => new Promise(r => { resolve = r }) } })
  try {
    p.onLoad(); await p.choosePhoto(); const pending = send(p, '照片里有多少人？'); await new Promise(r => setImmediate(r))
    await p.ask(); assert.equal(p.__calls.length, 1)
    resolve({ ok: true, data: { count: 0, boxes: [], notice: '检测结果仅供参考' } }); await pending
    assert.equal(p.data.messages[1].crowd.count, 0); assert.match(p.data.messages[1].text, /约 0 人/)
    assert.equal(p.data.messages[0].imagePath, '/photo.jpg')
    assert.equal(p.data.imagePath, '')
  } finally { p.onUnload(); p.restore() }
})

test('选择和追问解析保持明确范围，不把歧义时刻或任意句子当作确认', () => {
  const options = [{ label: '中央大街', value: 'a' }, { label: '太阳岛', value: 'b' }]
  assert.equal(choiceIndex('第二个', options), 1); assert.equal(choiceIndex('第三个', options), -1)
  assert.equal(choiceIndex('我不选第一个', options), -1)
  assert.equal(choiceIndex('同名大学', [{ name: '同名大学', address: '校区一' }, { name: '同名大学', address: '校区二' }]), -1)
  assert.equal(clarificationValue({ kind: 'minutes' }, '十五分钟'), 15)
  assert.equal(clarificationValue({ kind: 'minutes' }, '少一点'), null)
  assert.equal(clarificationValue({ kind: 'clock' }, '五点'), null)
  assert.equal(clarificationValue({ kind: 'clock' }, '下午5点半'), '17:30')
})

test('文字确认方案仍需弹窗与版本校验；取消后方案可重试，旧消息事件不能应用方案', async () => {
  let allow = false, modalCount = 0
  const p = loadPage(pagePath, { wx: { showModal: o => { modalCount++; o.success({ confirm: allow }) } }, api: {
    'guide.ask': () => ({ ok: true, data: result(1, { tripChange: { tripId: 't', baseVersion: 3, proposalId: 'p',
      candidates: [{ candidateId: 'c', feasible: true, nodes: [{ name: '中央大街', plannedStayMin: 30 }], notes: [] }] } }) }),
    'trip.confirmChange': (payload, options) => {
      assert.equal(payload.proposalId, 'p'); assert.equal(options.expectedVersion, 3)
      assert.ok(options.requestId); return { ok: true, data: { version: 4 } }
    },
  } })
  try {
    p.onLoad(); await send(p, '少待十分钟'); const oldReply = p.data.activeReplyId
    await send(p, '确认方案'); assert.equal(modalCount, 1)
    assert.equal(p.__calls.some(c => c.action === 'trip.confirmChange'), false)
    assert.equal(p.data.tripChange.proposalId, 'p'); assert.ok(p.data.activeReplyId)
    allow = true
    await p.confirmChange({ currentTarget: { dataset: { id: 'c', reply: oldReply } } })
    assert.equal(modalCount, 1)
    await send(p, '确认方案'); assert.equal(modalCount, 2)
    assert.equal(p.__calls.filter(c => c.action === 'trip.confirmChange').length, 1)
    assert.match(p.data.messages.at(-1).text, /已确认并生效/)
  } finally { p.onUnload(); p.restore() }
})

test('多项追问逐条用文字回答，未补齐前不调用提案接口', async () => {
  const p = loadPage(pagePath, { api: {
    'guide.ask': () => ({ ok: true, data: result(1, { tripChange: { tripId: 't', baseVersion: 1, draftId: 'd', needsClarification: true,
      questions: [{ key: 'node', kind: 'node', prompt: '修改哪一站？', options: [{ label: '中央大街', value: 'n' }] },
        { key: 'minutes', kind: 'minutes', prompt: '调整多少分钟？' }] } }) }),
    'trip.adjustText': payload => {
      assert.deepEqual(payload.answers, { node: 'n', minutes: 15 })
      return { ok: true, data: { proposalId: 'p', candidates: [] } }
    },
  } })
  try {
    p.onLoad(); await send(p, '少待一会儿'); await send(p, '第一个')
    assert.equal(p.__calls.length, 1); assert.match(p.data.messages.at(-1).text, /调整多少分钟/)
    await send(p, '十五分钟'); assert.equal(p.__calls.at(-1).action, 'trip.adjustText')
    await p.clear(); assert.deepEqual(p.data.messages, []); assert.equal(p.data.result, null)
  } finally { p.onUnload(); p.restore() }
})

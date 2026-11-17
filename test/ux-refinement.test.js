const test = require('node:test')
const assert = require('node:assert/strict')
const { meetingPresentation } = require('../miniprogram/utils/meeting-presentation')
const { makeWorld, makeCrew, expectOk } = require('./helpers')
const { loadPage, loadComponent } = require('./page-harness')

test('单人已确认集合提供开始入口，通过真实接口继续到达；不替其他成员确认', async () => {
  const w = await makeWorld(); const { crewId } = expectOk(await w.A('crew.create', { name: '单人小队' }))
  const created = expectOk(await w.A('meet.create', { crewId, placeName: '测试广场', point: { latitude: 45.77, longitude: 126.62 }, plannedMeetAt: w.plusMin(60).toISOString() }))
  const viewer = created.participants[0].userId
  const task = { ...created, status: 'proposed' }
  assert.equal(meetingPresentation(task, viewer).canFinalizeConfirmation, true)
  const confirmed = expectOk(await w.A('meet.confirm', { meetTaskId: created.meetTaskId, decision: 'confirm' }, { expectedVersion: created.version }))
  assert.equal(confirmed.status, 'confirmed')
  expectOk(await w.A('meet.arrive', { meetTaskId: created.meetTaskId }, { expectedVersion: confirmed.version }))
  task.participants.push({ userId: 'other', status: 'invited', confirmedVersion: null })
  assert.equal(meetingPresentation(task, viewer).canFinalizeConfirmation, false)
  assert.match(meetingPresentation(task, viewer).statusHint, /另外 1 位/)
  task.participants.pop(); task.participants[0].confirmedVersion = 0
  assert.equal(meetingPresentation(task, viewer).canFinalizeConfirmation, false)
})

test('站点更多操作取消不修改，弹窗期间版本变化不提交旧操作', () => {
  let sheet, modal, submitted = 0
  const p = loadPage('miniprogram/pages/trip/index.js', { wx: { showActionSheet: o => { sheet = o }, showModal: o => { modal = o } } })
  try {
    p.setData({ trip: { tripId: 't', version: 1 }, busy: '', loading: false }); p.nodeAction = () => { submitted++ }
    p.openNodeMore({ currentTarget: { dataset: { nodeid: 'n' } } }); sheet.success({ tapIndex: 0 }); modal.success({ confirm: false }); assert.equal(submitted, 0)
    p.openNodeMore({ currentTarget: { dataset: { nodeid: 'n' } } }); sheet.success({ tapIndex: 0 }); p.setData({ trip: { tripId: 't', version: 2 } }); modal.success({ confirm: true }); assert.equal(submitted, 0)
    p.openNodeMore({ currentTarget: { dataset: { nodeid: 'n' } } }); sheet.success({ tapIndex: 0 }); modal.success({ confirm: true }); assert.equal(submitted, 1)
  } finally { p.restore() }
})


test('配图完成后仍可生成短片，未知状态可查询而不重复创建', () => {
  const c = loadComponent('miniprogram/components/guide-media/index.js', { properties: { available: true, preferredKind: 'image' } })
  try {
    c.updateTasks([{ taskId: 'i', kind: 'image', optionId: 'aliyun-image', status: 'succeeded', url: 'https://example.com/image.png' }])
    assert.equal(c.data.hasImageTask, true); assert.equal(c.data.hasVideoTask, false)
    c.updateTasks([{ taskId: 'v', kind: 'video', optionId: 'aliyun-video', status: 'unknown' }])
    assert.equal(c.data.canRefresh, true); assert.equal(c.data.tasks[0].waiting, true)
    assert.equal(c.data.tasks[0].completed, false)
  } finally { c.__restoreGlobals() }
})

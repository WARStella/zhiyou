function meetingPresentation(task, userId) {
  const participants = task.participants || []
  const included = participants.filter(p => p.status !== 'declined')
  const pending = included.filter(p => !['confirmed', 'arrived'].includes(p.status) || p.confirmedVersion !== task.version)
  const viewer = participants.find(p => p.userId === userId)
  const canFinalizeConfirmation = task.status === 'proposed' && included.length > 0 && pending.length === 0 && Boolean(viewer && viewer.status === 'confirmed')
  let statusHint = ''
  if (task.status === 'proposed') statusHint = canFinalizeConfirmation ? '参与成员已确认，点击“开始集合”后可标记到达。' : viewer && viewer.status === 'declined' ? '你已选择暂不参加，可在集合结束前重新确认。' : viewer && viewer.status === 'confirmed' && viewer.confirmedVersion === task.version ? '你已确认，等待另外 ' + pending.length + ' 位成员确认。' : '请先确认是否参加本次集合。'
  else if (['confirmed', 'active'].includes(task.status)) statusHint = viewer && viewer.status === 'arrived' ? '已记录你到达，等待其他成员。' : '请前往集合点，到达后点击“我已到达”。'
  else if (task.status === 'arrived_all') statusHint = task.initiatorUserId === userId ? '成员已到齐，请检查后续行程并确认出发。' : '成员已到齐，等待发起人检查行程并确认出发。'
  return { canFinalizeConfirmation, statusHint }
}
module.exports = { meetingPresentation }

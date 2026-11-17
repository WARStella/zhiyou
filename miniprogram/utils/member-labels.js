/** 昵称只用于显示，可以重名；身份和 Map 的键始终使用唯一用户 ID。 */
function createMemberLabels(members, me) {
  return new Map((members || []).filter(m => m.userId).map(m => {
    const nickname = typeof m.nickname === 'string' ? m.nickname.trim() : ''
    const label = nickname || '未命名'
    return [m.userId, m.userId === me ? '我（' + label + '）' : label]
  }))
}

module.exports = { createMemberLabels }

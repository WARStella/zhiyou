const validToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{24}$/.test(token)
function invitationToken(query = {}) {
  if (validToken(query.token)) return query.token
  let scene = query.scene
  try { scene = decodeURIComponent(scene || '') } catch (_) { return '' }
  return typeof scene === 'string' && scene[0] === 'i' && validToken(scene.slice(1)) ? scene.slice(1) : ''
}
function scanToken(result) {
  const path = result && result.path
  if (typeof path !== 'string' || !/^\/?pages\/invite\/index\?/.test(path)) return ''
  const query = {}
  for (const part of path.split('?')[1].split('&')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    const key = part.slice(0, at)
    if (key === 'token' || key === 'scene') query[key] = part.slice(at + 1)
  }
  return invitationToken(query)
}
module.exports = { validToken, invitationToken, scanToken }

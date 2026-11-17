'use strict';

const C = require('./repo/collections');

/** 调用方须先验证队伍成员身份；只查询本队成员，对外仅提供昵称。 */
async function memberNicknames(repo, members) {
  const ids = [...new Set(members.map(m => m.userId))];
  if (!ids.length) return new Map();
  const users = await repo.find(C.USERS, { openid: { __op: 'in', value: ids } }, { limit: ids.length });
  return new Map(users.map(user => [user.openid,
    typeof user.nickname === 'string' ? user.nickname.trim() || null : null]));
}

module.exports = { memberNicknames };

/** 已验证成员身份的位置列表仅补充地图需要的头像。 */
async function memberAvatars(repo, members) {
  const ids = [...new Set(members.map(m => m.userId))];
  if (!ids.length) return new Map();
  const users = await repo.find(C.USERS, { openid: { __op: 'in', value: ids } }, { limit: ids.length });
  return new Map(users.map(user => [user.openid, user.avatarFileId || null]));
}
module.exports.memberAvatars = memberAvatars;

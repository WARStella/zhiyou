'use strict';

const { createHash } = require('crypto');

// 仅供已鉴权的队伍接口关联消息与位置，不在聊天响应中直接返回 openid。
function crewMemberKey(crewId, userId) {
  return 'cm_' + createHash('sha256').update(JSON.stringify([crewId, userId])).digest('hex').slice(0, 48);
}

module.exports = { crewMemberKey };

'use strict';

// 草稿上下文、批量校验及候选规划共用插入规则；不改写历史节点。
function insertNode(items, node, payload) {
  let index = items.length;
  if (payload.insertion === 'after') {
    index = items.findIndex(n => n.nodeId === payload.afterNodeId);
    if (index < 0) return false;
    index++;
  } else if (payload.insertion === 'start') {
    index = items.findIndex(n => n.status !== 'done' && n.status !== 'skipped');
    if (index < 0) index = items.length;
  }
  items.splice(index, 0, node);
  return true;
}

module.exports = { insertNode };

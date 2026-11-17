const { assert, CODES } = require('../lib/errors');
const { isPlaceholderPlace } = require('../lib/placeholder-place');
const C = require('../lib/repo/collections');
const resp = require('../lib/resp');
module.exports = async function cleanup(ctx) {
  assert(ctx.env === 'dev', CODES.FORBIDDEN_ENV, '仅允许在开发环境清理占位地点');
  assert(ctx.payload.confirm === true, CODES.INVALID_PARAM, '请确认清理占位地点');
  const targets = [];
  for (let skip = 0; ; skip += 100) {
    const rows = await ctx.repo.find(C.PLACES, {}, { skip, limit: 100, sort: { _id: 1 } });
    targets.push(...rows.filter(isPlaceholderPlace));
    if (rows.length < 100) break;
  }
  let removed = 0;
  for (const target of targets) {
    const current = await ctx.repo.get(C.PLACES, target._id);
    if (isPlaceholderPlace(current)) removed += (await ctx.repo.remove(C.PLACES, target._id)).removed;
  }
  return resp.ok({ removed, message: `已删除 ${removed} 条占位地点，保留真实地点及历史行程` });
};

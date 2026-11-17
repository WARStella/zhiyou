'use strict';

const { assert, CODES } = require('../lib/errors');
const resp = require('../lib/resp');
const C = require('../lib/repo/collections');
const { requireCrewMember } = require('../lib/authz');
const { createOcrProvider, MAX_IMAGE_BYTES } = require('../lib/ocr/tencent');
const { createMapProvider } = require('../lib/map');
const { coord, haversineMeters } = require('../lib/geo');
const { requestCount } = require('../lib/map/usage');
const RADIUS_METERS = 3000;

async function authorize(ctx) {
  assert(typeof ctx.payload.crewId === 'string' && ctx.payload.crewId.length > 0, CODES.INVALID_PARAM, '请先加入队伍');
  await requireCrewMember(ctx.repo, ctx.payload.crewId, ctx.openid);
}
async function rateLimit(ctx, action) {
  const now = new Date(ctx.now || Date.now()).getTime();
  const recent = await ctx.repo.find(C.EVENTS, { action, userId: ctx.openid, type: 'api_call' }, { sort: { ts: -1 }, limit: 10 });
  assert(recent.filter(row => new Date(row.ts).getTime() >= now - 60000).length < 10,
    CODES.RATE_LIMITED, '操作过于频繁，请一分钟后重试');
}

async function recognize(ctx) {
  await authorize(ctx);
  const encoded = ctx.payload.imageBase64;
  assert(typeof encoded === 'string' && encoded.length > 0 && encoded.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4 &&
    encoded.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded), CODES.INVALID_PARAM, '图片须为不超过 1MB 的 JPG 或 PNG');
  const image = Buffer.from(encoded, 'base64');
  const jpeg = image.length >= 4 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
  const png = image.length >= 24 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert(image.length <= MAX_IMAGE_BYTES && image.toString('base64') === encoded && (jpeg || png),
    CODES.INVALID_PARAM, '图片编码无效，仅支持 JPG 或 PNG；请重新拍摄');
  await rateLimit(ctx, 'ocr.recognize');
  const result = await (ctx.createOcrProvider || createOcrProvider)().recognize(image, ctx.now);
  await authorize(ctx);
  return resp.ok(result);
}

async function searchMeeting(ctx) {
  await authorize(ctx);
  const keyword = typeof ctx.payload.keyword === 'string' ? ctx.payload.keyword.trim() : '';
  const center = coord(ctx.payload.center);
  assert(keyword.length >= 2 && keyword.length <= 60, CODES.INVALID_PARAM, '请输入 2—60 字的地点名称');
  assert(center, CODES.INVALID_PARAM, '请先取得当前位置，再搜索附近地点');
  await rateLimit(ctx, 'ocr.searchMeeting');
  let result;
  try {
    result = await (ctx.createMapProvider || createMapProvider)().searchPlaces({ keyword, center,
      radius: RADIUS_METERS, autoExtend: false, orderBy: 'distance', pageSize: 20, pageIndex: 1 });
  } catch (_) { result = null; }
  assert(result && result.ok, CODES.UPSTREAM_MAP_FAILED, '附近地点搜索失败，请稍后重试或手动选点');
  await authorize(ctx);
  const seen = new Set(), candidates = [];
  for (const item of result.items || []) {
    const point = coord(item && item.location);
    const name = item && typeof item.title === 'string' ? item.title.trim().slice(0, 100) : '';
    if (!point || !name) continue;
    const distance = haversineMeters(center, point);
    const key = name + '@' + point.latitude + ',' + point.longitude;
    if (distance > RADIUS_METERS || seen.has(key)) continue;
    seen.add(key);
    candidates.push({ id: String(candidates.length), name, address: String(item.address || '').slice(0, 200),
      point, distanceMeters: Math.round(distance), source: 'tencent-poi', verified: false });
  }
  candidates.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return resp.ok({ candidates: candidates.slice(0, 10), radiusMeters: RADIUS_METERS,
    center, keyword, notice: '地图候选未经实地核验，请核对名称、地址及入口后再选择。' },
  { mapApiCalls: requestCount(result) });
}

module.exports = { recognize, searchMeeting };

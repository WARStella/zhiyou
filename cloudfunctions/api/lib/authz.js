'use strict';

/**
 * 授权校验 —— docs/01 §0 决定 1 的唯一落地处。
 *
 * 云函数用 admin 身份访问数据库，会绕过安全规则，所以：
 *   任何队伍相关请求的第一步都是 requireCrewMember()。
 *   **不缓存成员身份**，每次实时查 crew_members。
 *   这样"退出后访问立即撤销"（10/21 验收）自动成立，不需要额外失效逻辑。
 */

const { CODES, fail, assert } = require('./errors');
const C = require('./repo/collections');

/** 返回 active 成员记录，非成员返回 null。 */
async function getMembership(repo, crewId, userId) {
  if (!crewId || !userId) return null;
  return repo.findOne(C.CREW_MEMBERS, { crewId, userId, status: 'active' });
}

async function requireCrewMember(repo, crewId, userId) {
  assert(crewId, CODES.INVALID_PARAM, '缺少 crewId');
  const m = await getMembership(repo, crewId, userId);
  if (!m) {
    // 刻意不区分"队伍不存在"与"你不是成员"，避免泄露队伍是否存在
    throw fail(CODES.FORBIDDEN_NOT_MEMBER, '你不是该小队成员，或已退出');
  }
  return m;
}

async function requireCrewOwner(repo, crewId, userId) {
  const m = await requireCrewMember(repo, crewId, userId);
  if (m.role !== 'owner') throw fail(CODES.FORBIDDEN_NOT_MEMBER, '仅发起人可执行此操作');
  return m;
}

async function requireCrew(repo, crewId) {
  const crew = await repo.get(C.CREWS, crewId);
  if (!crew || crew.status !== 'active') throw fail(CODES.NOT_FOUND, '小队不存在或已解散');
  return crew;
}

async function loadPlace(repo, placeId) {
  const p = await repo.get(C.PLACES, placeId);
  if (!p) throw fail(CODES.NOT_FOUND, '地点不存在', { placeId });
  return p;
}

/**
 * 规划准入：未核验或低可信度的地点不得进入候选。
 * 对应 §6.6「检索到资料 ≠ 资料可信」——可信度取决于踏勘与复核。
 */
function isPlaceUsable(place) {
  return Boolean(place && place.verifiedAt && place.confidence !== 'low');
}

function assertPlaceUsable(place) {
  if (!isPlaceUsable(place)) {
    throw fail(CODES.INSUFFICIENT_DATA, '该地点尚未完成实地核验，不能用于规划', {
      placeId: place && place._id,
      verifiedAt: place ? place.verifiedAt : null,
      confidence: place ? place.confidence : null,
    });
  }
  return place;
}

/**
 * 位置读取权限：本人可读；他人需为同队成员且已开启共享。
 * 关闭共享时**不返回坐标**，只返回状态（docs/01 §2.9）。
 */
function canReadLocation(viewerMember, targetMember) {
  if (!viewerMember || !targetMember) return false;
  if (viewerMember.userId === targetMember.userId) return true;
  if (targetMember.status !== 'active') return false;
  return targetMember.locationSharing !== false;
}

module.exports = {
  getMembership,
  requireCrewMember,
  requireCrewOwner,
  requireCrew,
  loadPlace,
  isPlaceUsable,
  assertPlaceUsable,
  canReadLocation,
};

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
 * 地点准入 —— **按用途分两级，不是一个二元开关**。
 *
 * 2026-10-13 修正：首版把核验做成了"全有或全无"（`verifiedAt` 为空则连行程里都不能出现）。
 * 这是错的，因为"核验"对不同用途的意义完全不同：
 *
 *   · **行程节点**只要知道"有这么个地方、在哪、大概待多久" —— 外部 POI 的数据质量够用；
 *   · **集合点**还要考察入口位置、可达性、辨识度、开放条件（§7.1）—— 必须实地踏勘。
 *
 * 而首版的全有或全无会让**地点检索回来的 POI 一个都用不了**，
 * 与「外部检索保证覆盖度、实地踏勘保证可信度」的设计目标直接矛盾。
 *
 * §6.6 的原意是「检索到资料 ≠ 资料可信」，它约束的是**可信度标注与使用范围**，
 * 不是"未核验就一律不可用"。
 */

/** 判断一条地点记录是否携带可用坐标（两种坐标写法都接受） */
function hasCoordinate(place) {
  if (!place || !place.location) return false;
  const lat = place.location.latitude !== undefined ? place.location.latitude : place.location.lat;
  const lng = place.location.longitude !== undefined ? place.location.longitude : place.location.lng;
  return typeof lat === 'number' && typeof lng === 'number';
}

/**
 * 行程节点准入：需有名称与坐标。**未核验也允许**，但必须在结果里标注来源与可信度。
 * 无法计算步行时间（缺坐标）的地点仍然拒绝 —— 那会让时间线失真。
 */
function canBeTripNode(place) {
  if (!place) return false;
  if (!place.name) return false;
  if (!hasCoordinate(place)) return false; // 缺坐标 → 时间线会失真，必须拒绝
  return true;
}

/**
 * 集合点准入：在行程节点要求之上，还必须有实地核验。
 * 理由见 §7.1（可达性、辨识度、停留条件）与 §7.3（集合延误会影响后续行程）。
 */
function canBeMeetingPoint(place) {
  if (!canBeTripNode(place)) return false;
  return Boolean(place.verifiedAt) && place.confidence !== 'low';
}

/** 地点去向：供接口与界面统一判断 */
function placeEligibility(place) {
  return {
    tripNode: canBeTripNode(place),
    meetingPoint: canBeMeetingPoint(place),
    verified: Boolean(place && place.verifiedAt),
    confidence: (place && place.confidence) || null,
    dataSource: (place && place.dataSource) || null,
  };
}

/** 兼容旧名：默认按**集合点**从严解释，避免被误用于宽松场景 */
const isPlaceUsable = canBeMeetingPoint;

function assertPlaceUsable(place) {
  if (!canBeMeetingPoint(place)) {
    throw fail(CODES.INSUFFICIENT_DATA, '该地点尚未完成实地核验，不能作为集合点', {
      placeId: place && place._id,
      verifiedAt: place ? place.verifiedAt : null,
      confidence: place ? place.confidence : null,
    });
  }
  return place;
}

function assertCanBeTripNode(place) {
  if (!canBeTripNode(place)) {
    throw fail(CODES.INSUFFICIENT_DATA, '该地点缺少可用坐标或名称，无法安排进路线', {
      placeId: place && place._id,
      hasName: Boolean(place && place.name),
      hasCoordinate: hasCoordinate(place),
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
  // 地点准入（按用途分级）
  hasCoordinate,
  canBeTripNode,
  canBeMeetingPoint,
  placeEligibility,
  assertCanBeTripNode,
  // 兼容旧名：按集合点从严解释
  isPlaceUsable,
  assertPlaceUsable,
  canReadLocation,
};

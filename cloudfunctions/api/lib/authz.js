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
  const crew = await repo.get(C.CREWS, crewId);
  assert(crew && crew.status === 'active', CODES.FORBIDDEN_NOT_MEMBER, '小队已解散');
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
 * ── 核验等级（2026-10-14 新增）：三级，不是一个布尔 ──────────
 *
 * 起因是一个必须承认的现实：**本队只来得及实地核验一两个点**，
 * 而集合点推荐至少要有几个候选才谈得上"推荐"。
 *
 * 于是必须回答一个此前回避的问题：**"没实地核验过的地方，能不能当集合点？"**
 *
 * 首版答案是"不能"（`verifiedAt` 为空即出局）。那条规则很干净，但它的代价是
 * 整条团队与集合主线**没有数据可跑** —— 而后端 14 个 action 与全部测试都是通的。
 * 一个因为缺数据而永远跑不起来的正确算法，等于没有。
 *
 * 三级定义（判据写在这里，界面必须原样透出，不得简化成一个"可用"）：
 *
 *   level 0 `field-survey` 已实地踏勘 —— §7.1 四项（入口／可达性／辨识度／停留条件）全核过。
 *                          可信度最高，`verifiedAt` 非空。
 *   level 1 `aggregated`   三方聚合 —— 上游 POI 数据 + 上游照片，**可达性与入口未经实地确认**。
 *                          可作集合点，但**必须标注"未实地核验"**。
 *   level 2 `none`         仅够作行程节点 —— 有名称与坐标，不能当集合点。
 *
 * ⚠️ **不可违背的一条**：`fieldVerified` 与 `verificationLevel` 由 `verifiedAt` 与
 * `meetingPointEligible` **推导**，不接受调用方自报。§6.6 的原话是
 * 「检索到资料 ≠ 资料可信」—— 三方数据的图能自己声称已核验，标注就失去意义。
 */
const VERIFICATION_LEVEL = {
  FIELD_SURVEY: 'field-survey',
  AGGREGATED: 'aggregated',
  NONE: 'none',
};

/** 核验等级的中文标注 —— 界面直接用，避免各处自己拼词导致口径不一 */
const VERIFICATION_LABEL = {
  'field-survey': '已实地核验',
  aggregated: '未实地核验 · 三方聚合',
  none: '无核验数据',
};

function verificationLevelOf(place) {
  if (place && place.verifiedAt) return VERIFICATION_LEVEL.FIELD_SURVEY;
  if (place && place.meetingPointEligible === true) return VERIFICATION_LEVEL.AGGREGATED;
  return VERIFICATION_LEVEL.NONE;
}

/**
 * 集合点准入：在行程节点要求之上，还需要一条**可交代的核验依据**。
 *
 * 两种依据都放行，但它们的可信度不同、且必须能被区分：
 *   · `verifiedAt` 非空        —— 实地核验过（level 0）；
 *   · `meetingPointEligible`   —— 三方数据+照片足以支持"能当集合点"，但未实地确认（level 1）。
 *
 * 两条都排除 `confidence: 'low'`：低可信度不该进推荐列表，
 * 否则"推荐"这个词就没有意义了。
 */
function canBeMeetingPoint(place) {
  if (!canBeTripNode(place)) return false;
  if (place.confidence === 'low') return false;
  if (place.meetingPointEligible === false) return false;
  return Boolean(place.verifiedAt) || place.meetingPointEligible === true;
}

/** 地点去向：供接口与界面统一判断 */
function placeEligibility(place) {
  const level = verificationLevelOf(place);
  return {
    tripNode: canBeTripNode(place),
    meetingPoint: canBeMeetingPoint(place),
    /**
     * ⚠️ `verified` 只表示"**实地**核验过"。三方聚合**不算** ——
     * 它有自己的 `verificationLevel`，不要用这个字段去概括。
     */
    verified: Boolean(place && place.verifiedAt),
    verificationLevel: level,
    verificationLabel: VERIFICATION_LABEL[level],
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
  // 核验等级（三级，2026-10-14）
  VERIFICATION_LEVEL,
  VERIFICATION_LABEL,
  verificationLevelOf,
  assertCanBeTripNode,
  // 兼容旧名：按集合点从严解释
  isPlaceUsable,
  assertPlaceUsable,
  canReadLocation,
};

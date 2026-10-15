'use strict';

/**
 * 踏勘录入 —— `place.survey`。
 *
 * ── 为什么必须有它 ────────────────────────────────────────
 *
 * 2026-10-13 的决定是：**检索到的地点不再入库**，`places` 集合只由踏勘写入。
 * 理由是"库里有这条"会被读成"我们确认过这个地方"，而未核验的上游数据
 * 和踏勘核验过的数据混在一个集合里，准入分级（§2.2.1）就失去了依据。
 *
 * 但那个决定只做了一半：**写入的口子没有开**。结果是 10/16 踏勘的数据
 * 只能手工往控制台里敲 —— 而当晚就要用它跑通集合点推荐。
 *
 * ── 这个动作真正要保证的事 ────────────────────────────────
 *
 * 不是"字段写进去了"，而是**`canBeMeetingPoint()` 从此返回 true**。
 * 这是两个不同的命题：`verifiedAt` 漏写、`confidence: 'low'` 写错、
 * 坐标写成 `lat/lng` 而 `authz` 读 `latitude/longitude` —— 任何一条都会
 * 让记录"看起来录好了，但推荐里永远不出现"，而且**不报错**。
 *
 * 所以本动作的返回值里直接给出 `eligibility`，让录入者当场看到后果，
 * 而不是等到晚上推荐为空时再回头猜（见 §11.3「失败原因可定位」）。
 *
 * ── 环境守卫 ──────────────────────────────────────────────
 *
 * 与 `ops.initDb` / `ops.cleanupPlaceholderPlaces` 同一惯例：仅 dev。
 * 这条数据是**可信度层**的输入，被污染之后整条准入链的说法都不成立。
 */

const resp = require('../lib/resp');
const { CODES, assert, require_fields } = require('../lib/errors');
const { placeEligibility } = require('../lib/authz');
const { isPlaceholderPlace } = require('../lib/placeholder-place');
const { WALK_SOURCE } = require('../lib/geo');
const { logEvent } = require('../lib/trace');
const C = require('../lib/repo/collections');

/** 与 docs/01 §2.2 的 category 枚举一致 */
const CATEGORIES = ['spot', 'entrance', 'exit', 'rest', 'food', 'toilet', 'meeting'];
const CONFIDENCE = ['high', 'medium', 'low'];
/** 地点来源 —— 计划书 §2.2 原话是"现场踏勘 / 官网 / 电话" */
const DATA_SOURCES = ['survey', 'official-site', 'phone', 'aggregated'];

/**
 * 把坐标统一成 `{latitude, longitude}`。
 *
 * ⚠️ 上游（腾讯/高德）返回的是 `lat` / `lng`，而全库与 `authz.hasCoordinate`
 * 读的是 `latitude` / `longitude`。**两种写法都接受，但落库时只写后者** ——
 * 否则会得到一条"有坐标"却被判为"缺坐标"的记录，且没有任何报错。
 */
function normalizeLocation(raw, fieldName) {
  if (!raw) return null;
  const lat = raw.latitude !== undefined ? raw.latitude : raw.lat;
  const lng = raw.longitude !== undefined ? raw.longitude : raw.lng;
  assert(
    typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng),
    CODES.INVALID_PARAM,
    `${fieldName} 必须是 {latitude, longitude}（或 {lat, lng}）且为有限数字`,
    { received: raw }
  );
  assert(lat >= -90 && lat <= 90, CODES.INVALID_PARAM, `${fieldName}.latitude 超出 -90~90`);
  assert(lng >= -180 && lng <= 180, CODES.INVALID_PARAM, `${fieldName}.longitude 超出 -180~180`);
  return { latitude: lat, longitude: lng };
}

function normalizeVisitDuration(raw) {
  if (!raw) return null;
  // 允许直接给一个数字，等价于 {default: n}
  if (typeof raw === 'number') {
    assert(raw > 0, CODES.INVALID_PARAM, 'visitDurationMin 必须为正数');
    return { min: raw, default: raw, max: raw };
  }
  const min = raw.min;
  const def = raw.default;
  const max = raw.max;
  for (const [k, v] of [['min', min], ['default', def], ['max', max]]) {
    assert(typeof v === 'number' && v > 0, CODES.INVALID_PARAM, `visitDurationMin.${k} 必须是正数`);
  }
  assert(min <= def && def <= max, CODES.INVALID_PARAM, 'visitDurationMin 必须满足 min ≤ default ≤ max', {
    received: raw,
  });
  return { min, default: def, max };
}

/**
 * 步行时间记录。`source` **不得缺省**（docs/01 §2.2 的写入规则）：
 * 由地图接口取回的一律 `upstream`，踏勘实测才是 `survey` ——
 * 缺省会让人把估算当实测用。
 */
function normalizeWalkableTo(raw) {
  if (raw === undefined || raw === null) return null;
  assert(Array.isArray(raw), CODES.INVALID_PARAM, 'walkableTo 必须是数组');
  return raw.map((rec, i) => {
    assert(rec && typeof rec === 'object', CODES.INVALID_PARAM, `walkableTo[${i}] 必须是对象`);
    assert(rec.placeId, CODES.INVALID_PARAM, `walkableTo[${i}].placeId 必填`);
    assert(
      typeof rec.walkMin === 'number' && rec.walkMin > 0,
      CODES.INVALID_PARAM,
      `walkableTo[${i}].walkMin 必须是正数（分钟）`
    );
    const source = rec.source || WALK_SOURCE.SURVEY;
    assert(
      Object.values(WALK_SOURCE).includes(source),
      CODES.INVALID_PARAM,
      `walkableTo[${i}].source 必须是 ${Object.values(WALK_SOURCE).join(' / ')}`
    );
    return {
      placeId: rec.placeId,
      walkMin: rec.walkMin,
      walkMeters: typeof rec.walkMeters === 'number' ? rec.walkMeters : null,
      source,
      verifiedAt: rec.verifiedAt || null,
      measuredAt: rec.measuredAt || null,
    };
  });
}

/**
 * 照片。**`verified` 由来源推导，不接受调用方自报** ——
 * 这正是 §6.6「检索到资料 ≠ 资料可信」要防的那件事：
 * 联网抓来的图能自己声称已核验，标注就失去意义。
 */
function normalizePhotos(raw) {
  if (raw === undefined || raw === null) return null;
  assert(Array.isArray(raw), CODES.INVALID_PARAM, 'photos 必须是数组');
  return raw.map((ph, i) => {
    assert(ph && ph.url, CODES.INVALID_PARAM, `photos[${i}].url 必填`);
    const source = ph.source || 'survey';
    assert(
      source === 'survey' || source === 'upstream',
      CODES.INVALID_PARAM,
      `photos[${i}].source 只能是 survey（踏勘实拍）或 upstream（联网抓取）`
    );
    return {
      url: ph.url,
      source,
      // 踏勘实拍才算核验过；联网抓来的一律 false，不给自报的余地
      verified: source === 'survey',
      capturedAt: ph.capturedAt || null,
      capturedBy: ph.capturedBy || null,
      /** 抓取来源的归属（如 amap），答辩与合规都需要能说清图从哪来 */
      provider: ph.provider || null,
      credit: ph.credit || null,
    };
  });
}

/** 只挑出调用方**显式给了**的字段，避免用 undefined 覆盖已有值 */
function pickPatch(p) {
  const patch = {};

  if (p.name !== undefined) {
    assert(String(p.name).trim().length > 0, CODES.INVALID_PARAM, 'name 不能为空');
    patch.name = String(p.name).trim();
  }
  if (p.aliases !== undefined) {
    assert(Array.isArray(p.aliases), CODES.INVALID_PARAM, 'aliases 必须是数组');
    patch.aliases = p.aliases.map((a) => String(a));
  }
  if (p.category !== undefined) {
    assert(CATEGORIES.includes(p.category), CODES.INVALID_PARAM, `category 必须是 ${CATEGORIES.join(' / ')}`, {
      received: p.category,
    });
    patch.category = p.category;
  }
  if (p.location !== undefined) patch.location = normalizeLocation(p.location, 'location');
  if (p.entranceLocation !== undefined) {
    patch.entranceLocation = p.entranceLocation === null ? null : normalizeLocation(p.entranceLocation, 'entranceLocation');
  }
  if (p.openHours !== undefined) patch.openHours = p.openHours;
  if (p.openCondition !== undefined) patch.openCondition = p.openCondition;
  if (p.ticketRequired !== undefined) patch.ticketRequired = Boolean(p.ticketRequired);
  if (p.visitDurationMin !== undefined) patch.visitDurationMin = normalizeVisitDuration(p.visitDurationMin);
  if (p.walkableTo !== undefined) patch.walkableTo = normalizeWalkableTo(p.walkableTo);
  if (p.photos !== undefined) patch.photos = normalizePhotos(p.photos);
  if (p.tags !== undefined) patch.tags = p.tags;
  if (p.notes !== undefined) patch.notes = p.notes;

  /**
   * 核验三件套 —— 这三个字段决定"能不能当集合点"，也是本动作存在的理由。
   *
   * `verifiedAt` **不给就让录入者以为录了、实际没核验**：缺省视为"本次踏勘即核验"，
   * 用服务端时间写入。要显式表达"还没核验"就传 `null`。
   */
  if (p.verifiedAt !== undefined) {
    patch.verifiedAt = p.verifiedAt === null ? null : new Date(p.verifiedAt);
    assert(
      patch.verifiedAt === null || !Number.isNaN(patch.verifiedAt.getTime()),
      CODES.INVALID_PARAM,
      'verifiedAt 不是合法时间'
    );
  }
  if (p.verifiedBy !== undefined) patch.verifiedBy = p.verifiedBy;
  if (p.confidence !== undefined) {
    assert(CONFIDENCE.includes(p.confidence), CODES.INVALID_PARAM, `confidence 必须是 ${CONFIDENCE.join(' / ')}`);
    patch.confidence = p.confidence;
  }
  if (p.dataSource !== undefined) {
    assert(
      DATA_SOURCES.includes(p.dataSource),
      CODES.INVALID_PARAM,
      `dataSource 必须是 ${DATA_SOURCES.join(' / ')}（"踏勘 / 官网 / 电话 / 三方聚合"）`,
      { received: p.dataSource }
    );
    patch.dataSource = p.dataSource;
  }

  /**
   * ── 三级核验（2026-10-14）────────────────────────────────
   *
   * 现实是本队只来得及实地核验一两个点，而集合点推荐需要几个候选才有意义。
   * 于是"没实地核验过的地方能不能当集合点"这个问题必须显式回答，而不是靠缺省。
   *
   *   verifiedAt 非空                 → level 0「已实地核验」
   *   meetingPointEligible === true   → level 1「未实地核验 · 三方聚合」
   *   两者都没有                       → level 2「仅行程节点」
   *
   * ⚠️ level 1 **必须显式传** `meetingPointEligible: true`。
   * 刻意不做成缺省值：一个只带了坐标的记录不该"顺手"变成集合点候选。
   */
  if (p.meetingPointEligible !== undefined) {
    assert(
      typeof p.meetingPointEligible === 'boolean',
      CODES.INVALID_PARAM,
      'meetingPointEligible 必须是布尔值'
    );
    patch.meetingPointEligible = p.meetingPointEligible;
  }

  /**
   * 实地核验与三方聚合**不能同时成立** —— 后者按定义就是"没去现场"。
   * 这条断言防的是最危险的一种记录：`verifiedAt` 被填上、看起来已核验，
   * 而它其实只有三方数据。§6.6「检索到资料 ≠ 资料可信」防的就是这个。
   */
  if (patch.meetingPointEligible === true) {
    assert(
      patch.verifiedAt === undefined || patch.verifiedAt === null,
      CODES.INVALID_PARAM,
      'meetingPointEligible 表示"未实地核验"，不能同时写 verifiedAt。' +
        '实地核验过就不需要这个开关（verifiedAt 本身已足以准入）',
      { verifiedAt: patch.verifiedAt, meetingPointEligible: patch.meetingPointEligible }
    );
  }

  return patch;
}

async function survey(ctx) {
  const { repo } = ctx;
  const p = ctx.payload || {};

  /**
   * 仅 dev。与 ops.initDb 同惯例 —— 踏勘数据是可信度层的输入，
   * 被污染之后准入分级的整套说法就不再成立。
   */
  assert(ctx.env === 'dev', CODES.FORBIDDEN_ENV, `当前环境为 ${ctx.env}，踏勘录入仅限 dev`);

  const isUpdate = Boolean(p.placeId);

  if (isUpdate) {
    const existing = await repo.get(C.PLACES, p.placeId);
    assert(existing, CODES.NOT_FOUND, '地点不存在，无法更新', { placeId: p.placeId });
    const patch = pickPatch(p);
    assert(Object.keys(patch).length > 0, CODES.INVALID_PARAM, '没有需要更新的字段');

    const { doc } = await repo.update(C.PLACES, p.placeId, patch);
    await logEvent(repo, {
      ts: new Date(ctx.now ? ctx.now : Date.now()),
      type: 'data_change',
      action: 'place.survey',
      userId: ctx.openid,
      placeId: p.placeId,
      mode: 'update',
      fields: Object.keys(patch),
    });

    return resp.ok({
      mode: 'update',
      place: doc,
      /** 录入者当场就能看到"这条现在能不能当集合点"，不必等推荐为空时再回头猜 */
      eligibility: placeEligibility(doc),
      message: describeEligibility(doc),
    });
  }

  // ── 新建：录入一个此前库里没有的地点 ──
  require_fields(p, ['name', 'location', 'category']);
  assert(p.confirm === true, CODES.INVALID_PARAM, '新建地点需显式传入 confirm: true');

  const patch = pickPatch(p);

  /**
   * 缺省语义：**这条记录从一个"踏勘录入"入口进来，就默认它已实地核验**。
   *
   * 不这么做的话，录入者填完名称坐标却忘了 `verifiedAt`，会得到一条
   * "看起来录好了、推荐里永远不出现"的记录 —— 这正是本动作存在的理由。
   * 要表达"未实地核验"，就显式传 `meetingPointEligible: true`。
   */
  if (patch.verifiedAt === undefined && patch.meetingPointEligible !== true) {
    patch.verifiedAt = new Date(ctx.now ? ctx.now : Date.now());
  }
  if (patch.verifiedBy === undefined && patch.verifiedAt) patch.verifiedBy = ctx.openid;

  const location = patch.location;

  /**
   * 按"名字 + 千分位坐标"查重。
   *
   * 用 `place-id.js` 同一套粒度，理由也一样：坐标取三位小数（约 100 米）——
   * 太精确会把同一个地点因上游坐标抖动而变成两条，太粗又会把相邻两家合成一条。
   */
  const sameName = (await repo.find(C.PLACES, { name: patch.name }, { limit: 20 })).filter(
    (row) => !isPlaceholderPlace(row)
  );
  const duplicate = sameName.find(
    (row) =>
      row.location &&
      Math.abs(row.location.latitude - location.latitude) < 0.001 &&
      Math.abs(row.location.longitude - location.longitude) < 0.001
  );
  assert(
    !duplicate,
    CODES.INVALID_PARAM,
    `同名同位置的地点已存在（${duplicate && duplicate._id}），请改用 placeId 更新，避免出现两条看起来一样的记录`,
    { existingPlaceId: duplicate && duplicate._id }
  );

  const doc = await repo.insert(C.PLACES, Object.assign({}, patch, { coordSys: 'gcj02' }));

  await logEvent(repo, {
    ts: new Date(ctx.now ? ctx.now : Date.now()),
    type: 'data_change',
    action: 'place.survey',
    userId: ctx.openid,
    placeId: doc._id,
    mode: 'create',
    fields: Object.keys(patch),
  });

  return resp.ok({
    mode: 'create',
    place: doc,
    eligibility: placeEligibility(doc),
    message: describeEligibility(doc),
  });
}

/**
 * 把准入后果翻成一句人能读懂的话 —— 录入当晚最需要知道的就是这一句。
 *
 * 刻意把 **等级** 说出来（已实地核验 / 未实地核验·三方聚合），而不是笼统说"可作集合点"：
 * 两者可信度不同，录入者必须当场知道自己在录哪一种。
 */
function describeEligibility(place) {
  const elig = placeEligibility(place);
  if (elig.verificationLevel === 'field-survey') return '已实地核验，可作集合点，也可作行程节点';
  if (elig.verificationLevel === 'aggregated') {
    return '未实地核验（三方聚合），可作集合点；界面与接口必须标注这一点，不得当成已核验';
  }
  if (elig.meetingPoint) return '可作集合点，也可作行程节点，无需实地核验';
  if (elig.tripNode) return '可作行程节点；资料可信度较低或已标记为不适合集合';
  return '既不能作行程节点也不能作集合点：缺名称或坐标（坐标缺失会让步行时间失真）';
}

module.exports = survey;
module.exports.CATEGORIES = CATEGORIES;
module.exports.DATA_SOURCES = DATA_SOURCES;

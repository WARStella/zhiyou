'use strict';

/**
 * 测试夹具 —— 已核验的地点，用于跑通规划与集合算法。
 *
 * ⚠️ 这里的坐标是基于公开地图的**近似值**，walkableTo 的步行分钟数也是估计值。
 * 它们**只用于算法自测**，不得写入生产库、不得作为踏勘结果引用。
 * 10/16 踏勘后由 C 用真实数据替换（届时 confidence 升为 high）。
 */

const VERIFIED_AT = new Date('2026-10-16T02:00:00.000Z');

const places = [
  {
    _id: 'p_zhongyang',
    name: '中央大街',
    aliases: ['中央大街', '步行街'],
    category: 'spot',
    coordSys: 'gcj02',
    location: { latitude: 45.7756, longitude: 126.6175 },
    entranceLocation: { latitude: 45.7756, longitude: 126.6175 },
    visitDurationMin: { min: 20, default: 45, max: 120 },
    walkableTo: [
      { placeId: 'p_fanghong', walkMin: 8, walkMeters: 620, verifiedAt: VERIFIED_AT },
      { placeId: 'p_sofia', walkMin: 9, walkMeters: 700, verifiedAt: VERIFIED_AT },
      { placeId: 'p_zhaolin', walkMin: 7, walkMeters: 540, verifiedAt: VERIFIED_AT },
    ],
    dataSource: '测试夹具（非踏勘结果）',
    verifiedAt: VERIFIED_AT,
    verifiedBy: 'fixture',
    confidence: 'high',
    tags: ['街区'],
  },
  {
    _id: 'p_fanghong',
    name: '防洪纪念塔',
    aliases: ['防洪纪念塔'],
    category: 'meeting',
    coordSys: 'gcj02',
    location: { latitude: 45.781, longitude: 126.6185 },
    entranceLocation: { latitude: 45.781, longitude: 126.6185 },
    visitDurationMin: { min: 10, default: 20, max: 40 },
    walkableTo: [
      { placeId: 'p_stalin', walkMin: 5, walkMeters: 380, verifiedAt: VERIFIED_AT },
    ],
    dataSource: '测试夹具（非踏勘结果）',
    verifiedAt: VERIFIED_AT,
    verifiedBy: 'fixture',
    confidence: 'high',
    tags: ['广场', '集合点候选'],
  },
  {
    _id: 'p_sofia',
    name: '圣索菲亚教堂',
    aliases: ['索菲亚'],
    category: 'spot',
    coordSys: 'gcj02',
    location: { latitude: 45.7703, longitude: 126.6206 },
    entranceLocation: { latitude: 45.7705, longitude: 126.621 },
    visitDurationMin: { min: 30, default: 45, max: 60 },
    walkableTo: [],
    dataSource: '测试夹具（非踏勘结果）',
    verifiedAt: VERIFIED_AT,
    verifiedBy: 'fixture',
    confidence: 'high',
    tags: ['建筑'],
  },
  {
    _id: 'p_zhaolin',
    name: '兆麟公园',
    aliases: ['兆麟公园'],
    category: 'rest',
    coordSys: 'gcj02',
    location: { latitude: 45.7749, longitude: 126.624 },
    entranceLocation: { latitude: 45.775, longitude: 126.6242 },
    visitDurationMin: { min: 15, default: 30, max: 60 },
    walkableTo: [],
    dataSource: '测试夹具（非踏勘结果）',
    verifiedAt: VERIFIED_AT,
    verifiedBy: 'fixture',
    confidence: 'high',
    tags: ['休息'],
  },
  {
    _id: 'p_stalin',
    name: '斯大林公园',
    aliases: ['江畔'],
    category: 'rest',
    coordSys: 'gcj02',
    location: { latitude: 45.783, longitude: 126.619 },
    entranceLocation: { latitude: 45.783, longitude: 126.619 },
    visitDurationMin: { min: 15, default: 30, max: 60 },
    walkableTo: [],
    dataSource: '测试夹具（非踏勘结果）',
    verifiedAt: VERIFIED_AT,
    verifiedBy: 'fixture',
    confidence: 'high',
    tags: ['江景'],
  },
  {
    _id: 'p_laodaowai',
    name: '老道外中华巴洛克街区',
    aliases: ['老道外'],
    category: 'spot',
    coordSys: 'gcj02',
    location: { latitude: 45.757, longitude: 126.642 },
    entranceLocation: null,
    visitDurationMin: { min: 30, default: 60, max: 120 },
    walkableTo: [],
    dataSource: '测试夹具（非踏勘结果）',
    verifiedAt: VERIFIED_AT,
    verifiedBy: 'fixture',
    confidence: 'high',
    tags: ['历史街区'],
  },
  {
    _id: 'p_unverified',
    name: '未核验的某处',
    aliases: [],
    category: 'spot',
    coordSys: 'gcj02',
    location: { latitude: 45.78, longitude: 126.62 },
    entranceLocation: null,
    visitDurationMin: { min: 10, default: 20, max: 30 },
    walkableTo: [],
    dataSource: '测试夹具',
    verifiedAt: null,
    verifiedBy: null,
    confidence: 'low',
    tags: [],
  },
];

const byId = places.reduce((acc, p) => {
  acc[p._id] = p;
  return acc;
}, {});

const DEFAULT_PARAMS = {
  walkSpeedMPerMin: 75,
  stayMinDefault: 30,
  meetBufferMin: 5,
  algoVersion: 'planner-0.1.0-test',
};

module.exports = { places, byId, DEFAULT_PARAMS, VERIFIED_AT };

'use strict';

/**
 * 假地图服务的**演示数据**（POI 池）。
 *
 * ── 为什么把它单独放一个文件 ────────────────────────────────
 *
 * `fake.js` 的职责是**模拟腾讯地图服务的行为**（Key 语义、错误码、返回结构、
 * 坐标与时间的量纲）。而"有哪些地点"是**数据**，两者混在一起会让
 * fake.js 看起来像"为了通过某些测试而凑的一堆特判"。
 *
 * 分开之后边界很清楚：
 *   · fake.js      —— 行为契约（必须与真服务一致）
 *   · fake-data.js —— 演示数据（本身不承载任何断言）
 *
 * ⚠️ **这批数据不是"腾讯会返回什么"的证据。**
 * 它只是给测试提供可预期的对象。腾讯真实的返回分布只能用**真实调用**验证 ——
 * 那正是 `test/fixtures/upstream/` 里录音的用途（见 lib/map/replay.js）。
 */

/**
 * 哈尔滨真实地名，便于人工核对时一眼看出是演示数据。
 *
 * 前 5 条是普通景点；后 2 条**带类别后缀的交通设施**是刻意保留的 ——
 * 它们复现过两次真实缺陷（类目匹配、排序被距离冲掉），
 * 删掉它们会让那两条回归测试失去对象。
 * **类目字符串取自真实返回，不要改成自己编的写法。**
 */
const PLACE_POOL = [
  {
    poiId: 'fake_poi_1',
    title: '圣索菲亚教堂',
    category: '旅游景点:教堂',
    address: '透笼街88号',
    latitude: 45.7703,
    longitude: 126.6206,
  },
  {
    poiId: 'fake_poi_2',
    title: '防洪纪念塔',
    category: '旅游景点:景点',
    address: '中央大街尽头',
    latitude: 45.781,
    longitude: 126.6185,
  },
  {
    poiId: 'fake_poi_3',
    title: '兆麟公园',
    category: '旅游景点:公园',
    address: '森林街41号',
    latitude: 45.7749,
    longitude: 126.624,
  },
  {
    poiId: 'fake_poi_4',
    title: '老道外中华巴洛克',
    category: '旅游景点:历史街区',
    address: '靖宇街',
    latitude: 45.757,
    longitude: 126.642,
  },
  {
    poiId: 'fake_poi_5',
    title: '斯大林公园',
    category: '旅游景点:公园',
    address: '斯大林街',
    latitude: 45.783,
    longitude: 126.619,
  },
  // ── 以下两条是回归夹具，不是普通演示数据 ──
  {
    poiId: 'fake_poi_6',
    title: '冰雪大世界[公交站]',
    category: '基础设施;交通设施:公交车站',
    address: '松北区',
    latitude: 45.7901,
    longitude: 126.59,
  },
  {
    poiId: 'fake_poi_7',
    title: '冰雪大世界[地铁站]',
    category: '基础设施;交通设施:地铁站',
    address: '松北区',
    latitude: 45.7895,
    longitude: 126.5885,
  },
];

module.exports = { PLACE_POOL };

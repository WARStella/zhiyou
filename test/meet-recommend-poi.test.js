'use strict';

/**
 * 集合点推荐：候选从地图 POI 检索来（2026-10-14 用户要求）。
 *
 * 用户原话："这个推荐一个集合点默认按小队成员能同时步行到达的地方算吧，
 *            **注意不要标在马路上**"
 *
 * ── 两句话各对应一处改动 ──────────────────────────────────
 *
 * ① "成员能同时步行到达" —— `recommendMeetPoints` **本来就在做**
 *    （minimax：先让最远的成员步行时间最短，再比平均值与差距）。
 *    真正卡住它的是**候选从哪来**：旧实现只查库里那 200 条，
 *    而那个集合只有限 dev 的 `place.survey` 会写入 —— 线上是空的，
 *    于是永远报 `NO_VERIFIED_PLACE`。**功能从上线起就不可能跑通。**
 *
 * ② "不要标在马路上" —— 这条是靠**来源**保证的，不是靠过滤：
 *    算出来的任何坐标都可能在马路中间、江面或楼顶，
 *    而 POI 检索返回的**必然是真实存在的地点**。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeWorld, makeCrew, expectOk, createMapProvider } = require('./helpers');

/** 成员位置：中央大街附近三个人，彼此相距几百米 */
const MEMBER_POINTS = [
  { latitude: 45.7756, longitude: 126.6175 },
  { latitude: 45.7800, longitude: 126.6200 },
  { latitude: 45.7720, longitude: 126.6150 },
];

/**
 * 建一个三人小队并让每个人都上报位置。
 *
 * ⚠️ 必须**三人都有位置**：`recommend` 的口径是"任一成员缺位置就
 *   整体不出候选"（`MEMBER_NO_LOCATION`），一人队测不出推荐逻辑。
 *
 * `makeCrew` 会把 B、C 两个客户端都拉进队，所以三个位置正好
 * 一人一个 —— 同一个账号上报两次只会覆盖，人数还是 1。
 */
async function crewWithLocations(w) {
  const { crewId } = await makeCrew(w, '推荐测试小队');
  const who = ['A', 'B', 'C'];
  for (let i = 0; i < MEMBER_POINTS.length; i++) {
    expectOk(
      await w[who[i]]('loc.report', { crewId, point: MEMBER_POINTS[i], source: 'manual' })
    );
  }
  return { crewId };
}

// ── 核心：库里没有候选时回退到 POI 检索 ─────────────────────

test('库里没有集合点候选时，**回退到地图 POI 检索**并给出候选', async () => {
  /**
   * ⚠️ 这条是本次改动的核心。夹具默认是有地点的，
   *    所以必须显式 `seedPlaces: []` 才能走到回退分支 ——
   *    不这么做的话新代码一次都不会被执行，而测试全绿。
   */
  const w = await makeWorld({ seedPlaces: [] });
  const { crewId } = await crewWithLocations(w);

  const rec = expectOk(await w.A('meet.recommend', { crewId }));

  assert.ok(rec.candidates.length > 0, '空库时应当靠检索给出候选，而不是报"没有地点数据"');
  assert.equal(rec.candidateSource, 'poi-search', '要如实说明候选来自检索');

  const top = rec.candidates[0];
  assert.ok(top.placeName, '候选必须带地点名 —— 集合点名称要能填进表单');
  assert.ok(top.point && typeof top.point.latitude === 'number', '候选必须带坐标');
  /** ⚠️ 检索出来的点不在 places 里，id 用 `poi_` 前缀标明这一点 */
  assert.match(top.placeId, /^poi_/, '检索候选的 id 要能一眼看出不是库里的记录');
});

test('检索候选**不是马路上** —— 全部来自 POI 池（有名字的真实地点）', async () => {
  /**
   * 用户要求"注意不要标在马路上"。
   *
   * 这条不是靠坐标过滤保证的，而是靠**来源**：POI 检索只会返回
   * 有名字的真实地点。所以断言就落在"每个候选都有名字"上 ——
   * 一个算出来的任意坐标是没有名字的。
   */
  const w = await makeWorld({ seedPlaces: [] });
  const { crewId } = await crewWithLocations(w);
  const rec = expectOk(await w.A('meet.recommend', { crewId }));

  for (const c of rec.candidates) {
    assert.ok(c.placeName && c.placeName.trim().length, `候选 ${c.placeId} 必须有地点名`);
    assert.ok(c.point, `候选 ${c.placeId} 必须有坐标`);
  }
});

test('检索中心是成员的**几何中心** —— 与 minimax 目标一致', async () => {
  /**
   * "到各点最大距离最小"的位置正是几何中心，与推荐目标同向。
   * 拿某一个成员的位置当中心，会让其他人系统性偏远。
   *
   * 这里通过**断言检索请求**来验证：抓 provider 收到的 center。
   */
  const seen = [];
  const mapFactory = (name, opts) => {
    const p = createMapProvider(name || 'fake', opts);
    const orig = p.searchPlaces.bind(p);
    p.searchPlaces = function (input) {
      seen.push(input.center);
      return orig(input);
    };
    return p;
  };

  const w = await makeWorld({ seedPlaces: [], createMapProvider: mapFactory });
  const { crewId } = await crewWithLocations(w);
  expectOk(await w.A('meet.recommend', { crewId }));

  assert.ok(seen.length > 0, '必须真的发起过检索');
  const c = seen[0];
  /** 三个人都要算进去 —— 只取前两个是我第一版写错的期望值 */
  const n = MEMBER_POINTS.length;
  const expLat = MEMBER_POINTS.reduce((s, p) => s + p.latitude, 0) / n;
  const expLng = MEMBER_POINTS.reduce((s, p) => s + p.longitude, 0) / n;
  assert.ok(Math.abs(c.latitude - expLat) < 1e-9, '纬度应当是成员位置的几何中心');
  assert.ok(Math.abs(c.longitude - expLng) < 1e-9, '经度同理');
});

test('检索半径用**步行可达范围** —— 不然检索回来的点会被 TOO_FAR 全排除', async () => {
  const seen = [];
  const mapFactory = (name, opts) => {
    const p = createMapProvider(name || 'fake', opts);
    const orig = p.searchPlaces.bind(p);
    p.searchPlaces = function (input) {
      seen.push(input.radius);
      return orig(input);
    };
    return p;
  };

  const w = await makeWorld({ seedPlaces: [], createMapProvider: mapFactory });
  const { crewId } = await crewWithLocations(w);
  expectOk(await w.A('meet.recommend', { crewId }));

  const geo = require('../cloudfunctions/api/lib/geo');
  for (const r of seen) {
    assert.equal(r, geo.MAX_WALK_METERS, '半径要与步行可达上限一致');
  }
});

// ── 检索失败时要说清原因 ───────────────────────────────────

test('地图 Key 没配时**如实报配置问题**，不说"附近没有地方"', async () => {
  /**
   * ⚠️ 两者修法完全不同：一个是去控制台配 Key，一个是换个地方碰头。
   *    混成一句"推荐不出集合点"会让人一直换关键词找一个连不通的服务。
   */
  const mapFactory = () => ({
    searchPlaces: async () => ({
      ok: false,
      reason: 'MAP_KEY_NOT_CONFIGURED',
      message: '云函数环境变量 MAP_KEY 未配置，无法调用地图服务',
      hint: '云开发控制台 → 云函数 → api → 配置 → 环境变量 → 新增 MAP_KEY',
    }),
  });

  const w = await makeWorld({ seedPlaces: [], createMapProvider: mapFactory });
  const { crewId } = await crewWithLocations(w);
  const rec = expectOk(await w.A('meet.recommend', { crewId }));

  assert.equal(rec.candidates.length, 0);
  assert.equal(rec.reason, 'MAP_KEY_NOT_CONFIGURED', '原因要原样透出，不要归一成一句"没找到"');
  assert.match(rec.message, /MAP_KEY/);
  assert.ok(rec.manualFallback, '要让界面知道还有"手动选点"这条路');
});

test('检索到的点全都步行不可达时，如实说明而不是硬推荐一个远的', async () => {
  /**
   * ⚠️ 这条守的是"**能同时步行到达**"这个前提。
   *
   * 造一个"POI 离成员几公里"的场景：`recommendMeetPoints` 会按
   * `MAX_WALK_METERS` 把它们全排除（`TOO_FAR`）。此时应当**没有候选**，
   * 而不是硬推荐一个要走一小时的集合点。
   */
  const faraway = {
    latitude: 45.9,
    longitude: 126.9,
  };
  const mapFactory = () => ({
    searchPlaces: async () => ({
      ok: true,
      items: [{ poiId: 'x1', title: '很远的地方', location: faraway, address: '某路 1 号' }],
    }),
  });

  const w = await makeWorld({ seedPlaces: [], createMapProvider: mapFactory });
  const { crewId } = await crewWithLocations(w);
  const rec = expectOk(await w.A('meet.recommend', { crewId }));

  assert.equal(rec.candidates.length, 0, '走不到就不该推荐');
  const why = (rec.excluded || []).find((e) => e.reason === 'TOO_FAR');
  assert.ok(why, '而且要说清是"走不到"，不是"没找到"');
});

// ── 库里有点时优先用库里的 ─────────────────────────────────

test('库里**有**可用候选时优先用库里的 —— 那是有人实地核验过的', async () => {
  /**
   * 检索结果不入库（2026-10-13 用户决定），可信度低于人工录入的地点：
   * 有人跑过现场，至少知道入口在哪。所以有就用，检索只作兜底。
   */
  const w = await makeWorld(); // 默认夹具，里面有 meeting 类目的地点
  const { crewId } = await crewWithLocations(w);
  const rec = expectOk(await w.A('meet.recommend', { crewId }));

  assert.equal(rec.candidateSource, 'library', '不该无缘无故去花检索配额');
  assert.ok(rec.candidates.length > 0);
  for (const c of rec.candidates) {
    assert.equal(/^poi_/.test(c.placeId), false, '这一轮的候选应当都来自库里');
  }
});

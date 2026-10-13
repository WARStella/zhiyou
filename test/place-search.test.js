'use strict';

/**
 * 地点检索与候选池测试。
 *
 * 这一层的核心主张：**外部检索保证覆盖度，实地踏勘保证可信度。**
 * 所以测试重点不是"能不能搜到"，而是：
 *   · 检索回来的地点是否**一律标注未核验**（不能假装可信）
 *   · 它们能不能作行程节点、能不能作集合点（分级是否正确）
 *   · 去重是否有效（同一 POI 反复检索不能把库撑爆）
 *   · 不入库模式是否真的没写库
 *
 * 全程使用假地图服务，不发真实 HTTP（慢、不稳定、要花钱）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeWorld, expectOk, NOW, C } = require('./helpers');

const FAKE = { provider: 'fake' };
const CENTER = { latitude: 45.7756, longitude: 126.6175 };

// ── 基本检索 ──────────────────────────────────────────────

test('地点检索：候选一律入库并标注未核验，可游览不可集合', async () => {
  const w = await makeWorld();
  const res = expectOk(
    await w.A('place.search', Object.assign({ keyword: '教堂', center: CENTER }, FAKE))
  );

  assert.equal(res.ok, true);
  assert.ok(res.candidates.length >= 1);
  assert.equal(res.saved.created, res.candidates.length, '新检索到的地点应全部入库');

  const first = res.candidates[0];
  assert.ok(first.placeId, '入库后必须有 placeId，否则无法加入行程');
  assert.equal(first.verified, false, '外部检索地点一律未核验');
  assert.equal(first.dataSource, 'tencent-poi');
  assert.equal(first.visitDurationSource, 'default-untuned', '停留时长是估值，必须标出来源');

  // 分级验证：能作行程节点，不能作集合点
  const listed = expectOk(await w.A('place.list', {}));
  const found = listed.places.find((x) => x.placeId === first.placeId);
  assert.equal(found.tripNodeAllowed, true, '未核验地点应可作行程节点');
  assert.equal(found.meetingPointAllowed, false, '未核验地点不可作集合点');
});

test('地点检索：停留时长是估值，必须随结果说明', async () => {
  const w = await makeWorld();
  const res = expectOk(await w.A('place.search', Object.assign({ keyword: '教堂', center: CENTER }, FAKE)));

  assert.match(res.ranking.timeEstimateCaveat, /估值|踏勘/);
  assert.match(res.ranking.timeEstimateCaveat, /default-untuned/);
});

test('地点检索：不给范围时退回默认中心，且必须回传用了哪个中心', async () => {
  const w = await makeWorld();

  // 本项目定位是"单城"（哈尔滨），不给范围时退回市中心是合理默认 ——
  // 但调用方必须能看见，否则会误以为结果来自自己指定的位置。
  const fallback = expectOk(await w.A('place.search', Object.assign({ keyword: '' }, FAKE)));
  assert.equal(fallback.ok, true);
  assert.ok(fallback.centerUsed, '必须回传实际使用的中心');
  assert.equal(typeof fallback.centerUsed.latitude, 'number');
  assert.equal(fallback.regionUsed, null);

  // 给了 region 就不该再套一个中心
  const byRegion = expectOk(
    await w.A('place.search', Object.assign({ keyword: '公园', region: '哈尔滨' }, FAKE))
  );
  assert.equal(byRegion.ok, true);
  assert.equal(byRegion.centerUsed, null, '用城市范围检索时不该凭空造一个中心');
  assert.equal(byRegion.regionUsed, '哈尔滨');
});

test('地点检索：provider 层缺检索范围必须失败，不猜也不放行', async () => {
  const { createMapProvider } = require('../cloudfunctions/api/lib/map');
  const provider = createMapProvider('fake');

  const r = await provider.searchPlaces({ keyword: '教堂' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'SEARCH_BOUNDARY_REQUIRED');
  assert.match(r.hint, /center|region/);
});

test('地点检索：缺 Key 是失败，且不写库', async () => {
  const w = await makeWorld();
  const before = (await w.A('place.list', {})).data.places.length;

  // 覆盖 Key 为空 → provider 拒绝（仅 dev 环境接受 overrideKey）
  const res = expectOk(
    await w.A('place.search', {
      keyword: '教堂',
      center: CENTER,
      provider: 'fake',
      overrideKey: '',
    })
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'MAP_KEY_NOT_CONFIGURED');
  assert.ok(res.hint, '失败要给出可执行的修复指引');

  const after = (await w.A('place.list', {})).data.places.length;
  assert.equal(after, before, '失败不得写库');
});

// ── 去重 ──────────────────────────────────────────────────

test('地点检索：同一 POI 反复检索不重复入库', async () => {
  const w = await makeWorld();
  const q = Object.assign({ keyword: '教堂', center: CENTER }, FAKE);

  const first = expectOk(await w.A('place.search', q));
  assert.equal(first.saved.created, 1);
  assert.equal(first.saved.reused, 0);

  const second = expectOk(await w.A('place.search', q));
  assert.equal(second.saved.created, 0, '第二次不应再建新记录');
  assert.equal(second.saved.reused, 1, '应复用已有记录');
  assert.equal(second.candidates[0].placeId, first.candidates[0].placeId, 'placeId 必须稳定');

  const listed = expectOk(await w.A('place.list', {}));
  assert.equal(listed.total, 8, '7 条夹具 + 1 条新检索');
});

test('地点检索：save:false 只给候选，不写库', async () => {
  const w = await makeWorld();
  const res = expectOk(
    await w.A('place.search', Object.assign({ keyword: '公园', center: CENTER, save: false }, FAKE))
  );

  assert.equal(res.ok, true);
  assert.ok(res.candidates.length >= 1);
  assert.equal(res.saved.created, 0);
  assert.equal(
    res.candidates.every((x) => x.placeId === null && x.saved === false),
    true,
    '未入库的候选没有 placeId，界面要据此禁用"加入行程"'
  );
  assert.equal((await w.A('place.list', {})).data.places.length, 7, '确实没有写库');
});

// ── 排序 ──────────────────────────────────────────────────

test('地点检索：交通设施排在最后，并被标记为不可游览', async () => {
  /**
   * 真实事故：搜「冰雪大世界」，上游把「冰雪大世界[公交站]」排在前面。
   * 它是公交站，不是那个冰雪乐园。
   *
   * 这里**不硬过滤**（用户也可能真的在找某个交通设施），
   * 而是稳定地排到后面并打上标记。
   */
  const w = await makeWorld();
  const res = expectOk(await w.A('place.search', Object.assign({ keyword: '', center: CENTER }, FAKE)));

  const flags = res.candidates.map((c) => c.visitable);
  assert.ok(flags.includes(false), '夹具里必须有不可游览的地点，否则这条测试没覆盖到');
  assert.ok(flags.includes(true));

  const firstNon = flags.indexOf(false);
  const lastVis = flags.lastIndexOf(true);
  assert.ok(firstNon > lastVis, '可游览的必须全部排在不可游览之前');

  // 上游相对顺序在两组内部仍要保持
  const visIdx = res.candidates.filter((c) => c.visitable).map((c) => c.upstreamIndex);
  for (let i = 1; i < visIdx.length; i++) {
    assert.ok(visIdx[i] > visIdx[i - 1], '同组内必须保持上游顺序');
  }

  // 那条公交站确实被判为不可游览
  const stop = res.candidates.find((c) => String(c.name).indexOf('公交站') >= 0);
  assert.ok(stop, '夹具里的公交站应当出现在结果里（只是排在后面）');
  assert.equal(stop.visitable, false);

  assert.match(res.ranking.note, /交通设施/);
});

test('地点检索：默认按上游相关性排序，而不是按距离重排', async () => {
  const w = await makeWorld();
  const res = expectOk(await w.A('place.search', Object.assign({ keyword: '', center: CENTER }, FAKE)));

  /**
   * ⚠️ 首版默认按"到检索中心的直线距离"重排，**把上游的相关性排序整个冲掉了**。
   * 实测后果：搜「冰雪大世界」时结果前列全是附近的地铁站，真正的目标被挤到后面。
   * 搜索的第一诉求是"找到我要的那个地方"，那是相关性。
   */
  assert.equal(res.ranking.basis, 'relevance');
  assert.equal(res.mapApiCalls, 1, '相关性排序零配额成本');

  const idx = res.candidates.map((c) => c.upstreamIndex);
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i] > idx[i - 1], '必须保持上游顺序');
  }

  // 距离仍然照常计算并返回 —— 只是不再当排序依据
  assert.equal(
    res.candidates.every((c) => typeof c.straightLineMeters === 'number'),
    true,
    '距离仍要给出，供用户参考'
  );
  assert.match(res.ranking.note, /相关性/);
  assert.ok(res.ranking.basisMeaning.relevance);

  // 与显式的距离排序**确实不同** —— 否则这条测试等于没测
  const byDist = expectOk(
    await w.A('place.search', Object.assign({ keyword: '', center: CENTER, rankBy: 'distance' }, FAKE))
  );
  assert.equal(byDist.ranking.basis, 'distance');
  assert.notDeepEqual(
    res.candidates.map((c) => c.name),
    byDist.candidates.map((c) => c.name),
    '两种排序恰好相同时，这条断言就失去意义了 —— 换一组夹具'
  );

  const dists = byDist.candidates.map((c) => c.straightLineMeters);
  for (let i = 1; i < dists.length; i++) {
    assert.ok(dists[i] >= dists[i - 1], '显式按距离时必须真的按距离升序');
  }
});

test('地点检索：rankBy=verified 时已核验地点优先', async () => {
  const w = await makeWorld();

  // 先用同名的已核验地点占位：把检索回来的 POI 手工标为已核验
  const seeded = expectOk(await w.A('place.search', Object.assign({ keyword: '教堂', center: CENTER }, FAKE)));
  await w.repo.update(C.PLACES, seeded.candidates[0].placeId, {
    verifiedAt: new Date(NOW),
    confidence: 'high',
  });

  const res = expectOk(
    await w.A('place.search', Object.assign({ keyword: '', center: CENTER, rankBy: 'verified' }, FAKE))
  );
  assert.equal(res.ranking.basis, 'verified');
  assert.equal(res.candidates[0].verified, true, '已核验地点应排最前');
});

test('地点检索：enrichWalk 用真实步行时间精排，并如实计入配额', async () => {
  const w = await makeWorld();
  const res = expectOk(
    await w.A(
      'place.search',
      Object.assign({ keyword: '', center: CENTER, enrichWalk: true, enrichWalkTop: 3 }, FAKE)
    )
  );

  assert.equal(res.ranking.enriched, 3);
  assert.equal(res.mapApiCalls, 4, '1 次检索 + 3 次路线 = 4 次配额');
  assert.match(res.ranking.note, /真实步行时间/);

  const withWalk = res.candidates.filter((x) => typeof x.walkMinutes === 'number');
  assert.equal(withWalk.length, 3);
  for (let i = 1; i < withWalk.length; i++) {
    assert.ok(withWalk[i].walkMinutes >= withWalk[i - 1].walkMinutes, '应按步行时间升序');
  }

  // 事件日志要记下真实消耗，11/8 统计成本靠它。
  // ⚠️ invoke 层本来就会写一条 api_call（mapApiCalls 恒为 0），
  //    这里要的是我们自己的 upstream_call，必须按 type 过滤。
  const events = await w.repo.find('events', { type: 'upstream_call', action: 'place.search' });
  assert.equal(events.length, 1);
  assert.equal(events[0].mapApiCalls, 4, '上游调用次数必须如实记录');
  assert.equal(events[0].detail.enriched, 3);
});

// ── 与规划的衔接 ──────────────────────────────────────────

test('检索入库的地点可以直接排进路线，并带未核验标注', async () => {
  const w = await makeWorld();
  const found = expectOk(await w.A('place.search', Object.assign({ keyword: '公园', center: CENTER }, FAKE)));
  const ids = found.candidates.map((x) => x.placeId);

  const trip = expectOk(
    await w.A('trip.plan', { placeIds: ids, startAt: NOW, constraints: [] })
  );

  assert.equal(trip.saved, true, '检索回来的地点应能直接生成路线');
  assert.equal(trip.unverifiedNotice.count, ids.length);
  assert.equal(trip.unverifiedNotice.scope, 'tripNodeOnly');
});

test('检索入库的地点不能作集合点，且排除原因要说明它还能用在哪', async () => {
  const w = await makeWorld();
  const found = expectOk(
    await w.A('place.search', Object.assign({ keyword: '防洪', center: CENTER }, FAKE))
  );
  const placeId = found.candidates[0].placeId;

  // 设成可作集合点的类别（MEET_CATEGORIES 里的值），
  // 排除原因才会走到"未核验"这一支，而不是被类目筛掉
  await w.repo.update(C.PLACES, placeId, { category: 'meeting' });

  const { crewId } = await makeCrewSafe(w);
  const rec = expectOk(await w.A('meet.recommend', { crewId }));
  const why = (rec.excluded || []).find((x) => x.placeId === placeId);
  assert.ok(why, '未核验地点必须出现在排除原因里');
  assert.equal(why.reason, 'PLACE_NOT_MEETING_POINT');
  assert.match(why.message, /可安排为游览节点/);
});

/** 复用 helpers 的建队逻辑（避免各测试文件重复实现） */
async function makeCrewSafe(w) {
  const { makeCrew } = require('./helpers');
  return makeCrew(w);
}

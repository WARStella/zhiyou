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

// ── 多关键词检索 ──────────────────────────────────────────

test('多关键词：用户说了几个地方就搜几次，并轮转合并', async () => {
  /**
   * ⚠️ **真实事故的回归**（2026-10-13）。
   *
   * 用户说「先去哈工大玩一小时再去冰雪大世界玩3小时」，
   * 而 `searchKeyword` 是**单个字符串** —— 检索只发了「哈工大」，
   * 冰雪大世界根本没进候选，用户看到的全是哈工大的各种门。
   *
   * 修好之后还有第二道坎：**合并顺序**。
   * 若按关键词顺序拼接（先搜完 A 再搜 B），第一个词会把列表占满。
   * 所以必须**轮转**：各词的第 1 名、各词的第 2 名……
   */
  const w = await makeWorld();
  const res = expectOk(
    await w.A(
      'place.search',
      Object.assign({ keywords: ['公园', '教堂'], center: CENTER }, FAKE)
    )
  );

  assert.deepEqual(res.keywordsUsed, ['公园', '教堂'], '两个词都要真的发出去');

  const byKw = (kw) => res.candidates.filter((c) => (c.foundBy || []).indexOf(kw) >= 0);
  assert.ok(byKw('公园').length >= 2, '「公园」应当命中多条');
  assert.ok(byKw('教堂').length >= 1, '「教堂」应当命中至少一条');

  // 轮转：前两条必须来自不同的关键词，否则第一个词会占满列表
  const firstTwo = res.candidates.slice(0, 2).map((c) => c.foundBy[0]);
  assert.notEqual(firstTwo[0], firstTwo[1], `前两条不该来自同一个检索词：${firstTwo.join(' / ')}`);
});

test('多关键词：单个关键词时行为不变（向后兼容）', async () => {
  const w = await makeWorld();
  const one = expectOk(
    await w.A('place.search', Object.assign({ keyword: '公园', center: CENTER }, FAKE))
  );
  const list = expectOk(
    await w.A('place.search', Object.assign({ keywords: ['公园'], center: CENTER }, FAKE))
  );

  assert.deepEqual(list.keywordsUsed, ['公园']);
  assert.deepEqual(
    list.candidates.map((c) => c.name),
    one.candidates.map((c) => c.name),
    '同一个词，两种传法结果必须一致'
  );
});

test('多关键词：每个检索词至少预选一个 —— 用户提到的地名不能被名额挤掉', async () => {
  const w = await makeWorld();
  const res = expectOk(
    await w.A(
      'place.search',
      Object.assign(
        {
          keywords: ['公园', '教堂'],
          center: CENTER,
          // 轻松节奏只有 3 个名额；若不做覆盖兜底，第一个词可能全占了
          autoPick: { pace: 'relaxed', keywords: ['公园', '教堂'] },
        },
        FAKE
      )
    )
  );

  assert.deepEqual(res.picked.keywordsMissing, [], '两个词都必须有代表');
  assert.deepEqual(res.picked.keywordsCovered.sort(), ['公园', '教堂'].sort());

  const reasons = res.picked.items.map((x) => x.reason);
  assert.ok(
    reasons.some((r) => /你提到的/.test(r)),
    `覆盖兜底要说明理由，实际：${JSON.stringify(reasons)}`
  );
  assert.ok(res.picked.placeIds.length >= 2);
});

test('多关键词：某个词搜不到时，如实报告而不是假装搜全了', async () => {
  const w = await makeWorld();
  const res = expectOk(
    await w.A(
      'place.search',
      Object.assign(
        {
          keywords: ['公园', '这个地名肯定不存在'],
          center: CENTER,
          autoPick: { pace: 'normal', keywords: ['公园', '这个地名肯定不存在'] },
        },
        FAKE
      )
    )
  );

  assert.deepEqual(
    res.picked.keywordsMissing,
    ['这个地名肯定不存在'],
    '搜不到的词要如实列出来 —— 否则用户以为系统找过了'
  );
  assert.ok(res.picked.keywordsCovered.indexOf('公园') >= 0);
});

test('地点检索：默认全城检索，需要"附近的"时才用坐标', async () => {
  const w = await makeWorld();

  /**
   * ⚠️ 真实事故：用户说「我想去冰雪大世界」，而真正的冰雪大世界在松北区、
   * 离他十几公里，被 `nearby(center, 5000)` 的半径**排除在外** ——
   * 系统于是在附近找了家同名的 VR 游戏店推荐给他。
   *
   * **"找那个地方"（相关性）与"找附近的地方"（距离）是两种检索。**
   */
  const city = expectOk(await w.A('place.search', Object.assign({ keyword: '', center: CENTER }, FAKE)));
  assert.equal(city.scopeUsed, 'city', '默认必须全城检索');
  assert.equal(city.regionUsed, '哈尔滨');
  assert.equal(city.centerUsed, CENTER, '仍然回传中心，用于算距离');

  // 显式要"附近的"时才用坐标
  const near = expectOk(
    await w.A('place.search', Object.assign({ keyword: '', center: CENTER, scope: 'nearby' }, FAKE))
  );
  assert.equal(near.scopeUsed, 'nearby');
  assert.equal(near.regionUsed, null);

  // 给了 region 就用它
  const byRegion = expectOk(
    await w.A('place.search', Object.assign({ keyword: '公园', region: '齐齐哈尔' }, FAKE))
  );
  assert.equal(byRegion.regionUsed, '齐齐哈尔');
  assert.equal(byRegion.centerUsed, null, '用城市范围检索时不该凭空造一个中心');
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

// ── 自动预选（"AI 生成路线"的关键一步） ────────────────────

test('自动预选：节奏决定选几个 —— 说了少走路就不该被塞五个景点', async () => {
  const w = await makeWorld();
  const pick = async (pace) =>
    expectOk(
      await w.A(
        'place.search',
        Object.assign({ keyword: '', center: CENTER, autoPick: { pace: pace } }, FAKE)
      )
    ).picked;

  assert.equal((await pick('relaxed')).limit, 3);
  assert.equal((await pick('normal')).limit, 4);
  assert.equal((await pick('packed')).limit, 5);

  assert.equal((await pick('relaxed')).placeIds.length, 3, '轻松节奏只选 3 个');
  assert.equal((await pick('packed')).placeIds.length, 5, '紧凑节奏选 5 个');

  // 非法节奏按 normal 处理，不报错也不乱选
  assert.equal((await pick('随便')).limit, 4);
  assert.equal((await pick(undefined)).limit, 4);
});

test('自动预选：必去一定选上，且不被数量上限挤掉', async () => {
  const w = await makeWorld();

  // 先让夹具里的景点进库
  const first = expectOk(await w.A('place.search', Object.assign({ keyword: '', center: CENTER }, FAKE)));
  const target = first.candidates.find((c) => c.name === '老道外中华巴洛克');
  assert.ok(target, '夹具里应当有这一条');

  const res = expectOk(
    await w.A(
      'place.search',
      Object.assign(
        {
          keyword: '',
          center: CENTER,
          autoPick: { pace: 'relaxed', mustVisitTexts: ['老道外中华巴洛克'] },
        },
        FAKE
      )
    )
  );

  const ids = res.picked.placeIds;
  assert.ok(ids.includes(target.placeId), '必去的地点必须在预选里 —— 这是用户明说要去的地方');
  assert.equal(
    res.picked.items.find((x) => x.placeId === target.placeId).reason,
    '必去',
    '要能说明为什么选它'
  );
  assert.ok(ids.length >= 3, '必去不占用普通名额');
});

test('自动预选：绝不自动选交通设施', async () => {
  const w = await makeWorld();
  const res = expectOk(
    await w.A(
      'place.search',
      Object.assign({ keyword: '', center: CENTER, autoPick: { pace: 'packed' } }, FAKE)
    )
  );

  const byId = {}
  res.candidates.forEach((c) => {
    byId[c.placeId] = c
  })
  for (const id of res.picked.placeIds) {
    assert.equal(
      byId[id].visitable,
      true,
      `预选里不该出现不可游览的地点：${byId[id].name}`
    )
  }

  // 夹具里确实有不可游览项，否则这条测试没覆盖到
  assert.ok(
    res.candidates.some((c) => c.visitable === false),
    '夹具里必须有交通设施，否则这条断言是空的'
  );
});

test('自动预选：「必去」也必须过类目这一关，交通设施不算', async () => {
  /**
   * ⚠️ **真实事故的回归**（2026-10-13 实测 DeepSeek 发现）。
   *
   * 用户说「我想先去**哈工大**玩一小时」，而"哈工大"是子串，
   * 于是匹配上了「哈工大[地铁站]」「哈工大[公交站]」「哈工大-3口」，
   * 全部被标成"必去" —— 系统一本正经地把一个地铁站排进了行程。
   *
   * **"名字里有这几个字"不等于"这就是那个地方"**，
   * 与"民宿名字里嵌了地标名"是同一类错误。
   */
  const w = await makeWorld();

  const first = expectOk(await w.A('place.search', Object.assign({ keyword: '', center: CENTER }, FAKE)));
  const transit = first.candidates.filter((c) => c.visitable === false);
  assert.ok(transit.length > 0, '夹具里必须有交通设施，否则这条测试是空的');

  // 夹具里的交通设施名字里确实带着地标名（否则测不到这个场景）
  const named = transit.filter((c) => c.name.indexOf('冰雪大世界') >= 0);
  assert.ok(named.length > 0, '夹具里必须有"名字含地标名的交通设施"');

  const res = expectOk(
    await w.A(
      'place.search',
      Object.assign(
        {
          keyword: '',
          center: CENTER,
          autoPick: { pace: 'normal', mustVisitTexts: ['冰雪大世界'] },
        },
        FAKE
      )
    )
  );

  const byId = {};
  res.candidates.forEach((c) => {
    byId[c.placeId] = c;
  });

  for (const id of res.picked.placeIds) {
    assert.equal(
      byId[id].visitable,
      true,
      `必去也不能选交通设施，但它选了：${byId[id].name}`
    );
  }

  // 真正的游览地点该被选中（必去规则本身仍然有效）
  const real = first.candidates.find(
    (c) => c.name.indexOf('冰雪大世界') >= 0 && c.visitable === true
  );
  if (real) {
    assert.ok(
      res.picked.placeIds.includes(real.placeId),
      '真正的冰雪大世界应该因"必去"被选中'
    );
  }
});

test('自动预选：说明里要写清选了谁、为什么', async () => {
  const w = await makeWorld();
  const res = expectOk(
    await w.A(
      'place.search',
      Object.assign({ keyword: '', center: CENTER, autoPick: { pace: 'normal' } }, FAKE)
    )
  );

  assert.match(res.picked.note, /预选 \d+ 个地点/);
  assert.match(res.picked.note, /（/, '每一项都要带理由');
  assert.equal(res.picked.items.length, res.picked.placeIds.length);
});

test('自动预选：不传 autoPick 时不做预选', async () => {
  const w = await makeWorld();
  const res = expectOk(await w.A('place.search', Object.assign({ keyword: '', center: CENTER }, FAKE)));
  assert.equal(res.picked, null, '没要求就不该擅自替用户选');
});

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

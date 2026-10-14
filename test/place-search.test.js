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
/** 纯函数直接测 —— 预选规则是业务规则，必须能被测试（见 place.js 的说明） */
const { autoPick, bestMatch } = require('../cloudfunctions/api/actions/place');

const FAKE = { provider: 'fake' };
const CENTER = { latitude: 45.7756, longitude: 126.6175 };

// ── 基本检索 ──────────────────────────────────────────────

test('地点检索：候选标注未核验，可作行程节点、不可作集合点', async () => {
  const w = await makeWorld();
  // 空关键字返回整个假 POI 池 —— 里面有已踏勘的、也有没踏勘的
  const res = expectOk(
    await w.A('place.search', Object.assign({ keyword: '', center: CENTER }, FAKE))
  );

  assert.equal(res.ok, true);
  assert.ok(res.candidates.length >= 1);
  assert.equal(res.persisted, false, '检索结果不入库（用户决定：全从腾讯地图实时搜）');

  const first = res.candidates.find((c) => !c.matchedSurveyed);
  assert.ok(first, '夹具里必须有**没对上踏勘数据**的候选，否则这条测试是空的');
  assert.equal(first.verified, false, '外部检索地点一律未核验');
  assert.ok(first.name && first.location, '有名称与坐标即可作行程节点');
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
  assert.ok(res.picked.itemIds.length >= 2);
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

// ── 点名模式 vs 区域漫游 ──────────────────────────────────

test('点名去两个地方，就不该替他补到十个', async () => {
  /**
   * ⚠️ **真实事故的回归**（2026-10-13，第四次"名字包含即相等"）。
   *
   * 用户说「先去哈工大玩一小时再去冰雪大世界玩3小时」，
   * 而"必去"的判据是**名字里含这几个字**且**不设数量上限**，
   * 于是候选里 10 条名字带「冰雪大世界」的全进了行程：
   * 冰雪大世界本身、梦幻冰雪馆、VR 游戏店、民宿、宾馆、公寓、摩天轮…
   *
   * **用户说的"冰雪大世界"是一个地方，不是十个。**
   */
  const w = await makeWorld();
  const res = expectOk(
    await w.A(
      'place.search',
      Object.assign(
        {
          keywords: ['公园', '教堂'],
          center: CENTER,
          // 没有 anchorText → 用户点名了具体地方 → 只选点名的
          autoPick: { pace: 'normal', keywords: ['公园', '教堂'], mustVisitTexts: ['公园', '教堂'] },
        },
        FAKE
      )
    )
  );

  assert.equal(
    res.picked.itemIds.length,
    2,
    `点名两个地方就该只有两个，实际 ${res.picked.items.map((x) => x.name).join('、')}`
  );
  const names = res.picked.items.map((x) => x.name);
  assert.ok(names.includes('兆麟公园'), '「公园」要选中一个');
  assert.ok(names.includes('圣索菲亚教堂'), '「教堂」要选中一个');
});

test('点名一个地方时，同名的住宿与附属项不能被一起选进来', async () => {
  /**
   * 实测：搜「冰雪大世界」返回的 10 条里混着
   * 「冰雪大世界民宿」「…欣怡宾馆(冰雪大世界凯利广场店)」「…公寓」——
   * **住的地方不是玩的地方**，看一眼就知道不对。
   *
   * 住宿类的类目常常笼统到查不出来，所以名字也要查。
   */
  const w = await makeWorld();
  const res = expectOk(
    await w.A(
      'place.search',
      Object.assign(
        {
          keywords: ['冰雪大世界'],
          center: CENTER,
          autoPick: { pace: 'normal', keywords: ['冰雪大世界'], mustVisitTexts: ['冰雪大世界'] },
        },
        FAKE
      )
    )
  );

  for (const item of res.picked.items) {
    assert.equal(
      /宾馆|酒店|民宿|公寓|旅馆|客栈|招待所|旅舍/.test(item.name),
      false,
      `住宿场所不该进游览顺序：${item.name}`
    );
  }
  // 夹具里确实有交通设施类，否则这条断言是空的
  assert.ok(res.candidates.some((c) => c.visitable === false), '夹具里必须有不可游览项');
});

test('说了"附近"也**不补足** —— "附近"说的是范围，不是"多给我几个"', async () => {
  /**
   * ⚠️ 这条测试**方向反过来了**（2026-10-14 用户决定）。
   *
   * 它原来叫「区域漫游：说了"附近逛逛"，就该按节奏补足」，
   * 断言的是"有锚点就替他多选几个"。
   *
   * 用户原话：
   *   "我每次搜索完默认帮我选择三个地点，**按理说是一个**"
   *   "为什么需要补足，**用户说去哪就去哪呗**"
   *
   * 我第一版只去调"**什么时候允许**补足"的判据（把 `named.length <= 1`
   * 换成 `anchorText`）—— 那是在**给一个本来就该删的行为加条件**。
   * 用户第二句话把问题拉回根上：**任何补足都是在替他决定要去哪。**
   *
   * "附近"说的是**范围**（去哪儿找），不是"给我多挑几个"。
   */
  const w = await makeWorld();
  const res = expectOk(
    await w.A(
      'place.search',
      Object.assign(
        {
          keywords: ['公园'],
          center: CENTER,
          autoPick: {
            pace: 'packed',
            keywords: ['公园'],
            mustVisitTexts: ['公园'],
            anchorText: '公园',
          },
        },
        FAKE
      )
    )
  );

  assert.equal(res.picked.itemIds.length, 1, '说了一个地方就选一个，有锚点也一样');
});
test('住宿名字被识别为不可游览，并说明原因', async () => {
  const w = await makeWorld();
  const res = expectOk(
    await w.A('place.search', Object.assign({ keyword: '', center: CENTER }, FAKE))
  );

  for (const c of res.candidates) {
    if (c.visitable === false) {
      assert.ok(c.notVisitableReason, `${c.name} 不可游览却没给出原因`);
      assert.match(c.notVisitableReason, /交通|住宿/);
    } else {
      assert.equal(c.notVisitableReason, null, `${c.name} 可游览却带了原因`);
    }
  }
});

// ── 一个名字只对应一个地方 ────────────────────────────────

test('bestMatch：上游认得简称时，要听上游的，而不是自己猜"XX+后缀"', () => {
  /**
   * ⚠️ **真实事故的回归**（2026-10-13）。
   *
   * 用户说「哈工大」，候选里有两条：
   *   · 「哈工大科技园」—— 名字以「哈工大」开头，是**借这个名字**的地方；
   *   · 「哈尔滨工业大学」—— **就是它**，但简称与全称对不上字符串。
   *
   * 只按"名字含关键词 + 名字最短"排序，会选中**科技园** ——
   * 用户要的是大学，不是它的科技园。
   *
   * 而上游搜索「哈工大」时会返回「哈尔滨工业大学」（`foundBy` 里有它），
   * **上游做了模糊/简称匹配，比我们自己的字符串规则更懂。**
   */
  const cands = [
    { itemId: 'p1', name: '哈工大科技园', category: '旅游景点:景点', visitable: true, foundBy: ['哈工大'] },
    { itemId: 'p2', name: '哈尔滨工业大学', category: '教育;高等院校', visitable: true, foundBy: ['哈工大'] },
  ];

  const best = bestMatch(cands, '哈工大', new Set());
  assert.equal(best.name, '哈尔滨工业大学', '简称对应的是全称，不是"XX科技园"');
});

test('bestMatch：名字恰好等于关键词时，压过一切', () => {
  const cands = [
    { itemId: 'p1', name: '哈尔滨冰雪大世界', category: '旅游景点:景点', visitable: true, foundBy: ['冰雪大世界'] },
    { itemId: 'p2', name: '冰雪大世界', category: '旅游景点:景点', visitable: true, foundBy: ['冰雪大世界'] },
  ];
  assert.equal(bestMatch(cands, '冰雪大世界', new Set()).name, '冰雪大世界');
});

test('bestMatch：同名的一堆里，短名字优先于"蹭名字"的长名字', () => {
  const cands = [
    { itemId: 'p1', name: '哈尔滨欣怡宾馆(冰雪大世界凯利广场店)', category: '住宿', visitable: false },
    { itemId: 'p2', name: '哈尔滨冰雪大世界', category: '旅游景点:景点', visitable: true },
    { itemId: 'p3', name: '哈尔滨冰雪大世界梦幻冰雪馆', category: '旅游景点:景点', visitable: true },
  ];
  const best = bestMatch(cands, '冰雪大世界', new Set());
  assert.equal(best.name, '哈尔滨冰雪大世界');
  assert.equal(best.visitable, true, '不可游览的根本不参与');
});

test('bestMatch：没有候选匹配时返回 null，不能硬凑一个', () => {
  const cands = [{ itemId: 'p1', name: '中央大街', category: '旅游景点', visitable: true }];
  assert.equal(bestMatch(cands, '冰雪大世界', new Set()), null);
});

test('同一句话的两份表示不能重复计数 —— 三个地方就是三个', () => {
  /**
   * ⚠️ **真实事故的回归**（2026-10-13）。
   *
   * 解析层对同一句话给出**两份表示**：
   *
   *     searchKeywords  = ["哈工大", "冰雪大世界", "哈学院"]        ← 用户原话
   *     mustVisitTexts  = ["哈尔滨工业大学", "哈尔滨冰雪大世界", …]  ← 规范化后的
   *
   * 旧的合并逻辑把它们并成一个列表，于是「哈工大」和「哈尔滨工业大学」
   * 成了两个独立条目、各选一个地方 —— **用户说三个，出来四个**。
   *
   * **用两份数据做同一件事，必然重复。**
   */
  const cands = [
    { itemId: 'p1', name: '哈尔滨工业大学', category: '教育;高等院校', visitable: true, foundBy: ['哈工大'] },
    { itemId: 'p2', name: '哈工大科技园', category: '旅游景点:景点', visitable: true, foundBy: ['哈工大'] },
    { itemId: 'p3', name: '哈尔滨冰雪大世界', category: '旅游景点:景点', visitable: true, foundBy: ['冰雪大世界'] },
    { itemId: 'p4', name: '哈尔滨学院', category: '教育;高等院校', visitable: true, foundBy: ['哈学院'] },
  ];

  const r = autoPick(cands, {
    pace: 'normal',
    keywords: ['哈工大', '冰雪大世界', '哈学院'],
    mustVisitTexts: ['哈尔滨工业大学', '哈尔滨冰雪大世界', '哈尔滨学院'],
  });

  assert.equal(
    r.itemIds.length,
    3,
    `用户说了三个地方，实际选了 ${r.items.map((x) => x.name).join('、')}`
  );
  assert.deepEqual(
    r.items.map((x) => x.name),
    ['哈尔滨工业大学', '哈尔滨冰雪大世界', '哈尔滨学院'],
    '每个关键词各出一个，且要是对的那个'
  );
});

test('没有检索词时才退回必去项 —— 不能因此漏掉用户明说要去的地方', () => {
  const cands = [
    { itemId: 'p1', name: '兆麟公园', category: '旅游景点:公园', visitable: true },
    { itemId: 'p2', name: '圣索菲亚教堂', category: '旅游景点:教堂', visitable: true },
  ];
  const r = autoPick(cands, { pace: 'relaxed', mustVisitTexts: ['兆麟公园'] });
  assert.ok(r.itemIds.includes('p1'), '没有检索词时，必去项必须仍然生效');
});

test('点名三个地方就三个 —— 模型误填 anchorText 也不能多塞', async () => {
  /**
   * ⚠️ **真实事故的回归**（2026-10-13）。
   *
   * 用户说「先去哈工大玩一小时再去冰雪大世界玩两小时再去哈学院玩一小时」，
   * 而模型把**具体目的地**「哈工大」填进了 `anchorText`。
   *
   * 系统的"要不要替他补地点"判据里含 `Boolean(anchorText)` ——
   * 于是被当成"区域漫游"，**又补了一个地方进来**：
   *
   *     1 哈尔滨工业大学       必去
   *     2 哈尔滨冰雪大世界     必去
   *     3 哈尔滨学院           必去
   *     4 哈尔滨冰雪大世界梦幻冰雪馆  相关性靠前   ← 用户没说过
   *
   * 判据改成只看**点名了几个地方** —— 点了三个就是三个。
   */
  const w = await makeWorld();
  const res = expectOk(
    await w.A(
      'place.search',
      Object.assign(
        {
          keywords: ['公园', '教堂'],
          center: CENTER,
          autoPick: {
            pace: 'normal',
            keywords: ['公园', '教堂'],
            mustVisitTexts: ['公园', '教堂'],
            // 模型把具体目的地误当成"区域"填了进来
            anchorText: '公园',
          },
        },
        FAKE
      )
    )
  );

  assert.equal(
    res.picked.itemIds.length,
    2,
    `点名两个就两个，anchorText 不能触发补足。实际：${res.picked.items.map((x) => x.name).join('、')}`
  );
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

test('地点检索：**一律不入库** —— 反复检索也不会往库里写东西', async () => {
  /**
   * ⚠️ 用户决定（2026-10-13）："以后地点不会入库，全从腾讯地图搜索"。
   *
   * 原先每次检索都会把 POI 灌进 `places`，包括同一 POI 的复用逻辑
   * （`saved.created` / `saved.reused`）。**那些字段现在不存在了。**
   *
   * 理由：检索回来的 POI 是**未核验**的，把它们灌进地点库
   * 只会让"库里有这条"看起来像"我们确认过这个地方"。
   * `places` 现在**只由踏勘写入**。
   */
  const w = await makeWorld();
  const q = Object.assign({ keyword: '教堂', center: CENTER }, FAKE);
  const before = (await w.A('place.list', {})).data.places.length;

  const first = expectOk(await w.A('place.search', q));
  assert.ok(first.candidates.length >= 1);
  assert.equal(first.persisted, false, '响应必须说清"没有入库"');
  assert.equal(first.saved, undefined, '`saved` 这个字段不该再存在 —— 它暗示检索会写库');

  const second = expectOk(await w.A('place.search', q));
  assert.ok(second.candidates.length >= 1);

  const after = (await w.A('place.list', {})).data.places.length;
  assert.equal(after, before, `检索不得改变地点库：${before} → ${after}`);

  /**
   * 但**稳定标识必须一致** —— 同一批地点两次检索要得到同一个 `itemId`，
   * 否则踏勘实测的步行时间（按 placeId 索引）永远对不上、行程也无法复现。
   */
  assert.equal(
    second.candidates[0].itemId,
    first.candidates[0].itemId,
    'itemId 必须稳定'
  );
});

test('未踏勘的候选：能进游览顺序，但不能作集合点', async () => {
  const w = await makeWorld();
  const res = expectOk(
    await w.A('place.search', Object.assign({ keyword: '', center: CENTER }, FAKE))
  );

  const c = res.candidates.find((x) => !x.matchedSurveyed);
  assert.ok(c, '要挑一条**没对上踏勘数据**的候选');
  assert.equal(c.saved, false, '不在库里');
  assert.equal(c.placeId, null, '没有数据库 id');
  assert.ok(c.itemId, '但必须有稳定标识 —— 规划要用它');
  assert.equal(c.verified, false, '外部检索地点一律未核验');
  assert.equal(c.dataSource, 'tencent-poi');
  assert.equal(c.visitDurationSource, 'default-untuned', '停留时长是估值，必须标出来源');
  assert.ok(c.name && c.location, '有名称与坐标就能排进行程（不必入库）');
});

test('检索结果对上了踏勘地点时，带上库里的 id 与核验状态', async () => {
  /**
   * 这是"检索保证覆盖度、踏勘保证可信度"两条线的**接缝**：
   * 搜到一个我们已经实地核验过的地方，就该用库里那份数据 ——
   * 它才有可信的停留时长、实测步行时间，才能当集合点。
   */
  const w = await makeWorld();
  const res = expectOk(
    await w.A('place.search', Object.assign({ keyword: '', center: CENTER }, FAKE))
  );

  const hit = res.candidates.find((c) => c.matchedSurveyed);
  assert.ok(hit, '假池里有与踏勘数据同名的地点，应当对上号');
  assert.ok(hit.placeId, '对上号就带上库里的 id');
  assert.equal(hit.saved, true);
  assert.equal(hit.verified, true, '踏勘过的地点是核验状态');
  assert.equal(res.matchedSurveyed >= 1, true, '响应里要能看出对上了几条');
});

// ── 排序 ──────────────────────────────────────────────────

// ── 自动预选（"AI 生成路线"的关键一步） ────────────────────

test('自动预选：**精确选用户说的那几个**，不按节奏凑数', async () => {
  /**
   * ⚠️ 这条测试**改过主题**（2026-10-14 用户决定）。
   *
   * 它原来叫「节奏决定选几个」，断言 `relaxed` 选 3 个、`packed` 选 5 个。
   * 那个行为**已删除**：用户说去哪就去哪，系统不再按节奏补足。
   *
   * ⚠️ 这里刻意**一个检索词都不给** —— 那是 `autoPick` 的"什么都没认出来"
   *    情形。以前会按节奏凑 3～5 个，现在**一个都不选**：
   *    没有用户点名的地点，替他编一份行程单是最不该做的事。
   *    界面应当如实说"没认出你要去哪"。
   */
  const w = await makeWorld();
  const pick = async (pace) =>
    expectOk(
      await w.A(
        'place.search',
        Object.assign({ keyword: '', center: CENTER, autoPick: { pace: pace } }, FAKE)
      )
    ).picked;

  for (const pace of ['relaxed', 'normal', 'packed']) {
    const p = await pick(pace);
    assert.equal(p.itemIds.length, 0, `节奏 ${pace} 也不该凭空凑数`);
  }

  /** `limit` 仍然如实回传（它是节奏的表达），但它**不再决定选几个** */
  assert.equal((await pick('relaxed')).limit, 3);
  assert.equal((await pick('packed')).limit, 5);
  assert.equal((await pick('随便')).limit, 4, '非法节奏按 normal 报，不报错也不乱选');
});
test('自动预选：**点名几个就选几个** —— 不再有"名额被挤掉"这回事', async () => {
  /**
   * ⚠️ 这条测试**改过主题**（2026-10-14 用户决定）。
   *
   * 它原来叫「必去一定选上，且不被数量上限挤掉」—— 守的是
   * "补足的名额不能把用户明说要去的地方挤掉"。
   *
   * 补足删掉之后，**这个问题从根上不存在了**：没有补足就没有名额争抢。
   * 现在守的是新契约本身：点名几个就是几个。
   */
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

  assert.equal(res.picked.itemIds.length, 1, '点名一个就选一个');
  const item = res.picked.items[0];
  assert.equal(item.name, '老道外中华巴洛克', '选中的必须正是用户说的那个地方');
  assert.match(item.reason, /必去/, '理由要标明"这是你点名要去的"');
});
test('自动预选：说明里要写清选了谁、为什么', async () => {
  /**
   * ⚠️ 夹具改成**点名一个地方**（2026-10-14）。
   *
   * 原来给的是一个检索词都没有的 `autoPick`，靠"按节奏补足"凑出内容，
   * 于是这条测试顺带依赖了补足行为。补足删掉之后那种输入选出 0 个，
   * 也就没有"选了谁、为什么"可写 —— 那正是补足被删后的**正确**表现。
   *
   * 现在用**用户真的说了要去哪**的输入来守这条：说明必须写清选了谁、为什么。
   */
  const w = await makeWorld();
  const res = expectOk(
    await w.A(
      'place.search',
      Object.assign(
        {
          keyword: '教堂',
          center: CENTER,
          autoPick: { pace: 'normal', keywords: ['教堂'] },
        },
        FAKE
      )
    )
  );

  assert.ok(res.picked.itemIds.length > 0, '前提：点名的地方要能选上');
  assert.match(res.picked.note, /预选 \d+ 个地点/);
  assert.match(res.picked.note, /（/, '每一项都要带理由');
  assert.equal(res.picked.items.length, res.picked.itemIds.length);
});

test('自动预选：**什么都认不出来时一个都不选**，并如实说明', async () => {
  /**
   * ⚠️ 这条守住"补足删掉之后"的正确行为（2026-10-14 用户决定）。
   *
   * 以前这种输入会按节奏凑 4 个地方给用户。现在**一个都不选** ——
   * 没认出他要去哪，替他编一份行程单是最不该做的事。
   * 界面据此提示"没认出你要去哪"，而不是默默给出一条看起来完整的路线。
   */
  const w = await makeWorld();
  const res = expectOk(
    await w.A(
      'place.search',
      Object.assign({ keyword: '', center: CENTER, autoPick: { pace: 'normal' } }, FAKE)
    )
  );

  assert.equal(res.picked.itemIds.length, 0, '不该凭空凑数');
  assert.ok(res.picked.note, '要有一句话说明为什么是空的');
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

test('**未入库**的检索结果可以直接排进路线（不必先入库）', async () => {
  /**
   * ⚠️ 用户决定（2026-10-13）："以后地点不会入库，全从腾讯地图搜索"。
   *
   * 所以规划**不能再要求 placeIds** —— 检索结果没有数据库 id。
   * 改为把地点数据**内嵌**传给 `trip.plan`（`places: [...]`）。
   */
  const w = await makeWorld();
  const found = expectOk(await w.A('place.search', Object.assign({ keyword: '公园', center: CENTER }, FAKE)));

  const places = found.candidates.map((x) => ({
    itemId: x.itemId,
    name: x.name,
    category: x.category,
    location: x.location,
    poiId: x.poiId,
  }));

  assert.equal(
    places.every((x) => x.name && x.location),
    true,
    '内嵌地点必须有名称与坐标'
  );

  const trip = expectOk(
    await w.A('trip.plan', { places: places, startAt: NOW, constraints: [], startPoint: null })
  );

  assert.equal(trip.saved, true, '未入库的检索结果应能直接生成路线');
  assert.equal(trip.nodes.length, places.length);
  /**
   * 节点必须带**地点快照** —— 否则事后 `adjust` 回库读不到
   * （那些地点根本不在库里）。行程要**自洽**。
   */
  for (const n of trip.nodes) {
    assert.ok(n.placeSnapshot, `节点 ${n.placeName} 缺少地点快照`);
    assert.ok(n.placeSnapshot.name && n.placeSnapshot.location);
  }
});

test('未核验的地点不能作集合点，且排除原因要说明它还能用在哪', async () => {
  /**
   * 库里那条「未核验的某处」（夹具）代表**已入库但尚未踏勘**的地点。
   * 它可作行程节点，不可作集合点 —— 这就是准入分级的意义。
   */
  const w = await makeWorld();
  const listed = expectOk(await w.A('place.list', {}));
  const target = listed.places.find((p) => !p.verified);

  assert.ok(target, '夹具里必须有未核验的地点，否则这条测试是空的');
  assert.ok(target.placeId);

  // 设成可作集合点的类别（MEET_CATEGORIES 里的值），
  // 排除原因才会走到"未核验"这一支，而不是被类目筛掉
  await w.repo.update(C.PLACES, target.placeId, { category: 'meeting' });

  const { crewId } = await makeCrewSafe(w);
  const rec = expectOk(await w.A('meet.recommend', { crewId }));
  const why = (rec.excluded || []).find((x) => x.placeId === target.placeId);
  assert.ok(why, '未核验地点必须出现在排除原因里');
  assert.equal(why.reason, 'PLACE_NOT_MEETING_POINT');
  assert.match(why.message, /可安排为游览节点/);
});

/** 复用 helpers 的建队逻辑（避免各测试文件重复实现） */
async function makeCrewSafe(w) {
  const { makeCrew } = require('./helpers');
  return makeCrew(w);
}

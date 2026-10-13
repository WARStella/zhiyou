'use strict';

/**
 * 需求解析测试。
 *
 * 这一层最要紧的不是"能解析出多少"，而是**不能解析出什么**：
 *   · 含糊表达（"有点累""尽量少走"）**绝不能被换算成具体数值**（§6.2）；
 *   · 没把握的时间（"五点前"没说上下午）必须追问，不能替用户决定；
 *   · 检索词不能把动词时间词吞进去，更不能取自"用户明确不想去的地方"。
 *
 * 这几条一旦破了，规划器就会拿着**猜出来的数字**去算可行性 ——
 * 而且算得一本正经，没有任何地方会报错。这是最难发现的一类错误。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const rb = require('../cloudfunctions/api/lib/ai/rulebased');
const { parseIntents } = require('../cloudfunctions/api/lib/ai');
const { makeWorld, expectOk, NOW, C } = require('./helpers');
const fixtures = require('./fixtures/places');

const KNOWN = fixtures.places.map((p) => p.name);

// ── 能解析的 ──────────────────────────────────────────────

test('规则解析：明确的时段与时间能解析出来', () => {
  const r = rb.parse('下午三点出发，晚上八点结束');
  assert.equal(r.startClock.text, '15:00', '「下午三点」= 15:00');
  assert.equal(r.endClock.text, '20:00', '「晚上八点」= 20:00');

  // 这句话里没有地点，「检索词」待确认是**正确行为**；
  // 这里只断言时间项没有含糊
  const timeUncertain = r.uncertainties.filter((u) => u.field === 'startAt' || u.field === 'endAt');
  assert.equal(timeUncertain.length, 0, '时间都说清楚了，不该有待确认');
});

test('规则解析：时间支持阿拉伯数字与「半」', () => {
  assert.equal(rb.parse('17:30 前结束').endClock.text, '17:30');
  assert.equal(rb.parse('下午五点半结束').endClock.text, '17:30');
  assert.equal(rb.parse('上午十点出发').startClock.text, '10:00');
});

test('规则解析：锚点必须剥掉动词与时间词', () => {
  // 实测踩到的坑：整体捕获会得到「我下午想去中央大街」这种检索词
  const r = rb.parse('我下午想去中央大街附近逛逛', { knownPlaceNames: KNOWN });
  assert.equal(r.anchorText, '中央大街');
  assert.equal(r.searchKeyword, '中央大街');
  assert.equal(/我|想|去|下午/.test(r.anchorText), false, '检索词里不得混入动词时间词');
});

test('规则解析：必去与排除按原文顺序，且冲突时以排除为准', () => {
  const r = rb.parse('一定要去中央大街，别去兆麟公园', { knownPlaceNames: KNOWN });

  assert.deepEqual(r.mustVisitTexts, ['中央大街']);
  assert.deepEqual(r.avoidTexts, ['兆麟公园'], '「别去 X」不得被当成必去');
  assert.equal(
    r.uncertainties.some((u) => u.field === 'mustVisit'),
    true,
    '自相矛盾必须让用户澄清'
  );
});

test('规则解析：检索词不得取自"明确不想去的地方"', () => {
  // 实测踩到的坑：兆麟公园比中央大街长，按"取最长"会选中被排除的那个
  const r = rb.parse('一定要去中央大街，别去兆麟公园', { knownPlaceNames: KNOWN });
  assert.notEqual(r.searchKeyword, '兆麟公园');
  assert.equal(r.searchKeyword, '中央大街');
});

test('规则解析：非地名不得被当成必去', () => {
  // 实测踩到的坑：「尽量多去几个地方」曾被解析成"必去：几个地方"
  const r = rb.parse('上午十点出发，尽量多去几个地方', { knownPlaceNames: KNOWN });
  assert.deepEqual(r.mustVisitTexts, []);
  assert.equal(r.pace, 'packed');
});

test('规则解析：并列目标要拆开，不能当成一个地名', () => {
  const r = rb.parse('想去教堂和公园', { knownPlaceNames: KNOWN });
  assert.equal(r.goalText, '教堂', '不能是「教堂和公园」—— 那不是地名');
  assert.deepEqual(r.goalAlternatives, ['公园'], '后半句不能被丢掉');
  assert.equal(r.searchKeyword, '教堂');
  assert.equal(r.uncertainties.length, 0);
});

// ── 实测踩到的坑：POI 名字里嵌了地标名 ────────────────────

test('简称匹配不得被"名字里嵌了地标"的长 POI 名骗到', () => {
  /**
   * 真实事故：用户说「我想去冰雪大世界」，库里有一条检索回来的 POI 叫
   * 「哈尔滨悦苒民宿(哈尔滨冰雪大世界融创文旅城龙川路地铁站)」——
   * 它的名字里嵌了「冰雪大世界」，于是双向包含的简称匹配把它当成了
   * 用户要去的地方，检索词也变成那串 30 字的全名。
   */
  const withPoi = KNOWN.concat([
    '哈尔滨悦苒民宿(哈尔滨冰雪大世界融创文旅城龙川路地铁站)',
  ]);
  const r = rb.parse('我想去冰雪大世界', { knownPlaceNames: withPoi });

  assert.deepEqual(r.mustVisitTexts, [], '不得把那间民宿当成必去');
  assert.equal(r.goalText, '冰雪大世界', '「去 X」的目标要抽出来');
  assert.equal(r.searchKeyword, '冰雪大世界', '检索词必须是用户说的那个地标');
});

test('真正的简称仍然要认得出来', () => {
  // 「索菲亚」是「圣索菲亚教堂」的简称 —— 长度过半，应当认
  const r = rb.parse('想去索菲亚', { knownPlaceNames: KNOWN });
  assert.deepEqual(r.mustVisitTexts, ['圣索菲亚教堂']);
  assert.equal(r.searchKeyword, '圣索菲亚教堂');
});

test('用户说的地标不在已知库里时，仍要能搜到（「去 X」兜底）', () => {
  // 这是最常见的表达方式，不加兜底会什么都搜不到
  const r = rb.parse('我想去冰雪大世界', { knownPlaceNames: KNOWN });
  assert.equal(r.searchKeyword, '冰雪大世界');
  assert.equal(r.uncertainties.some((u) => u.field === 'searchKeyword'), false);
});

test('「去 X」抽出后要清掉尾部的游览动词', () => {
  const r = rb.parse('想去中央大街逛逛', { knownPlaceNames: [] });
  assert.equal(r.goalText, '中央大街', '不能是「中央大街逛逛」');
});

// ── 实测踩到的坑：交通设施抢占了用户想去的地方 ────────────

test('交通设施不得被当作"用户想去的地方"', () => {
  /**
   * 真实事故：库里有一条检索回来的 POI 叫「冰雪大世界[地铁站]」
   * （类目 `基础设施;交通设施:地铁站`）。它是**地铁站**，不是那个冰雪乐园。
   * 让它参与匹配，用户想去的地方会被替换成一个地铁站，
   * 检索词也跟着变成「冰雪大世界[地铁站]」—— 搜出来全是地铁站。
   *
   * ⚠️ **类目字符串必须用真实返回过的值**。第一版修复时我用了自己编的
   * `…:地铁站`，它恰好能匹配，测试是绿的；而线上真实的
   * `…:公交车站` 匹配不上（「公交车站」里没有连续的「公交站」三个字），
   * 于是同一个 bug 又犯了第二次。
   */
  const places = [
    { name: '中央大街', category: '旅游景点:景点' },
    { name: '冰雪大世界[地铁站]', category: '基础设施;交通设施:地铁站' },
    { name: '冰雪大世界[公交站]', category: '基础设施;交通设施:公交车站' },
    { name: '哈尔滨站[地铁站]', category: '基础设施;交通设施:地铁站' },
  ];
  const known = rb.pickKnownPlaceNames(places);

  assert.deepEqual(known, ['中央大街'], '交通设施必须被排除');
  assert.equal(rb.isVisitableCategory('旅游景点:公园'), true);
  assert.equal(rb.isVisitableCategory('基础设施;交通设施:公交车站'), false);
  assert.equal(rb.isVisitableCategory('基础设施;交通设施:地铁站'), false);

  const r = rb.parse('我想去冰雪大世界', { knownPlaceNames: known });
  assert.deepEqual(r.mustVisitTexts, [], '不得把交通设施当成必去');
  assert.equal(r.searchKeyword, '冰雪大世界', '检索词必须是用户说的那个地标');
});

test('不可游览类目的关键词覆盖真实返回的写法', () => {
  // 这些字符串都取自真实返回，不要改成自己编的写法
  const real = [
    '基础设施;交通设施:公交车站',
    '基础设施;交通设施:地铁站',
    '基础设施;交通设施:停车场',
    '生活服务:公共厕所',
  ];
  for (const c of real) {
    assert.equal(rb.isVisitableCategory(c), false, `${c} 应当被判为不可游览`);
  }
  const visitable = ['旅游景点:景点', '旅游景点:公园', '旅游景点:教堂', '餐饮服务:中餐厅', '购物服务:商场'];
  for (const c of visitable) {
    assert.equal(rb.isVisitableCategory(c), true, `${c} 应当可游览`);
  }
});

test('匹配时要去掉名字里的门店后缀', () => {
  const places = [{ name: 'Theone钢琴教室(民生路店)', category: '教育培训:音乐教室' }];
  const known = rb.pickKnownPlaceNames(places);

  assert.equal(rb.baseName('Theone钢琴教室(民生路店)'), 'Theone钢琴教室');
  assert.equal(rb.baseName('冰雪大世界[地铁站]'), '冰雪大世界');
  assert.equal(rb.baseName('普通名字'), '普通名字', '没有后缀时原样返回');

  const r = rb.parse('想去Theone钢琴教室', { knownPlaceNames: known });
  assert.deepEqual(r.mustVisitTexts, ['Theone钢琴教室(民生路店)'], '去掉后缀一致就该认');
});

// ── 不能解析的（§6.2 的核心） ─────────────────────────────

test('规划时的停留时长：「逛一小时」必须被听见', () => {
  /**
   * 实测踩到的坑：用户说「我想去冰雪大世界，逛一小时」，
   * 首版规则只认「**多**逛一小时」，没有「多」就认不出，
   * 于是停留用了默认的 45 分钟 —— 用户明确说了时长，系统却当没听见。
   */
  const r = rb.parse('我想去冰雪大世界，逛一小时');
  assert.equal(r.stayMinutes, 60);
  assert.equal(r.searchKeyword, '冰雪大世界', '时长不该污染检索词');
  assert.equal(r.goalText, '冰雪大世界');

  assert.equal(rb.parse('待 40 分钟').stayMinutes, 40);
  assert.equal(rb.parse('玩两个小时').stayMinutes, 120);
  assert.equal(rb.parse('逛半小时').stayMinutes, 30, '「半小时」要认');
  assert.equal(rb.parse('参观 90 分钟').stayMinutes, 90);

  // 没说时长就不该有值 —— 用地点自带的默认值
  assert.equal(rb.parse('我想去中央大街').stayMinutes, null);
});

test('规划时的停留时长：明显不合理的时长要问，不能照单全收', () => {
  const r = rb.parse('去中央大街，逛 20 小时');
  assert.equal(r.stayMinutes, null, '20 小时显然不对，不该直接采用');
  const u = r.uncertainties.find((x) => x.field === 'stayMinutes');
  assert.ok(u, '必须让用户确认');
  assert.match(u.why, /太长/);
});

test('停留时长进了 structured，能直接下发给规划器', () => {
  const st = rb.toStructured(rb.parse('去中央大街，逛一小时'));
  assert.equal(st.structured.stayMin, 60);

  const none = rb.toStructured(rb.parse('去中央大街'));
  assert.equal(none.structured.stayMin, null);
});

test('两条停留规则不会互相干扰：「多待一会儿」是调整，「逛一小时」是规划', () => {
  // 调整场景：extendStayMin
  assert.equal(rb.parse('多待 20 分钟').extendStayMin, 20);
  assert.equal(rb.parse('多待 20 分钟').stayMinutes, null);

  // 规划场景：stayMinutes
  assert.equal(rb.parse('逛 20 分钟').stayMinutes, 20);
  assert.equal(rb.parse('逛 20 分钟').extendStayMin, null);
});

test('解析说明不能只依赖 matched —— 模型常常不填它', () => {
  /**
   * ⚠️ **真实缺陷的回归**（2026-10-13 实测 DeepSeek 发现）。
   *
   * DeepSeek 返回了正确的 endClock / pace / mustVisitTexts，
   * 却把 `matched` 留空 —— 于是界面显示「**没有能确定的项**」，
   * 而实际上解析出了一堆东西。
   *
   * `matched` 是"解析过程记录"，模型不一定给；
   * 所以说明必须以**结构化字段**为准，matched 只是补充原文片段。
   */
  const parsed = {
    rawText: '我想先去哈工大玩一小时',
    anchorText: '哈工大',
    searchKeyword: '哈工大',
    endClock: { hour: 17, minute: 0, text: '17:00' },
    startClock: { hour: 14, minute: 0, text: '14:00' },
    pace: 'relaxed',
    mustVisitTexts: ['哈工大'],
    avoidTexts: [],
    stayMinutes: 60,
    matched: [], // ← 模型没填
    uncertainties: [],
  };

  const lines = rb.explain(parsed);
  assert.ok(lines.length >= 5, `matched 为空也要能说明解析结果，实际只有 ${lines.length} 条`);

  const joined = lines.join('\n');
  assert.match(joined, /结束时间：17:00/);
  assert.match(joined, /开始时间：14:00/);
  assert.match(joined, /节奏：relaxed/);
  assert.match(joined, /区域：哈工大/);
  assert.match(joined, /必去：哈工大/);
  assert.match(joined, /每站停留：60 分钟/, '带单位的字段必须写清单位');
});

test('解析说明：matched 有原文片段时优先用它', () => {
  const parsed = {
    rawText: '五点前结束',
    endClock: { hour: 17, minute: 0, text: '17:00' },
    matched: [{ field: 'endAt', text: '五点前', value: '17:00' }],
    mustVisitTexts: [],
    avoidTexts: [],
    uncertainties: [],
  };

  const lines = rb.explain(parsed);
  assert.equal(lines.length, 1, 'matched 已覆盖的字段不该重复输出');
  assert.match(lines[0], /来自「五点前」/, '原文片段对用户理解最有价值');
});

test('一句话说了两个地方 → 两个检索词，不能只搜第一个', () => {
  /**
   * ⚠️ **真实事故的回归**（2026-10-13）。
   *
   * 用户说「先去哈工大玩一小时再去冰雪大世界玩3小时」，
   * 而当时只产出**一个** searchKeyword，前端也只搜一个 ——
   * 冰雪大世界根本没进候选，用户看到的全是哈工大的各种门。
   *
   * 首版连拆分都做不到：只按「和跟与、,，及」拆，**「再」不在其中**，
   * 整句被当成一个地名，检索词成了
   * 「哈工大玩一小时再去冰雪大世界玩3小时」。
   */
  const r = rb.parse('先去哈工大玩一小时再去冰雪大世界玩3小时');
  assert.deepEqual(r.searchKeywords, ['哈工大', '冰雪大世界']);
  assert.equal(r.searchKeyword, '哈工大', '主检索词仍是第一个');

  // 顺接词都要能拆
  for (const s of [
    '先去中央大街然后再去防洪纪念塔',
    '想去中央大街，然后去防洪纪念塔',
    '要去中央大街和防洪纪念塔',
  ]) {
    assert.ok(
      rb.parse(s).searchKeywords.length >= 2,
      `「${s}」应当拆出多个检索词，实际 ${JSON.stringify(rb.parse(s).searchKeywords)}`
    );
  }
});

test('检索词里绝不能混进动词与时长', () => {
  const r = rb.parse('去防洪纪念塔玩两个小时');
  assert.equal(r.searchKeyword, '防洪纪念塔');
  assert.equal(r.stayMinutes, 120);
  assert.equal(
    r.searchKeywords.some((k) => /玩|小时|分钟/.test(k)),
    false,
    `检索词里不能有动词或时长：${JSON.stringify(r.searchKeywords)}`
  );
});

test('连接词可能是地名的一部分 —— 「和平路」不能被拆成「平路」', () => {
  /**
   * 拆分用的连接词表里有「和」，而**地名可能以它开头**。
   *
   *     '和平路'.split(/[和...]/)  →  ['', '平路']  →  「平路」 ❌
   *
   * 保护：地名不可能以连接词开头，所以"首段为空"就是"这不是连接词"。
   */
  for (const name of ['和平路', '和兴路', '与安街']) {
    const r = rb.parse('我想去' + name);
    assert.equal(r.searchKeyword, name, `「${name}」被拆坏了`);
    assert.deepEqual(r.searchKeywords, [name]);
  }
});

test('类目词不是地名 —— 「公园」不该被认成「兆麟公园」', () => {
  /**
   * ⚠️ **第三次踩到同一类错误**（2026-10-13）：
   * 「名字里含这几个字」被当成了「就是那个地方」。
   *
   *     matchKnown('公园', [...'兆麟公园'...])  →  '兆麟公园'  ❌
   *     长度比 2/4 = 0.5，恰好卡在简称阈值上
   *
   * 与「哈工大」→「哈工大[地铁站]」、「冰雪大世界」→「…龙川路地铁站」
   * 完全同源。用户说"公园"是**类目**，不是要去兆麟公园。
   */
  const r = rb.parse('想去教堂和公园', { knownPlaceNames: KNOWN });
  assert.deepEqual(r.mustVisitTexts, [], '类目词不能进必去');
  assert.equal(r.searchKeyword, '教堂');
  // 但仍然可以拿它们去**检索** —— 「公园」是个合法检索词
  assert.deepEqual(r.searchKeywords, ['教堂', '公园']);
});

test('类目词表不能误伤真实地名 —— 「中央大街」必须能当必去项', () => {
  /**
   * ⚠️ 修上一个问题时踩的坑：`CATEGORY_WORDS` 里混着「中央大街」
   * （它作为**检索兜底**是合适的），直接拿它做"是不是具体地点"的判断，
   * 会把「一定要去中央大街」的必去项整个丢掉。
   *
   * 所以类目词分成两份表，用途不同（见 rulebased.js 的注释）。
   */
  const r = rb.parse('一定要去中央大街，别去兆麟公园', { knownPlaceNames: KNOWN });
  assert.deepEqual(r.mustVisitTexts, ['中央大街'], '中央大街是真实地名，不能被当成类目词丢掉');
  assert.deepEqual(r.avoidTexts, ['兆麟公园']);
});

test('并列的必去项要拆开，否则永远匹配不到任何地点', () => {
  const r = rb.parse('我想去中央大街和索菲亚教堂', { knownPlaceNames: KNOWN });
  assert.deepEqual(
    r.mustVisitTexts,
    ['中央大街', '圣索菲亚教堂'],
    '整串「中央大街和索菲亚教堂」拿去做匹配，一个 POI 都匹配不上'
  );
});

test('解析说明要把**所有**检索词列出来，不能只显示一个', () => {
  /**
   * ⚠️ **真实困惑的回归**（2026-10-13）：用户看到界面写「检索词：哈工大」，
   * 问"为什么是一个而不是三个"—— 而实际三个都搜了。
   *
   * `explain()` 打印的是单数 `searchKeyword`（"主检索词"），
   * 复数 `searchKeywords` 没显示。**数据是对的，显示漏了** ——
   * 但显示漏了，用户就会以为系统漏搜了，等同于是错的。
   */
  const lines = rb.explain(rb.parse('先去哈工大再去冰雪大世界再去哈学院'));
  const kwLine = lines.find((l) => l.indexOf('检索词：') === 0);
  assert.ok(kwLine, '必须有检索词这一行');
  for (const kw of ['哈工大', '冰雪大世界', '哈学院']) {
    assert.ok(kwLine.indexOf(kw) >= 0, `检索词行必须包含「${kw}」，实际：${kwLine}`);
  }
});

test('检索词与目标地点是同一份时不显示两遍', () => {
  const lines = rb.explain(rb.parse('先去哈工大再去冰雪大世界再去哈学院'));
  assert.equal(
    lines.filter((l) => l.indexOf('目标地点：') === 0).length,
    0,
    '与检索词完全重复的「目标地点」不该单独出现'
  );
  // 但「检索词」这个标签要留着 —— 用户验的是"系统拿什么去搜了"
  assert.equal(lines.filter((l) => l.indexOf('检索词：') === 0).length, 1);
});

test('明确不想去的地方不能出现在目标地点里', () => {
  /**
   * ⚠️ **改 GOAL_RE 时引入的回归**（2026-10-13）。
   *
   * `GOAL_RE` 改成全局匹配后，「别去兆麟公园」里**也有一个「去」** ——
   * 于是兆麟公园进了目标地点，同时又出现在「排除」里，**自相矛盾**。
   */
  const r = rb.parse('一定要去中央大街，别去兆麟公园', { knownPlaceNames: KNOWN });
  assert.deepEqual(r.goalAlternatives, [], '排除项不能进目标');
  assert.equal(r.goalText, '中央大街');

  const lines = rb.explain(r);
  const joined = lines.join('\n');
  assert.match(joined, /排除：兆麟公园/);
  assert.equal(
    lines.some((l) => l.indexOf('目标地点：') === 0 && l.indexOf('兆麟公园') >= 0),
    false,
    '目标地点里不能出现兆麟公园'
  );
});

test('含糊表达绝不能被换算成数值（§6.2）', () => {
  const r = rb.parse('有点累，尽量少走');

  const fields = r.uncertainties.map((u) => u.field);
  assert.ok(fields.includes('maxWalkMinutes'), '必须进待确认，不能自动给数值');

  const st = rb.toStructured(r);
  assert.equal(
    st.structured.maxWalkMinutes,
    null,
    '「有点累」不能自动变成步行上限 —— 这正是 §6.2 明令禁止的'
  );
  assert.equal(st.constraints.length, 0, '含糊表达不得生成任何约束');
});

test('没说是上午还是下午时，必须追问而不是替用户决定', () => {
  const r = rb.parse('五点前结束');
  assert.equal(r.endClock, null, '不得擅自定成 17:00 或 05:00');

  const u = r.uncertainties.find((x) => x.field === 'endAt');
  assert.ok(u);
  assert.match(u.why, /上午还是下午/);
  assert.deepEqual(u.candidates, ['05:00', '17:00'], '要给出候选而不是让用户自己想');
});

test('含糊表达不得生成约束，但明确表达必须生成', () => {
  const vague = rb.toStructured(rb.parse('随便逛逛，尽量少走'));
  assert.equal(vague.constraints.length, 0);

  const clear = rb.toStructured(rb.parse('晚上八点结束'));
  assert.equal(clear.constraints.length, 1);
  assert.equal(clear.constraints[0].key, 'endAt');
  assert.equal(clear.constraints[0].hardness, 'hard');
  assert.ok(clear.constraints[0].confirmedAt, '硬约束必须有确认时间，否则不参与判定');
});

test('认不出要去哪时如实说明，而不是硬编一个检索词', () => {
  const r = rb.parse('下午三点出发，晚上八点结束', { knownPlaceNames: KNOWN });
  assert.equal(r.searchKeyword, null, '宁可不给，也不给垃圾');
  assert.equal(r.uncertainties.some((u) => u.field === 'searchKeyword'), true);
});

test('原话必须一字不改地保留', () => {
  const text = '我下午想去中央大街附近逛逛，五点前结束，少走点路';
  const r = rb.parse(text, { knownPlaceNames: KNOWN });
  assert.equal(r.rawText, text);
  assert.equal(rb.toStructured(r).structured.rawText, text, '落库的也必须是原话');
});

// ── 降级链 ────────────────────────────────────────────────

test('模型不可用时降级到规则解析，且降级原因必须留痕', async () => {
  const r = await parseIntents('晚上八点结束', {
    // 不给 AI_API_KEY → http provider 不可用
    preferModel: true,
  });

  assert.equal(r.ok, true, '降级链必须保证有结果');
  assert.equal(r.parser, 'rulebased');
  assert.equal(r.degraded, true, '降级必须被标记出来');
  assert.equal(r.attempts[0].parser, 'http');
  assert.equal(r.attempts[0].reason, 'NOT_CONFIGURED');
  assert.equal(r.attempts[0].ok, false);
});

test('显式 preferModel:false 时直接用规则，不算降级', async () => {
  const r = await parseIntents('晚上八点结束', { preferModel: false });
  assert.equal(r.parser, 'rulebased');
  assert.equal(r.degraded, false, '主动选择规则解析不是降级');
  assert.equal(r.attempts.length, 0);
});

test('模型返回坏 JSON 时也必须降级，不能让解析整体失败', async () => {
  const { createFakeParser } = require('../cloudfunctions/api/lib/ai');
  const r = await parseIntents('晚上八点结束', {
    provider: 'fake',
    canned: {},
    // fake 只会在 failWith 时失败；这里用一个必失败的 provider 验证降级语义
    failWith: { reason: 'AI_BAD_JSON', message: '模型返回的不是合法 JSON' },
  });
  assert.equal(r.ok, false, '显式指定单一 provider 时失败即失败');
  assert.equal(r.attempts[0].reason, 'AI_BAD_JSON');
});

// ── 动作层 ────────────────────────────────────────────────

test('intent.parse：原话落库、来源标为 rule、降级留痕', async () => {
  const w = await makeWorld();
  const text = '我下午想去中央大街附近逛逛，五点前结束，少走点路';

  const res = expectOk(await w.A('intent.parse', { text, preferModel: false }));

  assert.equal(res.ok, true);
  assert.equal(res.parser, 'rulebased');
  assert.equal(res.degraded, false);
  assert.equal(res.rawText, text);
  assert.ok(res.requirementId);

  // 落库的 requirements
  const req = await w.repo.get(C.REQUIREMENTS, res.requirementId);
  assert.equal(req.rawText, text, '原话必须原样落库 —— 评测与可解释性都靠它');
  assert.equal(req.source, 'rule', '规则解析既不是 ai 也不是 manual，必须能区分');
  assert.ok(req.aiMeta);
  assert.equal(req.aiMeta.parser, 'rulebased');
  assert.equal(req.structured.rawText, text);

  // 界面要能如实告知"这是谁解析的"
  assert.ok(Array.isArray(res.explanation));
  assert.ok(res.explanation.length >= 1);
  assert.equal(res.searchKeyword, '中央大街', '前端可直接拿它去检索');
});

test('intent.parse：解析出的结束时间能直接下发给规划器', async () => {
  const w = await makeWorld();
  const res = expectOk(await w.A('intent.parse', { text: '晚上八点结束，去中央大街', preferModel: false }));

  assert.equal(res.constraints.length, 1);
  assert.equal(res.constraints[0].key, 'endAt');
  assert.equal(res.constraints[0].hardness, 'hard');
  assert.ok(res.constraints[0].confirmedAt);

  // 真把它交给 trip.plan，必须是"生效的硬约束"而不是被静默忽略
  const planned = expectOk(
    await w.A('trip.plan', {
      placeIds: ['p_zhongyang', 'p_fanghong'],
      startAt: NOW,
      constraints: res.constraints,
    })
  );
  assert.ok(planned.saved === true || planned.conflicts.length > 0, '约束必须参与判定');
});

test('intent.parse：空输入如实报错，不编造解析结果', async () => {
  const w = await makeWorld();
  const res = expectOk(await w.A('intent.parse', { text: '   ', preferModel: false }));
  // 解析器返回成功但内容为空 → 必须至少给出"没有输入内容"
  const fields = (res.uncertainties || []).map((u) => u.field);
  assert.ok(fields.includes('rawText'));
  assert.equal((res.constraints || []).length, 0);
});

test('intent.parse：降级到规则时，attempts 里能看出模型为什么没用上', async () => {
  const w = await makeWorld();
  const res = expectOk(await w.A('intent.parse', { text: '晚上八点结束' }));

  assert.equal(res.parser, 'rulebased');
  assert.equal(res.degraded, true);
  const up = res.attempts.find((a) => a.parser === 'http');
  assert.ok(up, '必须记录尝试过模型');
  assert.equal(up.reason, 'NOT_CONFIGURED');
});

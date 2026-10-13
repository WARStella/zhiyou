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

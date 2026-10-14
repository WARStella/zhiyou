'use strict';

/**
 * 解析评分的测试。
 *
 * ⚠️ 这里**不调用模型** —— 评分器是纯函数。
 * "用了哪个模型/几发 few-shot"是另一件事，等样例集齐了再跑对照。
 * 本文件只保证：**同一个解析结果，任何时候都被打同样的分。**
 * 评分器本身不确定，任何对照实验都没有意义。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { scoreSample, summarize, KIND } = require('../cloudfunctions/api/lib/ai/eval');

const FIX = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/intent-samples.json'), 'utf8')
);

test('样例集本身要合格：id 唯一、有 text、有 expected', () => {
  const ids = FIX.samples.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复');
  assert.ok(FIX.samples.length >= 20, `样例太少（${FIX.samples.length}）；§11.2 要求 60–100 条，这是起步`);
  for (const s of FIX.samples) {
    assert.ok(s.id && s.text, `${s.id} 缺 id 或 text`);
    assert.ok(s.expected && Object.keys(s.expected).length, `${s.id} 没有 expected —— 这样的样例无法评分`);
    assert.ok(s.source, `${s.id} 缺 source —— 分不清哪些是真实遇到过的`);
  }
  // 真实遇到过的（含缺陷复现）必须有足够占比，否则样例集是自说自话
  const real = FIX.samples.filter((s) => String(s.source).startsWith('real'));
  assert.ok(real.length >= 5, `真实来源的样例只有 ${real.length} 条 —— 全是自己编的等于没测`);
});

test('有 note 的缺陷样例，必须把"不想要的"也声明出来', () => {
  /**
   * ⚠️ **这是本次踩到的坑，值得单独立一条测试。**
   *
   * s05 的场景是「一定要去中央大街，**别去兆麟公园**」。
   * 原 fixture 只声明了 `mustVisitTextsContain` 与 `avoidTextsContain`，
   * 于是当解析结果把「兆麟公园」**放进必去**时 —— **一条检查都没触发**。
   *
   * 样例集**没测到它声称要测的东西**，而表面上一切正常。
   * 这比"样例太少"危险得多：它给人已经覆盖了的错觉。
   *
   * 规则：声明了"含有 X"的排除类语义（别去／不要去／除了），
   * 就必须同时声明"不含 X"。
   */
  for (const s of FIX.samples) {
    const exp = s.expected || {};
    /**
     * ⚠️ 正则要区分两种「别去」：
     *   · 「别去**兆麟公园**」—— 排除了一个**地点**，必须有"不含"的断言
     *   · 「最后一站**别去了**」—— **调整**语义（跳过一站），与地点无关
     *
     * 首版没加 `(?!了)`，于是把 s17 也扫进来了 —— **同一个"字符串 vs 语义"
     * 问题，出现在我用来防它的那个守卫身上。**（今天第 N 次）
     */
    const saysAvoid = /别去(?!了)|不要去|不想去|除了|避开/.test(s.text);
    if (!saysAvoid) continue;
    assert.ok(
      exp.mustVisitTextsNotContain || exp.searchKeywordsNotContain || exp.avoidTextsContain,
      `${s.id}（${s.text}）表达了"不要去"，却没有任何"不含"的断言 —— 这条例外路径不会被测到`
    );
    assert.ok(
      exp.mustVisitTextsNotContain,
      `${s.id} 必须在**必去**里也声明不含 —— 只查检索词的话，` +
        `"把它塞进必去"这种错误会漏过去（这正是 s05 首版的样子）`
    );
  }
});

test('全对的解析应当零失败', () => {
  const s = FIX.samples.find((x) => x.id === 's01');
  const { checks } = scoreSample(s, {
    endClock: { hour: 17, minute: 0, text: '17:00' },
    anchorText: '中央大街',
    searchKeywords: ['中央大街'],
  });
  const bad = checks.filter((c) => !c.ok);
  assert.deepEqual(bad, [], `不该有失败：${JSON.stringify(bad)}`);
});

test('漏提取记为 MISS', () => {
  const s = FIX.samples.find((x) => x.id === 's01');
  const { checks } = scoreSample(s, { searchKeywords: ['中央大街'] });
  const f = checks.filter((c) => !c.ok);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, KIND.MISS);
  assert.match(f[0].detail, /没提取出来/);
});

test('值错误记为 WRONG，与"没提取到"分开', () => {
  const s = FIX.samples.find((x) => x.id === 's01');
  const { checks } = scoreSample(s, {
    endClock: { hour: 18, minute: 0 },
    searchKeywords: ['中央大街'],
  });
  const f = checks.filter((c) => !c.ok);
  assert.equal(f[0].kind, KIND.WRONG);
  assert.match(f[0].detail, /期望 17:0，实际 18:0/);
});

test('**多提取记为 EXTRA** —— 系统自己加了一个，会直接改错行程', () => {
  /**
   * 这是本项目最贵的一类错误：用户没说要"必去"某地，
   * 系统自己加进去，整条路线就变了。
   * 它必须与"漏了一个"**分开统计**。
   */
  const s = FIX.samples.find((x) => x.id === 's05');
  const { checks } = scoreSample(s, {
    mustVisitTexts: ['中央大街', '兆麟公园'],
    avoidTexts: [],
    searchKeywords: ['中央大街', '兆麟公园'],
  });
  const kinds = checks.filter((c) => !c.ok).map((c) => c.kind);
  assert.ok(kinds.includes(KIND.EXTRA), `应当记 EXTRA，实际 ${JSON.stringify(kinds)}`);
  assert.ok(
    checks.some((c) => !c.ok && /不该进必去|不该把/.test(c.detail)),
    '说明要讲清"系统自己加了一个"'
  );
});

test('§6.2：含糊表达被换算成数值，必须判失败', () => {
  const s = FIX.samples.find((x) => x.id === 's08');
  const { checks } = scoreSample(s, {
    // 两个待确认项都要给全 —— 只给一个的话，"另一个没追问"本身也是失败
    uncertainties: [
      { field: 'maxWalkMinutes', why: '少走路' },
      { field: 'pace', why: '有点累' },
    ],
    maxWalkMinutes: 30, // ← 这正是禁止的
  });
  const bad = checks.filter((c) => !c.ok);
  assert.equal(bad.length, 1, `只该有一条失败（猜测数值），实际 ${JSON.stringify(bad)}`);
  assert.equal(bad[0].name, '不得猜测 maxWalkMinutes');
  assert.equal(bad[0].kind, KIND.EXTRA);
  assert.match(bad[0].detail, /§6.2/);
});

test('子串不算命中 —— 「和平路」不该被判成包含「平路」', () => {
  /**
   * ⚠️ 评分器的**假阳性比漏报更危险**：它会让正确的实现看起来是错的，
   * 于是有人去"修"一个本来没坏的东西。
   * 首版这里用子串匹配，就踩了这个坑（当天第七次「字符串包含即相等」）。
   */
  const s = FIX.samples.find((x) => x.id === 's07'); // 期望 检索词含"和平路"、不含"平路"
  const { checks } = scoreSample(s, { searchKeywords: ['和平路'] });
  assert.deepEqual(checks.filter((c) => !c.ok), [], '「和平路」是正确结果，不该有任何失败');
});

test('§6.2：不换算、只追问 —— 这才是对的', () => {
  const s = FIX.samples.find((x) => x.id === 's08');
  const { checks } = scoreSample(s, {
    uncertainties: [
      { field: 'maxWalkMinutes', why: '「尽量少走路」没有具体数值' },
      { field: 'pace', why: '「有点累」表达含糊' },
    ],
  });
  assert.deepEqual(checks.filter((c) => !c.ok), []);
});

test('认不出地点时编一个检索词 = EXTRA', () => {
  const s = FIX.samples.find((x) => x.id === 's25');
  const { checks } = scoreSample(s, { searchKeywords: ['我要去的地方'] });
  const bad = checks.filter((c) => !c.ok);
  assert.equal(bad[0].kind, KIND.EXTRA);
  assert.match(bad[0].detail, /不能编一个检索词/);
});

test('调整语义不得被当成每站时长（s16）', () => {
  const s = FIX.samples.find((x) => x.id === 's16');
  const { checks } = scoreSample(s, { extendStayMin: 20, stayMinutes: 20 });
  const bad = checks.filter((c) => !c.ok);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].name, 'stayMinutes 应为空');
  assert.equal(bad[0].kind, KIND.EXTRA);
});

test('只检查样例声明过的字段 —— 不惩罚合理的不同表达', () => {
  /**
   * 没写进 expected 的字段一律不管。
   * 否则指标会变成"像不像参考答案"，而不是"对不对"。
   */
  const s = FIX.samples.find((x) => x.id === 's18'); // 只要求 searchKeywords 含"索菲亚"
  const { checks } = scoreSample(s, {
    searchKeywords: ['索菲亚教堂'],
    anchorText: '索菲亚教堂',
    // 一堆样例没要求的字段，全都不该被检查
    matched: [{ field: 'x' }],
    uncertainties: [{ field: 'y' }],
    pace: 'packed',
  });
  assert.deepEqual(checks.filter((c) => !c.ok), []);
  assert.equal(
    checks.every((c) => /searchKeywords/.test(c.name)),
    true,
    '只该检查声明过的项'
  );
});

// ── 汇总 ──────────────────────────────────────────────────

test('汇总：分开报告四类错误，不合成一个"准确率"', () => {
  const scored = [
    scoreSample(FIX.samples.find((s) => s.id === 's01'), { searchKeywords: ['中央大街'] }), // MISS
    scoreSample(FIX.samples.find((s) => s.id === 's01'), {
      endClock: { hour: 18, minute: 0 },
      searchKeywords: ['中央大街'],
    }), // WRONG
    scoreSample(FIX.samples.find((s) => s.id === 's05'), {
      mustVisitTexts: ['中央大街', '兆麟公园'],
      searchKeywords: ['中央大街'],
    }), // EXTRA
  ];
  const sum = summarize(scored);

  assert.equal(sum.samples, 3);
  /**
   * ⚠️ 这里断言的是**关系**，不是具体数字 —— 数字会随样例集内容变化，
   * 而这条测试要守的是"四类**分开**统计"这件事本身。
   */
  assert.ok(sum.byKind.MISS >= 1, '要有漏提取');
  assert.equal(sum.byKind.WRONG, 1, '值错误一条');
  /**
   * s05 的场景：`mustVisitTexts` 里混进了用户明确不想去的地方。
   * 那一条同时触发 EXTRA（必去里多了）与 MISS（排除项漏了）——
   * **两种毛病都要出现，而不是互相抵消**。
   */
  assert.ok(sum.byKind.EXTRA >= 1, '多提取（必去里混进不去的地方）要单独算');
  assert.equal(sum.byKind.MALFORMED, 0);
  assert.equal(sum.severity.extra, sum.byKind.EXTRA, 'severity 里 extra 要对得上');
  assert.match(sum.note, /多提取最严重/);
  assert.equal(typeof sum.checkPassRate, 'number');
  assert.equal(sum.failedSamples.length, 3);
});

test('汇总：全对时 cleanSamples 等于样例数', () => {
  const good = { endClock: { hour: 17, minute: 0 }, searchKeywords: ['中央大街'] };
  const sum = summarize([scoreSample(FIX.samples[0], good), scoreSample(FIX.samples[0], good)]);
  assert.equal(sum.cleanSamples, 2);
  assert.equal(sum.samplePassRate, 1);
  assert.equal(sum.byKind.MISS + sum.byKind.EXTRA + sum.byKind.WRONG + sum.byKind.MALFORMED, 0);
});

test('汇总：空输入不抛异常', () => {
  const sum = summarize(null);
  assert.equal(sum.samples, 0);
  assert.equal(sum.samplePassRate, null);
  assert.equal(sum.checkPassRate, null);
});

// ── 对着真实缺陷跑一遍（回归）──────────────────────────────

test('今天的 6 个真实缺陷，修复后的行为应当全部通过', () => {
  /**
   * 这些样例来自今天**真实撞到**的缺陷（commit 见 note）。
   * 用它们跑一遍"修复后的解析行为"，等价于把当时的教训固化下来。
   *
   * ⚠️ 这里喂的是**人工构造的'修复后'解析结果** ——
   * 因为规则解析器对这几条已经修好了，而模型那条路要真跑才知道。
   * 这条测试守的是**评分器对它们的判据**是正确的。
   */
  const fixed = {
    s02: { searchKeywords: ['哈工大', '冰雪大世界'], stayMinutesByText: { 哈工大: 60 } },
    s03: {
      searchKeywords: ['哈工大', '冰雪大世界', '哈学院'],
      stayMinutesByText: { 哈工大: 60, 冰雪大世界: 120, 哈学院: 60 },
    },
    s04: { searchKeywords: ['冰雪大世界'], stayMinutes: 60 },
    s05: { mustVisitTexts: ['中央大街'], avoidTexts: ['兆麟公园'], searchKeywords: ['中央大街'] },
    s07: { searchKeywords: ['和平路'] },
    s20: { mustVisitTexts: ['中央大街'] },
  };

  for (const [id, parsed] of Object.entries(fixed)) {
    const s = FIX.samples.find((x) => x.id === id);
    assert.ok(s, `样例 ${id} 不存在`);
    const bad = scoreSample(s, parsed).checks.filter((c) => !c.ok);
    assert.deepEqual(bad, [], `${id}（${s.note || ''}）不该有失败：${JSON.stringify(bad)}`);
  }
});

/**
 * ── 出行方式：用户报的真实缺陷（2026-10-14）──────────────────
 *
 * 用户原话："当我在行程框内输入**我想骑车去哈工大**时只会帮我选四个
 *            和哈工大相关的地点"
 *
 * ── 根因（两个，都要锁住）────────────────────────────────
 *
 * ① 「骑车」**完全没有被识别**成出行方式 —— 用户说了白说，
 *    规划仍按"自动"算，该骑车的那段可能给他排成步行。
 *
 * ② 更隐蔽：「骑车」插在「想」与「去」中间，把 `MUST_STRONG_RES` 的
 *    「想去」搅坏了 —— 它抓成「骑车去哈工」（不在库里，被丢弃），
 *    而 `MUST_WEAK_RE` 的「去哈工大」又因值已在 hits 里而跳过。
 *    结果**目的地没进必去**，一句话规划退化成
 *    "在哈工大附近随便挑几个点" —— 正是用户看到的现象。
 *
 * ⚠️ ②这个形态值得记：**多加两个字就把"必去"降级成了"顺路看看"**，
 *    而且全程不报错。没有这两条样例，它会一直躺在那儿。
 */
test('出行方式：真实缺陷 s26 与反向用例 s27 都要挡住', () => {
  const { rulebased } = require('../cloudfunctions/api/lib/ai');
  /** 真实调用会带已知地点名 —— 不带的话弱信号「去 X」按设计不收 */
  const known = ['哈工大', '中央大街', '索菲亚教堂', '冰雪大世界', '兆麟公园', '太阳岛'];
  const at = new Date('2026-10-14T09:00:00+08:00');

  for (const id of ['s26', 's27', 's28', 's29']) {
    const s = FIX.samples.find((x) => x.id === id);
    assert.ok(s, `样例 ${id} 不存在`);

    const parsed = rulebased.parse(s.text, { now: at, knownPlaceNames: known });
    const bad = scoreSample(s, parsed).checks.filter((c) => !c.ok);
    assert.deepEqual(bad, [], `${id}「${s.text}」不该有失败：${JSON.stringify(bad)}`);
  }
});

test('s26：「骑车」既不能丢，也不能把目的地吃掉', () => {
  const { rulebased } = require('../cloudfunctions/api/lib/ai');
  const known = ['哈工大', '中央大街'];
  const p = rulebased.parse('我想骑车去哈工大', {
    now: new Date('2026-10-14T09:00:00+08:00'),
    knownPlaceNames: known,
  });

  assert.equal(p.preferredMode, 'bicycling', '「骑车」必须被识别成出行方式');
  assert.deepEqual(p.mustVisitTexts, ['哈工大'], '「哈工大」必须进必去 —— 它是目的地，不是"附近随便看看"');
  assert.equal(p.searchKeyword, '哈工大');
  /** 依据要留痕，便于人工核对解析对不对 */
  assert.ok(
    p.matched.some((m) => m.field === 'preferredMode'),
    '解析依据里要留下"骑车→bicycling"这条'
  );
});

test('s27：「我想去地铁站」里的「地铁」是地名，不是出行方式', () => {
  /**
   * ⚠️ 这是**反向用例**，比正向更容易漏。
   *
   * 若把"地铁"识别成 transit，目的地就丢了 —— 用户说要去地铁站，
   * 系统却以为他想坐地铁去哪儿。只断言"期望某个方式"抓不到这类误判。
   */
  const { rulebased } = require('../cloudfunctions/api/lib/ai');
  const p = rulebased.parse('我想去地铁站', {
    now: new Date('2026-10-14T09:00:00+08:00'),
    knownPlaceNames: ['地铁站'],
  });

  assert.equal(p.preferredMode, null, '不该识别出出行方式');
  assert.equal(p.searchKeyword, '地铁站', '地名要完整保留');
});

test('「骑车」只在紧跟「去/到/往」时才算出行方式', () => {
  const { rulebased } = require('../cloudfunctions/api/lib/ai');
  const at = new Date('2026-10-14T09:00:00+08:00');

  /** 紧跟 → 是出行方式 */
  assert.equal(rulebased.parse('骑车去哈工大', { now: at }).preferredMode, 'bicycling');
  assert.equal(rulebased.parse('我想骑行到中央大街', { now: at }).preferredMode, 'bicycling');

  /** 不紧跟 → 不是（这里的"骑车"是在描述别的） */
  assert.equal(rulebased.parse('我想去骑车公园', { now: at }).preferredMode, null);
});

/**
 * ⚠️ 走 AI 解析时 `preferredMode` 是**模型直接给的**，必须校验。
 *
 * 用户连了 API 之后走的就是这条路 —— 只修规则解析器的正则，
 * 对他那条路一点用都没有。所以提示词里加了字段（`intent-v5`），
 * 而**校验放在 `toStructured`**：两条解析路径都经过它，单点收口。
 */
test('出行方式的归一化：模型的同义写法要认，野值要挡住', () => {
  const { rulebased } = require('../cloudfunctions/api/lib/ai');
  const at = new Date('2026-10-14T09:00:00+08:00');
  const norm = (v) => rulebased.toStructured({ rawText: 'x', preferredMode: v }, { now: at }).structured.preferredMode;

  /** 模型爱给这些 —— 都要归位，否则用户说的方式静默失效 */
  assert.equal(norm('bicycling'), 'bicycling');
  assert.equal(norm('bike'), 'bicycling');
  assert.equal(norm('bicycle'), 'bicycling');
  assert.equal(norm('自行车'), 'bicycling');
  assert.equal(norm('骑行'), 'bicycling');
  assert.equal(norm('BICYCLING'), 'bicycling', '大小写不该影响');
  assert.equal(norm(' 骑行 '), 'bicycling', '首尾空格不该影响');
  assert.equal(norm('走'), 'walking');
  assert.equal(norm('地铁'), 'transit');
  assert.equal(norm('drive'), 'driving');

  /** 认不出就置 null，**不原样透传** —— 野值会让下游静默失效 */
  assert.equal(norm('飞机'), null);
  assert.equal(norm('bikee'), null);
  assert.equal(norm(''), null);
  assert.equal(norm(null), null);
  assert.equal(norm(undefined), null);
});

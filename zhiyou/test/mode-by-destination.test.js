'use strict';

/**
 * 出行方式**按目的地分别记**（2026-10-14 用户要求）。
 *
 * 用户原话：
 *   "用户在搜索框输入后如果使用的是 ai 接口且去该目的地时表达了出行方式，
 *    则按说的出行方式选择（比如：我想骑车去哈工大），
 *    **若多个地名则只自动选择用户说过出行方式的目的地**
 *    （比如：我想骑车去哈工大，再去冰雪大世界 ——
 *     只是去哈工大的出行方式选择为骑车，
 *     **冰雪大世界依旧需要用户自己选择**）"
 *
 * ── 这一条纠正了粒度 ──────────────────────────────────────
 *
 * 我上一版把出行方式当成**整句话**的属性（一个 `preferredMode`）。
 * 而它是"**到某个目的地**"的属性：
 * 「我想骑车去哈工大，再去冰雪大世界」里的"骑车"只属于哈工大那一程。
 * 当成全局的话，系统会把"骑车"也套到 14 公里外的冰雪大世界上 ——
 * 而用户根本没这么说。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { rulebased } = require('../cloudfunctions/api/lib/ai');
const { loadPage } = require('./page-harness');

const AT = new Date('2026-10-14T09:00:00+08:00');
const KNOWN = ['哈工大', '中央大街', '冰雪大世界', '索菲亚教堂', '太阳岛'];
const parse = (t) => rulebased.parse(t, { now: AT, knownPlaceNames: KNOWN });

// ── 解析层：按地名配对 ─────────────────────────────────────

test('**首字缩写**要认（用户提醒："哈工大确实指的是哈尔滨工业大学"）', () => {
  /**
   * ⚠️ 用户原话：
   *   "哈工大确实指的是哈尔滨工业大学，**用户输入时会经常输入简写**"
   *   "那哈工大三个字哈尔滨工业大学七个字**明显不会覆盖一半**"
   *
   * `matchKnown` 的简称规则是"要覆盖全名一半长度"（3/7 ≈ 0.43 够不到），
   * 它挡的是"名字里嵌了地标名的民宿"。而中文地名缩写**不是取一半**，
   * 是**取每个词的首字**：哈工大 ← 哈尔滨·工业·大学。
   *
   * 两种规则的形状不同，只能并存 —— 见 `canonicalPlace` 的说明。
   */
  const FULL = ['哈尔滨工业大学', '中央大街', '哈尔滨冰雪大世界', '圣索菲亚教堂'];
  const p = rulebased.parse('我想骑车去哈工大', { now: AT, knownPlaceNames: FULL });

  assert.deepEqual(p.mustVisitTexts, ['哈尔滨工业大学'], '缩写要能对上全名');
  assert.deepEqual(p.preferredModeByText, { 哈尔滨工业大学: 'bicycling' }, '按地名记的方式也要用全名');
});

test('**两条路用同一套认地名的规则** —— 不许一条认、一条不认', () => {
  /**
   * ⚠️ 这条抓出过一个真错：我给 `preferredModeByText` 加了首字缩写，
   *    却把「必去目的地」那条路留着老逻辑。于是「我想骑车去哈工大」里：
   *
   *        地点被认出来了 → 检索词有了
   *        必去却是空的   → 它不被当成"一定要去"，只是个检索词
   *
   * 同一个系统里**两套认地名的规则**，必然出现这种"一个认、一个不认"。
   */
  const FULL = ['哈尔滨工业大学', '中央大街', '哈尔滨冰雪大世界', '圣索菲亚教堂'];
  const p = rulebased.parse('骑车去索菲亚', { now: AT, knownPlaceNames: FULL });

  assert.deepEqual(p.mustVisitTexts, ['圣索菲亚教堂'], '必去那条路要认缩写');
  assert.deepEqual(p.preferredModeByText, { 圣索菲亚教堂: 'bicycling' }, '方式那条路也要认');
});

test('缩写**不许**把"名字里嵌了地标名"的 POI 收进来', () => {
  /**
   * ⚠️ 这是 `matchKnown` 那半长度阈值的**存在理由**，缩写规则不能把它破坏掉。
   *
   * 实测踩过：用户说「我想去冰雪大世界」，库里有一条检索回来的 POI 叫
   * 「哈尔滨悦苒民宿(哈尔滨冰雪大世界融创文旅城龙川路地铁站)」——
   * 名字里嵌了地标名，宽松匹配就会命中它。
   */
  const FULL = ['哈尔滨冰雪大世界', '哈尔滨悦苒民宿(哈尔滨冰雪大世界融创文旅城龙川路地铁站)'];
  const p = rulebased.parse('我想去冰雪大世界', { now: AT, knownPlaceNames: FULL });

  assert.deepEqual(p.mustVisitTexts, ['哈尔滨冰雪大世界'], '要挑那个真正的景点，不是嵌了它名字的民宿');
});

test('一个地名：方式配到它身上', () => {
  const p = parse('我想骑车去哈工大');
  assert.deepEqual(p.preferredModeByText, { 哈工大: 'bicycling' });
  /** ⚠️ 能对到具体地名时**不算**全局偏好 —— 否则会套到别处 */
  assert.equal(p.modeIsGlobal, false);
});

test('**两个地名、只说了一个的方式** —— 另一个不许被套上', () => {
  /**
   * ⚠️ 这条正是用户举的例子，也是本次改动最核心的断言。
   */
  const p = parse('我想骑车去哈工大，再去冰雪大世界');

  assert.deepEqual(p.preferredModeByText, { 哈工大: 'bicycling' }, '骑车只属于哈工大那一程');
  assert.equal(
    Object.prototype.hasOwnProperty.call(p.preferredModeByText, '冰雪大世界'),
    false,
    '冰雪大世界**必须不在这里** —— 用户没说那一程怎么走'
  );
  assert.equal(p.modeIsGlobal, false, '不能当成全局偏好，否则会套到冰雪大世界上');

  /** 两个地方都要进必去 —— 说去就得去 */
  assert.deepEqual(p.mustVisitTexts, ['哈工大', '冰雪大世界']);
});

test('两个地名各说各的方式 —— 各配各的', () => {
  const p = parse('骑车去哈工大，然后步行去中央大街');
  assert.deepEqual(p.preferredModeByText, { 哈工大: 'bicycling', 中央大街: 'walking' });
});

test('说了方式但没说去哪 → 当整趟的默认偏好', () => {
  /**
   * 「我想骑车去」没说是去哪。这时不能把方式丢掉 ——
   * 用户确实说了"骑车"，只是没指定目的地。
   */
  const p = parse('我想骑车去');
  assert.equal(p.preferredMode, 'bicycling');
  assert.deepEqual(p.preferredModeByText, {}, '没配到任何地名');
  assert.equal(p.modeIsGlobal, true, '要标成全局偏好');
});

test('「我想去地铁站」里的"地铁"不是出行方式', () => {
  const p = parse('我想去地铁站');
  assert.equal(p.preferredMode, null);
  assert.deepEqual(p.preferredModeByText, {});
});

test('配对时**在连接词处切断** —— 否则会把后面整串当地名', () => {
  /**
   * ⚠️ 「骑车去哈工大，再去冰雪大世界」里，方式词后面紧跟的是
   *    「去哈工大，再去冰雪大世界」。不切断的话地名会变成一整串。
   */
  const p = parse('骑车去哈工大，再去冰雪大世界');
  const keys = Object.keys(p.preferredModeByText);
  assert.equal(keys.length, 1);
  assert.equal(keys[0], '哈工大', `地名必须是切干净的一个：${keys[0]}`);
});

// ── 归一化：模型给的同义写法 ───────────────────────────────

test('按地名的映射也要归一化，野值整条丢弃', () => {
  const norm = (v) =>
    rulebased.toStructured({ rawText: 'x', preferredModeByText: v }, { now: AT }).structured
      .preferredModeByText;

  assert.deepEqual(norm({ 哈工大: 'bike', 中央大街: '自行车' }), {
    哈工大: 'bicycling',
    中央大街: 'bicycling',
  });
  /** 认不出的**整条丢**，不留半截 —— 野值会让下游静默失效 */
  assert.deepEqual(norm({ 哈工大: '飞机' }), {});
  assert.deepEqual(norm({ 哈工大: 'bicycling', 坏数据: 'xxx' }), { 哈工大: 'bicycling' });
  assert.deepEqual(norm(null), {});
  assert.deepEqual(norm(['bicycling']), {}, '数组不是映射，要挡住');
});

// ── 界面层：哪几段需要用户自己选 ───────────────────────────

function pageWithLegs(parsedLegModes, preferredMode, legOptionsOverride) {
  const page = loadPage('miniprogram/pages/trip/index.js', {});
  page.setData({
    parsedLegModes: parsedLegModes || {},
    preferredMode: preferredMode || 'auto',
  });
  page.applyTrip(
    {
      tripId: 't1',
      version: 1,
      nodes: [
        { nodeId: 'n0', placeId: 'p_n0', placeName: '哈工大', status: 'pending', seq: 0 },
        { nodeId: 'n1', placeId: 'p_n1', placeName: '冰雪大世界', status: 'pending', seq: 1 },
      ],
      saved: true,
      summary: { endAt: '2026-10-20T05:00:00.000Z', totalWalkMin: 8, totalStayMin: 90 },
      startPoint: { latitude: 45.75, longitude: 126.6 },
      startLeg: { minutes: 12, meters: 900, mode: 'walking', toPlaceName: '哈工大' },
      legOptions: legOptionsOverride || [
        {
          toPlaceId: 'p_n0',
          toPlaceName: '哈工大',
          isFirstLeg: true,
          chosenMode: 'driving',
          recommendedMode: 'driving',
          options: [
            { mode: 'bicycling', minutes: 30, isRecommended: false },
            { mode: 'driving', minutes: 18, isRecommended: true },
          ],
          unavailable: [],
        },
        {
          toPlaceId: 'p_n1',
          toPlaceName: '冰雪大世界',
          fromPlaceName: '哈工大',
          chosenMode: 'driving',
          recommendedMode: 'driving',
          options: [
            { mode: 'bicycling', minutes: 72.7, isRecommended: false },
            { mode: 'driving', minutes: 19.3, isRecommended: true },
          ],
          unavailable: [],
        },
      ],
    },
    ''
  );
  return page;
}

test('用户说了方式的**那一段**按他说的选，标成"按你那句话里说的"', () => {
  const page = pageWithLegs({ 哈工大: 'bicycling' }, 'auto');
  const leg = page.data.legPicker.find((l) => l.toPlaceId === 'p_n0');

  assert.equal(leg.selected, 'bicycling', '按用户说的骑车');
  assert.equal(leg.source, 'words');
  assert.match(leg.sourceNote, /那句话/);
  assert.equal(leg.needsChoice, false, '用户说过了，不需要再问');
});

test('用户**没说方式的那些段**标成"待你选择"', () => {
  /**
   * ⚠️ 用户的明确要求："其余**依旧需要用户自己选择**"。
   *
   * 没有任何偏好（偏好是"自动"）时，系统挑的那个只是"最快的建议"，
   * 不该假装成用户的决定。
   */
  const page = pageWithLegs({ 哈工大: 'bicycling' }, 'auto');
  const leg = page.data.legPicker.find((l) => l.toPlaceId === 'p_n1');

  assert.equal(leg.needsChoice, true, '冰雪大世界那一段要用户自己选');
  assert.equal(leg.source, 'auto');
});

test('他在「我的」设了默认方式时，没说到的那段标成"按你的默认"而不是"待你选择"', () => {
  /**
   * 有默认偏好就是"他心里有数"，系统按它预选并如实标注 ——
   * 与"什么都没有、系统只好挑最快的"是两回事。
   */
  const page = pageWithLegs({ 哈工大: 'bicycling' }, 'walking');
  const leg = page.data.legPicker.find((l) => l.toPlaceId === 'p_n1');

  assert.equal(leg.needsChoice, false, '有默认偏好就不必标"待你选择"');
  assert.equal(leg.source, 'default');
  assert.match(leg.sourceNote, /我的/);
});

test('用户在逐段选择器里点过的**优先于**解析结果', () => {
  /**
   * 优先级：选择器里点的（最近、最具体）> 那句话里说的 > 系统挑的。
   * 否则用户点了"那我走路吧"，界面又跳回骑车。
   */
  const page = pageWithLegs({ 哈工大: 'bicycling' }, 'auto');
  page.onLegModeTap({ currentTarget: { dataset: { placeid: 'p_n0', mode: 'driving' } } });

  const leg = page.data.legPicker.find((l) => l.toPlaceId === 'p_n0');
  assert.equal(leg.selected, 'driving', '以用户点的为准');
  assert.equal(leg.source, 'user');
});

test('地名对不上时**不硬套** —— 宁可让他自己选', () => {
  /**
   * ⚠️ 张冠李戴比"没生效"更糟：把"骑车"套到 14 公里外那一段上，
   *    用户会以为系统乱来。
   */
  const page = pageWithLegs({ 完全不认识的地方: 'bicycling' }, 'auto');
  const leg = page.data.legPicker.find((l) => l.toPlaceId === 'p_n0');

  assert.notEqual(leg.selected, 'bicycling', '对不上就不该套上去');
  assert.equal(leg.needsChoice, true);
});

test('用户说的词是地点名的一部分时能对上（"哈工大" → "哈工大科技园"）', () => {
  const page = pageWithLegs({ 哈工大: 'bicycling' }, 'auto');
  const leg = page.data.legPicker.find((l) => l.toPlaceId === 'p_n0');
  assert.equal(leg.selected, 'bicycling', '包含关系算同一个地方');
});

test('**方向只有一个** —— 长的键不许命中短的名字', () => {
  /**
   * ⚠️ 这条抓出过一个真 bug：我第一版写成双向包含
   *    （`n.indexOf(key) >= 0 || key.indexOf(n) >= 0`），
   *    于是键「哈尔滨工业大学」也命中了地点名「哈工大」。
   *
   * 后果不是"多匹配了一个"，而是**两段被同一个键一起套上** ——
   * 用户只对其中一个说了方式，另一个被张冠李戴。
   */
  const page = pageWithLegs({ 哈尔滨工业大学: 'bicycling' }, 'auto');

  const leg0 = page.data.legPicker.find((l) => l.toPlaceId === 'p_n0')
  const leg1 = page.data.legPicker.find((l) => l.toPlaceId === 'p_n1')

  assert.notEqual(leg0.selected, 'bicycling', '短名不该被长键命中');
  assert.notEqual(leg1.selected, 'bicycling', '更不该同时套到两段上');
  assert.equal(leg0.needsChoice, true);
});

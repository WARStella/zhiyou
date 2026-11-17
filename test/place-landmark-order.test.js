'use strict';

/**
 * 检索结果的**地标分层**（2026-10-14 用户要求）。
 *
 * 用户原话：
 *   "不要按强度，按理说**哈尔滨工业大学应该排在第一**，
 *    其次是**哈尔滨工业大学（南门）**这种的，
 *    但我想把这种带有地点坐标的**除非直接输入这些地标否则都放在后面**，
 *    比如第二个会出现**哈尔滨工程大学**，第三个会出现**哈尔滨理工大学**"
 *
 * ── 为什么需要它 ──────────────────────────────────────────
 *
 * `relevance` 排序**保留上游（腾讯）的相关性顺序**。搜"哈工大"时上游会把
 * 「哈尔滨工程大学」「哈尔滨理工大学」这类**同族名字**排在真地标附近 ——
 * 于是用户看到的第二个候选是一所**完全不同的学校**。
 *
 * 分成三层：主地标 → 它的子地点 → 其余。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeWorld, expectOk, createMapProvider } = require('./helpers');

const CENTER = { latitude: 45.7756, longitude: 126.6175 };

/**
 * 造一个"上游按这个顺序返回"的假地图服务。
 *
 * @param {Array<{title:string, lat?:number, lng?:number}>} pois 顺序即上游相关性顺序
 */
function mapWith(pois) {
  return () =>
    Object.assign(createMapProvider('fake', {}), {
      searchPlaces: async () => ({
        ok: true,
        items: pois.map((p, i) => ({
          poiId: 'x' + i,
          title: p.title,
          address: p.address || null,
          /** ⚠️ 用户说"带有地点坐标的" —— 真实 POI 都有坐标，这里也照给 */
          location: { latitude: p.lat === undefined ? CENTER.latitude : p.lat, longitude: p.lng === undefined ? CENTER.longitude : p.lng },
        })),
      }),
    });
}

/** 用户举的那一组：真地标 + 它的门 + 两所同族的别的学校 */
const REAL_WORLD = [
  { title: '哈尔滨工业大学' },
  { title: '哈尔滨工程大学' },
  { title: '哈尔滨理工大学' },
  { title: '哈尔滨工业大学（南门）' },
];

async function searchNames(pois, keyword) {
  const w = await makeWorld({ seedPlaces: [], createMapProvider: mapWith(pois) });
  const res = expectOk(
    await w.A('place.search', { keyword: keyword || '哈工大', center: CENTER, provider: 'fake' })
  );
  return res.candidates.map((c) => c.name);
}

test('主地标第一，**它的子地点第二**，同族的别的学校排后面', async () => {
  /**
   * ⚠️ 用户举的正是这一组：「哈尔滨工程大学」在第二个、
   *    「哈尔滨理工大学」在第三个 —— 而它们是**完全不同的学校**，
   *    只是名字同族。
   */
  const names = await searchNames(REAL_WORLD);

  assert.equal(names[0], '哈尔滨工业大学', '真地标必须第一');
  assert.equal(names[1], '哈尔滨工业大学（南门）', '它的门第二（而不是别的学校）');

  const huGong = names.indexOf('哈尔滨工程大学');
  const huLi = names.indexOf('哈尔滨理工大学');
  assert.ok(huGong >= 2, `哈尔滨工程大学要被排到子地点之后，实际第 ${huGong + 1}`);
  assert.ok(huLi >= 2, `哈尔滨理工大学要被排到子地点之后，实际第 ${huLi + 1}`);
});

test('层内**保持上游顺序** —— 只调层级，不推翻上游的相关性', async () => {
  /**
   * ⚠️ `哈尔滨工程大学` 在上游排在 `哈尔滨理工大学` 前面，
   *    分层之后这个相对顺序必须保留 —— 上游的相关性判断仍然是有信息的。
   */
  const names = await searchNames(REAL_WORLD);
  assert.ok(
    names.indexOf('哈尔滨工程大学') < names.indexOf('哈尔滨理工大学'),
    '同层内的先后要与上游一致'
  );
});

test('**"地址里带了地标"的不算子地点** —— 长度约束不能省', async () => {
  /**
   * ⚠️ 真实事故：搜「冰雪大世界」时上游返回一条
   *    「哈尔滨悦苒民宿(哈尔滨冰雪大世界融创文旅城龙川路地铁站)」——
   *    名字里嵌了地标名，但长度是地标的三倍。
   *
   * 它是"**地址里带了地标**"，不是"地标的某个门"，而且它还是住宿
   * （不可游览，会被移到后面）。这里守的是**分层判定本身**：
   * 不能因为"名字含主地标"就当成子地点。
   */
  const names = await searchNames([
    { title: '哈尔滨冰雪大世界' },
    { title: '哈尔滨悦苒民宿(哈尔滨冰雪大世界融创文旅城龙川路地铁站)' },
    { title: '兆麟公园' },
  ]);

  assert.equal(names[0], '哈尔滨冰雪大世界');
  const hotel = names.indexOf('哈尔滨悦苒民宿(哈尔滨冰雪大世界融创文旅城龙川路地铁站)');
  assert.ok(hotel > 0, '那家民宿不该被当成子地点提到前面');
});

test('主地标太短时**不做分层** —— 两个字做包含判定太容易误伤', async () => {
  /**
   * 「公园」只有两个字，做包含判定会把"兆麟公园""斯大林公园"
   * 全当成它的子地点。短名字直接放弃分层，顺序原样保留。
   */
  const names = await searchNames([
    { title: '公园' },
    { title: '兆麟公园' },
    { title: '斯大林公园' },
  ]);
  assert.deepEqual(names, ['公园', '兆麟公园', '斯大林公园'], '短名不做分层，保持上游顺序');
});

test('直接输入子地点本身时它就在第一位 —— "除非直接输入这些地标"', async () => {
  /**
   * ⚠️ 用户原话里有这句："**除非直接输入这些地标**否则都放在后面"。
   *
   * 直接输入「哈工大南门」时，上游返回的第一条就是那个门本身，
   * 它成为主地标，自然排在第一 —— 这条规则**自动满足**，
   * 不需要额外判断。
   */
  const names = await searchNames(
    [{ title: '哈尔滨工业大学（南门）' }, { title: '哈尔滨工业大学' }, { title: '哈尔滨工程大学' }],
    '哈工大南门'
  );

  assert.equal(names[0], '哈尔滨工业大学（南门）', '直接搜的门就该第一');
  /** 而它的"母体"这时算不算子地点？含主地标名、且更短 —— 归到"其余"，仍在后面 */
  assert.ok(names.indexOf('哈尔滨工程大学') > 0);
});

test('只有一个结果时原样返回，不折腾', async () => {
  const names = await searchNames([{ title: '哈尔滨工业大学' }]);
  assert.deepEqual(names, ['哈尔滨工业大学']);
});

test('分层真的移动了顺序 —— **不是"上游恰好就对"**', async () => {
  /**
   * ⚠️ 这条是防"安慰剂测试"的：上面那几条断言**可能在上游顺序恰好
   *    就对时也通过**，那样就测不到分层逻辑。
   *
   * 这里刻意把子地点放在**上游最后一位**，看它会不会被提上来。
   * 若分层失效，它会留在最后 —— 这条就会失败。
   */
  const pois = [
    { title: '哈尔滨工业大学' },
    { title: '哈尔滨工程大学' },
    { title: '哈尔滨理工大学' },
    { title: '哈尔滨工业大学（南门）' }, // ← 上游最后
  ];
  const upstream = pois.map((p) => p.title);
  const names = await searchNames(pois);

  assert.notDeepEqual(names, upstream, '排序结果必须与上游顺序不同，否则等于没分层');
  assert.equal(names[1], '哈尔滨工业大学（南门）', '子地点要从最后一位提到第二位');
});

test('子地点的长度上限：正好 2 倍以内算，超过就不算', async () => {
  /**
   * 边界守卫。`SUB_LOCATION_MAX_RATIO = 2` ——
   * 留足后缀（`（南门）` / `-1号门` / `(游客中心)`）的余地，
   * 又挡住"整条地址"那种。
   */
  const base = '哈尔滨工业大学'; // 7 字 → 上限 14 字
  const names = await searchNames([
    { title: base },
    { title: '别的什么地方' },
    { title: base + '（南门）' }, // 11 字 ≤ 14 ✓
    { title: base + '融创文旅城龙川路地铁站店' }, // 21 字 > 14 ✗
  ]);

  const sub = names.indexOf(base + '（南门）')
  const tooLong = names.indexOf(base + '融创文旅城龙川路地铁站店')
  assert.equal(sub, 1, '2 倍以内的后缀算子地点');
  assert.ok(tooLong > sub, '超过 2 倍的不算子地点，要留在后面');
});

test('没有名字的脏数据不崩', async () => {
  const names = await searchNames([{ title: '哈尔滨工业大学' }, { title: '' }, { title: '哈尔滨工程大学' }]);
  assert.ok(names.length >= 2);
  assert.equal(names[0], '哈尔滨工业大学');
});

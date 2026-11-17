'use strict';

/**
 * 上游录音回放测试 —— **用真实返回驱动真实解析代码**。
 *
 * 与 `map.test.js` 的区别：
 *   · `map.test.js` 用 `fake.js`（我自己写的数据）测**行为契约**；
 *   · 本文件用录音（上游真的说过的话）测**解析是否正确**。
 *
 * 后者不可替代 —— `duration` 单位那个 bug（815 米返回 12，按秒解析会算成
 * 实际的 1/60，**且不报错**）只有真实返回才能暴露。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const { createMapProvider } = require('../cloudfunctions/api/lib/map');
const { createReplayTransport } = require('../cloudfunctions/api/lib/map/replay');
const { checkDurationUnit } = require('../cloudfunctions/api/lib/map/tencent');

const DIR = join(__dirname, 'fixtures', 'upstream');

/** 读出所有录音（跳过 README 之类的非 JSON 文件） */
function loadRecordings() {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')));
}

const RECORDINGS = loadRecordings();

/** 用录音驱动的 **真实 tencent provider**（不是另一个模拟器） */
function replayedProvider(recordings) {
  return createMapProvider('tencent', {
    http: createReplayTransport({ recordings: recordings || RECORDINGS }),
    key: 'REPLAY_KEY',
    timeoutMs: 1000,
  });
}

test('录音夹具至少有一条，且都是真实来源', () => {
  assert.ok(RECORDINGS.length >= 1, '没有录音夹具，这个文件等于没测');
  for (const r of RECORDINGS) {
    assert.ok(r.name, '每条录音要有名字');
    assert.ok(r.kind, '每条录音要标明接口类型');
    assert.match(String(r.source || ''), /真实/, `${r.name} 必须注明是真实调用返回`);
    assert.ok(r.body, `${r.name} 缺少 body`);
  }
});

test('真实步行返回：distance 单位是米、duration 单位是分钟', async () => {
  /**
   * 这是**真实事故的回归**：
   * 中央大街 → 防洪纪念塔，上游返回 `distance: 815, duration: 12`。
   * 按秒理解 = 68 米/秒（244 km/h），荒谬；
   * 按分钟理解 = 68 米/分 ≈ 4 km/h，与步行吻合。
   *
   * 首版代码写的是 `durationSeconds / 60` —— 会把每段步行时间算成实际的 1/60，
   * 而规划器的可行性检查会全部误判为"时间充裕"，**且不报错**。
   */
  const p = replayedProvider();
  const r = await p.walkingRoute(
    { latitude: 45.7756, longitude: 126.6175 },
    { latitude: 45.781, longitude: 126.6185 }
  );

  assert.equal(r.ok, true);
  assert.equal(r.status, 0);
  assert.equal(r.httpStatus, 200);

  assert.equal(r.distanceMeters, 815, '距离单位是米');
  assert.equal(r.durationRaw, 12, '上游原样返回 12');
  assert.equal(r.durationUnit, 'minute', '单位必须是分钟 —— 按秒理解是 244 km/h');
  assert.equal(r.durationMinutes, 12, '归一化后就是 12 分钟');
  assert.equal(r.unitCheck.plausible, true);
  assert.ok(
    r.unitCheck.impliedMPerMin >= 55 && r.unitCheck.impliedMPerMin <= 80,
    `隐含步速 ${r.unitCheck.impliedMPerMin} 米/分应接近真实步行速度`
  );

  // 自检逻辑与真实数据对得上
  const chk = checkDurationUnit(815, 12);
  assert.equal(chk.unit, 'minute');
  assert.equal(chk.plausible, true);
});

test('真实步行返回：折线是扁平数组，第一个点是绝对坐标', async () => {
  const p = replayedProvider();
  const r = await p.walkingRoute(
    { latitude: 45.7756, longitude: 126.6175 },
    { latitude: 45.781, longitude: 126.6185 }
  );

  assert.ok(r.polylineNumbers > 0, '要能读到折线');
  assert.equal(r.polylineNumbers % 2, 0, '扁平数组按两个一组，长度应为偶数');
  assert.equal(r.polylinePointCount, r.polylineNumbers / 2);

  // ⚠️ 首对是**绝对坐标**，其后是相对前一点的增量 —— 不能当成坐标序列直接用
  const [lat, lng] = r.polylineHead;
  assert.ok(lat > 45 && lat < 46, `首点纬度 ${lat} 应在哈尔滨范围内`);
  assert.ok(lng > 126 && lng < 127, `首点经度 ${lng} 应在哈尔滨范围内`);

  // 与输入坐标同一坐标系（相差几十米内）
  assert.ok(Math.abs(lat - 45.7756) < 0.01);
  assert.ok(Math.abs(lng - 126.6175) < 0.01);
});

test('真实步行返回：解析出的字段路径与 parsedVia 记录一致', async () => {
  const p = replayedProvider();
  const r = await p.walkingRoute(
    { latitude: 45.7756, longitude: 126.6175 },
    { latitude: 45.781, longitude: 126.6185 }
  );

  // parsedVia 是给人核对用的：万一上游改了结构，这份记录会立刻对不上
  assert.equal(r.parsedVia.distance, 'result.routes[0].distance');
  assert.equal(r.parsedVia.duration, 'result.routes[0].duration');

  const rec = RECORDINGS.find((x) => x.kind === 'direction-walking');
  const route = rec.body.result.routes[0];
  assert.equal(r.distanceMeters, route.distance, '解析值必须等于录音里的原值');
  assert.equal(r.durationRaw, route.duration);
  assert.equal(r.stepCount, route.steps.length, '步数应与录音一致（录音可能被截断）');
  assert.ok(r.firstStep && r.firstStep.instruction, '第一段指引要能读出来');
  assert.match(r.firstStep.instruction, /西北|上游街/);
});

test('回放传输层：找不到录音时必须显式失败，不能静默返回空', async () => {
  const p = replayedProvider([
    { name: '只有步行', kind: 'direction-walking', source: '真实', body: { status: 0, result: { routes: [] } } },
  ]);

  /**
   * ⚠️ provider **从不抛异常** —— 它把所有上游问题转成 `ok: false` 的结构化结果
   * （这是契约的一部分，见 map.test.js 的"失败就是失败"那组断言）。
   * 所以这里断言的是"失败被如实报告"，而不是"抛了异常"。
   */
  const r = await p.searchPlaces({ keyword: '冰雪大世界', center: { latitude: 45.78, longitude: 126.63 } });

  assert.equal(r.ok, false, '找不到录音就必须失败 —— 静默返回空会让测试假绿');
  assert.match(r.message, /没有对应的录音/);
  assert.match(r.message, /place-search/, '错误信息要说明是哪一类接口');
});

test('回放传输层：能按关键词挑到对应的那条录音', async () => {
  const recordings = [
    {
      name: '搜教堂',
      kind: 'place-search',
      source: '真实',
      request: { keyword: '教堂' },
      body: { status: 0, message: 'Success', count: 1, data: [{ id: 'poi_1', title: '圣索菲亚教堂', category: '旅游景点:教堂', location: { lat: 45.7703, lng: 126.6206 } }] },
    },
    {
      name: '搜公园',
      kind: 'place-search',
      source: '真实',
      request: { keyword: '公园' },
      body: { status: 0, message: 'Success', count: 1, data: [{ id: 'poi_2', title: '兆麟公园', category: '旅游景点:公园', location: { lat: 45.7749, lng: 126.624 } }] },
    },
  ];
  const p = replayedProvider(recordings);

  const a = await p.searchPlaces({ keyword: '教堂', center: { latitude: 45.78, longitude: 126.63 } });
  assert.equal(a.items[0].title, '圣索菲亚教堂');

  const b = await p.searchPlaces({ keyword: '公园', center: { latitude: 45.78, longitude: 126.63 } });
  assert.equal(b.items[0].title, '兆麟公园');
});

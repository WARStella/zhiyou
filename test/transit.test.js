'use strict';

/**
 * 高德公交（含地铁）provider 的测试。
 *
 * ── 这一版是**按实测重写的**（2026-10-14）──────────────────
 *
 * 上一版的字段路径是照官方文档写的，结果是：端点与参数都不对，
 * 一次都没跑通。后来用户在浏览器里直接把 URL 打通了，拿到真实返回，
 * 才有下面这些断言。
 *
 * fixture 来源：`test/fixtures/upstream/direction-transit-integrated-harbin.json`
 * （中央大街 → 冰雪大世界，真实返回精简而来，字段名一字未改）。
 *
 * 三条实测结论被钉在这里，别再靠"读文档"推翻它们：
 *   ① **端点用 v3**，城市参数是 `city`/`cityd`。
 *      v5 的 `city1`/`city2` 在同一 Key、同一坐标下回 `20001 缺少必填参数`。
 *   ② **成功的 `infocode` 是 `10000`**，而成功返回**也带 `info`**（值为 "OK"）——
 *      所以"有 info 就算错"是错的（我犯过这个错）。
 *   ③ **地铁识别看 `buslines[].type` 是否含「地铁」**（实测：`"地铁线路"`）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createAmapTransitProvider, parseTransit, STRATEGY, DEFAULT_ENDPOINT } = require('../cloudfunctions/api/lib/transit/amap');

const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures', 'upstream', 'direction-transit-integrated-harbin.json'),
    'utf8'
  )
);

const FROM = { latitude: 45.7756, longitude: 126.6175 }; // 中央大街
const TO = { latitude: 45.8029, longitude: 126.5353 }; // 冰雪大世界方向
const CITY = '0451'; // 哈尔滨 citycode

function fakeHttp(body) {
  const urls = [];
  const fn = async (url) => {
    urls.push(url);
    const json = typeof body === 'function' ? body(url) : body;
    // 真 defaultTransport 返回 { json, httpStatus, rawBody } —— 形状要对齐
    return { json, httpStatus: 200, rawBody: JSON.stringify(json) };
  };
  fn.urls = urls;
  return fn;
}

function provider(http, opts) {
  return createAmapTransitProvider(Object.assign({ key: 'FAKE-AMAP-KEY', http }, opts || {}));
}

// ── 端点与参数（这是卡了三轮的地方）──────────────────────

test('端点必须是 v3，且城市参数是 city（实测：v5 的 city1 回 20001）', async () => {
  const http = fakeHttp(FIXTURE.body);
  await provider(http).route({ from: FROM, to: TO, city: CITY });

  const url = http.urls[0];
  assert.match(DEFAULT_ENDPOINT, /\/v3\/direction\/transit\/integrated/, '用 v3 端点');
  assert.match(url, /[?&]city=0451/, 'v3 的城市参数是 city');
  assert.ok(!/[?&]city1=/.test(url), 'v5 的 city1 在这条端点上没有意义');
  assert.ok(!/show_fields=/.test(url), 'v5 才需要 show_fields=cost，v3 默认就返回票价');
});

test('坐标顺序是 lon,lat —— 与腾讯相反，写反了不报错但会规划到别处', async () => {
  const http = fakeHttp(FIXTURE.body);
  await provider(http).route({ from: FROM, to: TO, city: CITY });

  assert.match(http.urls[0], /origin=126\.617500%2C45\.775600/, 'origin 必须是「经度,纬度」');
  assert.match(http.urls[0], /destination=126\.535300%2C45\.802900/);
});

test('跨城才传 cityd', async () => {
  const http = fakeHttp(FIXTURE.body);
  await provider(http).route({ from: FROM, to: TO, city: CITY });
  assert.ok(!/cityd=/.test(http.urls[0]), '同城不该带 cityd');

  const http2 = fakeHttp(FIXTURE.body);
  await provider(http2).route({ from: FROM, to: TO, city: CITY, cityd: '010' });
  assert.match(http2.urls[0], /cityd=010/);
});

test('city 是必填，漏了本地就拦住并说清字段名', async () => {
  const http = fakeHttp(FIXTURE.body);
  const r = await provider(http).route({ from: FROM, to: TO });

  assert.equal(r.reason, 'CITY_REQUIRED');
  assert.match(r.message, /citycode/);
  assert.equal(http.urls.length, 0);
});

test('strategy 用 v3 的五档（不是 v5 的九档）', async () => {
  const expected = { 0: '最快捷', 1: '最经济', 2: '最少换乘', 3: '最少步行', 5: '不乘地铁' };
  for (const [value, label] of Object.entries(expected)) {
    const http = fakeHttp(FIXTURE.body);
    const r = await provider(http).route({ from: FROM, to: TO, city: CITY, strategy: value });
    assert.match(http.urls[0], new RegExp(`strategy=${value}`));
    assert.equal(r.strategyLabel, label);
  }
  assert.equal(STRATEGY.FASTEST, '0');
  assert.equal(STRATEGY.NO_SUBWAY, '5');
});

// ── 解析真实返回 ────────────────────────────────────────────

test('解析真实返回：取到两个方案，各自的耗时/步行/票价都对', async () => {
  const http = fakeHttp(FIXTURE.body);
  const r = await provider(http).route({ from: FROM, to: TO, city: CITY });

  assert.equal(r.ok, true);
  assert.equal(r.routes.length, 2);

  // 方案一：地铁，4170 秒 = 69.5 分
  assert.equal(r.routes[0].durationMinutes, 69.5);
  assert.equal(r.routes[0].walkingMeters, 3442);
  assert.equal(r.routes[0].costYuan, 3);
  assert.equal(r.routes[0].hasSubway, true);

  // 方案二：普通公交，3773 秒 ≈ 62.9 分，步行更少、更便宜
  assert.equal(r.routes[1].durationMinutes, 62.9);
  assert.equal(r.routes[1].walkingMeters, 1538);
  assert.equal(r.routes[1].costYuan, 2);
  assert.equal(r.routes[1].hasSubway, false);
});

test('默认给的是第一个方案，且步骤按"走路→坐车→出入口"排开', async () => {
  const http = fakeHttp(FIXTURE.body);
  const r = await provider(http).route({ from: FROM, to: TO, city: CITY });

  const kinds = r.best.steps.map((s) => s.kind);
  assert.deepEqual(kinds, ['walking', 'transit', 'entrance-exit', 'walking']);
  assert.equal(r.best.transitStepCount, 1);
});

test('地铁识别：`type` 含「地铁」→ 地铁；「普通公交线路」→ 不是', async () => {
  const transit = parseTransit(FIXTURE.body);

  const subway = transit.best.steps.find((s) => s.kind === 'transit');
  assert.equal(subway.isSubway, true);
  assert.equal(subway.lineType, '地铁线路');
  assert.equal(subway.lineName, '地铁2号线(气象台--江北大学城)');
  assert.equal(subway.departureStop, '中央大街');
  assert.equal(subway.arrivalStop, '世茂大道');
  assert.equal(subway.viaStationCount, 3);
  /**
   * ⚠️ 首末班时间：实测发现 **`start_time` 是空数组**，值在 `station_start_time` 里。
   * 而 `[]` 是 truthy —— `a || b` 会拿到 `[]`，界面渲染成空白且不报错。
   *
   * 这条断言第一次写的时候用了一个"我以为"的 fixture（`start_time: "0532"`），
   * 于是测试绿着、线上却显示空 —— 又犯了"用自己编的样本测自己写的规则"。
   * 现在 fixture 是**真实形状**（空数组 + station_*），断言也钉住回落行为。
   */
  assert.equal(FIXTURE.body.route.transits[0].segments[0].bus.buslines[0].start_time.length, 0, '前提：实测 start_time 是空数组');
  assert.equal(subway.startTime, '0532', '应当回落到 station_start_time');
  assert.equal(subway.endTime, '2254', '应当回落到 station_end_time');

  // 方案二的 126 路是普通公交
  const bus = parseTransit(FIXTURE.body).routes[1];
  assert.equal(bus.hasSubway, false);
  assert.deepEqual(bus.lineNames, ['126路(防洪纪念塔(友谊路)--枫叶小镇奥特莱斯)']);
});

test('出入口（几号口）被解析出来 —— 这是集合协同最有用的信息', async () => {
  const transit = parseTransit(FIXTURE.body);
  const ee = transit.best.steps.find((s) => s.kind === 'entrance-exit');

  assert.ok(ee, '实测返回里有 entrance/exit，不能丢');
  assert.equal(ee.entranceName, '1号口');
  assert.equal(ee.exitName, '3号口');
  assert.deepEqual(ee.entranceLocation, { latitude: 45.769293, longitude: 126.616338 });
  assert.match(ee.instruction, /进 1号口/, '要说成人话');
});

test('步行指引用上游原话', async () => {
  const transit = parseTransit(FIXTURE.body);
  const walk = transit.best.steps.find((s) => s.kind === 'walking');

  assert.equal(walk.instruction, '步行41米右转');
  assert.ok(walk.allInstructions.length >= 2, '全部步行指引都要留着');
  assert.equal(walk.walkingMeters, 1011);
  assert.equal(walk.durationSeconds, 1013);
});

test('route 层的整体信息（总里程、打车参考价）也要取出来', async () => {
  const transit = parseTransit(FIXTURE.body);
  assert.equal(transit.routeSummary.distanceMeters, 9409);
  assert.equal(transit.routeSummary.taxiCostYuan, 24);
});

test('转车次数按"坐车段数 - 1"算', async () => {
  const transit = parseTransit(FIXTURE.body);
  assert.equal(transit.routes[0].transferCount, 0, '只有一段地铁 → 无需换乘');
  assert.equal(transit.routes[1].transferCount, 0, '只有一段公交 → 无需换乘');
});

// ── 成功与失败的判定 ────────────────────────────────────────

test('回归：成功返回**也带 info 与 infocode**，不能因此判失败', async () => {
  /**
   * ⚠️ 我上一版把判定写成 `ok = status==='1' && !infocode && !info`，
   * 而真实成功返回是 `{"status":"1","info":"OK","infocode":"10000", …}` ——
   * **成功会被判成失败**。这条测试钉住"10000 才是成功码"。
   */
  const http = fakeHttp(FIXTURE.body);
  const r = await provider(http).route({ from: FROM, to: TO, city: CITY });

  assert.equal(FIXTURE.body.info, 'OK', '前提：实测成功返回带 info');
  assert.equal(FIXTURE.body.infocode, '10000', '前提：实测成功 infocode 是 10000');
  assert.equal(r.ok, true, '带 info/infocode 的成功返回必须判成功');
});

test('实测的三种错误返回都要判失败，且带成因提示', async () => {
  const cases = [
    ['20001', 'MISSING_REQUIRED_PARAMS', /city|缺少必填/],
    ['10001', 'INVALID_USER_KEY', /Key/],
    ['10012', 'NO_PERMISSION', /未开通|权限/],
  ];
  for (const [infocode, info, re] of cases) {
    const http = fakeHttp({ status: '0', info, infocode });
    const r = await provider(http).route({ from: FROM, to: TO, city: CITY });
    assert.equal(r.ok, false, `${infocode} 应当判失败`);
    assert.equal(r.infocode, infocode);
    assert.ok(r.hint, `${infocode} 必须有提示`);
    assert.match(r.hint, re);
  }
});

test('没有公交方案时明确说明，而不是返回空壳', async () => {
  const http = fakeHttp({ status: '1', info: 'OK', infocode: '10000', count: '0', route: { transits: [] } });
  const r = await provider(http).route({ from: FROM, to: TO, city: CITY });

  assert.equal(r.ok, true, '上游调用本身成功');
  assert.equal(r.best, null);
  assert.equal(r.emptyReason, 'NO_TRANSIT_ROUTE');
});

test('实测的 parsedVia 要如实带出去（供以后核对字段）', async () => {
  const transit = parseTransit(FIXTURE.body);
  assert.match(transit.parsedVia.duration, /秒/);
  assert.match(transit.parsedVia.buslines, /数组/);
  assert.match(transit.parsedVia.lineType, /地铁线路/);
  assert.match(transit.parsedVia.entranceExit, /几号口/);
});

test('缺字段的返回不炸（上游结构可能再变）', () => {
  const parsed = parseTransit({ route: { transits: [{}] } });
  assert.equal(parsed.best.durationMinutes, null);
  assert.equal(parsed.best.hasSubway, false);
  assert.equal(parsed.best.transitStepCount, 0);
  assert.ok(parsed.parsedVia);
});

// ── Key 相关的通用约定 ──────────────────────────────────────

test('没配 Key 时给可执行的修复指引，且不发请求', async () => {
  const http = fakeHttp(FIXTURE.body);
  const r = await createAmapTransitProvider({ key: '', http }).route({ from: FROM, to: TO, city: CITY });
  assert.equal(r.reason, 'AMAP_KEY_NOT_CONFIGURED');
  assert.equal(http.urls.length, 0);
});

test('Key 前后空白会被去掉（与照片 provider 共用同一份归一化）', async () => {
  const http = fakeHttp(FIXTURE.body);
  const p = createAmapTransitProvider({ key: '  AMAP-KEY-X  ', http });
  await p.route({ from: FROM, to: TO, city: CITY });

  assert.equal(p.keyStatus().trimmed, true);
  assert.match(http.urls[0], /key=AMAP-KEY-X$/);
});

test('Key 不出现在返回结构里（脱敏）', async () => {
  const http = fakeHttp(FIXTURE.body);
  const r = await provider(http).route({ from: FROM, to: TO, city: CITY });
  assert.ok(!JSON.stringify(r).includes('FAKE-AMAP-KEY'));
  assert.match(r.requestUrl, /key=\*\*\*REDACTED\*\*\*/);
});

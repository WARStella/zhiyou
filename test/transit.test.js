'use strict';

/**
 * 高德公交（含地铁）provider 的测试。
 *
 * 全程不联网：HTTP 传输通过 `opts.http` 注入。
 * 契约来自官方文档（**未持 Key 实测**），所以每个字段都注明依据；
 * 实测若与文档不符，改的是这里并记录差异 —— 这也是 `transit.probe` 存在的理由。
 *
 * 这一层最容易出错的不是解析，而是**坐标顺序**：
 * 高德要求 `lon,lat`，而腾讯要 `lat,lng`，**两家相反**。
 * 写反了不会报错，只会得到一个"看起来正常、实际在几百公里外"的方案。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAmapTransitProvider, parseTransit, STRATEGY } = require('../cloudfunctions/api/lib/transit/amap');

const HARBIN = '哈尔滨';
const FROM = { latitude: 45.7756, longitude: 126.6175 }; // 中央大街
const TO = { latitude: 45.8038, longitude: 126.5331 }; // 冰雪大世界方向

function fakeHttp(body) {
  const urls = [];
  const fn = async (url) => {
    urls.push(url);
    return { json: typeof body === 'function' ? body(url) : body, httpStatus: 200 };
  };
  fn.urls = urls;
  return fn;
}

/** 高德公交规划的正常返回骨架（route.transits[]） */
function transitOk(transits) {
  return { status: '1', info: 'OK', count: String((transits || []).length), route: { transits: transits || [] } };
}

function provider(http, opts) {
  return createAmapTransitProvider(Object.assign({ key: 'FAKE-AMAP-KEY', http }, opts || {}));
}

test('坐标顺序是 lon,lat —— 与腾讯相反，写反了不会报错但会规划到别处', async () => {
  const http = fakeHttp(transitOk([]));
  await provider(http).route({ from: FROM, to: TO, city: HARBIN });

  const url = http.urls[0];
  assert.match(url, /origin=126\.617500%2C45\.775600/, 'origin 必须是「经度,纬度」');
  assert.match(url, /destination=126\.533100%2C45\.803800/);
});

test('city 是必填，漏了要在本地拦住并说清原因', async () => {
  const http = fakeHttp(transitOk([]));
  const r = await provider(http).route({ from: FROM, to: TO });

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'CITY_REQUIRED');
  assert.match(r.message, /city/);
  /**
   * 漏 city 时高德回的是 `20001 缺少必填参数`，而那个错误码**不点明是 city** ——
   * 所以本地拦一道，把排查方向直接指出来。
   */
  assert.match(r.hint, /哈尔滨/);
  assert.equal(http.urls.length, 0, '本地就能判定的错误不该发请求');
});

test('strategy 进 URL，且中文名可展示（这几档本身就是可解释的偏好）', async () => {
  for (const [name, value] of Object.entries(STRATEGY)) {
    const http = fakeHttp(transitOk([]));
    const r = await provider(http).route({ from: FROM, to: TO, city: HARBIN, strategy: value });
    assert.match(http.urls[0], new RegExp(`strategy=${value}`));
    assert.equal(r.strategyLabel, { 0: '最快捷', 1: '最经济', 2: '最少换乘', 3: '最少步行', 5: '不乘地铁' }[value]);
  }
});

test('缺省 strategy 为「最快捷」', async () => {
  const http = fakeHttp(transitOk([]));
  const r = await provider(http).route({ from: FROM, to: TO, city: HARBIN });
  assert.equal(r.strategy, '0');
  assert.equal(r.strategyLabel, '最快捷');
});

test('解析出一个可用的公交方案：耗时、步行距离、票价、换乘', async () => {
  const http = fakeHttp(
    transitOk([
      {
        duration: '1860', // 31 分钟
        walking_distance: '820',
        cost: '2.0',
        segments: [
          { walking: { distance: '300', duration: '240' }, instruction: '步行至防洪纪念塔站' },
          {
            bus: {
              buslines: [
                {
                  name: '地铁2号线(气象台--江北大学城)',
                  type: '地铁线路',
                  via_num: '4',
                  departure_stop: { name: '防洪纪念塔' },
                  arrival_stop: { name: '冰雪大世界' },
                },
              ],
            },
            instruction: '乘坐地铁2号线',
          },
          { walking: { distance: '520', duration: '420' }, instruction: '步行至目的地' },
        ],
      },
    ])
  );
  const r = await provider(http).route({ from: FROM, to: TO, city: HARBIN });

  assert.equal(r.ok, true);
  assert.equal(r.best.durationMinutes, 31, '1860 秒 = 31 分钟');
  assert.equal(r.best.walkingMeters, 820);
  assert.equal(r.best.costYuan, 2);
  assert.equal(r.best.hasSubway, true, '这一段是地铁 —— 界面上该显示地铁图标');
  assert.equal(r.best.transitStepCount, 1, '只有一步是坐车，其余是走路');

  const ride = r.best.steps.find((s) => s.kind === 'transit');
  assert.equal(ride.isSubway, true);
  assert.equal(ride.lineName, '地铁2号线(气象台--江北大学城)');
  assert.equal(ride.departureStop, '防洪纪念塔');
  assert.equal(ride.arrivalStop, '冰雪大世界');
  assert.equal(ride.viaStationCount, 4);
});

test('公交（非地铁）不会被误判成地铁', async () => {
  const http = fakeHttp(
    transitOk([
      {
        duration: '2400',
        walking_distance: '400',
        segments: [
          {
            bus: { buslines: [{ name: '110路', type: '普通公交线路', via_num: '8' }] },
          },
        ],
      },
    ])
  );
  const r = await provider(http).route({ from: FROM, to: TO, city: HARBIN });

  assert.equal(r.best.hasSubway, false);
  assert.equal(r.best.steps[0].isSubway, false);
  assert.equal(r.best.steps[0].lineName, '110路');
});

test('多方案时给出各自摘要（"最少换乘"这类偏好要有依据）', async () => {
  const http = fakeHttp(
    transitOk([
      { duration: '1800', walking_distance: '600', cost: '2.0', segments: [{ bus: { buslines: [{ type: '地铁线路' }] } }] },
      { duration: '2400', walking_distance: '200', cost: '1.0', segments: [{ bus: { buslines: [{ type: '普通公交线路' }] } }] },
    ])
  );
  const r = await provider(http).route({ from: FROM, to: TO, city: HARBIN });

  assert.equal(r.routes.length, 2);
  assert.equal(r.routes[0].durationMinutes, 30);
  assert.equal(r.routes[1].walkingMeters, 200, '第二方案步行更少 —— "最少步行"的依据');
  assert.equal(r.routes[1].costYuan, 1, '"最经济"的依据');
});

test('没有公交方案时明确说明，而不是返回一个空壳', async () => {
  const http = fakeHttp(transitOk([]));
  const r = await provider(http).route({ from: FROM, to: TO, city: HARBIN });

  assert.equal(r.ok, true, '上游调用本身成功');
  assert.equal(r.best, null);
  assert.equal(r.emptyReason, 'NO_TRANSIT_ROUTE', '要说清"这两点之间没有公交"，而不是"出错了"');
});

test('20801/20802 这类"公交不可达"的 status 要给出人话', async () => {
  const http = fakeHttp({ status: '20801', info: '起点附近没有公交站点' });
  const r = await provider(http).route({ from: FROM, to: TO, city: HARBIN });

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'UPSTREAM_STATUS_20801');
  assert.match(r.hint, /公交不可达|没有公交站点/);
});

test('没配 Key 时给可执行的修复指引，且不发请求', async () => {
  const http = fakeHttp(transitOk([]));
  const r = await createAmapTransitProvider({ key: '', http }).route({ from: FROM, to: TO, city: HARBIN });

  assert.equal(r.reason, 'AMAP_KEY_NOT_CONFIGURED');
  assert.match(r.hint, /环境变量/);
  assert.equal(http.urls.length, 0);
});

test('Key 前后空白会被去掉（与照片 provider 共用同一份归一化）', async () => {
  const http = fakeHttp(transitOk([]));
  const p = createAmapTransitProvider({ key: '  AMAP-KEY-X  ', http });
  await p.route({ from: FROM, to: TO, city: HARBIN });

  assert.equal(p.keyStatus().trimmed, true);
  assert.match(http.urls[0], /key=AMAP-KEY-X$/, '实际发出去的必须是去掉空白后的值');
});

test('Key 不出现在返回结构里（脱敏）', async () => {
  const http = fakeHttp(transitOk([]));
  const r = await provider(http).route({ from: FROM, to: TO, city: HARBIN });
  assert.ok(!JSON.stringify(r).includes('FAKE-AMAP-KEY'));
  assert.match(r.requestUrl, /key=\*\*\*REDACTED\*\*\*/);
});

test('缺起点或终点时本地拦住', async () => {
  const http = fakeHttp(transitOk([]));
  const r = await provider(http).route({ from: FROM, city: HARBIN });
  assert.equal(r.reason, 'ORIGIN_DESTINATION_REQUIRED');
  assert.equal(http.urls.length, 0);
});

test('parseTransit 对缺字段的返回不炸（上游结构可能与我们预期不同）', () => {
  const parsed = parseTransit({ route: { transits: [{}] } });
  assert.equal(parsed.best.durationMinutes, null);
  assert.equal(parsed.best.hasSubway, false);
  assert.equal(parsed.best.transitStepCount, 0);
  assert.ok(parsed.parsedVia, '必须带回"按哪个字段路径解析的"，便于与实测核对');
});

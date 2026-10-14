'use strict';

/**
 * 公交探针的测试。
 *
 * 探针的价值全在**分层**：把"公交规划不通"的几种互不相干的原因拆开。
 * 所以测试围绕"层与层不能混"来写 —— 尤其 Key 没配时，
 * 后面几层必须明确说**没测**，而不是让它看起来像也失败了。
 *
 * 还有一个只有测试能守住的东西：`parsedVia` 与 `rawHead` 必须回传。
 * 没有它们，实测发现字段对不上时**无从定位** —— 那探针就白探了。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, expectOk } = require('./helpers');
const { createAmapTransitProvider } = require('../cloudfunctions/api/lib/transit/amap');

function fakeHttp(body) {
  const urls = [];
  const fn = async (url) => {
    urls.push(url);
    const json = typeof body === 'function' ? body(url) : body;
    /**
     * ⚠️ 必须同时给 `rawBody` —— 真 `defaultTransport` 返回的就是
     * `{ json, httpStatus, rawBody }`。少了它，`rawHead` 会是 null，
     * 而"字段与实际不符时贴回原始返回核对"**正是这个探针的核心用途**。
     * 替身缺一项，探针就废一半，而且不会有任何报错。
     */
    return { json, httpStatus: 200, rawBody: JSON.stringify(json) };
  };
  fn.urls = urls;
  return fn;
}

/** 一个"看起来对"的公交返回：含一段地铁 */
function transitBody() {
  return {
    status: '1',
    info: 'OK',
    count: '1',
    route: {
      transits: [
        {
          duration: '1860',
          walking_distance: '820',
          cost: '2.0',
          segments: [
            { walking: { distance: '300', duration: '240' } },
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
            },
          ],
        },
      ],
    },
  };
}

function worldWith(http, opts) {
  opts = opts || {};
  return makeWorld({
    createTransitProvider: () =>
      createAmapTransitProvider(
        Object.assign({ key: opts.key === undefined ? 'FAKE-AMAP-KEY' : opts.key, http }, opts.providerOpts)
      ),
  });
}

test('全通时 verdict 为 OK，四层都过', async () => {
  const w = await worldWith(fakeHttp(transitBody()));
  const res = expectOk(await w.A('transit.probe', {}));

  assert.equal(res.ok, true);
  assert.equal(res.verdict, 'OK');
  const byStep = Object.fromEntries(res.steps.map((s) => [s.step, s]));
  assert.equal(byStep['api-key'].ok, true);
  assert.equal(byStep.upstream.ok, true);
  assert.equal(byStep.fields.ok, true);
  assert.equal(byStep.subway.ok, true);
  assert.match(byStep.subway.detail, /地铁2号线/, '要把识别到的线路名说出来');
  assert.equal(res.mapApiCalls, 1, '探针会真实调用上游，要如实报告消耗');
});

test('Key 没配时：后三层明确说**未测**，且不发请求', async () => {
  const http = fakeHttp(transitBody());
  const w = await worldWith(http, { key: '' });
  const res = expectOk(await w.A('transit.probe', {}));

  assert.equal(res.ok, false);
  assert.equal(res.verdict, 'KEY_MISSING');

  const byStep = Object.fromEntries(res.steps.map((s) => [s.step, s]));
  /**
   * `ok: null` 表示"没测"，与 `ok: false`（测了没过）**必须能区分** ——
   * 混同会让人去查本来没问题的地方。
   */
  assert.equal(byStep.upstream.ok, null, '未测必须是 null，不能是 false');
  assert.match(byStep.upstream.detail, /未测/);
  assert.equal(byStep.fields.ok, null);
  assert.equal(byStep.subway.ok, null);
  assert.equal(http.urls.length, 0, '没 Key 就不该发请求');
  assert.equal(res.mapApiCalls, undefined, '没发请求就不该报告消耗');
});

test('上游失败时字段层与地铁层不冒充"没通过"', async () => {
  const http = fakeHttp({ status: '10012', info: '权限不足' });
  const w = await worldWith(http);
  const res = expectOk(await w.A('transit.probe', {}));

  assert.equal(res.verdict, 'UPSTREAM_FAILED');
  const byStep = Object.fromEntries(res.steps.map((s) => [s.step, s]));
  assert.equal(byStep.upstream.ok, false);
  assert.equal(byStep.fields.ok, null, '上游没通，字段无从核对 —— 是"未测"不是"失败"');
  assert.equal(byStep.subway.ok, null);
  /**
   * 提示要指向控制台里真正该改的那一项。这里实际给的是
   * 「权限不足 —— 该 Key 可能未开通此接口」—— 比笼统说"去开通服务"更准，
   * 因为高德的接口是**逐个开通**的，问题通常就出在没勾「公交路径规划」。
   */
  assert.match(res.hint, /未开通此接口|权限/, '要指向控制台里真正该改的那一项');
});

test('接口通但没识别到地铁时，verdict 明确指向识别规则 —— 这正是探针要发现的东西', async () => {
  const body = transitBody();
  // 把地铁换成普通公交：模拟"识别规则可能不对"的情况
  body.route.transits[0].segments[1].bus.buslines[0].type = '普通公交线路';
  body.route.transits[0].segments[1].bus.buslines[0].name = '110路';

  const w = await worldWith(fakeHttp(body));
  const res = expectOk(await w.A('transit.probe', {}));

  assert.equal(res.verdict, 'SUBWAY_NOT_DETECTED');
  const byStep = Object.fromEntries(res.steps.map((s) => [s.step, s]));
  assert.equal(byStep.fields.ok, true, '字段解析是通的');
  assert.equal(byStep.subway.ok, false, '但地铁没识别出来');
  assert.match(res.hint, /rawHead/, '要请人把原始返回贴回来，否则无从改起');
});

test('没有公交方案时不被当成"接口失败"', async () => {
  const http = fakeHttp({ status: '1', info: 'OK', count: '0', route: { transits: [] } });
  const w = await worldWith(http);
  const res = expectOk(await w.A('transit.probe', {}));

  assert.equal(res.verdict, 'NO_ROUTE');
  const byStep = Object.fromEntries(res.steps.map((s) => [s.step, s]));
  assert.equal(byStep.upstream.ok, true, '接口是通的');
  assert.match(byStep.fields.detail, /没有公交方案/);
});

test('parsedVia 与 rawHead 必须回传 —— 没有它们，实测发现字段不符时无从定位', async () => {
  const w = await worldWith(fakeHttp(transitBody()));
  const res = expectOk(await w.A('transit.probe', {}));

  const fields = res.steps.find((s) => s.step === 'fields');
  assert.ok(fields.raw.parsedVia, '必须带回"按哪个字段路径解析的"');
  assert.match(fields.raw.parsedVia.duration, /transits\[0\]\.duration/);
  assert.ok(res.rawHead, '必须带回原始返回头部，用于与文档核对');
  assert.match(res.rawHead, /transits/, 'rawHead 里应当能看到真实结构');
});

test('探针默认用的是一条"必须坐车"的线路（跨松花江），否则验不出地铁识别', async () => {
  const http = fakeHttp(transitBody());
  const w = await worldWith(http);
  const res = expectOk(await w.A('transit.probe', {}));

  assert.equal(res.city, '哈尔滨');
  // 起终点纬度差不大但经度差约 0.08（跨江），直线距离远超步行合理范围
  const dLng = Math.abs(res.probeFrom.longitude - res.probeTo.longitude);
  assert.ok(dLng > 0.05, `默认探针起终点应当相距较远（实际经度差 ${dLng}），否则会得到一条"全靠走"的方案`);
});

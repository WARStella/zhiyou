'use strict';

/**
 * 距离矩阵的测试。
 *
 * ── 这一层要守住的核心是一条"会静默出错"的行为 ─────────────
 *
 * 官方文档原文：某对起终点算失败时返回 `status: 4`，
 * 此时 **`distance` 是直线距离，且不返回 `duration`。**
 *
 * 也就是说：**一个失败的结果看起来完全正常** —— 它有距离、字段齐全、
 * 不报错。不检查 `status`，就会把直线距离当成路面距离用。
 * 而这个项目在这一点上已经有过实测教训：
 *
 *     直线 605 米 → 实际步行 815 米   （1.35 倍）
 *     直线  10 米 → 实际步行  76 米   （7.6 倍）
 *
 * 短距离下直线距离**根本不是距离**。所以 `usable: false` 这条断言，
 * 是本文件里最重要的一条。
 *
 * 全程不联网：HTTP 传输通过 `opts.http` 注入。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTencentProvider } = require('../cloudfunctions/api/lib/map/tencent');
const { createFakeProvider } = require('../cloudfunctions/api/lib/map/fake');
const { MATRIX_MODES } = require('../cloudfunctions/api/lib/map/matrix-modes');

const FROM = { latitude: 45.7756, longitude: 126.6175 };
const TOS = [
  { latitude: 45.781, longitude: 126.6185 },
  { latitude: 45.783, longitude: 126.619 },
];

function fakeHttp(body) {
  const urls = [];
  const fn = async (url) => {
    urls.push(url);
    return { json: typeof body === 'function' ? body(url) : body, httpStatus: 200 };
  };
  fn.urls = urls;
  return fn;
}

/** 腾讯矩阵接口的正常返回：rows[0].elements[] */
function matrixOk(elements) {
  return { status: 0, message: 'query ok', result: { rows: [{ elements: elements }] } };
}

function provider(http, opts) {
  return createTencentProvider(Object.assign({ key: 'FAKE-MAP-KEY', http }, opts || {}));
}

test('正常返回：路面距离与耗时都解析出来，并归一化成分钟', async () => {
  const http = fakeHttp(
    matrixOk([
      { distance: 815, duration: 720 },
      { distance: 1200, duration: 900 },
    ])
  );
  const r = await provider(http).distanceMatrix(FROM, TOS, 'walking');

  assert.equal(r.ok, true);
  assert.equal(r.mode, 'walking');
  assert.equal(r.elements.length, 2);
  assert.equal(r.usableCount, 2);
  assert.equal(r.elements[0].distanceMeters, 815);
  assert.equal(r.elements[0].durationMinutes, 12, '720 秒 = 12 分钟');
  assert.equal(r.elements[1].durationMinutes, 15);
  // 计量按"计算次数"，不是请求次数 —— 界面与成本记录都要用这个数
  assert.equal(r.calculationCount, 2);
});

test('⚠️ status:4 的结果必须标 usable:false —— 否则直线距离会被当成路面距离', async () => {
  const http = fakeHttp(
    matrixOk([
      { distance: 800, status: 4 }, // 附近没有路：这是**直线距离**
      { distance: 815, duration: 720 },
    ])
  );
  const r = await provider(http).distanceMatrix(FROM, TOS, 'walking');

  assert.equal(r.ok, true, '整个请求是成功的');
  assert.equal(r.usableCount, 1, '只有一对是可用的路面结果');

  const bad = r.elements[0];
  assert.equal(bad.usable, false, '算失败的那一对必须标出来');
  assert.equal(bad.failureReason, 'NO_ROAD_NEARBY');
  assert.equal(bad.distanceMeters, 800, '距离照原样带回（便于排查），但不可用');
  assert.equal(bad.durationMinutes, null);
  assert.equal(bad.rawStatus, 4);
});

test('缺失的 element 也按不可用处理，且原因与"没有路"分开', async () => {
  const http = fakeHttp(matrixOk([{ distance: 815, duration: 720 }])); // 只回了一对，但要了两对
  const r = await provider(http).distanceMatrix(FROM, TOS, 'walking');

  assert.equal(r.usableCount, 1);
  assert.equal(r.elements[1].usable, false);
  assert.equal(r.elements[1].failureReason, 'NO_CELL', '空白格与"附近没有路"是两回事，排查方向不同');
});

test('duration 为 0 视为"上游没给"，而不是"零分钟"', async () => {
  /**
   * 旧版距离接口对步行恒返回 `duration: 0`（文档原文：「步行方式不计算耗时，
   * 该值始终为 0」）。矩阵接口是否也这样，文档没说 —— 所以要能容纳两种可能。
   * 把 0 当成"零分钟"会让步行时间变成 0，整条时间线失去意义。
   */
  const http = fakeHttp(matrixOk([{ distance: 815, duration: 0 }]));
  const r = await provider(http).distanceMatrix(FROM, [TOS[0]], 'walking');

  assert.equal(r.elements[0].usable, true, '距离仍是可用的路面距离');
  assert.equal(r.elements[0].durationMinutes, null, '0 表示"没给"，不是 0 分钟');
  /**
   * ⚠️ 字段名从 `durationSeconds` 改成了 **`durationRaw`**（2026-10-14）——
   * 原名**假设了单位是秒**，而那个假设从未实测过，且同一文件里
   * 步行路线接口的实测结论是**分钟**。把未验证的单位写进字段名
   * 会让读它的人以为那是既定事实。
   */
  assert.equal(r.elements[0].durationRaw, 0, '原始值照实保留，便于核对');
});

// ── duration 单位自检（2026-10-14 新增）────────────────────

test('单位自检：步行 815 米 / duration 12 → 判为**分钟**（68 米/分符合步速）', async () => {
  const http = fakeHttp(matrixOk([{ distance: 815, duration: 12 }]));
  const r = await provider(http).distanceMatrix(FROM, [TOS[0]], 'walking');
  const el = r.elements[0];

  assert.equal(el.unitCheck.plausible, true);
  assert.equal(el.unitCheck.unit, 'minutes', '12 分钟走 815 米是合理步速；12 秒则荒谬');
  assert.equal(el.unitCheck.divisor, 1);
  assert.equal(el.durationMinutes, 12, '按分钟归一化，不能再除以 60');
  assert.match(el.unitCheck.note, /分钟/);
});

test('单位自检：**两种解释都不合理**时如实标出来，不假装数据是好的', async () => {
  /**
   * ⚠️ 这条来自用户实测（2026-10-14）：
   * 「到冰雪大世界 14426 米、24.7 分钟、显示为步行」——等于 **35 km/h 的步行**。
   *
   * 24.7 分钟来自 `1482 / 60`，即假设单位是秒。但：
   *   · 按秒   → 35 km/h，不是步行
   *   · 按分钟 → 35 km/h，也不是步行
   *
   * 两种都不合理，说明上游返回值与方式不一致（可能没尊重 mode，
   * 或 duration 与 distance 不是同一段路）。**没有实测数据时不该猜一个单位**，
   * 而应该把这个矛盾记下来 —— 一个"35 km/h 的步行"流到界面上，
   * 人会按一个不可能的速度安排行程。
   */
  const http = fakeHttp(matrixOk([{ distance: 14426, duration: 1482 }]));
  const r = await provider(http).distanceMatrix(FROM, [TOS[0]], 'walking');
  const el = r.elements[0];

  assert.equal(el.unitCheck.plausible, false, '两种解释都不在步行区间，必须标出来');
  assert.match(el.unitCheck.note, /都不在/);
  assert.match(el.unitCheck.note, /mode/, '要指出最可能的原因');
  assert.ok(el.unitCheck.impliedSpeedMPerMin > 120, '隐含速度确实过高');
  /** 原始值要留着，实测核对方便 */
  assert.equal(el.durationRaw, 1482);
  assert.equal(el.distanceMeters, 14426);
});

test('单位自检：驾车 14426 米 / 1482 → 按秒是合理车速', async () => {
  const http = fakeHttp(matrixOk([{ distance: 14426, duration: 1482 }]));
  const r = await provider(http).distanceMatrix(FROM, [TOS[0]], 'driving');
  const el = r.elements[0];

  assert.equal(el.unitCheck.plausible, true, '同一组数在驾车下是合理的');
  assert.equal(el.unitCheck.unit, 'seconds');
  assert.equal(el.durationMinutes, 24.7);
});

test('单元格失败时不做单位自检 —— 此时 distance 是直线距离，判速度没有意义', async () => {
  const http = fakeHttp(matrixOk([{ distance: 5000, duration: 120, status: 4 }]));
  const r = await provider(http).distanceMatrix(FROM, [TOS[0]], 'walking');
  const el = r.elements[0];

  assert.equal(el.usable, false);
  assert.equal(el.unitCheck.plausible, null, '失败单元格自检应为"未测"');
  assert.equal(el.unitCheck.impliedSpeedMPerMin, null);
});

test('公交被明确拒绝 —— 拿驾车耗时冒充公交比不做更糟', async () => {
  const http = fakeHttp(matrixOk([]));
  const r = await provider(http).distanceMatrix(FROM, TOS, 'transit');

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'MODE_NOT_SUPPORTED');
  assert.match(r.message, /不支持/);
  assert.match(r.message, /direction\/v1\/transit/, '要指出公交该走哪条路，而不是只说"不支持"');
  assert.equal(http.urls.length, 0, '不支持的方式不该发请求');
});

test('三种支持的方式都能正常发出请求，且 mode 进 URL', async () => {
  for (const mode of MATRIX_MODES) {
    const http = fakeHttp(matrixOk([{ distance: 800, duration: 600 }]));
    const r = await provider(http).distanceMatrix(FROM, [TOS[0]], mode);
    assert.equal(r.ok, true, `${mode} 应当被支持`);
    assert.match(http.urls[0], new RegExp(`mode=${mode}`));
    assert.match(http.urls[0], /\/ws\/distance\/v1\/matrix/);
  }
});

test('终点个数上限与空终点都被拦住，且不发请求', async () => {
  const http = fakeHttp(matrixOk([]));
  const p = provider(http);

  const none = await p.distanceMatrix(FROM, [], 'walking');
  assert.equal(none.reason, 'TO_REQUIRED');

  const tooMany = await p.distanceMatrix(
    FROM,
    Array.from({ length: 201 }, (_, i) => ({ latitude: 45.7 + i * 0.001, longitude: 126.6 })),
    'walking'
  );
  assert.equal(tooMany.reason, 'TOO_MANY_TARGETS');

  assert.equal(http.urls.length, 0);
});

test('没配 Key 时给出可执行的修复指引', async () => {
  const http = fakeHttp(matrixOk([]));
  const r = await createTencentProvider({ key: '', http }).distanceMatrix(FROM, TOS, 'walking');

  assert.equal(r.reason, 'MAP_KEY_NOT_CONFIGURED');
  assert.match(r.hint, /环境变量/);
  assert.equal(http.urls.length, 0);
});

test('上游 status 非 0 时带出 status 与成因提示', async () => {
  const http = fakeHttp({ status: 311, message: 'key格式错误' });
  const r = await provider(http).distanceMatrix(FROM, TOS, 'walking');

  assert.equal(r.ok, false);
  assert.equal(r.status, 311);
  assert.equal(r.reason, 'UPSTREAM_STATUS_311');
});

test('Key 不出现在返回结构里（脱敏）', async () => {
  const http = fakeHttp(matrixOk([{ distance: 800, duration: 600 }]));
  const r = await provider(http).distanceMatrix(FROM, [TOS[0]], 'walking');
  assert.ok(!JSON.stringify(r).includes('FAKE-MAP-KEY'), 'Key 不得泄漏进响应');
  assert.match(r.requestUrl, /key=\*\*\*REDACTED\*\*\*/);
});

// ── 假 provider 的契约 ──────────────────────────────────────

test('假 provider 缺省**不编造耗时** —— 编一份会让链路误以为已经能跑', async () => {
  const p = createFakeProvider({ key: 'FAKE' });
  const r = await p.distanceMatrix(FROM, TOS, 'walking');

  assert.equal(r.ok, true);
  assert.equal(r.usableCount, 0, '缺省没有任何可用结果');
  assert.equal(r.elements[0].failureReason, 'FAKE_NO_DATA');
  assert.equal(r.elements[0].durationMinutes, null);
});

test('假 provider 的显式注入值可用（测试要能表达"上游给了什么"）', async () => {
  const p = createFakeProvider({
    key: 'FAKE',
    matrixResults: [{ distanceMeters: 815, durationSeconds: 720 }],
  });
  const r = await p.distanceMatrix(FROM, [TOS[0]], 'walking');

  assert.equal(r.usableCount, 1);
  assert.equal(r.elements[0].distanceMeters, 815);
  assert.equal(r.elements[0].durationMinutes, 12);
});

test('假 provider 能模拟 status:4（"直线距离被当路面距离"那个入口）', async () => {
  const p = createFakeProvider({ key: 'FAKE', matrixNoRoad: true });
  const r = await p.distanceMatrix(FROM, TOS, 'walking');

  assert.equal(r.usableCount, 0);
  assert.equal(r.elements[0].failureReason, 'NO_ROAD_NEARBY');
  assert.equal(r.elements[0].distanceMeters, 800, '刻意给一个"看起来正常的距离"——正是不检查就会中招的形态');
});

test('假 provider 与真实 provider 的方式清单一致（防漂移）', async () => {
  const fake = createFakeProvider({ key: 'FAKE' });
  const real = createTencentProvider({ key: 'FAKE', http: fakeHttp(matrixOk([])) });

  for (const mode of ['walking', 'bicycling', 'driving', 'transit', 'flying']) {
    const a = await fake.distanceMatrix(FROM, [TOS[0]], mode);
    const b = await real.distanceMatrix(FROM, [TOS[0]], mode);
    assert.equal(
      a.ok,
      b.ok,
      `${mode}：假 provider 与真实 provider 的支持范围必须一致（否则测试绿灯、真机失败）`
    );
  }
});

// ── Key 状态接口（2026-10-14 补）──────────────────────────

test('回归：腾讯 provider 必须提供 keyStatus() —— 缺了会让探针误报"未配 Key"', () => {
  /**
   * ⚠️ 这条守着一个**白跑一轮**的错：
   *
   * 腾讯 provider 原来只有 `keyConfigured` / `keyMasked`（**属性**），
   * 而高德那两个 provider 用的是 `keyStatus()`（**方法**）。
   * 我写距离矩阵探针时照搬了高德那套：
   *
   *     typeof provider.keyStatus === 'function'
   *       ? provider.keyStatus() : { configured: null }     // ← 永远拿到 null
   *
   * 而探针把这个 null 归进了"未配 Key"，于是**在没有问题的地方报了 KEY_MISSING** ——
   * 而规划明明一直在正常调用矩阵（界面上有驾车数据）。
   *
   * 教训：`typeof x === 'function'` 这种"有就用"的写法，在对方**没有**
   * 这个方法时**静默降级成另一个结论**，而不是报错。
   */
  const p = createTencentProvider({ key: 'MAP-SECRET-KEY' });

  assert.equal(typeof p.keyStatus, 'function', '必须提供 keyStatus()');
  const ks = p.keyStatus();
  assert.equal(ks.configured, true);
  assert.match(ks.masked, /\*/, '只允许掩码');
  assert.equal(ks.masked.includes('SECRET'), false, '掩码不得泄露 Key');
  assert.equal(ks.trimmed, false);
});

test('两个 Key 接口形状必须同时可用 —— 旧的使用者不能被破坏', () => {
  const p = createTencentProvider({ key: '\tMAP-SECRET-KEY ' });

  /** 旧字段（actions/map.js 与既有测试在用） */
  assert.equal(p.keyConfigured, true);
  assert.equal(p.keyWasTrimmed, true);
  /** 新方法（探针在用） */
  assert.equal(p.keyStatus().configured, true);
  assert.equal(p.keyStatus().trimmed, true);
  /** 两者必须一致 —— 不一致比缺一个更糟 */
  assert.equal(p.keyStatus().configured, p.keyConfigured);
});

test('没配 Key 时 keyStatus 如实报 false', () => {
  const p = createTencentProvider({ key: '' });
  assert.equal(p.keyStatus().configured, false);
  assert.equal(p.keyStatus().masked, null);
});
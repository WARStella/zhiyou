'use strict';

/**
 * 高德照片 provider 的测试。
 *
 * 全程**不需要 Key、不联网**：HTTP 传输通过 `opts.http` 注入。
 * 这样"真实上游返回什么形状"这件事可以在拿到 Key 之前就锁进测试里，
 * 拿到 Key 之后实测只需**核对**，而不是从零试错。
 *
 * ⚠️ 这份契机的来源是官方文档（未持 Key 实测），所以每个字段都写明了
 * 它依据的是哪一句文档原话 —— 实测若与文档不符，改的是这里，并记录差异。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAmapPhotoProvider, pickBestByName, normalizeKey } = require('../cloudfunctions/api/lib/photo/amap');

const HERE = { latitude: 45.781, longitude: 126.6185 };

/** 造一个假传输：记录请求 URL，并返回指定的高德响应体 */
function fakeHttp(body, opts) {
  opts = opts || {};
  const urls = [];
  const fn = async (url) => {
    urls.push(url);
    if (opts.throw) throw opts.throw;
    return { json: typeof body === 'function' ? body(url) : body, httpStatus: 200 };
  };
  fn.urls = urls;
  return fn;
}

/** 高德「搜索POI 2.0」的正常返回：status 为**字符串** '1' */
function amapOk(pois) {
  return { status: '1', info: 'OK', count: String((pois || []).length), pois: pois || [] };
}

function provider(http, opts) {
  return createAmapPhotoProvider(Object.assign({ key: 'FAKE-AMAP-KEY-0001', http }, opts || {}));
}

test('请求必须带 show_fields=photos —— 漏了不会报错，只会安静地不返回照片', async () => {
  const http = fakeHttp(amapOk([{ id: 'B1', name: '防洪纪念塔', location: '126.6185,45.781', photos: [] }]));
  const p = provider(http);
  await p.photosByName({ name: '防洪纪念塔', targetLocation: HERE });

  const url = http.urls[0];
  assert.match(url, /show_fields=photos/, '高德文档原文：show_fields 未设置时只返回基础信息类内字段');
  assert.match(url, /keywords=/, '按名字检索');
  assert.match(url, /region=/, '必须限定城市，否则会搜到同名异地地点');
  assert.ok(!/key=FAKE-AMAP-KEY-0001/.test(url) === false, '请求里当然要带 key（但不得出现在返回结构里）');
});

test('Key 绝不出现在返回结构里（脱敏）', async () => {
  const http = fakeHttp(amapOk([]));
  const p = provider(http);
  const res = await p.photosByName({ name: '某地', targetLocation: HERE });

  const dump = JSON.stringify(res);
  assert.ok(!dump.includes('FAKE-AMAP-KEY-0001'), 'Key 不得泄漏进响应、日志或截图');
  assert.match(res.requestUrl, /key=\*\*\*REDACTED\*\*\*/, '请求 URL 里的 Key 要打码');
});

test('正常取到照片：解析 photos[].url 与 title', async () => {
  const http = fakeHttp(
    amapOk([
      {
        id: 'B0FFF',
        name: '防洪纪念塔',
        address: '中央大街尽头',
        location: '126.6185,45.781',
        photos: [
          { title: '广场入口', url: 'https://store.is.autonavi.com/a.jpg' },
          { title: '纪念塔全景', url: 'https://store.is.autonavi.com/b.jpg' },
        ],
      },
    ])
  );
  const res = await provider(http).photosByName({ name: '防洪纪念塔', targetLocation: HERE });

  assert.equal(res.ok, true);
  assert.equal(res.photos.length, 2);
  assert.equal(res.photos[0].url, 'https://store.is.autonavi.com/a.jpg');
  assert.equal(res.photos[0].title, '广场入口');
  assert.equal(res.matchedPoi.id, 'B0FFF');
  assert.equal(res.matchBasis, 'exact-name');
  assert.equal(res.emptyReason, null);
  // 距离守卫的结论要挂在**每一张**照片上，客户端逐张取用才不会漏掉标注
  for (const ph of res.photos) {
    assert.equal(ph.trusted, true);
    assert.equal(ph.trustBasis, 'distance-verified');
  }
});

test('上游 POI 没有照片 → POI_HAS_NO_PHOTO（不是故障，是上游确实没图）', async () => {
  const http = fakeHttp(amapOk([{ id: 'B1', name: '防洪纪念塔', location: '126.6185,45.781' }]));
  const res = await provider(http).photosByName({ name: '防洪纪念塔', targetLocation: HERE });

  assert.equal(res.ok, true, '上游调用本身是成功的');
  assert.equal(res.photos.length, 0);
  assert.equal(res.emptyReason, 'POI_HAS_NO_PHOTO');
});

test('上游没有匹配到 POI → NO_POI_MATCHED，与"没照片"分开', async () => {
  const http = fakeHttp(amapOk([]));
  const res = await provider(http).photosByName({ name: '不存在的地方', targetLocation: HERE });

  assert.equal(res.photos.length, 0);
  assert.equal(res.emptyReason, 'NO_POI_MATCHED');
});

test('名字对得上但地点在 5 公里外 → 距离守卫判不可信（照片比名字更危险）', async () => {
  const http = fakeHttp(
    amapOk([
      {
        id: 'B_FAR',
        name: '防洪纪念塔',
        location: '126.6185,45.826', // 纬度 +0.045 ≈ 5 公里
        photos: [{ title: '另一个区的同名地点', url: 'https://x/far.jpg' }],
      },
    ])
  );
  const res = await provider(http).photosByName({ name: '防洪纪念塔', targetLocation: HERE });

  assert.equal(res.photos.length, 1, '照片本身照样返回 —— 丢不丢是调用方的决定');
  assert.equal(res.photos[0].trusted, false);
  assert.equal(res.photos[0].trustBasis, 'too-far');
  assert.ok(res.photos[0].distanceMeters > 300);
  assert.equal(res.trust.trusted, false);
});

test('名字完全对不上 → 判不可信，但仍如实带回上游返回了什么', async () => {
  const http = fakeHttp(
    amapOk([
      {
        id: 'B_HOTEL',
        name: '某某快捷宾馆',
        location: '126.6185,45.781',
        photos: [{ title: '客房', url: 'https://x/hotel.jpg' }],
      },
    ])
  );
  const res = await provider(http).photosByName({ name: '防洪纪念塔', targetLocation: HERE });

  assert.equal(res.photos[0].trusted, false);
  assert.equal(res.photos[0].trustBasis, 'name-mismatch');
  assert.equal(res.matchedPoi.name, '某某快捷宾馆', '如实带回命中项，便于排查与答辩');
  assert.equal(res.matchBasis, 'first-result');
});

test('上游没给坐标 → distance-unknown，**无法确认不等于可信**', async () => {
  const http = fakeHttp(
    amapOk([{ id: 'B1', name: '防洪纪念塔', photos: [{ title: '图', url: 'https://x/a.jpg' }] }])
  );
  const res = await provider(http).photosByName({ name: '防洪纪念塔', targetLocation: HERE });

  assert.equal(res.photos[0].trusted, false);
  assert.equal(res.photos[0].trustBasis, 'distance-unknown');
});

test('未配置 Key 时给出可执行的修复指引，而不是发起请求', async () => {
  const http = fakeHttp(amapOk([]));
  const p = createAmapPhotoProvider({ key: '', http });
  const res = await p.photosByName({ name: '防洪纪念塔', targetLocation: HERE });

  assert.equal(res.reason, 'AMAP_KEY_NOT_CONFIGURED');
  assert.equal(res.emptyReason, 'PROVIDER_NOT_CONFIGURED');
  assert.match(res.hint, /环境变量/);
  assert.equal(http.urls.length, 0, '没 Key 就不该发请求');
});

test('Key 前后空白会被去掉，并如实报告去过空白', async () => {
  const http = fakeHttp(amapOk([{ id: 'B1', name: '某地', location: '126.6185,45.781', photos: [] }]));
  // 从控制台表格复制时最常见的粘贴错误
  const p = createAmapPhotoProvider({ key: '\t AMAP-KEY-WITH-WRAPPER \n', http });
  await p.photosByName({ name: '某地', targetLocation: HERE });

  assert.equal(p.keyStatus().trimmed, true, '要能说出"去过空白"，否则 10001 会把人引向重新申请 Key');
  assert.match(http.urls[0], /key=AMAP-KEY-WITH-WRAPPER$/, '实际发出去的必须是去掉空白后的值');
});

test('Key 校验失败时，提示里带上"去过空白"这条信息', async () => {
  const http = fakeHttp({ status: '10001', info: 'INVALID_USER_KEY' });
  const p = createAmapPhotoProvider({ key: ' AMAP-KEY-X ', http });
  const res = await p.photosByName({ name: '某地', targetLocation: HERE });

  assert.equal(res.ok, false);
  assert.match(res.hint, /多余空白/, '这一条能省掉一次无谓的重新申请 Key');
});

test('上游抛错（超时等）不抛给调用方，转为结构化的失败', async () => {
  const err = new Error('上游请求超时（8000ms）');
  err.code = 'UPSTREAM_MAP_FAILED';
  const res = await provider(fakeHttp(null, { throw: err })).photosByName({
    name: '某地',
    targetLocation: HERE,
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'UPSTREAM_FAILED');
  assert.equal(res.emptyReason, 'UPSTREAM_FAILED');
  assert.match(res.message, /超时/);
  assert.deepEqual(res.photos, []);
});

test('上游 status 非 1 时带出 status 与成因提示', async () => {
  const http = fakeHttp({ status: '10003', info: 'DAILY_QUERY_OVER_LIMIT' });
  const res = await provider(http).photosByName({ name: '某地', targetLocation: HERE });

  assert.equal(res.ok, false);
  assert.equal(res.status, '10003');
  assert.equal(res.reason, 'UPSTREAM_STATUS_10003');
  assert.ok(res.hint, '要给出这个 status 的常见成因');
});

test('没有地点名时不发请求 —— 名字是这个接口的唯一检索依据', async () => {
  const http = fakeHttp(amapOk([]));
  const res = await provider(http).photosByName({ name: '', targetLocation: HERE });

  assert.equal(res.reason, 'NAME_REQUIRED');
  assert.equal(http.urls.length, 0);
});

test('选最像的候选：完全同名优先，其次宽松匹配，最后取第一条', () => {
  const pois = [
    { id: '1', name: '防洪纪念塔广场店' },
    { id: '2', name: '防洪纪念塔' },
    { id: '3', name: '别的什么' },
  ];
  assert.equal(pickBestByName(pois, '防洪纪念塔').poi.id, '2', '完全同名优先');
  assert.equal(pickBestByName(pois, '防洪纪念塔').basis, 'exact-name');

  const loose = pickBestByName([{ id: '1', name: '哈尔滨防洪纪念塔' }], '防洪纪念塔');
  assert.equal(loose.poi.id, '1');
  assert.equal(loose.basis, 'loose-name');

  const none = pickBestByName([{ id: '9', name: '完全无关' }], '防洪纪念塔');
  assert.equal(none.basis, 'first-result', '不匹配也要带回上游返回了什么，否则信息被丢掉');
});

test('normalizeKey 的行为（含空值与全空白）', () => {
  assert.deepEqual(normalizeKey(' ABC '), { key: 'ABC', trimmed: true, hadValue: true });
  assert.deepEqual(normalizeKey('ABC'), { key: 'ABC', trimmed: false, hadValue: true });
  assert.deepEqual(normalizeKey('   '), { key: '', trimmed: true, hadValue: true });
  assert.deepEqual(normalizeKey(null), { key: '', trimmed: false, hadValue: false });
});

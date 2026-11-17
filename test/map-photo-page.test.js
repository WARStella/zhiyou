'use strict';

/**
 * 地图页的照片图钉。
 *
 * 这一层的错误方式很特别：**它不会崩，它只是"什么都不显示"**。
 * 图钉退回空图标、照片拿不到临时地址、云存储没保存成功 ——
 * 这些在真机上都表现为"页面上没有那张图"，而没有任何报错。
 * 所以这组测试的重点全在**降级路径要说得出原因**，而不是正常路径能不能显示。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./page-harness');

/**
 * `place.list` 的返回形状 —— 注意坐标是**嵌套的 `location`**，
 * 不是平铺的 latitude/longitude。写错这个，页面会在 `.then` 里抛异常，
 * 然后被 `.catch` 吞成一句"加载失败"，看起来像接口问题。
 */
const PLACES = [
  {
    placeId: 'p_fanghong',
    name: '防洪纪念塔',
    category: 'meeting',
    location: { latitude: 45.781, longitude: 126.6185 },
    tripNodeAllowed: true,
    meetingPointAllowed: true,
    verified: true,
  },
  {
    placeId: 'p_sofia',
    name: '圣索菲亚教堂',
    category: 'spot',
    location: { latitude: 45.7703, longitude: 126.6206 },
    tripNodeAllowed: true,
    meetingPointAllowed: true,
    verified: true,
  },
];

/** 后端 `place.fetchPhotos` 的成功返回形状 */
function photoResponse(overrides) {
  return {
    ok: true,
    data: Object.assign(
      {
        placeId: 'p_fanghong',
        provider: 'amap',
        photos: [
          {
            url: 'https://store.is.autonavi.com/a.jpg',
            title: '广场入口',
            source: 'upstream',
            verified: false,
            provider: 'amap',
            fileID: 'cloud://env/poi-photos/p_fanghong/0-abc.img',
          },
        ],
        persistedCount: 1,
        emptyReason: null,
        verification: { passed: true, reason: null, checks: [] },
        notice: '照片只提供辨识度辅助，不构成对可达性等物理属性的核验。',
      },
      overrides || {}
    ),
  };
}

/**
 * 让地点列表加载完成。
 *
 * `loadPlaces()` 是一条 Promise 链（callApi → then → setData → refreshMarkers）。
 * 只等一个 `setImmediate` 不够 —— `data.places` 还是空的，后续断言会以
 * "属性是 null"这种与真因无关的方式失败。
 */
async function settle(times) {
  for (let i = 0; i < (times || 4); i++) {
    await new Promise((r) => setImmediate(r));
  }
}

async function loaded(p) {
  p.loadPlaces();
  await settle(3);
  return p;
}

function makePage(opts) {
  opts = opts || {};
  /**
   * `wx` 交给测试台去合并（它会保留内置的 `createMapContext` / `nextTick` 等替身，
   * 只覆盖我指定那几项）。整体替换会让 `refreshMarkers()` 里的
   * `wx.createMapContext` 抛错 —— 而那会表现为"图钉没画出来"，与真因无关。
   */
  return loadPage('miniprogram/pages/map/index.js', {
    api: Object.assign({ 'place.list': { ok: true, data: { places: PLACES } } }, opts.api),
    wx: opts.wx,
  });
}

test('选中集合点后才能取照片 —— 一次只针对一个地点', async (t) => {
  const p = makePage();
  t.after(() => p.restore());
  await loaded(p);

  assert.equal(p.data.meetingPoint, null, '未选中时没有取照目标');

  p.selectMeeting({ currentTarget: { dataset: { placeid: 'p_fanghong' } } });
  assert.equal(p.data.meetingPoint.placeId, 'p_fanghong');
  assert.equal(p.data.photoNote, '', '切换集合点时清空上一次的提示，避免串台');
});

test('取到照片后：**集合点图钉**换成照片、并显式给出尺寸', async (t) => {
  const p = makePage({
    api: { 'place.fetchPhotos': photoResponse() },
    wx: {
      cloud: {
        getTempFileURL: (o) =>
          o.success({ fileList: [{ fileID: o.fileList[0], tempFileURL: 'https://temp.example/pic.jpg' }] }),
      },
    },
  });
  t.after(() => p.restore());
  await loaded(p);

  p.selectMeeting({ currentTarget: { dataset: { placeid: 'p_fanghong' } } });
  p.fetchPhotos();
  await settle();

  const actions = p.__calls.map((c) => c.action);
  assert.ok(actions.includes('place.fetchPhotos'), '必须真的调了取照片接口');

  const meetingMarker = p.data.markers.find((m) => m.latitude === 45.781);
  assert.ok(meetingMarker, '集合点必须画出来');
  assert.equal(meetingMarker.iconPath, 'https://temp.example/pic.jpg', '有照片就用照片当图钉');
  /**
   * 网络图的尺寸必须显式给：不写时真机上的测量时机不确定，
   * 会出现忽大忽小或干脆不显示 —— 而且不报错。
   */
  assert.ok(meetingMarker.width > 0 && meetingMarker.height > 0, '照片图钉必须显式指定 width/height');

  /**
   * ⚠️ 这条断言**改过**（2026-10-14 用户要求："地图上还没确定路线
   * 又出现了一堆图钉，干脆把图钉删了吧"）：
   *
   * 库里那些**地点**不再画成本页的图钉 —— 它们既不是他要去的、
   * 也不是约好的，只是挡住路网的噪音。
   *
   * 行程页仍然照画目的地图钉（那是"这条路线要去的点"，语义完全不同）。
   */
  const placeMarker = p.data.markers.find((m) => m.latitude === 45.7703);
  assert.equal(placeMarker, undefined, '库里地点不再画图钉');
});

test('照片的"未实地核验"标注必须出现在提示里', async (t) => {
  const p = makePage();
  t.after(() => p.restore());
  await loaded(p);

  p.selectMeeting({ currentTarget: { dataset: { placeid: 'p_fanghong' } } });
  const text = p.describePhotos([{ fileID: 'cloud://x/1.img' }], {}, null);

  assert.match(text, /未实地核验/, '联网抓来的照片必须说出这一点');
  assert.match(text, /不代表可达性/, '要说清它不能证明什么');
});

test('四类"没有照片"的原因各自有人话，不混成一句"暂无照片"', async (t) => {
  const p = makePage();
  t.after(() => p.restore());
  await loaded(p);

  const cases = [
    ['PROVIDER_NOT_CONFIGURED', /尚未配置照片服务/],
    ['UPSTREAM_FAILED', /暂时不可用/],
    ['NO_POI_MATCHED', /没有匹配到这个地点/],
    ['POI_HAS_NO_PHOTO', /这个地点没有照片/],
  ];
  for (const [reason, re] of cases) {
    const text = p.describePhotos([], { emptyReason: reason }, null);
    assert.match(text, re, `${reason} 应当有专门的说明`);
  }
});

test('照片取到了但没保存进云存储时，如实说"无法显示"而不是报成功', async (t) => {
  const p = makePage();
  t.after(() => p.restore());
  await loaded(p);

  const text = p.describePhotos([{ url: 'https://x/1.jpg', fileID: null }], {}, null);
  assert.match(text, /保存到云存储失败/, '没落存储的图客户端拿不到，不能假装有');
});

test('临时地址获取失败时退回普通图钉，并说明原因', async (t) => {
  const p = makePage({ wx: { cloud: { getTempFileURL: (o) => o.fail({ errMsg: 'boom' }) } } });
  t.after(() => p.restore());
  await loaded(p);

  p.selectMeeting({ currentTarget: { dataset: { placeid: 'p_fanghong' } } });
  p.resolveTempUrls('p_fanghong', ['cloud://env/x.img']);

  assert.equal(p.data.photoBusy, false, '失败也要解除忙碌状态，否则按钮永远禁用');
  assert.match(p.data.photoNote, /退回普通图标/);
  assert.equal((p.data.photoUrls || {}).p_fanghong, undefined, '不该留下半截地址');

  // 图钉必须仍然是内置图标，而不是空路径
  const meetingMarker = p.data.markers.find((m) => m.latitude === 45.781);
  assert.equal(meetingMarker.iconPath, '/assets/pin-meeting.png', '降级后要看得见图钉');
});

test('取照片失败时给出后端返回的原因，且解除忙碌状态', async (t) => {
  const p = makePage({
    api: { 'place.fetchPhotos': { ok: false, error: { code: 'FORBIDDEN_ENV', message: '仅限 dev' } } },
  });
  t.after(() => p.restore());
  await loaded(p);

  p.selectMeeting({ currentTarget: { dataset: { placeid: 'p_fanghong' } } });
  p.fetchPhotos();
  await settle();

  assert.equal(p.data.photoBusy, false);
  assert.equal(p.data.photoNote, '仅限 dev', '要把后端的原因原样透出，而不是"操作失败"');
});

test('未选集合点时取照片是空操作，不调用后端', async (t) => {
  const p = makePage();
  t.after(() => p.restore());
  await loaded(p);

  p.__calls.length = 0;
  p.fetchPhotos();
  assert.equal(p.__calls.length, 0, '没有目标地点时不该发请求');
});

/**
 * ⚠️ 这里原来有四条测试：点图钉选中地点、图钉 id 映射准确、
 * 异常输入不抛错、点图钉与点列表同路径（约 90 行）。
 *
 * 2026-10-14 用户要求"地图上还没确定路线又出现了一堆图钉，干脆把图钉删了吧"，
 * 于是本页**不再画地点图钉** —— 那四条测试的全部前提消失了：
 * `markerPlaceIndex` 恒为空，`onMarkerTap` 永远静默返回。
 *
 * 与其让它们继续"通过"（假绿），不如删掉并把这件事记在这里。
 * **行程页的目的地图钉不受影响**，那边仍然画、也仍然可以点。
 */
test('本页不再画地点图钉，也不再绑 bindmarkertap（交互已随图钉一起移除）', async (t) => {
  const p = makePage();
  t.after(() => p.restore());
  await loaded(p);

  /** 库里有很多地点，但一个都不该变成图钉 */
  assert.ok(p.data.places.length > 0, '前提：库里是有地点的');
  assert.equal(p.data.markers.length, 0, '没有"我"、没有集合点、没有队员时，地图上应当没有图钉');

  const fs = require('node:fs');
  const path = require('node:path');
  const xml = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'map', 'index.wxml'), 'utf8');
  assert.equal(/bindmarkertap=/.test(xml), false, 'WXML 上不该再绑 bindmarkertap');

  /** 选中地点仍然要走列表那条路（`selectMeeting`）—— 它没有受影响 */
  p.selectMeeting({ currentTarget: { dataset: { placeid: 'p_fanghong' } } });
  assert.equal(p.data.meetingPoint.placeId, 'p_fanghong', '点「集合点候选」列表仍然能选中');
  assert.ok(p.data.markers.length > 0, '选中后集合点图钉要画出来');
});
test('照片拿不到时不会留下空白图钉（回归：静默降级）', async (t) => {
  const p = makePage({
    api: {
      'place.fetchPhotos': photoResponse({
        // 有 url 但没落成云存储 —— 客户端拿不到任何可显示的东西
        photos: [{ url: 'https://x/1.jpg', source: 'upstream', verified: false, provider: 'amap', fileID: null }],
        persistedCount: 0,
      }),
    },
  });
  t.after(() => p.restore());
  await loaded(p);

  p.selectMeeting({ currentTarget: { dataset: { placeid: 'p_fanghong' } } });
  p.fetchPhotos();
  await settle();

  const meetingMarker = p.data.markers.find((m) => m.latitude === 45.781);
  assert.equal(meetingMarker.iconPath, '/assets/pin-meeting.png', '无可显示照片时必须退回内置图标');
  assert.match(p.data.photoNote, /保存到云存储失败/);
});

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

test('取到照片后：图钉换成照片、并显式给出尺寸', async (t) => {
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
  assert.equal(meetingMarker.iconPath, 'https://temp.example/pic.jpg', '有照片就用照片当图钉');
  /**
   * 网络图的尺寸必须显式给：不写时真机上的测量时机不确定，
   * 会出现忽大忽小或干脆不显示 —— 而且不报错。
   */
  assert.ok(meetingMarker.width > 0 && meetingMarker.height > 0, '照片图钉必须显式指定 width/height');

  // 非集合点的图钉不受影响
  const otherMarker = p.data.markers.find((m) => m.latitude === 45.7703);
  assert.equal(otherMarker.iconPath, '/assets/pin-place.png');
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

test('点图钉能选中地点（回归：首版没绑 bindmarkertap，图钉是"死的"）', async (t) => {
  const p = makePage();
  t.after(() => p.restore());
  await loaded(p);

  // 先确认 WXML 上真的绑了 —— 只测 JS 会漏掉"事件根本没接上"这个真因
  const fs = require('node:fs');
  const path = require('node:path');
  const xml = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'map', 'index.wxml'), 'utf8');
  assert.match(xml, /bindmarkertap="onMarkerTap"/, 'map 组件必须绑定 bindmarkertap');
  assert.equal(typeof p.onMarkerTap, 'function', '绑了就必须有对应方法，否则点了还是没反应');

  assert.equal(p.data.meetingPoint, null);
  p.onMarkerTap({ detail: { markerId: 0 } });
  assert.equal(p.data.meetingPoint.placeId, 'p_fanghong', '点第一个图钉应当选中它');
});

test('点 A 不会选中 B：图钉 id 与地点的映射必须准确', async (t) => {
  const p = makePage();
  t.after(() => p.restore());
  await loaded(p);

  /**
   * 这里刻意模拟"图钉里混了非地点标记"的真实情况：
   * `refreshMarkers()` 除了地点，还会 push 我(999)、队员(2000+)、团队集合点(3000)。
   * 用 `places` 下标当 id 的话，一旦顺序或数量变动就会静默错位。
   */
  p.teamLocations = [{ point: { latitude: 45.7, longitude: 126.6 }, source: 'manual' }]
  p.teamMeeting = { point: { latitude: 45.79, longitude: 126.61 }, name: '团队集合点' }
  p.refreshMarkers()

  // 每个地点图钉都点到正确的地点
  for (const place of p.data.places) {
    const markerId = Object.keys(p.data.markerPlaceIndex).find((k) => p.data.markerPlaceIndex[k] === place.placeId)
    assert.ok(markerId !== undefined, `${place.placeId} 必须有对应的图钉 id`)
    p.onMarkerTap({ detail: { markerId: Number(markerId) } })
    assert.equal(p.data.meetingPoint.placeId, place.placeId, `点 markerId=${markerId} 应当选中 ${place.placeId}`)
  }

  // 非地点图钉（我／队员／团队集合点）不该选中任何地点
  const before = p.data.meetingPoint.placeId
  for (const id of [999, 2000, 3000]) {
    p.onMarkerTap({ detail: { markerId: id } })
    assert.equal(p.data.meetingPoint.placeId, before, `markerId=${id} 不是地点图钉，不该改变选中项`)
  }
});

test('点图钉的异常输入不抛错 —— 图钉与 places 短暂不一致时页面不该崩', async (t) => {
  const p = makePage();
  t.after(() => p.restore());
  await loaded(p);

  // 这些都不该抛
  p.onMarkerTap({});
  p.onMarkerTap({ detail: {} });
  p.onMarkerTap({ detail: { markerId: null } });
  p.onMarkerTap({ detail: { markerId: 'not-a-number' } });
  p.onMarkerTap({ detail: { markerId: 12345 } }); // 越界
  assert.equal(p.data.meetingPoint, null, '无效点击不该选中任何东西');
});

test('点图钉与点列表走同一条路径（清空上一次的提示）', async (t) => {
  const p = makePage();
  t.after(() => p.restore());
  await loaded(p);

  p.setData({ photoNote: '上一次的提示' });
  p.onMarkerTap({ detail: { markerId: 0 } });
  assert.equal(p.data.photoNote, '', '换集合点时要清掉上一次的取照提示，否则会串台');

  p.setData({ photoNote: '又一次提示' });
  p.selectMeeting({ currentTarget: { dataset: { placeid: 'p_sofia' } } });
  assert.equal(p.data.photoNote, '', '两条路径行为必须一致');
  assert.equal(p.data.meetingPoint.placeId, 'p_sofia');
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

const test = require('node:test')
const assert = require('node:assert/strict')
const { makeWorld, expectOk, expectFail } = require('./helpers')
const { loadPage } = require('./page-harness')
const { createTencentProvider } = require('../cloudfunctions/api/lib/map/tencent')
const point = { latitude: 30.27, longitude: 120.15 }
const area = { ok: true, city: '杭州市', district: '西湖区', adcode: '330106' }
const poi = (id, title, category = '旅游景点:景点') => ({ poiId: id, title, category, location: point, adInfo: { city: '杭州市', adcode: '330106' } })

test('首屏只返回当前区县景点，过滤培训与停车场，去重保留上游排名', async () => {
  const calls = []
  const w = await makeWorld({ createMapProvider: () => ({ reverseGeocode: async () => area, searchPlaces: async input => {
    calls.push(input); return { ok: true, items: [poi('b','景点乙'), poi('a','景点甲'), poi('a','景点甲'), poi('c','音乐教室','教育培训'), poi('d','景点停车场'), { ...poi('e','外地景点'), adInfo: { city: '北京市' } }] }
  } }) })
  const r = expectOk(await w.A('place.popular', { center: point, scope: 'district' }))
  assert.deepEqual(r.items.map(p => p.name), ['景点乙','景点甲']); assert.deepEqual(r.items.map(p => p.rank), [1,2])
  assert.equal(calls[0].region, '330106'); assert.equal(calls[0].strictDistrict, true)
  assert.ok(r.items.every(p => p.verified === false && p.placeId === null && p.itemId))
})

test('区县无结果才扩大到全市，缺坐标不发地图请求', async () => {
  const inputs = []
  const w = await makeWorld({ createMapProvider: () => ({ reverseGeocode: async () => area, searchPlaces: async p => { inputs.push(p); return { ok: true, items: inputs.length === 1 ? [] : [poi('a','景点')] } } }) })
  expectFail(await w.A('place.popular', {}), 'INVALID_PARAM'); assert.equal(inputs.length, 0)
  const r = expectOk(await w.A('place.popular', { center: point }))
  assert.equal(r.scope, 'city'); assert.equal(inputs[1].region, '杭州市'); assert.match(r.rankingNote, /扩大到全市/)
})

test('定位拒绝不调用旧地点库，旧景点响应不覆盖用户搜索', async () => {
  const denied = loadPage('miniprogram/pages/trip/index.js')
  try { await denied.loadKnown(); assert.match(denied.data.popularError, /未取得/); assert.equal(denied.__calls.length, 0) } finally { denied.restore() }
  let resolve
  const p = loadPage('miniprogram/pages/trip/index.js', { wx: { getLocation: o => o.success(point) }, api: { 'place.popular': () => new Promise(r => { resolve = r }) } })
  try {
    const pending = p.loadKnown(); await new Promise(r => setImmediate(r)); p.setCandidates([{ itemId: 'search', name: '用户搜索' }], 'search', '')
    resolve({ ok: true, data: { items: [{ itemId: 'stale', name: '旧推荐' }] } }); await pending
    assert.equal(p.data.candidates[0].itemId, 'search'); assert.equal(p.data.popularLoading, false)
  } finally { p.restore() }
})

test('腾讯逆解析及区县检索参数遵守城市范围和景点分类', async () => {
  const urls = []
  const provider = createTencentProvider({ key: 'test', http: async url => { urls.push(new URL(url)); return { json: url.includes('geocoder') ? { status: 0, result: { address_component: { city: '杭州市', district: '西湖区' }, ad_info: { adcode: '330106' } } } : { status: 0, data: [] } } } })
  assert.equal((await provider.reverseGeocode(point)).city, '杭州市')
  await provider.searchPlaces({ keyword: '景点', region: '330106', strictDistrict: true, category: '旅游景点' })
  assert.equal(urls[0].searchParams.get('location'), '30.27,120.15')
  assert.equal(urls[1].searchParams.get('boundary'), 'region(330106,2)')
  assert.equal(urls[1].searchParams.get('filter'), 'category=旅游景点')
})

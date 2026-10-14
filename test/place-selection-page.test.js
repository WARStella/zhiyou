const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./page-harness');
const tap = id => ({ currentTarget: { dataset: { id } } });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('已知地点加载后可分别勾选、取消和移除，并保留完整规划字段', async () => {
  const places = [1, 2].map(i => ({ placeId: 'p' + i, name: '地点' + i, location: { latitude: 45 + i / 10, longitude: 126 }, visitDurationMin: { default: 30 }, tripNodeAllowed: true }));
  const p = loadPage('miniprogram/pages/trip/index.js', { api: { 'place.list': { ok: true, data: { places } } } });
  p.loadKnown(); await flush();
  assert.deepEqual(p.data.candidates.map(c => c.itemId), ['p1','p2']);
  p.toggleCandidate(tap('p1'));
  assert.deepEqual(p.data.candidates.map(c => c.selected), [true,false]);
  assert.deepEqual(p.data.selected[0].location, places[0].location);
  assert.deepEqual(p.data.selected[0].visitDurationMin, places[0].visitDurationMin);
  p.toggleCandidate(tap('p2')); p.toggleCandidate(tap('p1'));
  assert.deepEqual(p.data.selected.map(c => c.itemId), ['p2']);
  p.removeSelected(tap('p2'));
  assert.equal(p.data.selected.length, 0);
  assert.ok(p.data.candidates.every(c => !c.selected));
});

test('未入库搜索地点可手动选择，并将坐标和 POI 标识传给规划接口', async () => {
  const p = loadPage('miniprogram/pages/trip/index.js', { api: { 'trip.plan': (payload) => {
    assert.equal(payload.places[0].poiId, 'external-1');
    assert.deepEqual(payload.places[0].location, { latitude: 45.7, longitude: 126.6 });
    return { ok: true, data: { feasible: false, saved: false, conflicts: [] } };
  } } });
  p.setCandidates([{ itemId: 'poi_external-1', poiId: 'external-1', placeId: null, name: '检索地点', location: { latitude: 45.7, longitude: 126.6 }, tripNodeAllowed: true }], 'search');
  p.toggleCandidate(tap('poi_external-1'));
  assert.equal(p.data.selected[0].itemId, 'poi_external-1');
  p.createTrip(); await flush();
  assert.equal(p.__calls.filter(c => c.action === 'trip.plan').length, 1);
  p.removeSelected(tap('poi_external-1'));
  assert.equal(p.data.selected.length, 0);
});

test('候选和已选列表的点击标识与处理器统一使用 itemId', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const xml = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/trip/index.wxml'), 'utf8');
  assert.ok(!xml.includes('data-id="{{item.placeId}}"'));
  assert.equal((xml.match(/data-id="\{\{item.itemId\}\}"/g) || []).length, 2);
});

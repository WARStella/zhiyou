'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./page-harness');
const { layoutMarkerLabels } = require('../miniprogram/utils/map-marker-labels');

const point = { latitude: 45.7756, longitude: 126.6175 };
const peer = (userId, location = point, extra) => ({ userId, point: location, hasLocation: true,
  source: 'gps', ...extra });

function pageWithMembers(members) {
  const page = loadPage('miniprogram/pages/map/index.js');
  page.setData({ myPoint: point, mySource: 'gps', me: 'me', scale: 15 });
  page.teamLocations = members;
  page.refreshMarkers();
  return page;
}

test('自己与队友完全同坐标时保留两个重叠图标，常显标签错开且不修改真实坐标', () => {
  const page = pageWithMembers([peer('me'), peer('peer')]);
  const markers = page.data.markers;
  assert.equal(markers.length, 2);
  assert.deepEqual(markers.map(m => m.id), [999, 2000]);
  assert.notEqual(markers[0].callout.anchorY, markers[1].callout.anchorY);
  assert.ok(Math.abs(markers[0].callout.anchorY - markers[1].callout.anchorY) > 32);
  for (const marker of markers) {
    assert.equal(marker.latitude, point.latitude);
    assert.equal(marker.longitude, point.longitude);
    assert.equal(marker.collision, '');
    assert.equal(marker.callout.collision, '');
    assert.equal(marker.callout.display, 'ALWAYS');
    assert.equal(marker.joinCluster, false);
  }
  assert.deepEqual(page.data.myPoint, point);
  assert.deepEqual(page.teamLocations[1].point, point);
});

test('两人坐标不同但屏幕上非常接近时也错开标签，不偏移标记', () => {
  const near = { latitude: point.latitude + 0.00002, longitude: point.longitude + 0.00002 };
  const page = pageWithMembers([peer('peer', near)]);
  const other = page.data.markers.find(m => m.id === 2000);
  assert.equal(other.latitude, near.latitude);
  assert.equal(other.longitude, near.longitude);
  assert.notEqual(other.callout.anchorY, page.data.markers[0].callout.anchorY);
});

test('多人同位置及集合点重合时全部保留，重复刷新不累积偏移', () => {
  const page = pageWithMembers([peer('a'), peer('b'), peer('c', point, { stale: true })]);
  page.setData({ meetingPoint: { ...point, name: '集合点' } });
  page.refreshMarkers();
  const first = structuredClone(page.data.markers);
  assert.equal(first.length, 5);
  assert.equal(new Set(first.map(m => m.callout.anchorY)).size, 5);
  assert.ok(first.some(m => m.alpha === 0.25 && /上次位置（已过期）/.test(m.callout.content)));
  assert.ok(first.filter(m => m.alpha !== 0.25).every(m => !/定位|手动|已过期/.test(m.callout.content)));
  page.refreshMarkers();
  assert.deepEqual(page.data.markers, first);
  assert.deepEqual(page.data.polyline[0].points, [point, point], '连线仍使用原始坐标');
});

test('成员返回顺序改变时，标记身份和标签布局保持稳定', () => {
  const page = pageWithMembers([peer('b'), peer('a')]);
  const before = structuredClone(page.data.markers);
  page.teamLocations.reverse();
  page.refreshMarkers();
  assert.deepEqual(page.data.markers, before);
});

test('队员离开重叠位置后取消标签偏移', () => {
  const page = pageWithMembers([peer('peer')]);
  assert.ok(page.data.markers.find(m => m.id === 2000).callout.anchorY < 0);
  page.teamLocations = [peer('peer', { latitude: 45.8, longitude: 126.7 })];
  page.refreshMarkers();
  assert.equal(page.data.markers.find(m => m.id === 2000).callout.anchorY, 0);
});

test('只在缩放结束后重排标签，拖动过程、未变缩放不反复刷新', () => {
  const page = pageWithMembers([peer('peer', { latitude: point.latitude, longitude: point.longitude + 0.001 })]);
  page.onMapRegionChange({ type: 'end', detail: { scale: 20 } });
  assert.equal(page.data.markers.find(m => m.id === 2000).callout.anchorY, 0);
  let refreshes = 0;
  const original = page.refreshMarkers.bind(page);
  page.refreshMarkers = () => { refreshes++; original(); };
  page.onMapRegionChange({ type: 'begin', detail: { scale: 15 } });
  assert.equal(refreshes, 0);
  page.onMapRegionChange({ type: 'regionchange', detail: { type: 'end', scale: 15 } });
  assert.equal(refreshes, 1);
  assert.ok(page.data.markers.find(m => m.id === 2000).callout.anchorY < 0);
  page.onMapRegionChange({ type: 'end', detail: { scale: 15 } });
  page.onMapRegionChange({ type: 'end', detail: { scale: NaN } });
  page.onMapRegionChange();
  assert.equal(refreshes, 1);
});

test('布局仅产生显示副本，不污染缓存中的标签、图标尺寸和经纬度', () => {
  const markers = [999, 2000].map(id => ({ id, ...point, iconPath: '/assets/dot-me.png', width: 26,
    height: 26, callout: { content: '队员', display: 'ALWAYS' } }));
  const original = structuredClone(markers);
  const result = layoutMarkerLabels(markers, 15);
  assert.deepEqual(markers, original);
  assert.equal(result.length, 2);
  assert.equal(result[1].iconPath, markers[1].iconPath);
  assert.equal(result[1].width, markers[1].width);
  assert.deepEqual(layoutMarkerLabels(markers, 15), result);
});

test('独立消息框和用户名一起参与避让，多行消息不会覆盖相邻成员标签', () => {
  const markers = [999, 2000].map(id => ({ id, ...point, width: 40, height: 40,
    callout: { content: '队员', fontSize: 12, padding: 6, bgColor: '#FFFFFF', color: '#0F5132' } }));
  const baseline = layoutMarkerLabels(markers, 15);
  markers[0].chatBubble = { content: '第一行消息\n第二行消息\n第三行消息', fontSize: 12, padding: 8 };
  const result = layoutMarkerLabels(markers, 15);
  assert.ok(result[1].callout.anchorY < baseline[1].callout.anchorY - 50,
    '同坐标的下一位成员必须避开整个多行消息框');
  assert.deepEqual(result[0].callout, baseline[0].callout, '消息不改变原用户名标签');
  assert.equal(result[0].customCallout.anchorY, result[0].callout.anchorY);
  assert.equal(result[1].customCallout, undefined);
  assert.ok(result[0].chatBubble.groupWidth >= result[0].chatBubble.width);
  assert.deepEqual(result.map(m => [m.latitude, m.longitude]), [[point.latitude, point.longitude], [point.latitude, point.longitude]]);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, node } = require('./page-harness');

function ready(options) {
  const page = loadPage('miniprogram/pages/trip/index.js', options);
  page.applyTrip({ tripId: 't', version: 1, nodes: [node('a', '甲', 'done', 0), node('b', '乙', 'pending', 1)] });
  return page;
}

test('取消行程先确认；继续游览不修改当前路线和已记录进度', () => {
  let modal;
  const page = ready({ wx: { showModal: o => { modal = o; } } });
  try {
    const before = page.data.rawNodes;
    page.cancelTrip();
    assert.equal(page.data.trip.tripId, 't');
    assert.equal([...modal.confirmText].length, 4);
    modal.success({ confirm: false });
    assert.equal(page.data.rawNodes, before);
    assert.equal(page.data.trip.tripId, 't');
    assert.equal(page.data.rawNodes[0].status, 'done');
  } finally { page.restore(); }
});

test('确认取消退出当前导航并清理活动行程，保留选中地点方便重新确认', () => {
  const page = ready({ wx: { showModal: o => o.success({ confirm: true }) } });
  try {
    page.setData({ selected: [{ itemId: 'p_a', name: '甲' }] });
    page.navigationRequested = true;
    page.cancelTrip();
    assert.equal(page.data.trip, null);
    assert.equal(page.data.navLeg, null);
    assert.equal(page.navigationRequested, false);
    assert.equal(page.__storage['zhiyou-active-trip'], undefined);
    assert.equal(page.data.selected[0].name, '甲');
    assert.equal(page.data.tripDisplay, null);
    assert.match(page.data.note, /已取消/);
    assert.equal(page.__calls.length, 0, '取消当前界面不删除云端进度');
  } finally { page.restore(); }
});

test('确认期间行程已更新或正在操作时，旧取消不能清掉新行程', () => {
  let modal;
  const page = ready({ wx: { showModal: o => { modal = o; } } });
  try {
    page.cancelTrip();
    page.applyTrip({ tripId: 'new', version: 1, nodes: [node('c', '丙', 'pending', 0)] });
    modal.success({ confirm: true });
    assert.equal(page.data.trip.tripId, 'new');
    modal = null;
    page.setData({ busy: 'adjust' });
    page.cancelTrip();
    assert.equal(modal, null);
  } finally { page.restore(); }
});

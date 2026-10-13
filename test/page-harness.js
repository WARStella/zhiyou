'use strict';

/**
 * 小程序页面的最小测试台。
 *
 * ── 为什么需要它 ──────────────────────────────────────────
 *
 * 2026-10-13 一天里，用户找出的界面问题全是"跑通了但不对"这一类：
 * 出行段放错节点、判据反了、显示了单数字段、状态没刷新…
 * **这些都不是崩溃，是数据流错了 —— 而在此之前前端完全没有测试。**
 *
 * 后端有 200 项测试，前端一项都没有。这个不平衡必须补上。
 *
 * 做法：把 `Page({...})` 的选项截下来，给它一个能跑的 `setData`，
 * 于是可以直接调页面方法、断言 `data` 的变化。**不模拟渲染**，
 * 只验证"调了这个方法之后，data 对不对"。
 */

const path = require('path');

/** 把 `wx` 与 `getApp` 换成可控替身，并把 api 层换成假的 */
function loadPage(relPath, opts) {
  opts = opts || {};
  const abs = path.resolve(__dirname, '..', relPath);

  const calls = [];
  const apiStub = {
    newRequestId: () => 'req-test',
    callApi: (action, payload, options) => {
      calls.push({ action, payload, options });
      const h = (opts.api && opts.api[action]) || null;
      if (!h) return Promise.resolve({ ok: false, error: { code: 'NO_STUB', message: `未替身化：${action}` } });
      return Promise.resolve(typeof h === 'function' ? h(payload, options) : h);
    },
    callApiStrict: () => Promise.reject(new Error('未使用')),
    isVersionConflict: () => false,
  };

  // 覆盖 utils/api 的加载结果 —— 页面里 require 的就是它
  const apiPath = require.resolve('../miniprogram/utils/api');
  const prevCache = require.cache[apiPath];
  require.cache[apiPath] = {
    id: apiPath,
    filename: apiPath,
    loaded: true,
    exports: apiStub,
  };

  const wxCalls = [];
  const prevGlobals = {
    Page: global.Page,
    getApp: global.getApp,
    wx: global.wx,
  };

  let captured = null;
  global.Page = (o) => {
    captured = o;
  };
  global.getApp = () => opts.app || { globalData: { cloudReady: true } };
  global.wx = Object.assign(
    {
      createMapContext: () => ({ includePoints: (a) => wxCalls.push({ fn: 'includePoints', args: a }) }),
      getLocation: () => Promise.reject(new Error('no location')),
      showToast: (a) => wxCalls.push({ fn: 'showToast', args: a }),
      cloud: {},
      nextTick: (fn) => fn(),
    },
    opts.wx || {}
  );

  try {
    delete require.cache[abs];
    // eslint-disable-next-line global-require
    require(abs);
  } finally {
    global.Page = prevGlobals.Page;
    global.getApp = prevGlobals.getApp;
    global.wx = prevGlobals.wx;
    if (prevCache) require.cache[apiPath] = prevCache;
    else delete require.cache[apiPath];
  }

  if (!captured) throw new Error(`${relPath} 没有调用 Page()`);

  /** 造一个能跑的页面实例：拷 data、绑方法、给 setData */
  const page = Object.assign({}, captured);
  page.data = JSON.parse(JSON.stringify(captured.data || {}));
  for (const k of Object.keys(captured)) {
    if (typeof captured[k] === 'function') page[k] = captured[k].bind(page);
  }

  page.__calls = calls;
  page.__wx = wxCalls;
  page.__setDataLog = [];

  /**
   * setData 替身：合并进 data，**同步执行回调**。
   *
   * 真机上回调是在渲染之后跑的，但那是时序细节；
   * 我们要验证的是"回调里读到的是不是新值" —— 同步执行同样能测出这一点。
   */
  page.setData = function (patch, cb) {
    page.__setDataLog.push(patch);
    for (const k of Object.keys(patch || {})) page.data[k] = patch[k];
    if (typeof cb === 'function') cb();
  };

  return page;
}

/** 造一条行程节点（后端 trip.plan / trip.progress 的返回形状） */
function node(id, name, status, seq) {
  return {
    nodeId: id,
    placeId: 'p_' + id,
    placeName: name,
    seq: seq,
    location: { latitude: 45.77 + seq * 0.001, longitude: 126.61 + seq * 0.001 },
    verified: true,
    plannedArriveAt: '2026-10-20T01:00:00.000Z',
    plannedLeaveAt: '2026-10-20T01:45:00.000Z',
    plannedStayMin: 45,
    travelFromPrevMin: seq === 0 ? 0 : 8,
    travelFromPrevMeters: seq === 0 ? 0 : 620,
    travelSource: seq === 0 ? 'none' : 'survey',
    travelMode: seq === 0 ? 'none' : 'walking',
    status: status,
    actualArriveAt: null,
    actualLeaveAt: null,
  };
}

module.exports = { loadPage, node };

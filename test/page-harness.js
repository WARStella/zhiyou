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
  /**
   * ⚠️ 默认 `newRequestId` **必须每次返回新值**（2026-10-14 修正）。
   *
   * 首版缺省成常量 `'req-test'`。因为替身现在会留到下一次 `loadPage()` 为止
   * （见文件末尾那段注释），`diagnosis.test.js` 里那条直接 `require`
   * 真实 `utils/api` 测"每次生成都应该是新值"的用例就拿到了常量替身，
   * 于是失败信息是"每次生成都应该是新值" —— 而真因是**页面测试台泄漏到了它**。
   *
   * 替身的缺省行为要尽量贴近真实实现，否则它会以别处的失败形式暴露出来。
   */
  let reqSeq = 0;
  const apiStub = {
    newRequestId: opts.newRequestId || (() => `req-harness-${++reqSeq}`),
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
  /**
   * storage 的内容。**每次 loadPage 一份新的**，但由 `opts.storage` 预置 ——
   * 模拟"上一个页面已经写过"。
   */
  const storage = Object.assign({}, opts.storage || {});
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
  const harnessWx = {
      /**
       * ⚠️ **必须是回调风格**（2026-10-13 修正）。
       *
       * 小程序的 `wx.getLocation` 是 `{success, fail}` 回调，不是 Promise。
       * 首版替身写成 `() => Promise.reject(...)` —— **形状不对，于是页面代码
       * 走进了完全不同的分支**：`new Promise(resolve => { wx.getLocation({...}) })`
       * 永远不 resolve，页面就一直停在"正在取路线…"，而测试看到的是别的原因。
       *
       * **替身不同形，测出来的就不是真机上的行为。**
       */
      getLocation: (o) => {
        if (o && typeof o.fail === 'function') o.fail({ errMsg: 'harness: no location' });
      },
      createMapContext: () => ({ includePoints: (a) => wxCalls.push({ fn: 'includePoints', args: a }) }),
      showToast: (a) => wxCalls.push({ fn: 'showToast', args: a }),
      openLocation: (a) => wxCalls.push({ fn: 'openLocation', args: a }),
      pageScrollTo: (a) => wxCalls.push({ fn: 'pageScrollTo', args: a }),
      /**
       * storage 替身 —— **共享一份**（2026-10-14 新增）。
       *
       * 存在的理由：跨页传递靠 storage（`zhiyou-active-trip` / `zhiyou-active-crew`），
       * 而"行程页写了、地图页读不读得到"恰恰是最容易出错的一环
       * ——用户报的"生成路线后地图上看不到路线"就是这个 bug。
       *
       * 用 `opts.storage` 预置内容即可模拟"上一个页面写过"。
       */
      getStorageSync: (k) => (k in storage ? storage[k] : ''),
      setStorageSync: (k, v) => {
        storage[k] = v;
        wxCalls.push({ fn: 'setStorageSync', args: { key: k, value: v } });
      },
      removeStorageSync: (k) => {
        delete storage[k];
      },
      /**
       * `wx.cloud` 的替身。
       *
       * ⚠️ 同样是**回调风格**，理由与上面 `getLocation` 那段完全一样：
       * 页面对它用的是 `wx.cloud.getTempFileURL({ fileList, success, fail })`，
       * 替身写成 Promise 会让页面走进另一条分支，测出来就不是真机行为。
       */
      cloud: {
        getTempFileURL: (o) => {
          const opt = o || {};
          if (opts.tempFileUrlFailure) {
            if (typeof opt.fail === 'function') opt.fail({ errMsg: 'harness: getTempFileURL failed' });
            return;
          }
          const fileList = (opt.fileList || []).map((f) => {
            const fileID = typeof f === 'string' ? f : f.fileID;
            return { fileID, tempFileURL: `https://temp.example/${encodeURIComponent(fileID)}` };
          });
          if (typeof opt.success === 'function') opt.success({ fileList });
        },
      },
      nextTick: (fn) => fn(),
  };

  /**
   * ⚠️ `opts.wx` 必须与内置替身**浅合并**，不能整体替换（2026-10-14 修正）。
   *
   * 原来写成 `Object.assign({...内置}, opts.wx)` —— 顶层 Key 是合并的，
   * 但 **`cloud` 这个嵌套对象会被整体换掉**。测试只想覆盖
   * `cloud.getTempFileURL` 时，`opts.wx.cloud` 里的那一项就把内置 cloud 顶掉了，
   * 于是任何依赖内置 cloud 行为的页面都会走偏。
   *
   * 嵌套一层就够（`cloud` 是目前唯一的嵌套替身），这里显式处理并写明原因，
   * 比写一个通用深合并更不容易出错。
   */
  const override = opts.wx || {};
  const mergedWx = Object.assign({}, harnessWx, override, {
    cloud: Object.assign({}, harnessWx.cloud, override.cloud || {}),
  });
  global.wx = mergedWx;

  try {
    delete require.cache[abs];
    // eslint-disable-next-line global-require
    require(abs);
  } finally {
    /**
     * ⚠️ 只还原 `Page`，**`wx`、`getApp` 与 api 替身都保持安装**（2026-10-14 修正）。
     *
     * 首版把 `wx` 也还原了 —— 于是 `require` 之后、测试调用页面方法时，
     * `global.wx` 已经是 `undefined`，页面里 `wx.getLocation` 直接抛
     * 「Cannot read properties of undefined」。
     * 真实运行时里 `wx` 是**常驻全局**，不在加载后消失。
     *
     * 同一个错误在 api 替身上又犯了一次（照片图钉那组测试暴露出来）：
     * `loadPage()` 是**同步**的，而测试是**异步**的 ——
     * 在这里还原 api 替身，等于在页面代码跑起来之前就把它拆了。
     * 页面随后 `require` 到真实的 `utils/api`，于是 `wx.cloud.callFunction`
     * 被真的调用，报出来的却是"加载失败"这种与真因无关的错误。
     *
     * 现在两者都留到下一次 `loadPage()` 覆盖为止（每个测试都会重新装载，
     * 所以不会互相污染）。需要显式清理时用返回的 `restore()`。
     */
    global.Page = prevGlobals.Page;
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
  /** 供测试断言"页面写了什么到本地"（跨页传递靠它） */
  page.__storage = storage;

  /**
   * 显式清理：还原 api 缓存与 `wx` / `getApp` 全局。
   *
   * 因为替身现在会留到下一次 `loadPage()` 为止（见上面那段注释），
   * 一个测试文件里加载的页面替身可能被另一个测试文件里的页面拿到 ——
   * 尤其 `api 替身是共享的`：先加载 `trip` 再加载 `map`，
   * 两边会共用同一个 `calls` 数组与同一份 `opts.api`。
   *
   * 每个测试收尾时调一次最稳妥：`t.after(() => page.restore())`。
   */
  page.restore = function () {
    if (prevCache) require.cache[apiPath] = prevCache;
    else delete require.cache[apiPath];
    global.wx = prevGlobals.wx;
    global.getApp = prevGlobals.getApp;
  };

  /**
   * setData 替身：合并进 data，**同步执行回调**。
   *
   * 真机上回调是在渲染之后跑的，但那是时序细节；
   * 我们要验证的是"回调里读到的是不是新值" —— 同步执行同样能测出这一点。
   *
   * ⚠️ **必须支持嵌套路径**（2026-10-14 修正）。
   * 微信的 `setData` 允许 `{'photoUrls.p_1': {...}}` 这种写法，并会**自动创建
   * 中间对象**。首版替身直接 `data[key] = value` —— 于是 `"photoUrls.p_1"`
   * 成了一个字面 key，页面再读 `data.photoUrls` 就是 `undefined`。
   *
   * 这类错误特别值得修：测试会以"图钉没换成照片"这种**看起来像业务 bug** 的
   * 方式失败，而真因是测试台不支持一个微信本来就支持的写法。
   */
  function setPath(target, path, value) {
    const parts = String(path).split('.');
    let node = target;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (node[k] === null || typeof node[k] !== 'object') node[k] = {};
      node = node[k];
    }
    node[parts[parts.length - 1]] = value;
    return target;
  }

  page.setData = function (patch, cb) {
    page.__setDataLog.push(patch);
    for (const k of Object.keys(patch || {})) setPath(page.data, k, patch[k]);
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

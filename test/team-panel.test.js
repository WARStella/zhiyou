'use strict';

/**
 * 小队面板组件的折叠行为。
 *
 * ── 为什么单独测这个 ──────────────────────────────────────
 *
 * 这个面板很长（共同路线 + 位置与集合 + 候选方案），展开着会把地图和
 * 当前路线挤到屏幕外。用户要求把它做成"点击向下展开"的折叠卡片。
 *
 * 折叠这种东西**只有跑起来才知道对不对**，而它有三个容易做错的点：
 *   ① 没有小队时也折叠 → 用户没法创建/加入小队，功能直接不可用
 *   ② 有小队时默认展开 → 折叠等于没做
 *   ③ 每次 show 都重置折叠状态 → 用户展开后切个页面回来又合上
 *
 * 组件测试此前完全没有（测试台只有 `loadPage`），这一批补了 `loadComponent`。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadComponent } = require('./page-harness');

const KEY = 'zhiyou-active-crew';
const PANEL = 'miniprogram/components/team-panel/index.js';

test('没有小队时不折叠 —— 否则创建/加入的表单打不开，功能直接不可用', () => {
  const c = loadComponent(PANEL, { storage: {} });
  /** 模拟 attached（真机上会调 restore） */
  c.__restoreGlobals();
  assert.equal(c.data.collapsed, false, '没有小队时必须展开着显示创建/加入表单');
});

test('有小队时默认折叠 —— 面板太长，展开会盖住地图', () => {
  const c = loadComponent(PANEL, { storage: { [KEY]: 'crew_1' } });
  /** `attached` 会先 restore（读 storage → 设 crewId + collapsed）再看结果 */
  const origSetData = c.setData;
  c.setData = function (patch) {
    origSetData.call(c, patch);
  };
  /** restore 里会调 refresh()（异步 api），这里只关心它同步设下的字段 */
  if (c.__attached) c.__attached();

  assert.equal(c.data.crewId, 'crew_1', '前提：要先认出有小队');
  assert.equal(c.data.collapsed, true, '有小队时默认折叠');
});

test('切换折叠是纯开关，不动其他状态', () => {
  const c = loadComponent(PANEL, { storage: {} });
  c.setData({ error: '集合点不能作行程节点', message: '已发起集合' });

  c.toggleCollapse();
  assert.equal(c.data.collapsed, true);
  /**
   * ⚠️ 收起**不该清掉提示**：用户收起面板往往正是为了看清地图，
   * 回来时那条"集合已发起"的提示还得在。
   */
  assert.equal(c.data.error, '集合点不能作行程节点', '收起不该清掉错误提示');
  assert.equal(c.data.message, '已发起集合', '收起不该清掉成功提示');

  c.toggleCollapse();
  assert.equal(c.data.collapsed, false, '再点一次要展开回来');
});

test('退出小队后面板重新展开 —— 否则回来看到的是折叠的表单', () => {
  const c = loadComponent(PANEL, { storage: { [KEY]: 'crew_1' } });
  if (c.__attached) c.__attached();
  assert.equal(c.data.collapsed, true, '前提：有小队时是折叠的');

  c.clear();

  assert.equal(c.data.crewId, '', '小队要清掉');
  /**
   * 退出后面板里回到"创建小队 / 加入小队"表单。
   * 这里若还是折叠的，用户就**没法再加入任何小队**了 —— 功能死掉。
   */
  assert.equal(c.data.collapsed, false, '没有小队时必须展开，否则表单打不开');
});

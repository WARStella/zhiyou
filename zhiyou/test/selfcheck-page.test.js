'use strict';

/**
 * 自检页的守卫：**每个按钮绑的方法都必须存在，每个探针都必须有入口。**
 *
 * ── 为什么需要（2026-10-14 实际漏过）──────────────────────
 *
 * 我注册了 `transit.probe` 这个 action，也让用户去点，**但忘了在自检页加按钮**。
 * 用户回："自检页面点哪个？" —— 功能做完了，却没有入口。
 *
 * 这类漏项在 WXML 上的表现是**静默的**：`bindtap="runFooProbe"` 指向一个
 * 不存在的方法时，点下去什么都不发生，也不报错。与"点图钉没反应"是同一类
 * （那次是事件压根没绑）。
 *
 * 所以这里把两件事变成可执行的检查：
 *   ① WXML 里每个 bindtap 的方法名，页面 js 里都得有；
 *   ② 每个 probe action，自检页上都得有一个按钮能触发它。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MINIPROGRAM = path.join(__dirname, '..', 'miniprogram');
const PAGE_WXML = path.join(MINIPROGRAM, 'pages', 'index', 'index.wxml');
const PAGE_JS = path.join(MINIPROGRAM, 'pages', 'index', 'index.js');

const wxml = fs.readFileSync(PAGE_WXML, 'utf8');
const js = fs.readFileSync(PAGE_JS, 'utf8');

test('自检页每个按钮绑的方法都必须存在 —— 指向不存在的方法时点击静默无反应', () => {
  const handlers = [...wxml.matchAll(/bind(?:tap|input|change)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(handlers.length >= 5, `应当扫到多个事件绑定，实际 ${handlers.length} 个`);

  for (const name of handlers) {
    assert.match(
      js,
      new RegExp(`(^|\\s)${name}\\s*\\(`),
      `WXML 绑了 ${name}，但 index.js 里没有这个方法 —— 点下去什么都不发生，也不报错`
    );
  }
});

test('每个探针 action 都要有按钮能触发 —— 做了功能却没有入口', () => {
  /**
   * 探针清单与"用户需要能自己点"这件事绑定。
   * 加了新的 probe action 却忘了加按钮，就是这次踩的坑。
   */
  const probes = ['map.probe', 'ai.probe', 'photo.probe', 'transit.probe'];

  for (const action of probes) {
    assert.match(
      js,
      new RegExp(`'${action.replace('.', '\\.')}'`),
      `自检页应当能触发 ${action}`
    );
  }

  /** 并且每个都要有一个按钮（不是只在 js 里躺着） */
  const buttonCount = (wxml.match(/<button/g) || []).length;
  assert.ok(
    buttonCount >= probes.length,
    `按钮数（${buttonCount}）少于探针数（${probes.length}）—— 有探针没入口`
  );
});

test('公交探针的按钮文案要说清"会真实调用"', () => {
  /**
   * 探针会消耗配额。文案不说清，用户会以为它只是看看配置 ——
   * 而这个项目对配额一直是当作稀缺资源来省的。
   */
  const line = wxml.split(/\r?\n/).find((l) => /runTransitProbe/.test(l));
  assert.ok(line, '公交探针必须有按钮');
  assert.match(line, /会真实调用/, '要说明它会真实调用外部接口（消耗配额）');
});

test('探针按钮在 running 时禁用 —— 避免连点烧配额', () => {
  for (const name of ['runTransitProbe', 'runPhotoProbe', 'runMapProbe', 'runAiProbe']) {
    const line = wxml.split(/\r?\n/).find((l) => l.includes(name));
    assert.ok(line, `${name} 的按钮应当存在`);
    assert.match(line, /disabled="\{\{running\}\}"/, `${name} 按钮必须在 running 时禁用`);
  }
});

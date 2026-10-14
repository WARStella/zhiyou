'use strict';

/**
 * WXML 模板的静态守卫。
 *
 * ── 为什么需要它（2026-10-14，两次白屏）────────────────────
 *
 * 第一次：我加精度告警时，把它插在了 `wx:if` 与 `wx:else` 之间。
 *   后果不是"这一段不显示"，而是**整页都不渲染** —— 用户报
 *   「整张【我的位置】卡片都没了」。WXML 编译失败不弹错，表现就是东西凭空没了。
 *
 * 第二次：我为了"修"上面那处，把 `>=` 改成了 `&gt;=`，**反而把能编译的页面改到编译不过**：
 *
 *     Bad attr `wx:if` with message: unexpected '&' at pos25
 *
 *   因为 **WXML 不把 `&gt;` 当转义符解码**，它原样进入表达式。
 *   也就是说，我第一版守卫给出的建议是**错的**，而我自己照着执行了。
 *
 * ── 这个文件现在的立场 ────────────────────────────────────
 *
 * 只保留**零误报**的检查。一条会误报的检查比没有更糟 ——
 * 它训练人忽略告警，于是连"能抓到一次真问题"的价值也失去。
 *
 * 因此"`wx:else` 必须紧跟 `wx:if`"那条规则**刻意不写**：
 * 我写了三版，三版都在合法代码上误报（team-panel 的 block 写法、
 * 分不清"内容"与"兄弟"、不认跨行标签）。三版都错在同一件事上 ——
 * **没有真正的解析器却想判断嵌套结构**。判定清单改为注释，供人工复核。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MINIPROGRAM = path.join(__dirname, '..', 'miniprogram');

/** 收集所有 .wxml（含组件） */
function allWxml(dir, out) {
  out = out || [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) allWxml(full, out);
    else if (name.endsWith('.wxml')) out.push(full);
  }
  return out;
}

const FILES = allWxml(MINIPROGRAM);

/**
 * 改 WXML 条件块时的人工复核清单：
 *   1. `wx:else` / `wx:elif` 的**上一个兄弟元素**必须是它的 `wx:if`；
 *      中间不要插新元素，哪怕只是一个小提示。
 *   2. 想让提示跟着条件走，就把它**放进同一个元素内部**，
 *      或用 JS 先算好布尔量、在模板里单开一个 `wx:if`。
 *   3. 表达式里**不做比较运算**（`>` `<` `>=` `<=`）：`&gt;` 不被解码、
 *      原始 `>` 只是靠解析器容忍。一律在 JS 里算好。
 *   4. 改完点一次「编译」—— WXML 编译失败不会弹错，只会整页白屏。
 */

test('至少扫到了页面与组件（防止遍历失效导致"检查通过"其实什么都没查）', () => {
  assert.ok(FILES.length >= 5, `应当扫到多个 wxml，实际 ${FILES.length} 个`);
});

test('属性表达式里不得出现比较运算符，也不得用 &gt; / &lt; 绕', () => {
  for (const file of FILES) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, idx) => {
      const exprs = line.match(/\{\{[^}]*\}\}/g) || [];
      for (const expr of exprs) {
        const where = `${path.relative(MINIPROGRAM, file)}:${idx + 1}`;

        /**
         * `&gt;` / `&lt;` 是**最坏的选择**：看起来像转义，实际不被解码，
         * 直接导致编译失败（就是那条 `unexpected '&'`）。
         */
        assert.ok(
          !/&(gt|lt);/.test(expr),
          `${where} 表达式里用了 &gt; / &lt; —— WXML 不解码它，会报 unexpected '&' 并整页白屏。` +
            '请在 JS 里算好布尔量再给模板'
        );
        /**
         * 原始 `>` / `<` 有时能编译，但那是解析器的容忍度，不是契约。
         * 与其赌，不如把判断挪到能测的地方。
         */
        assert.ok(
          !/[<>]/.test(expr),
          `${where} 表达式里直接用了 < 或 > —— 解析器有时能容忍，但别赌它。` +
            '请在 JS 里算好布尔量再给模板'
        );
      }
    });
  }
});

test('标签开闭平衡 —— 少一个闭合标签同样是"整页不渲染"', () => {
  for (const file of FILES) {
    const src = fs.readFileSync(file, 'utf8');
    /** 去掉注释，避免注释里的示例标签干扰计数 */
    const clean = src.replace(/<!--[\s\S]*?-->/g, '');
    for (const tag of ['view', 'block', 'text', 'button', 'image', 'map']) {
      const open = (clean.match(new RegExp(`<${tag}(?=[\\s>])`, 'g')) || []).length;
      /** 自闭合写法（<image ... />）不计入需要闭合的 */
      const selfClosed = (clean.match(new RegExp(`<${tag}\\b[^>]*/>`, 'g')) || []).length;
      const close = (clean.match(new RegExp(`</${tag}>`, 'g')) || []).length;
      assert.equal(
        open - selfClosed,
        close,
        `${path.relative(MINIPROGRAM, file)} 的 <${tag}> 开合不平衡：开 ${open}（自闭合 ${selfClosed}）、闭 ${close}`
      );
    }
  }
});

test('被断言过的"算好布尔量再给模板"确实存在（防止有人又把它挪回模板里）', () => {
  const mapJs = fs.readFileSync(path.join(MINIPROGRAM, 'pages', 'map', 'index.js'), 'utf8');
  const tripJs = fs.readFileSync(path.join(MINIPROGRAM, 'pages', 'trip', 'index.js'), 'utf8');

  assert.match(mapJs, /myAccuracyBad/, '地图页的精度告警需要一个 JS 算好的布尔量');
  assert.match(tripJs, /allReached/, '行程页的"全部走完"需要一个 JS 算好的布尔量');

  const mapWxml = fs.readFileSync(path.join(MINIPROGRAM, 'pages', 'map', 'index.wxml'), 'utf8');
  const tripWxml = fs.readFileSync(path.join(MINIPROGRAM, 'pages', 'trip', 'index.wxml'), 'utf8');
  assert.match(mapWxml, /myAccuracyBad/, '模板要用那个布尔量');
  assert.match(tripWxml, /routeMap\.allReached/, '模板要用那个布尔量');
});

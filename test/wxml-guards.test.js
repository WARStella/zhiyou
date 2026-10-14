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

/** 收集所有 .wxss（含组件） */
function allWxss(dir, out) {
  out = out || [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) allWxss(full, out);
    else if (name.endsWith('.wxss')) out.push(full);
  }
  return out;
}

const WXSS_FILES = allWxss(MINIPROGRAM);

/**
 * WXSS 里不得使用**属性选择器**（`[disabled]` 这种）。
 *
 * 2026-10-14 加。起因是编译器的警告：
 *   「Some selectors are not allowed in component wxss, including
 *     tag name selectors, ID selectors, and attribute selectors」
 *
 * 而这不只是"一个警告" —— **规则会完全失效**。实测当时的写法是：
 *
 *     .btn[disabled] { background: #9aa5b1; }      // 从来没生效过
 *
 * 于是 55 个禁用的按钮一直是正常态的外观，用户看不出"这个按钮现在不能点"。
 * 静默失效比报错难查得多，所以在这里钉住。
 *
 * 正确写法是按**类名**（微信给禁用的 button 加 `button-disabled`），
 * 或用 `:disabled` 伪类。
 */
test('WXSS 不得用属性选择器 —— 它不生效，而且不报错', () => {
  const offenders = [];
  for (const file of WXSS_FILES) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let inComment = false;
    lines.forEach((line, i) => {
      const t = line.trim();
      /**
       * ⚠️ **必须先排掉注释**（2026-10-14 踩过）。
       *
       * 我在修这个 bug 时把原写法 `.btn[disabled]` 写进了注释里说明经过，
       * 于是这个检查**对着注释报错**。
       *
       * 这份文件里我已经因为"用正则在结构上找问题"误报过三次，
       * 每一次都是这类原因：**没有区分"代码"与"描述代码的文字"**。
       */
      if (inComment) {
        if (t.includes('*/')) inComment = false;
        return;
      }
      if (t.startsWith('/*') || t.startsWith('//')) {
        if (t.startsWith('/*') && !t.includes('*/')) inComment = true;
        return;
      }
      if (t.startsWith('*')) return;

      /** 只看选择器行：以 . # 或字母开头、且行内有 [ 的 */
      const isSelector = /^[.#a-zA-Z*]/.test(t);
      if (isSelector && t.includes('[')) {
        offenders.push(`${path.relative(MINIPROGRAM, file)}:${i + 1}  ${t}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    '属性选择器在 WXSS 里不生效，要改成类名（如 .button-disabled）或伪类：\n' + offenders.join('\n')
  );
});

/**
 * 组件的 String 属性不得收到 `null`。
 *
 * 2026-10-14 加。编译器每次渲染都警告一次：
 *   「property "personalTripId" ... received type-uncompatible value:
 *     expected <String> but get null value. Use empty string instead.」
 *
 * 根因是小程序的语义：**属性传 `null` 不算"没传"**（那要用 `undefined`
 * 或省略属性），所以 `null` 会实打实覆盖掉组件声明的默认值 `''`。
 * 页面 data 里那种"初始化为 null"的字段（`trip: null`）正好会踩到。
 */
test('给组件的 String 属性传值时要有空串兜底，别让 null 覆盖默认值', () => {
  /**
   * 只做**零误报**的检查：找出"传给组件的表达式"里直接读属性的写法，
   * 且该属性名在组件里声明为 String。
   *
   * 目前只有 team-panel 一个组件，所以这里显式列出它的 String 属性 ——
   * 比写一个通用解析器可靠（那种解析器我在这份文件里试过三次，都误报）。
   */
  const STRING_PROPS = ['personal-trip-id', 'source'];
  const offenders = [];

  for (const file of FILES) {
    const src = fs.readFileSync(file, 'utf8');
    for (const prop of STRING_PROPS) {
      const re = new RegExp(`${prop}="\\{\\{([^}]*)\\}\\}"`, 'g');
      let m;
      while ((m = re.exec(src)) !== null) {
        const expr = m[1].trim();
        /** 已经有兜底就不管：`|| ''`、`? ... : ...`、字面量 */
        if (/\|\||\?|'/.test(expr)) continue;
        offenders.push(`${path.relative(MINIPROGRAM, file)}  ${prop}="{{${expr}}}"`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'String 属性传 null 会覆盖组件默认值并触发编译警告，请加 `|| \'\'`：\n' + offenders.join('\n')
  );
});

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

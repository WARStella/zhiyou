'use strict';

/**
 * WXML 模板的静态守卫。
 *
 * ── 为什么需要它（2026-10-14 实际白屏一次）──────────────────
 *
 * 用户报："整张「我的位置」卡片都没了。"
 *
 * 真因不在 JS，在模板：
 *
 *   <view wx:if="{{myPoint}}" class="sub"> … </view>
 *   <view wx:if="{{myAccuracyM > 500}}" class="note warn"> … </view>   ← 我插进来的
 *   <view wx:else class="sub"> … </view>                              ← 不再配对
 *
 * 两条问题叠在一起：
 *   ① `wx:else` 必须**紧跟**它的 `wx:if`，中间插了别的 `wx:if` 就不成立；
 *   ② 属性值里出现未转义的 `>`。
 *
 * 后果不是"这一段不显示"，而是**模板编译不过、整页都不渲染** ——
 * 而小程序里没有编译期报错弹给你看，表现就是"东西凭空没了"。
 *
 * 本文件把那两条变成可执行的检查。**这类错误不值得靠人眼发现第二次。**
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
 * ── 一条**刻意不写**的检查，以及为什么 ────────────────────
 *
 * 白屏那次还有第二个原因：我在 `wx:if` 与 `wx:else` 之间插了一个新的 `wx:if`，
 * 破坏了配对。按理该有一条规则守住它。
 *
 * 我写了三版，三版都在**合法的代码上报错**：
 *   · 第一版把"中间隔着内容"当成违规 → 误报 team-panel 的 block 写法；
 *   · 第二版分不清"block 内部的内容"与"兄弟元素" → 同一处误报；
 *   · 第三版按"最近的兄弟开标签"判定，但不认跨行标签
 *     （`<button …>` / 内容 / `</button>`）→ 又把 button 当成兄弟。
 *
 * 三版都错在同一件事上：**没有真正的解析器却想判断嵌套结构**。
 * 而这种错法特别有害 —— 一个会误报的检查会训练人忽略它，
 * 那它连"能抓到一次真问题"的价值也失去了。
 *
 * 所以这条规则留空，只在下面留一段人工复核清单。真正该守住的是
 * "属性值里的未转义运算符"（它是白屏的直接原因，且那条规则零误报），
 * 以及"标签开闭平衡"。
 *
 * 人工复核清单（改 WXML 的条件块时）：
 *   1. `wx:else` / `wx:elif` 的**上一个兄弟元素**必须是它的 `wx:if`；
 *      中间不要插新的元素，哪怕只是一个小提示。
 *   2. 想让"提示"跟着条件走，就把它**放进同一个元素的内部**，
 *      或用 JS 先算好一个布尔量再在模板里单开一个 `wx:if`。
 *   3. 改完点一次「编译」—— WXML 编译失败不会弹错，只会整页白屏。
 */

test('至少扫到了页面与组件（防止 glob 失效导致"检查通过"其实什么都没查）', () => {
  assert.ok(FILES.length >= 5, `应当扫到多个 wxml，实际 ${FILES.length} 个`);
});

test('属性值里不得出现未转义的比较运算符（`>` / `<`）', () => {
  for (const file of FILES) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split(/\r?\n/);
    lines.forEach((line, idx) => {
      /** 只看标签属性区：从 `<` 到匹配的 `>` 之间容易误判，所以按"属性里的 {{ }}"来判断 */
      const exprs = line.match(/\{\{[^}]*\}\}/g) || [];
      for (const expr of exprs) {
        /**
         * `>` 在属性值里必须写成 `&gt;`，否则模板编译器会把它当成标签结束。
         * `<` 同理。**这正是白屏那次的第二个原因。**
         */
        assert.ok(
          !/>/.test(expr),
          `${path.relative(MINIPROGRAM, file)}:${idx + 1} 表达式 "${expr}" 里用了未转义的 ">"，` +
            '应写成 &gt;，或**在 JS 里算好再给模板**（后者更稳）'
        );
        assert.ok(
          !/</.test(expr),
          `${path.relative(MINIPROGRAM, file)}:${idx + 1} 表达式 "${expr}" 里用了未转义的 "<"，应写成 &lt;`
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

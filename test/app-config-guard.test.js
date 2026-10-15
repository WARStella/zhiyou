'use strict';

/**
 * `app.json` 的**上传前守卫**。
 *
 * ── 为什么需要它（2026-10-15 真实故障）────────────────────
 *
 * 上传小程序代码时被平台拒绝：
 *
 *     系统错误，错误码：80058
 *     desc(用于在游览地图上显示你当前所在位置，并计算你到约定集合点的步行时间与距离)
 *     of scope.userLocation exceeds 30, word count: 36
 *
 * 两个特点让它特别值得做成测试：
 *
 *   ① **只在上传那一刻才暴露** —— 本地编译、真机预览都不报，代价是一整个上传周期；
 *   ② **纯配置文本问题** —— 没有任何逻辑缺陷，靠读代码永远发现不了。
 *
 * 这与 `wxml-guards`（WXML 编译失败不弹错、只会整页白屏）是同一类：
 * **把"只能在特定时刻发现的失败"提前到本地**。
 *
 * ⚠️ 只加客观判据（字数、文件是否存在、引用是否闭合）。
 * 主观判断（"这句话写得好不好"）不进测试 —— 会误报的检查比没有检查更糟。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MP = path.join(__dirname, '..', 'miniprogram');
const app = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'));

const charCount = (s) => [...String(s)].length;

test('权限用途说明不得超过 30 字 —— 80058 就是这条引起的', () => {
  const perms = (app.permission && app.permission) || {};
  const scopes = Object.keys(perms).filter((k) => k.startsWith('scope.'));
  assert.ok(scopes.length > 0, '至少要声明一个 scope —— 否则这条测试等于什么都没查');

  for (const scope of scopes) {
    const desc = perms[scope] && perms[scope].desc;
    assert.equal(typeof desc, 'string', `${scope} 必须有 desc`);
    assert.ok(desc.trim().length > 0, `${scope}.desc 不能为空`);
    assert.ok(
      charCount(desc) <= 30,
      `${scope}.desc 有 ${charCount(desc)} 字，超过平台上限 30 字（上传会报 80058）：${desc}`
    );
  }
});

test('每个页面的四件套都要在（少一个就是编译期或运行期报错）', () => {
  for (const p of app.pages) {
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      const f = path.join(MP, `${p}.${ext}`);
      assert.ok(fs.existsSync(f), `缺少文件：${p}.${ext}`);
    }
  }
});

test('tabBar 指的页面必须在 pages 里（否则 tab 点了没反应）', () => {
  const list = (app.tabBar && app.tabBar.list) || [];
  assert.ok(list.length >= 2 && list.length <= 5, 'tabBar 只允许 2–5 项');
  for (const item of list) {
    assert.ok(
      app.pages.includes(item.pagePath),
      `tabBar 里的 ${item.pagePath} 不在 pages 列表中`
    );
    assert.ok(item.text && item.text.trim(), `${item.pagePath} 缺少 tab 文字`);
  }
});

test('sitemap 文件真实存在（app.json 声明了它）', () => {
  assert.ok(app.sitemapLocation, '缺少 sitemapLocation');
  assert.ok(
    fs.existsSync(path.join(MP, app.sitemapLocation)),
    `app.json 声明了 ${app.sitemapLocation}，但文件不存在`
  );
});

test('用到的位置接口必须在 requiredPrivateInfos 里声明', () => {
  /**
   * ⚠️ 少声明一项的后果不是报错，而是**真机上静默拿不到位置** ——
   * 而定位正是本项目"集合协同"的地基。
   * 判据用"代码里是否真的调了这个 API"，不是猜。
   */
  const used = new Set();
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) walk(full);
      else if (f.name.endsWith('.js')) {
        const src = fs.readFileSync(full, 'utf8');
        if (/wx\.getLocation\s*\(/.test(src)) used.add('getLocation');
        if (/wx\.chooseLocation\s*\(/.test(src)) used.add('chooseLocation');
      }
    }
  };
  walk(MP);

  const declared = app.requiredPrivateInfos || [];
  assert.ok(used.size > 0, '代码里没有找到位置接口调用 —— 判据可能失效了');
  for (const api of used) {
    assert.ok(
      declared.includes(api),
      `代码里用了 wx.${api}，但 app.json 的 requiredPrivateInfos 没声明它`
    );
  }
});

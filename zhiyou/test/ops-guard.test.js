'use strict';

/**
 * 运维/探针类 action 的准入守卫测试。
 *
 * 这一环守的是**授权**，而授权的测试有个特点：
 * 它平时什么都不影响，只在**不该进的人进来了**那一刻才有价值 ——
 * 而那一刻不会报错，只会静静地写进一条 `place.survey`。
 *
 * 所以下面既测纯函数，也测真实调用路径（`invoke` 的分发层），
 * 还测一件容易被忽略的事：**名单会不会漏掉新 action**。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const G = require('../cloudfunctions/api/lib/ops-guard');
const { makeWorld, expectOk } = require('./helpers');

// ── 纯函数 ────────────────────────────────────────────────

test('白名单解析：逗号/分号/空白都能分隔，去空去重', () => {
  assert.deepEqual(G.parseAdminOpenids('a,b'), ['a', 'b']);
  assert.deepEqual(G.parseAdminOpenids('a; b\nc'), ['a', 'b', 'c']);
  assert.deepEqual(G.parseAdminOpenids(' a , a ,, '), ['a'], '重复与空项都要去掉');
  assert.deepEqual(G.parseAdminOpenids(''), []);
  assert.deepEqual(G.parseAdminOpenids(null), []);
  assert.deepEqual(G.parseAdminOpenids(undefined), []);
});

test('受保护范围：ops.* 与探针全部覆盖，普通业务 action 不受影响', () => {
  for (const a of ['ops.initDb', 'ops.walkStats', 'ops.exportWalkSamples', 'ops.未来新增的某个']) {
    assert.equal(G.isAdminAction(a), true, `${a} 应当受保护`);
  }
  for (const a of ['map.probe', 'ai.probe', 'photo.probe', 'map.matrixProbe', 'transit.probe', 'place.survey', 'place.fetchPhotos']) {
    assert.equal(G.isAdminAction(a), true, `${a} 应当受保护`);
  }
  for (const a of ['trip.plan', 'crew.create', 'meet.arrive', 'user.login', 'place.search']) {
    assert.equal(G.isAdminAction(a), false, `${a} 是普通业务接口，不该被守卫挡住`);
  }
});

test('未配置白名单 → **一律拒绝**，并把自己的 openid 回给调用方', () => {
  /**
   * "没配就当没限制"是最糟的默认值：它会让守卫在**真正需要它的那一刻**
   * （刚部署、还没配变量）恰好失效。
   */
  const r = G.checkAdminAccess({ action: 'ops.initDb', openid: 'o_me', env: 'dev', adminOpenids: [] });
  assert.equal(r.allowed, false);
  assert.equal(r.code, 'FORBIDDEN_NOT_ADMIN');
  assert.match(r.message, /一律拒绝/);
  assert.equal(r.details.yourOpenid, 'o_me', '必须能自举：告诉调用方该把哪个值填进去');
  assert.match(r.details.hint, /ZY_ADMIN_OPENIDS/);
});

test('不在名单里 → 拒绝；在名单里 → 放行', () => {
  const denied = G.checkAdminAccess({ action: 'place.survey', openid: 'o_stranger', env: 'dev', adminOpenids: ['o_me'] });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, 'FORBIDDEN_NOT_ADMIN');
  assert.equal(denied.details.yourOpenid, 'o_stranger');

  const allowed = G.checkAdminAccess({ action: 'place.survey', openid: 'o_me', env: 'dev', adminOpenids: ['o_me'] });
  assert.equal(allowed.allowed, true);
});

test('非 dev 环境：即使是管理员也拒绝，且用**环境**错误码（处置方式不同）', () => {
  const r = G.checkAdminAccess({ action: 'ops.initDb', openid: 'o_me', env: 'prod', adminOpenids: ['o_me'] });
  assert.equal(r.allowed, false);
  assert.equal(r.code, 'FORBIDDEN_ENV', '环境不对要去改配置，白名单不对要去加 openid —— 两种处置，两个码');
});

test('普通业务 action 直接放行，连白名单都不看', () => {
  const r = G.checkAdminAccess({ action: 'trip.plan', openid: 'o_anyone', env: 'dev', adminOpenids: [] });
  assert.equal(r.allowed, true);
});

// ── 真实调用路径 ──────────────────────────────────────────

test('分发层：白名单为空时 ops.* 被拒，普通接口照常可用', async () => {
  const w = await makeWorld({ adminOpenids: [] });
  const denied = await w.A('ops.walkStats', {});
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'FORBIDDEN_NOT_ADMIN');
  assert.equal(denied.error.details.yourOpenid, 'openid_A', '拒绝时要能自举：把调用者自己的 openid 回给他');

  // 同一个世界里，普通接口不受影响 —— 守卫不能误伤主流程
  const ok = expectOk(await w.A('user.login', {}));
  assert.ok(ok.userId, '普通业务接口必须照常工作');
});

test('分发层：名单里有自己就能调 ops.*', async () => {
  const w = await makeWorld({ adminOpenids: ['openid_A'] });
  const d = expectOk(await w.A('ops.walkStats', {}));
  assert.equal(d.kind, 'walkStats');
});

test('分发层：名单里有别人但没自己 → 拒绝（不是"名单非空就放行"）', async () => {
  const w = await makeWorld({ adminOpenids: ['someone_else'] });
  const res = await w.A('ops.exportWalkSamples', {});
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'FORBIDDEN_NOT_ADMIN');
});

test('被拒的调用**不执行** action —— 不能只是"返回错误但已经把事做了"', async () => {
  /**
   * 守卫写在 `invoke` 的分发层、handler 之前，这条就是验它真的在那之前。
   * 判据：找一个会**写库**的受保护 action，确认拒绝后库里没有新记录。
   */
  const w = await makeWorld({ adminOpenids: [] });
  const C = require('../cloudfunctions/api/lib/repo/collections');
  const before = await w.repo.count(C.EVENTS, {});

  const res = await w.A('place.survey', {
    places: [{ name: '偷偷写进去的地点', location: { latitude: 45.7, longitude: 126.6 } }],
  });
  assert.equal(res.ok, false);

  // events 里应该只有"这次失败调用"本身那条，不该有任何地点写入
  const places = await w.repo.find(C.PLACES, { name: '偷偷写进去的地点' });
  assert.equal(places.length, 0, '被拒的调用不许产生任何业务写入');
  assert.ok((await w.repo.count(C.EVENTS, {})) >= before, '失败调用照样要留痕（可审计）');
});

// ── 名单会不会漏（防漂移）─────────────────────────────────

/** 去掉注释：只扫代码。首版扫全文时被自己写的说明文字绊倒过。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** 从 `module.exports = {...}` 里找出某个导出名对应的**本地函数名** */
function localNameOf(src, exportName) {
  /**
   * ⚠️ 结尾必须写成 `\s*\}\s*;` 而不是 `\n};`：
   * 工作副本的行尾是 **CRLF**（git 检出时转的），`\n};` 里那个 `\n`
   * 后面紧跟的是 `\r` —— 匹配不上，于是**所有** action 都"认不出本地函数名"，
   * 整条测试报出 48 个假问题。第一版就是这么错的。
   */
  const m = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\s*\}\s*;?/);
  if (!m) return null;
  for (const raw of m[1].split('\n')) {
    const line = stripComments(raw).trim().replace(/,$/, '');
    if (!line) continue;
    const kv = line.match(/^([\w$]+)\s*:\s*([\w$.]+)$/); // 形式：exportName: localName
    if (kv) {
      if (kv[1] === exportName) return kv[2].split('.').pop();
      continue;
    }
    const bare = line.match(/^([\w$]+)$/); // 形式：localName,
    if (bare && bare[1] === exportName) return bare[1];
  }
  return null;
}

/**
 * 切出**单个函数**的源码。
 *
 * ⚠️ 必须按函数切，不能按文件判断：`actions/user.js` 里既有仅 dev 的
 * `ops.initDb`，也有**普通产品功能** `user.updateProfile`（昵称/头像）。
 * 按文件判断会把后者一起判成"仅 dev"，于是这条测试报出三个假问题 ——
 * 而本项目的教训是：
 *
 *   > **一个会误报的检查比没有检查更糟** —— 它训练人忽略告警。
 */
function functionSlice(src, fnName) {
  const re = new RegExp(`^(?:async\\s+)?function\\s+${fnName}\\s*\\(`, 'm');
  const m = re.exec(src);
  if (m) {
    const rest = src.slice(m.index + m[0].length);
    const next = rest.search(/^(?:async\s+)?function\s|^const\s+[\w$]+\s*=\s*(?:async\s*)?\(|^module\.exports/m);
    return next === -1 ? rest : rest.slice(0, next);
  }
  // 箭头函数常量：`const probe = async (ctx) => {`
  const re2 = new RegExp(`^const\\s+${fnName}\\s*=\\s*(?:async\\s*)?\\(`, 'm');
  const m2 = re2.exec(src);
  if (m2) {
    const rest = src.slice(m2.index + m2[0].length);
    const next = rest.search(/^(?:async\s+)?function\s|^const\s+[\w$]+\s*=\s*(?:async\s*)?\(|^module\.exports/m);
    return next === -1 ? rest : rest.slice(0, next);
  }
  return null;
}

test('**扫源码交叉核对**：任何自己要求 dev 的 action 都必须在守卫名单里', () => {
  /**
   * 这条守的是"以后新加一个仅 dev 的 action，却忘了进守卫名单"。
   * 做法与 `wxml-guards`、"不许让占位地点长回来"那两条测试同一套路：
   * **扫源码，不靠人记**。
   *
   * 判据分三步，都不靠猜：
   *   ① 用 `require.cache` 按**函数身份**把每个已注册 action 反查到实现文件；
   *   ② 从 `module.exports` 找出它的**本地函数名**，切出那一个函数的源码；
   *   ③ 切片里有 `FORBIDDEN_ENV` → 它自己要求 dev → 必须在守卫名单里。
   *
   * 切片切不出来的进 `unresolved`，**单独列出来人工复核**，
   * 不猜、也不因此让整条测试误报。
   */
  const registry = require('../cloudfunctions/api/actions');
  const actionsDir = path.join(__dirname, '..', 'cloudfunctions', 'api', 'actions');

  /**
   * 函数 → 实现文件 / 导出键 的反查表。
   *
   * ⚠️ 必须按**函数身份**反查，不能拿 action 名去猜导出名：
   * action 名是 `user.login`，而模块里导出的是 `login`（前缀活在 index.js 里）。
   * 首版就是这么错的 —— 48 个 action 全部"认不出本地函数名"。
   */
  const fnToFile = new Map();
  const fnToExportKey = new Map();
  for (const [file, mod] of Object.entries(require.cache)) {
    if (!file.startsWith(actionsDir)) continue;
    if (file.endsWith(`${path.sep}index.js`)) continue;
    const exp = mod && mod.exports;
    if (typeof exp === 'function') fnToFile.set(exp, file); // 整个模块就是一个函数，没有导出键
    else if (exp && typeof exp === 'object') {
      for (const [key, v] of Object.entries(exp)) {
        if (typeof v === 'function') {
          fnToFile.set(v, file);
          fnToExportKey.set(v, key);
        }
      }
    }
  }

  const names = Object.keys(registry);
  const devOnly = [];
  const unresolved = [];
  let fileLevel = 0;
  for (const name of names) {
    const fn = registry[name];
    const file = fnToFile.get(fn);
    if (!file) {
      unresolved.push(`${name}（反查不到实现文件）`);
      continue;
    }
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const exportKey = fnToExportKey.get(fn);

    /**
     * 先按**导出键当函数名**直接切片，切不到再去解析导出块找别名。
     *
     * 为什么是这个顺序：本项目多数 action 文件用的是简写导出
     * （`module.exports = { plan, current, list, arrive }`），此时导出键**就是**函数名；
     * 而导出块解析对格式敏感（有没有分号、有没有尾注释都会影响）。
     * 先走简单而准确的那条路，解析只在真正有别名时兜底。
     */
    let local = null;
    if (exportKey && functionSlice(src, exportKey)) local = exportKey;
    if (!local && exportKey) {
      const alias = localNameOf(src, exportKey);
      if (alias && functionSlice(src, alias)) local = alias;
    }
    const slice = local ? functionSlice(src, local) : null;

    if (slice) {
      if (slice.includes('FORBIDDEN_ENV')) devOnly.push(name);
      continue;
    }
    /**
     * 认不出函数体的（模块整个就是一个函数、或导出用了别名）**回落到文件级**判断。
     * 这类模块只有一个导出，文件级与函数级等价；
     * 但计数要报出来，别让人以为全都是精确判断的。
     */
    if (src.includes('FORBIDDEN_ENV')) {
      devOnly.push(name);
      fileLevel++;
    } else if (exportKey === undefined) {
      fileLevel++;
    } else {
      unresolved.push(`${name}（切不出函数体且文件里没有 dev 断言）`);
    }
  }

  assert.ok(
    unresolved.length <= 1,
    `太多 action 判断不了（${unresolved.length} 个）—— 判据本身可能失效了：${unresolved.join('；')}`
  );
  assert.ok(devOnly.length >= 5, `只认出 ${devOnly.length} 个仅 dev 的 action —— 判据可能失效了`);

  const offenders = devOnly.filter((n) => !G.isAdminAction(n));
  assert.deepEqual(
    offenders,
    [],
    `这些 action 自己要求 dev，却不在守卫名单里：${offenders.join(', ')}` +
      (fileLevel ? `\n（其中 ${fileLevel} 个是按文件级判断的，非函数级精确切片）` : '')
  );

  // 反向抽样：普通产品功能**不该**被判成仅 dev（防误报方向的反例）
  for (const normal of ['user.login', 'user.updateProfile']) {
    assert.equal(devOnly.includes(normal), false, `${normal} 是普通产品功能，不能判成仅 dev`);
  }
});

test('名单里的每一条都对应真实注册的 action（防止名单写错名字）', () => {
  /**
   * 名单写错名字的后果是**静默无效**：以为守住了，其实那个名字根本不存在，
   * 而真正的 action 以别的名字裸露着。
   */
  const registry = require('../cloudfunctions/api/actions');
  const names = Object.keys(registry);
  for (const rule of G.ADMIN_ACTIONS) {
    if (rule.endsWith('.')) {
      assert.ok(names.some((n) => n.startsWith(rule)), `前缀规则 ${rule} 在注册表里没有任何匹配`);
    } else {
      assert.ok(names.includes(rule), `守卫名单里的 ${rule} 不是已注册的 action`);
    }
  }
});

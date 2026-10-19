'use strict';

/**
 * 注入点守卫。
 *
 * ── 为什么需要这个文件（2026-10-14 实际踩到）──────────────
 *
 * `lib/invoke.js` 的 `callCtx` 是一份**白名单**：外部服务工厂只能从入口注入，
 * 产品代码里不留任何测试钩子。这份白名单原本只靠一句注释提醒"新增注入点必须同时改这里"。
 *
 * 加照片服务时，动作层写了 `ctx.createPhotoService ? 替身 : 真实实现`，
 * 而白名单没加这一项。后果不是"注入没生效"这么简单：
 *
 *   · 测试注入的假 provider 被静默丢掉；
 *   · 动作层回落到**真实高德 provider**；
 *   · 报出来的错误是 `AMAP_KEY_NOT_CONFIGURED`。
 *
 * 也就是说，**一个关于"注入"的配置错误，伪装成了"API Key 没配"**。
 * 如果当时手边真有 Key，这条测试就会悄悄去连真实高德 —— 更糟。
 *
 * ── 这个文件检查什么 ──────────────────────────────────────
 *
 *   ① `SERVICE_INJECTIONS` 里每一项都真的被 `callCtx` 传递了（漏传立刻非法）；
 *   ② 每一项在动作层**确实被读到**（不是声明了却没人用）；
 *   ③ 生产入口 `cloudfunctions/api/index.js` **不注入任何替身**。
 *
 * ③ 很关键：注入点一旦被产品入口传了值，测试替身就有机会溜进线上。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { invoke, SERVICE_INJECTIONS } = require('../cloudfunctions/api/lib/invoke');
const { makeWorld, expectOk, C } = require('./helpers');

const invokeSrc = fs.readFileSync(
  path.join(__dirname, '..', 'cloudfunctions', 'api', 'lib', 'invoke.js'),
  'utf8'
);

test('注入点清单里的每一项，动作层都真的读到了', () => {
  for (const key of SERVICE_INJECTIONS) {
    assert.ok(
      new RegExp(`ctx\\.${key}\\b`).test(invokeSrc) || new RegExp(`callCtx\\.${key}\\b`).test(invokeSrc),
      `${key} 在 callCtx 里传递了，但动作层没有任何地方读它 —— 要么补上使用，要么从清单里删掉`
    );
  }
});

test('漏传注入点会立刻报错，而不是静默回落到真实实现', async () => {
  const w = await makeWorld();
  const healthy = {
    repo: w.repo,
    openid: 'openid_A',
    env: 'dev',
    now: w.NOW,
    /**
     * ⚠️ 2026-10-15：`ops.*` 现在要过管理员白名单（`lib/ops-guard.js`）。
     * 手搭 ctx 的测试必须显式声明，否则守卫会先一步拒绝 ——
     * 那样这条测试验的就不是"注入点断言生效"，而是"权限被拒"。
     */
    adminOpenids: ['openid_A'],
    createMapProvider: null,
    createPhotoService: null,
    createTransitProvider: null,
    createSpeechProvider: null, createOcrProvider: null, createGuideProvider: null, createInviteProvider: null, createSubscribeProvider: null,
  };

  // 对照组：字段齐全时必须正常
  const okRes = await invoke({ action: 'ops.health', requestId: 'req_guard_1', payload: {} }, healthy);
  assert.equal(okRes.ok, true);

  /**
   * 现在真的漏掉一项。
   *
   * `callCtx` 是一份白名单，漏传的后果本该是"动作层回落到真实实现" ——
   * 那是**静默**的，只会表现为一个看似无关的错误（当初就是 AMAP_KEY_NOT_CONFIGURED）。
   * 运行时断言把它变成一条明确的异常。
   */
  const missing = Object.assign({}, healthy);
  delete missing.createPhotoService;

  /**
   * `invoke` 的设计是**不把异常抛给客户端**（统一转成响应结构），
   * 所以这里断言的是响应：必须是明确失败，且错误信息直指漏传的那一项。
   *
   * 关键差别在于：改之前它会返回 ok: true（静默用了真实实现），
   * 改之后返回 ok: false 并点名 createPhotoService。
   */
  const bad = await invoke({ action: 'ops.health', requestId: 'req_guard_2', payload: {} }, missing);
  assert.equal(bad.ok, false, '漏传注入点必须失败，不得静默回落');
  assert.match(bad.error.message, /注入点未提供：createPhotoService/);
});

test('生产入口不注入任何替身 —— 只允许显式传 null（用真实实现）', () => {
  const entrySrc = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'api', 'index.js'), 'utf8');
  const passIdx = entrySrc.indexOf('invoke(event');
  assert.ok(passIdx >= 0, '入口必须调用 invoke');

  const tail = entrySrc.slice(passIdx);
  for (const key of SERVICE_INJECTIONS) {
    /**
     * 入口**必须出现**这个键（否则会在运行时抛错，见 invoke 的守卫），
     * 但它的值只允许是 `null` —— 传别的就是把替身带上了线。
     */
    const m = tail.match(new RegExp(`\\b${key}\\s*:\\s*([^,\\n]+)`));
    assert.ok(m, `生产入口必须显式声明 ${key}（用不到就传 null）`);
    assert.equal(m[1].trim(), 'null', `生产入口的 ${key} 只能是 null，不得注入替身`);
  }
});

test('照片服务的注入确实生效（本文件的起因，跑一条真实的）', async () => {
  const { createPhotoService } = require('../cloudfunctions/api/lib/photo');
  const { createFakePhotoProvider } = require('../cloudfunctions/api/lib/photo/fake');

  let factoryCalls = 0;
  const w = await makeWorld({
    createPhotoService: () => {
      factoryCalls += 1;
      return createPhotoService({
        photoProvider: createFakePhotoProvider({ mode: 'ok' }),
        store: {
          async persist(placeId, index) {
            return { ok: true, fileID: `cloud://t/${placeId}/${index}.img`, byteLength: 1, contentType: 'image/jpeg' };
          },
        },
      });
    },
  });

  const res = expectOk(await w.A('place.fetchPhotos', { placeId: 'p_zhongyang' }));

  assert.equal(factoryCalls, 1, '注入了工厂就必须被调用 —— 这正是当初漏掉的一步');
  assert.equal(res.provider, 'fake', 'provider 必须是注入的那个，不能回落到 amap');
  assert.notEqual(res.emptyReason, 'PROVIDER_NOT_CONFIGURED', '不得再伪装成"Key 没配"');
  assert.equal(res.photos.length, 1);

  const stored = await w.repo.get(C.PLACES, 'p_zhongyang');
  assert.equal(stored.photos.length, 1);
});

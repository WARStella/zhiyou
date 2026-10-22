'use strict';

/**
 * 照片服务探针的测试。
 *
 * 这条探针的价值全在**分层**：把"取照片没通"的几种互不相干的原因拆开，
 * 每一层单独说通没通。所以测试也围绕"层与层不能混"来写 ——
 * 尤其 Key 没配时，必须明确说后两层**没测**，而不是让它看起来像也失败了。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, expectOk } = require('./helpers');
const { createPhotoService } = require('../cloudfunctions/api/lib/photo');
const { createFakePhotoProvider } = require('../cloudfunctions/api/lib/photo/fake');

function worldWith(mode) {
  return makeWorld({
    createPhotoService: () =>
      createPhotoService({
        photoProvider: createFakePhotoProvider({ mode }),
        store: {
          async persist(placeId, index) {
            return { ok: true, fileID: `cloud://t/${placeId}/${index}.img`, byteLength: 1, contentType: 'image/jpeg' };
          },
        },
      }),
  });
}

test('全通时 verdict 为 OK，三层都是 ok', async () => {
  const w = await worldWith('ok');
  const res = expectOk(await w.A('photo.probe', {}));

  assert.equal(res.ok, true);
  assert.equal(res.verdict, 'OK');
  const byStep = Object.fromEntries(res.steps.map((s) => [s.step, s]));
  assert.equal(byStep['api-key'].ok, true);
  assert.equal(byStep.upstream.ok, true);
  assert.equal(byStep.fields.ok, true);
  assert.equal(res.mapApiCalls, 1, '探针会真实调用上游，要如实报告消耗');
});

test('Key 没配时：明确说后两层**未测**，且不发请求（省配额）', async () => {
  const w = await worldWith('no-key');
  const res = expectOk(await w.A('photo.probe', {}));

  assert.equal(res.ok, false);
  assert.equal(res.verdict, 'KEY_MISSING');

  const byStep = Object.fromEntries(res.steps.map((s) => [s.step, s]));
  assert.equal(byStep['api-key'].ok, false);
  assert.match(byStep['api-key'].detail, /AMAP_KEY/);
  /**
   * 关键：`ok: null` 表示"没测"，与 `ok: false`（测了没过）**必须能区分**。
   * 混成 false 会让人以为后两层也坏了，于是去查本来没问题的地方。
   */
  assert.equal(byStep.upstream.ok, null, '未测必须是 null，不能是 false');
  assert.match(byStep.upstream.detail, /未测/);
  assert.equal(byStep.fields.ok, null);
  assert.equal(res.mapApiCalls, undefined, '没发请求就不该报告消耗');
});

test('上游失败：verdict 指向 UPSTREAM_FAILED，并提示去查 Key 类型与服务开通', async () => {
  const w = await worldWith('upstream-failure');
  const res = expectOk(await w.A('photo.probe', {}));

  assert.equal(res.ok, false);
  assert.equal(res.verdict, 'UPSTREAM_FAILED');
  assert.match(res.hint, /Web服务|关键字搜索/, '要指向控制台里真正该改的那一项');

  const byStep = Object.fromEntries(res.steps.map((s) => [s.step, s]));
  assert.equal(byStep.upstream.ok, false);
  assert.equal(byStep.upstream.detail.includes('失败'), true);
});

test('接口通但该 POI 没照片：这是"没问题"，与失败区分开', async () => {
  const w = await worldWith('poi-without-photo');
  const res = expectOk(await w.A('photo.probe', {}));

  assert.equal(res.ok, true, '上游是通的，所以 ok 为 true');
  assert.equal(res.verdict, 'NO_PHOTO_FOR_THIS_POI');
  const byStep = Object.fromEntries(res.steps.map((s) => [s.step, s]));
  assert.equal(byStep.upstream.ok, true);
  assert.equal(byStep.fields.ok, null, '没照片不算"字段解析失败"');
  assert.match(byStep.fields.detail, /换个更知名的地标/);
});

test('名字匹配不到 POI：说清是匹配问题而不是接口问题', async () => {
  const w = await worldWith('no-poi');
  const res = expectOk(await w.A('photo.probe', {}));

  assert.equal(res.verdict, 'NO_MATCH');
  const byStep = Object.fromEntries(res.steps.map((s) => [s.step, s]));
  assert.equal(byStep.upstream.ok, true);
  assert.match(byStep.fields.detail, /匹配不到/);
});

test('探针不落云存储 —— 它验的是接口，不是要存东西', async () => {
  let persistCalls = 0;
  const w = await makeWorld({
    createPhotoService: () =>
      createPhotoService({
        photoProvider: createFakePhotoProvider({ mode: 'ok' }),
        store: {
          async persist() {
            persistCalls += 1;
            return { ok: true, fileID: 'cloud://x', byteLength: 1, contentType: 'image/jpeg' };
          },
        },
      }),
  });
  expectOk(await w.A('photo.probe', {}));
  assert.equal(persistCalls, 0, '探针不该往云存储写东西');
});

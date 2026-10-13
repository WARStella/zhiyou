'use strict';

/**
 * 步行样本管道与校准报告的测试。
 *
 * 这一环是"绕路系数"模型的**数据来源** —— 而数据管道最大的风险不是算法，
 * 是**静默地什么都没记**：规划照常成功，样本表却是空的，
 * 等到要训练时才发现白攒了一个月。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeWorld, expectOk } = require('./helpers');
const C = require('../cloudfunctions/api/lib/repo/collections');

const FAKE = { provider: 'fake', overrideKey: 'FAKEKEY-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF' };

const planOnce = (w, ids) =>
  w.A(
    'trip.plan',
    Object.assign(
      { placeIds: ids, startAt: '2026-10-20T01:00:00.000Z', constraints: [], startPoint: null },
      FAKE
    )
  );

test('规划一次，每次地图调用都记下一条「直线 vs 实际」样本', async () => {
  const w = await makeWorld();
  const before = await w.repo.count(C.WALK_SAMPLES, {});

  const res = expectOk(await planOnce(w, ['p_zhongyang', 'p_fanghong', 'p_sofia']));
  const calls = res.walkTimes.mapApiCalls;
  const after = await w.repo.count(C.WALK_SAMPLES, {});

  assert.ok(calls > 0, '这次规划应当真的调了地图接口，否则样本无从产生');
  assert.equal(after - before, calls, `记了 ${after - before} 条，但有 ${calls} 次地图调用 —— 每调一次就该有一条`);
});

test('样本里必须同时有直线距离、实际距离和倍率', async () => {
  const w = await makeWorld();
  await planOnce(w, ['p_zhongyang', 'p_fanghong', 'p_sofia']);

  const rows = await w.repo.find(C.WALK_SAMPLES, {});
  assert.ok(rows.length >= 1, '必须有样本');

  for (const s of rows) {
    assert.equal(typeof s.straightMeters, 'number');
    assert.equal(typeof s.actualMeters, 'number');
    assert.ok(s.straightMeters > 0, '直线距离为 0 的样本无法算倍率');
    /**
     * 倍率是**模型要预测的目标** —— 它算错的话，训练数据全废，
     * 而且不会有任何报错。
     */
    const want = Number((s.actualMeters / s.straightMeters).toFixed(3));
    assert.equal(s.detourRatio, want, '倍率必须等于 实际÷直线');
    assert.ok(s.fromName && s.toName, '要能看出是哪一段，便于排查异常样本');
  }
});

test('取不到路线时**不记样本** —— 失败不能变成训练数据', async () => {
  const w = await makeWorld();
  // 起终点相同会被上游拒绝（与 map.probe 的 ③ 一致）
  const res = await w.A(
    'trip.plan',
    Object.assign(
      {
        places: [
          { name: '同一个地方', location: { latitude: 45.7756, longitude: 126.6175 } },
          { name: '同一个地方', location: { latitude: 45.7756, longitude: 126.6175 } },
        ],
        startAt: '2026-10-20T01:00:00.000Z',
        constraints: [],
        startPoint: null,
      },
      FAKE
    )
  );
  const rows = await w.repo.find(C.WALK_SAMPLES, {});
  for (const s of rows) {
    assert.ok(s.actualMeters > 0, '不该把失败的调用记成样本');
  }
  assert.ok(res.ok === true || res.error, '规划本身不该因此崩掉');
});

test('ops.walkStats：样本少时如实说"不足以判断"，不给建议系数', async () => {
  const w = await makeWorld();
  await planOnce(w, ['p_zhongyang', 'p_fanghong', 'p_sofia']);

  const d = expectOk(await w.A('ops.walkStats', {}));
  assert.equal(d.kind, 'walkStats');
  assert.equal(d.currentConstant, 1.3, '报告要对照现在产品用的那个常数');
  assert.match(d.verdict, /不足以判断/);
  for (const b of d.buckets) {
    if (b.count < 5) {
      assert.equal(b.suggestedFactor, null, `${b.label} 只有 ${b.count} 条，不该给建议系数`);
      assert.equal(b.insufficient, true);
    }
  }
  assert.match(d.note, /先打败.*分段常数|分段常数/);
});

test('ops.walkStats：空库不抛异常', async () => {
  const w = await makeWorld();
  const d = expectOk(await w.A('ops.walkStats', {}));
  assert.equal(d.usableSamples, 0);
  assert.equal(d.overallMedianRatio, null);
  assert.equal(d.buckets.length, 6, '区间表是固定的，空库也要给出来');
  assert.match(d.verdict, /不足以判断/);
});

test('ops.walkStats 的分桶不重不漏', async () => {
  const w = await makeWorld();
  /**
   * ⚠️ 直线距离为 **0** 的样本会被 `usable` 过滤掉 —— 它算不出倍率（除以零），
   * 留着只会污染统计。所以这里从 1 米起算，并单独断言 0 被排除。
   */
  const edges = [1, 50, 100, 250, 300, 500, 600, 900, 1000, 1500, 2000, 5000];
  for (const m of edges) {
    await w.repo.insert(C.WALK_SAMPLES, {
      straightMeters: m,
      actualMeters: Math.round(m * 1.3),
      actualMinutes: 1,
      detourRatio: 1.3,
      fromName: 'A',
      toName: 'B',
      sampledAt: new Date('2026-10-13T00:00:00Z'),
    });
  }
  // 一条直线为 0 的脏数据：不该进入统计
  await w.repo.insert(C.WALK_SAMPLES, {
    straightMeters: 0,
    actualMeters: 40,
    actualMinutes: 1,
    detourRatio: null,
    fromName: 'A',
    toName: 'B',
    sampledAt: new Date('2026-10-13T00:00:00Z'),
  });

  const d = expectOk(await w.A('ops.walkStats', {}));
  assert.equal(d.totalSamples, edges.length + 1, '库里确实有这么多条');
  assert.equal(d.usableSamples, edges.length, '直线为 0 的那条要被排除在统计之外');

  const total = d.buckets.reduce((n, b) => n + b.count, 0);
  assert.equal(total, edges.length, `分桶把样本弄丢了：${total} ≠ ${edges.length}`);

  const find = (label) => d.buckets.find((b) => b.label.indexOf(label) === 0);
  assert.equal(find('0–100').count, 2, '1 和 50');
  assert.equal(find('100–300').count, 2, '100 和 250（左闭右开，100 归这一档）');
  assert.equal(find('300–600').count, 2, '300 和 500');
  assert.equal(find('600–1000').count, 2, '600 和 900');
  assert.equal(find('1000–2000').count, 2, '1000 和 1500');
  assert.equal(find('2000 米以上').count, 2, '2000 和 5000');
});

test('ops.walkStats：倍率的离群值不该带偏结论（用中位数）', async () => {
  const w = await makeWorld();
  // 9 条正常 + 1 条离谱（上游偶尔会返回奇怪的值）
  for (let i = 0; i < 9; i++) {
    await w.repo.insert(C.WALK_SAMPLES, {
      straightMeters: 500,
      actualMeters: 650,
      actualMinutes: 8,
      detourRatio: 1.3,
      fromName: 'A',
      toName: 'B',
      sampledAt: new Date('2026-10-13T00:00:00Z'),
    });
  }
  await w.repo.insert(C.WALK_SAMPLES, {
    straightMeters: 500,
    actualMeters: 50000, // 100 倍
    actualMinutes: 600,
    detourRatio: 100,
    fromName: 'A',
    toName: 'B',
    sampledAt: new Date('2026-10-13T00:00:00Z'),
  });

  const d = expectOk(await w.A('ops.walkStats', {}));
  const b = d.buckets.find((x) => x.label.indexOf('300–600') === 0);
  assert.equal(b.count, 10);
  assert.equal(b.suggestedFactor, 1.3, '中位数应当无视那条 100 倍的离群值');
  assert.equal(d.overallMedianRatio, 1.3);
});

test('样本写入失败不该让整次规划失败', async () => {
  const w = await makeWorld();
  const realInsert = w.repo.insert.bind(w.repo);
  w.repo.insert = (coll, doc) => {
    if (coll === C.WALK_SAMPLES) return Promise.reject(new Error('模拟写失败'));
    return realInsert(coll, doc);
  };

  const res = await planOnce(w, ['p_zhongyang', 'p_fanghong', 'p_sofia']);
  assert.equal(res.ok, true, '攒数据失败不能影响规划本身');
  /**
   * ⚠️ `planOnce` 返回的是**完整响应** `{ok, data}` —— 字段在 `data` 下面。
   * 首版写成 `res.walkTimes`，于是拿到 undefined，
   * 而 `undefined.sampleWriteFailed` 抛的错**看起来像功能坏了**，
   * 其实是测试自己找错了地方。
   */
  assert.equal(
    res.data.walkTimes.sampleWriteFailed >= 1,
    true,
    '必须记下写失败，不能悄悄吞掉'
  );
  assert.equal(res.data.walkTimes.samplesRecorded, 0, '写失败就不该算记上了');
});

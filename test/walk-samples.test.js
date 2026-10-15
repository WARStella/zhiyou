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

test('样本必须带上**多维情境** —— 用户提醒后补的这一块', async () => {
  /**
   * 用户原话："不应该是结合出行方式、天气、时间段、路途距离、出行时间
   * 这样多维的数据集吗？" —— 首版只记了两个数值，确实窄了。
   */
  const w = await makeWorld();
  await planOnce(w, ['p_zhongyang', 'p_fanghong', 'p_sofia']);

  const rows = await w.repo.find(C.WALK_SAMPLES, {});
  assert.ok(rows.length >= 1);
  const s = rows[0];

  assert.equal(s.mode, 'walking', '出行方式是分类特征，首版恒为步行');
  assert.equal(s.weather, null, '**天气只能由用户说，系统不猜** —— 现在如实是 null');
  /**
   * ⚠️ 时段取自**行程出发时刻**，不是"规划发生的时刻"。
   * 用 `now` 的话所有样本都会落在同一小时，这个维度就**看起来有值、
   * 其实没有信息量**。
   */
  assert.ok(
    ['night', 'morning', 'noon', 'afternoon', 'evening'].includes(s.timeBucket),
    `timeBucket 不合法：${s.timeBucket}`
  );
  assert.equal(typeof s.weekday, 'number');
  assert.ok(s.weekday >= 0 && s.weekday <= 6);
  assert.ok(s.fromId && s.toId, '要能按地点对回填标签');
});

test('预测与真实必须分开存 —— 拿预测当标签是循环论证', async () => {
  /**
   * 腾讯返回的 `duration` 是**预测值**。用它当训练标签，
   * 等于用地图的预测去训练模型预测地图的预测 —— 永远学不到真实世界。
   * 所以两个字段必须分开，且 `actualMinutes` **一开始是空的**。
   */
  const w = await makeWorld();
  await planOnce(w, ['p_zhongyang', 'p_fanghong', 'p_sofia']);

  const s = (await w.repo.find(C.WALK_SAMPLES, {}))[0];
  assert.ok(s.providerDurationSeconds > 0, '地图的预测值作为**特征**存下来（秒）');
  assert.equal(s.observedDurationSeconds, null, '**真实用时一开始必须是空的** —— 用户还没走');
  assert.equal(s.actualMinutes, null, '兼容字段同样为空');
  assert.equal(s.labeledAt, null);
});

// ── 字段口径与分组（2026-10-15 整理）──────────────────────

test('样本字段：新旧名同时写、值一致，且带 schemaVersion 与路线组键', async () => {
  /**
   * ⚠️ 旧名 `actualMeters` 会**误导**：它一直是"地图返回的路径距离"，
   * 不是"真人实际走的距离"。所以新名叫 `providerRouteMeters`，
   * 并**双写**过渡 —— 迁移期两种样本都要能读（读的一侧见 lib/walk-eval.js）。
   */
  const w = await makeWorld();
  await planOnce(w, ['p_zhongyang', 'p_fanghong', 'p_sofia']);
  const rows = await w.repo.find(C.WALK_SAMPLES, {});
  assert.ok(rows.length >= 1);

  for (const s of rows) {
    assert.equal(s.schemaVersion, 2, '字段口径变了就提版本，否则离线分析会悄悄错位');
    assert.ok(s.sampleId, '样本要有自己的 id：不依赖数据库 _id，也不必多写一次库');
    assert.equal(s.providerRouteMeters, s.actualMeters, '新名与兼容名必须是同一个值');
    assert.equal(
      s.providerDurationSeconds,
      Math.round(s.predictedMinutes * 60),
      '耗时统一存秒，兼容名是分钟'
    );
    assert.equal(s.upstreamDurationUnit, 'minutes', '上游单位要写下来，不靠记忆');
    assert.equal(s.qualityStatus, 'ok');
    assert.equal(s.excludedReason, null);
    assert.equal(s.cacheHit, false, '命中缓存的段不产生样本 —— 这个字段让该偏差可被核对');
    assert.ok(s.provider, '记下来源，便于核对"这条是怎么来的"');
    assert.ok(s.fetchedAt);
    /**
     * 分组键必须在写入时算好，且规则与读入口一致
     * （`sorted(fromId, toId)`，反向自动合并）。
     */
    assert.equal(s.routeGroupId, [s.fromId, s.toId].sort().join('|'));
  }
});

test('命中缓存的段**不产生样本** —— 这是样本集的抽样偏差，必须写下来', async () => {
  /**
   * 这条测试本来是想验证"重复规划产生多组记录"，结果**第一次跑就红了** ——
   * 因为第二次规划的路段全部命中 `walkableTo` 缓存，**一次地图调用都没有**，
   * 于是**一条样本都没记**。
   *
   * 红的不是实现，是**我的假设**。而它暴露的是一件必须写进文档的事：
   *
   *   > 样本集**系统性偏向"没缓存过的路线"**（新路线、跨区路线），
   *   > 反复走的熟路一条样本都不贡献。
   *
   * 这不是缺陷（缓存本来就是对的），但它是**抽样偏差** ——
   * 评测与答辩时都要说明，否则"我们有 300 条样本"会被误读成"覆盖了 300 段路"。
   */
  const w = await makeWorld();
  const ids = ['p_zhongyang', 'p_fanghong', 'p_sofia'];

  const first = expectOk(await planOnce(w, ids));
  assert.ok(first.walkTimes.mapApiCalls > 0, '第一次规划必须真的调了地图接口');
  const rows1 = await w.repo.find(C.WALK_SAMPLES, {});
  assert.equal(rows1.length, first.walkTimes.mapApiCalls, '每调一次地图接口记一条样本');

  const second = expectOk(await planOnce(w, ids));
  assert.equal(second.walkTimes.mapApiCalls, 0, '第二次规划应当全部命中缓存');
  const rows2 = await w.repo.find(C.WALK_SAMPLES, {});
  assert.equal(rows2.length, rows1.length, '命中缓存不产生样本 —— 这条偏差是可核对的（cacheHit 字段）');
});

test('清掉缓存后再规划：同一条路得到**同一个路线组**，不产生新路线', async () => {
  /**
   * 上一条说明了"熟路不产生样本"。这条把缓存清掉再走一遍，
   * 验证真正要守的东西：**同一条路的多次记录必须落在同一个组**。
   *
   * 这是 2026-10-15 修的那个缺陷的另一半 —— 按记录切分时，
   * 同一条路的多条记录会同时进开发集与冻结集，分数偏乐观且不报错。
   */
  const w = await makeWorld();
  const ids = ['p_zhongyang', 'p_fanghong', 'p_sofia'];

  await planOnce(w, ids);
  const rows1 = await w.repo.find(C.WALK_SAMPLES, {});
  const groups1 = new Set(rows1.map((s) => s.routeGroupId));
  assert.ok(rows1.length > 0 && groups1.size > 0);

  // 清掉库内地点的步行缓存 → 下一次规划会重新调地图接口
  const places = await w.repo.find(C.PLACES, {});
  for (const p of places) await w.repo.update(C.PLACES, p._id, { walkableTo: [] });

  const again = expectOk(await planOnce(w, ids));
  assert.ok(again.walkTimes.mapApiCalls > 0, '清掉缓存后应当重新调接口');

  const rows2 = await w.repo.find(C.WALK_SAMPLES, {});
  assert.ok(rows2.length > rows1.length, '样本应当增加');

  const groups2 = new Set(rows2.map((s) => s.routeGroupId));
  /**
   * ⚠️ 断言的是**键的稳定性**，不是"两轮组集合相等"。
   *
   * 第一次跑这条时红了：清缓存把**夹具里预置的那条缓存也清掉了**，
   * 于是第二轮多调了一段接口、多出一个组 —— 集合当然不相等。
   * 而真正要守的是：**同一条路在两轮里必须得到同一个键**
   * （键一变，切分就把它当两条路线，泄漏又回来了）。
   */
  for (const g of groups1) {
    assert.ok(groups2.has(g), `第一轮的组 ${g} 在第二轮必须仍是同一个键`);
  }
  for (const s of rows2) {
    assert.equal(s.routeGroupId, [s.fromId, s.toId].sort().join('|'), '组键规则必须两轮一致');
  }

  const perGroup = new Map();
  for (const s of rows2) perGroup.set(s.routeGroupId, (perGroup.get(s.routeGroupId) || 0) + 1);
  for (const g of groups1) {
    assert.ok(perGroup.get(g) >= 2, `组 ${g} 应当有至少 2 条（规划了两轮）`);
  }
});

test('时段函数：按北京时间分档，夜里归到 night', () => {
  const { bucketOf } = require('../cloudfunctions/api/lib/time');
  const at = (h) => new Date(Date.UTC(2026, 9, 13, h - 8, 0, 0)); // 北京 h 点
  assert.equal(bucketOf(at(0)), 'night');
  assert.equal(bucketOf(at(5)), 'night');
  assert.equal(bucketOf(at(8)), 'morning');
  assert.equal(bucketOf(at(13)), 'noon');
  assert.equal(bucketOf(at(15)), 'afternoon');
  assert.equal(bucketOf(at(19)), 'evening');
  assert.equal(bucketOf(at(23)), 'night');
  assert.equal(bucketOf(null), 'unknown', '无效时间不能抛异常');
  assert.equal(bucketOf('乱七八糟'), 'unknown');
});

// ── 标签回填：真实用时的唯一来源 ──────────────────────────

test('走完一段之后，样本被回填真实用时', async () => {
  const w = await makeWorld();
  const plan = expectOk(await planOnce(w, ['p_zhongyang', 'p_fanghong', 'p_sofia']));

  /**
   * ⚠️ 用**真有样本的那一段**，不是第一段。
   *
   * 原因：样本只在**真的调了地图接口**时记录。中央大街→防洪纪念塔
   * 在夹具里有 `walkableTo` 缓存，不走接口，**也就没有样本可标**。
   * 这是当前设计的真实边界 —— 首版测试用了第一段，
   * 于是"必须被回填"必然失败，**而失败原因不在实现上**。
   */
  const samples = await w.repo.find(C.WALK_SAMPLES, {});
  assert.ok(samples.length >= 1, '这次规划应当至少产生一条样本');
  const pairs = samples.map((s) => `${s.fromId}->${s.toId}`);
  const segIdx = plan.nodes.findIndex(
    (n, i) => i > 0 && pairs.includes(`${plan.nodes[i - 1].placeId}->${n.placeId}`)
  );
  assert.ok(segIdx > 0, `找不到有样本的段；样本在 ${pairs.join(', ')}`);

  /**
   * ⚠️ 两个坑，都是实测撞出来的：
   *
   * ① 不能连点两次 progress —— 相隔几毫秒，`diffMin` 得 **0**，
   *    实现按"非正数不标注"跳过。**那是正确行为**（0 分钟的标签没信息量）。
   * ② **`progress` 会用 `now` 覆盖 `actualArriveAt`** ——
   *    所以不能往节点里注入一个"未来的到达时刻"，那会造成时间倒挂，
   *    同样被跳过。只能把**上一站的离开时刻**设成过去。
   */
  const leaveAt = new Date(Date.now() - 20 * 60 * 1000); // 20 分钟前

  const trip = await w.repo.get(C.TRIPS, plan.tripId);
  const patched = trip.nodes.map((n, i) =>
    i === segIdx - 1
      ? Object.assign({}, n, { status: 'done', actualArriveAt: leaveAt, actualLeaveAt: leaveAt })
      : n
  );
  const newVer = (trip.version || 1) + 1;
  await w.repo.update(C.TRIPS, plan.tripId, { nodes: patched, version: newVer });

  expectOk(
    await w.A(
      'trip.progress',
      { tripId: plan.tripId, nodeId: plan.nodes[segIdx].nodeId, status: 'arrived' },
      { expectedVersion: newVer }
    )
  );

  const target = samples.find(
    (s) =>
      s.fromId === plan.nodes[segIdx - 1].placeId && s.toId === plan.nodes[segIdx].placeId
  );
  const after = await w.repo.get(C.WALK_SAMPLES, target._id);

  /**
   * ⚠️ 断言**关系**，不写死数字。
   *
   * `trip.progress` 用的 `now` 来自测试世界的时钟（**不是**真实墙上时间），
   * 所以"20 分钟"这种写死的期望必然对不上 —— 而失败原因又不在实现上。
   * 要验的是那个定义：`到达 − 上一站实际离开`。
   */
  const t2 = await w.repo.get(C.TRIPS, plan.tripId);
  const arriveAt = new Date(t2.nodes[segIdx].actualArriveAt);
  const expectedMin = Math.round((arriveAt.getTime() - leaveAt.getTime()) / 60000);

  assert.ok(expectedMin > 0, '造出来的时间间隔必须是正的，否则这条测试是空的');
  assert.equal(after.actualMinutes, expectedMin, '真实用时 = 到达 − 上一站实际离开');
  assert.equal(
    after.observedDurationSeconds,
    expectedMin * 60,
    '新字段存**秒** —— 同一个量两个单位，必须同时写、且换算一致'
  );
  assert.equal(
    Number.isInteger(after.actualMinutes),
    true,
    '**标签必须是整数分钟** —— diffMin 返回小数，存进去既没意义又撑大 JSON'
  );
  assert.ok(after.labeledAt, '要记下什么时候标的，便于排查');
  assert.equal(after.predictedMinutes != null, true, '预测值保留不动 —— 它是特征，不是标签');
});

test('首段没有"上一节点的实际离开"→ **保持未标注**，不用计划时间冒充', async () => {
  /**
   * 第一个节点的样本没有可信的起点。用 `plannedStartAt` 冒充实际出发时刻，
   * 会往训练集里灌一批"看起来有值、其实是计划"的脏标签。
   * **宁可少一条，不要脏一条。**
   */
  const w = await makeWorld();
  const plan = expectOk(await planOnce(w, ['p_zhongyang', 'p_fanghong', 'p_sofia']));

  expectOk(
    await w.A(
      'trip.progress',
      { tripId: plan.tripId, nodeId: plan.nodes[0].nodeId, status: 'arrived' },
      { expectedVersion: plan.version }
    )
  );

  const rows = await w.repo.find(C.WALK_SAMPLES, {});
  assert.equal(
    rows.every((r) => r.actualMinutes == null),
    true,
    '首段到达不该回填任何标签 —— 没有可信的起始时刻'
  );
});

test('时间倒挂（到达早于离开）→ 不标注', async () => {
  const w = await makeWorld();
  const plan = expectOk(await planOnce(w, ['p_zhongyang', 'p_fanghong', 'p_sofia']));

  // 手工造一个"离开时刻在将来"的节点，制造倒挂
  const trip = await w.repo.get(C.TRIPS, plan.tripId);
  const nodes = trip.nodes.map((n, i) =>
    i === 0
      ? Object.assign({}, n, {
          status: 'done',
          actualArriveAt: new Date('2026-10-20T05:00:00Z'),
          actualLeaveAt: new Date('2099-01-01T00:00:00Z'), // 未来
        })
      : n
  );
  await w.repo.update(C.TRIPS, plan.tripId, { nodes, version: (trip.version || 1) + 1 });

  expectOk(
    await w.A(
      'trip.progress',
      { tripId: plan.tripId, nodeId: plan.nodes[1].nodeId, status: 'arrived' },
      { expectedVersion: (trip.version || 1) + 1 }
    )
  );

  const rows = await w.repo.find(C.WALK_SAMPLES, {});
  assert.equal(
    rows.every((r) => r.actualMinutes == null),
    true,
    '倒挂时硬算会得到一个负标签，那比没有标签坏得多'
  );
});

test('回填失败不该让记录进度失败', async () => {
  const w = await makeWorld();
  const plan = expectOk(await planOnce(w, ['p_zhongyang', 'p_fanghong', 'p_sofia']));

  const doneRes = expectOk(
    await w.A(
      'trip.progress',
      { tripId: plan.tripId, nodeId: plan.nodes[0].nodeId, status: 'done' },
      { expectedVersion: plan.version }
    )
  );
  const verAfterDone = doneRes.version;

  const realFind = w.repo.find.bind(w.repo);
  w.repo.find = (coll, q, o) => {
    if (coll === C.WALK_SAMPLES) return Promise.reject(new Error('模拟查询失败'));
    return realFind(coll, q, o);
  };

  const res = await w.A(
    'trip.progress',
    { tripId: plan.tripId, nodeId: plan.nodes[1].nodeId, status: 'arrived' },
    { expectedVersion: verAfterDone }
  );
  assert.equal(res.ok, true, '攒数据出问题不能影响用户记录进度');
});

// ── 校准报告 ──────────────────────────────────────────────

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

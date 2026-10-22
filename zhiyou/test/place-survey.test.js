'use strict';

/**
 * 踏勘录入与**三级核验**的回归测试。
 *
 * 背景（2026-10-14 决定）：
 * 本队只来得及实地核验一两个点，撑不起 8–12 个地点的集合点候选池。
 * 于是集合点准入门槛从"必须有 verifiedAt"改成**三级**：
 *
 *   field-survey  已实地核验      → 最高可信，可作集合点
 *   aggregated    三方聚合        → 可作集合点，但**必须标注未实地核验**
 *   none          仅行程节点      → 不能作集合点
 *
 * 这组测试要守住的不是"字段写对了"，而是**等级不会被冒充**：
 * 三方数据不能自己声称已核验（§6.6「检索到资料 ≠ 资料可信」）。
 *
 * 同时守住旧行为不回归：只填 verifiedAt 的旧记录仍然能当集合点 ——
 * 这次改判据不该让任何一条既有数据突然失效。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, expectOk, expectFail, C } = require('./helpers');
const { canBeMeetingPoint, canBeTripNode, verificationLevelOf, VERIFICATION_LABEL } = require('../cloudfunctions/api/lib/authz');

const HB = { latitude: 45.7756, longitude: 126.6175 };

test('place.survey 仅限 dev —— 这是可信度层的输入，不能被生产环境写脏', async () => {
  const w = await makeWorld({ env: 'prod' });
  expectFail(
    await w.A('place.survey', { name: '某某广场', location: HB, category: 'meeting', confirm: true }),
    'FORBIDDEN_ENV'
  );
});

test('踏勘录入写入后，集合点准入确实生效（不只是"字段写进去了"）', async () => {
  const w = await makeWorld();
  const created = expectOk(
    await w.A('place.survey', {
      name: '索菲亚广场东侧入口',
      location: HB,
      category: 'meeting',
      visitDurationMin: { min: 10, default: 15, max: 30 },
      confidence: 'high',
      dataSource: 'survey',
      confirm: true,
    })
  );

  assert.equal(created.mode, 'create');
  // 缺省视为本次踏勘即核验：录入者忘了传 verifiedAt 也不该得到一条"永远不出现"的记录
  assert.ok(created.place.verifiedAt, '未传 verifiedAt 时应缺省为本次核验时间');
  assert.equal(created.eligibility.meetingPoint, true);
  assert.equal(created.eligibility.verificationLevel, 'field-survey');

  // 关键：不是看返回值，而是看**真正读库的那条记录**能不能过准入
  const stored = await w.repo.get(C.PLACES, created.place._id);
  assert.equal(canBeMeetingPoint(stored), true);
  assert.equal(canBeTripNode(stored), true);
});

test('上游的 lat/lng 会被规范成 latitude/longitude —— 否则会得到"有坐标却判为缺坐标"的记录', async () => {
  const w = await makeWorld();
  const created = expectOk(
    await w.A('place.survey', {
      name: '规范坐标测试点',
      // 上游（腾讯/高德）返回的是 lat/lng；authz.hasCoordinate 读的是 latitude/longitude
      location: { lat: 45.781, lng: 126.6185 },
      entranceLocation: { lat: 45.7811, lng: 126.6186 },
      category: 'meeting',
      confidence: 'high',
      confirm: true,
    })
  );

  const stored = await w.repo.get(C.PLACES, created.place._id);
  assert.deepEqual(stored.location, { latitude: 45.781, longitude: 126.6185 });
  assert.deepEqual(stored.entranceLocation, { latitude: 45.7811, longitude: 126.6186 });
  assert.equal(canBeTripNode(stored), true, '规范之后必须能被判为"有坐标"');
});

test('非法坐标被拒绝，且**不落库**', async () => {
  const w = await makeWorld();
  const before = await w.repo.count(C.PLACES, {});
  expectFail(
    await w.A('place.survey', {
      name: '坏坐标点',
      location: { latitude: 999, longitude: 126.6 },
      category: 'meeting',
      confirm: true,
    }),
    'INVALID_PARAM'
  );
  expectFail(
    await w.A('place.survey', { name: '缺坐标点', location: { latitude: 45.7 }, category: 'meeting', confirm: true }),
    'INVALID_PARAM'
  );
  assert.equal(await w.repo.count(C.PLACES, {}), before, '参数校验失败不得写入任何记录');
});

test('三级核验：三方聚合可作集合点，但**等级必须如实标为未实地核验**', async () => {
  const w = await makeWorld();
  const created = expectOk(
    await w.A('place.survey', {
      name: '三方聚合的集合点',
      location: { latitude: 45.79, longitude: 126.63 },
      category: 'meeting',
      confidence: 'medium',
      dataSource: 'aggregated',
      // 现实约束：没去过现场，但三方数据+照片足以支持它当集合点
      meetingPointEligible: true,
      confirm: true,
    })
  );

  const stored = await w.repo.get(C.PLACES, created.place._id);
  assert.equal(canBeMeetingPoint(stored), true, '三方聚合应当能当集合点');
  assert.equal(verificationLevelOf(stored), 'aggregated');
  assert.equal(created.eligibility.verificationLevel, 'aggregated');
  assert.equal(created.eligibility.verificationLabel, '未实地核验 · 三方聚合');

  /**
   * ⚠️ 这条是整组测试里最重要的一条断言。
   * `verified` 只表示"**实地**核验过" —— 三方聚合不算。
   * 如果它变成 true，界面就会把三方数据当已核验展示，那正是 §6.6 要防的事。
   */
  assert.equal(created.eligibility.verified, false, '三方聚合绝不能声称已实地核验');
  assert.equal(stored.verifiedAt, undefined, '未实地核验的记录不得带 verifiedAt');
});

test('三方聚合与实地核验不能同时成立 —— 防的是"看起来已核验，其实只有三方数据"', async () => {
  const w = await makeWorld();
  expectFail(
    await w.A('place.survey', {
      name: '自相矛盾的点',
      location: { latitude: 45.795, longitude: 126.635 },
      category: 'meeting',
      confidence: 'high',
      meetingPointEligible: true,
      verifiedAt: '2026-10-14T00:00:00.000Z', // ← 同时声称去过现场
      confirm: true,
    }),
    'INVALID_PARAM'
  );
});

test('只给坐标、不给任何核验依据 → **仍可作集合点**，但等级如实标为"无核验数据"', async () => {
  /**
   * ⚠️ 这条断言**改过方向**（2026-10-14），是用户决定放宽准入的结果。
   *
   * 用户原话："推荐集合点不需要实地核验，腾讯地图基本核验过"
   *
   * 旧规则要求"实地核验 **或** 显式 `meetingPointEligible`"，
   * 而后者**只有 `place.survey` 会写**、且限 dev —— 于是线上路径里
   * 没有任何代码能把地点标成"可作集合点"，`meet.recommend`
   * 面对近乎空的 `places` 永远报 `NO_VERIFIED_PLACE`。
   * **功能从上线起就不可能跑通。**
   *
   * 现在与行程节点同一套准入（名称 + 坐标）。
   *
   * ⚠️ 但**准入放宽 ≠ 标注放宽**：`verificationLevel` 照旧如实推导，
   *    这个点仍然是 `none`（无核验数据），界面必须标出来。
   *    准入与标注是两件事 —— §6.6「检索到资料 ≠ 资料可信」。
   */
  const w = await makeWorld();
  const created = expectOk(
    await w.A('place.survey', {
      name: '只够当节点的点',
      location: { latitude: 45.796, longitude: 126.636 },
      category: 'meeting',
      confidence: 'high',
      verifiedAt: null,
      confirm: true,
    })
  );

  const stored = await w.repo.get(C.PLACES, created.place._id);
  assert.equal(canBeTripNode(stored), true, '有名称有坐标就够作行程节点');
  assert.equal(canBeMeetingPoint(stored), true, '放宽后也能作集合点');
  /** 关键：能用，但必须如实标注"没核验过" */
  assert.equal(verificationLevelOf(stored), 'none', '等级要如实 —— 它确实没有任何核验依据');
  assert.equal(VERIFICATION_LABEL[verificationLevelOf(stored)], '无核验数据');
});

test('**显式否决**仍然一票否决 —— 放宽不等于忽略明确判定', async () => {
  /**
   * ⚠️ 这是放宽之后**唯一**还能挡住一个地点的开关。
   *
   * `meetingPointEligible === false` 表示"有人明确判定过这个点当集合点有问题"
   * （比如入口在施工、或者根本进不去）——那种判定不能被"放宽准入"盖掉。
   */
  const w = await makeWorld();
  const created = expectOk(
    await w.A('place.survey', {
      name: '明确不适合集合的点',
      location: { latitude: 45.7965, longitude: 126.6365 },
      category: 'meeting',
      confidence: 'high',
      meetingPointEligible: false,
      confirm: true,
    })
  );
  const stored = await w.repo.get(C.PLACES, created.place._id);
  assert.equal(canBeMeetingPoint(stored), false, '显式否决要挡住');
});

test('confidence 为 low 时不得作集合点 —— "推荐"这个词要有意义', async () => {
  const w = await makeWorld();
  const created = expectOk(
    await w.A('place.survey', {
      name: '低可信度的点',
      location: { latitude: 45.797, longitude: 126.637 },
      category: 'meeting',
      confidence: 'low',
      meetingPointEligible: true, // 就算显式开了开关
      confirm: true,
    })
  );
  const stored = await w.repo.get(C.PLACES, created.place._id);
  assert.equal(canBeMeetingPoint(stored), false, 'low 可信度即使显式开关也不得进推荐');
});

test('旧数据不回归：只填 verifiedAt 的记录仍然能当集合点', async () => {
  const w = await makeWorld();
  // 夹具里的地点就是"旧格式"：有 verifiedAt、没有 meetingPointEligible
  const legacy = await w.repo.get(C.PLACES, 'p_fanghong');
  assert.equal(legacy.meetingPointEligible, undefined);
  assert.equal(canBeMeetingPoint(legacy), true, '改判据不得让既有数据失效');
  assert.equal(verificationLevelOf(legacy), 'field-survey');
});

test('**显式否决**的地点会被排除，且排除原因带地点名（界面要能挂在地点上）', async () => {
  /**
   * ⚠️ 触发条件**改过**（2026-10-14）：放宽准入之后，"只够作行程节点"
   * 已经不再是被排除的理由，能挡住一个地点的只剩**显式否决**
   * （`meetingPointEligible: false`，即有人明确判定过它当集合点有问题）。
   *
   * 这条测试真正守的是**排除通路本身**：被排除的地点必须出现在
   * `excluded` 里并带上**地点名** —— 否则用户只会看到"候选里没有它"，
   * 而不知道为什么（10/31 验收「失败原因可定位」）。
   */
  const w = await makeWorld();
  const ineligible = expectOk(
    await w.A('place.survey', {
      name: '不可当集合点的点',
      location: { latitude: 45.776, longitude: 126.6174 },
      category: 'meeting',
      confidence: 'high',
      meetingPointEligible: false, // 显式否决 —— 放宽之后唯一的排除理由
      confirm: true,
    })
  );

  /**
   * 单人小队。
   *
   * `meet.recommend` 的成员位置是"**任一成员**缺位置就整体不出候选"（MEMBER_NO_LOCATION），
   * 两人队会把每个候选都排除掉，测不出准入过滤本身。
   */
  await w.A('user.login', {});
  const crew = expectOk(await w.A('crew.create', { name: '准入测试小队', shareLocationDefault: true }));
  await require('./helpers').enableLocation(w, 'A', crew.crewId);
  expectOk(
    await w.A('loc.report', {
      crewId: crew.crewId,
      point: { latitude: 45.7756, longitude: 126.6175 },
      source: 'manual',
    })
  );

  const rec = expectOk(await w.A('meet.recommend', { crewId: crew.crewId }));
  const ids = (rec.candidates || []).map((c) => c.placeId);
  assert.ok(!ids.includes(ineligible.place._id), '未达集合点准入的地点不得出现在候选里');

  const why = (rec.excluded || []).find((e) => e.placeId === ineligible.place._id);
  assert.ok(why, '被排除的地点必须出现在 excluded 里 —— 否则用户只会看到"候选里没有它"');
  assert.equal(why.reason, 'PLACE_NOT_MEETING_POINT');
  assert.equal(why.placeName, '不可当集合点的点', '排除信息必须带地点名，界面才能把它挂在地点上');
  assert.ok(!/p_/.test(why.placeName || ''), '不得把内部 id 当成展示名');

  // 证明"过滤的是准入，不是把所有人都滤掉"
  assert.ok(ids.includes('p_fanghong'), '已核验的集合点候选必须仍然可用');
});

test('更新模式：按 placeId 补录核验信息，且不影响其他字段', async () => {
  const w = await makeWorld();
  const before = await w.repo.get(C.PLACES, 'p_laodaowai');
  assert.equal(before.entranceLocation, null, '前提：这个点的入口位置是空的');

  const updated = expectOk(
    await w.A('place.survey', {
      placeId: 'p_laodaowai',
      entranceLocation: { latitude: 45.7571, longitude: 126.6421 },
      dataSource: 'survey',
      confidence: 'high',
    })
  );

  assert.equal(updated.mode, 'update');
  const after = await w.repo.get(C.PLACES, 'p_laodaowai');
  assert.deepEqual(after.entranceLocation, { latitude: 45.7571, longitude: 126.6421 });
  assert.equal(after.name, before.name, '未传的字段不得被覆盖');
  assert.deepEqual(after.walkableTo, before.walkableTo, '未传的数组不得被清空');
  assert.equal(after.eligibility, undefined, 'eligibility 只应出现在响应体里，不该写进记录');
  assert.equal(updated.eligibility.meetingPoint, true);
});

test('更新不存在的 placeId 报 NOT_FOUND，不静默新建', async () => {
  const w = await makeWorld();
  expectFail(
    await w.A('place.survey', { placeId: 'p_does_not_exist', confidence: 'high' }),
    'NOT_FOUND'
  );
});

test('walkableTo 的 source 不得缺省 —— 估算被当成实测是这条链上最贵的错误', async () => {
  const w = await makeWorld();
  const created = expectOk(
    await w.A('place.survey', {
      name: '步行记录测试点',
      location: { latitude: 45.799, longitude: 126.639 },
      category: 'meeting',
      confidence: 'high',
      walkableTo: [
        { placeId: 'p_zhongyang', walkMin: 8, walkMeters: 620 }, // 不传 source
        { placeId: 'p_sofia', walkMin: 9, source: 'upstream' },
      ],
      confirm: true,
    })
  );

  const stored = await w.repo.get(C.PLACES, created.place._id);
  assert.equal(stored.walkableTo[0].source, 'survey', '从踏勘入口进来的缺省为实测');
  assert.equal(stored.walkableTo[1].source, 'upstream', '显式声明的来源必须保留');

  expectFail(
    await w.A('place.survey', {
      placeId: created.place._id,
      walkableTo: [{ placeId: 'p_sofia', walkMin: 5, source: 'guessed' }],
    }),
    'INVALID_PARAM'
  );
});

test('照片：verified 由来源推导，不接受调用方自报', async () => {
  const w = await makeWorld();
  const created = expectOk(
    await w.A('place.survey', {
      name: '照片测试点',
      location: { latitude: 45.8, longitude: 126.64 },
      category: 'meeting',
      confidence: 'high',
      photos: [
        // 联网抓来的图**自报** verified: true —— 必须被忽略
        { url: 'https://example.com/a.jpg', source: 'upstream', verified: true, provider: 'amap' },
        { url: 'https://example.com/b.jpg', source: 'survey' },
      ],
      confirm: true,
    })
  );

  const stored = await w.repo.get(C.PLACES, created.place._id);
  assert.equal(stored.photos[0].verified, false, '联网抓取的图绝不能自称已核验');
  assert.equal(stored.photos[1].verified, true, '踏勘实拍才算核验过');
  assert.equal(stored.photos[0].provider, 'amap', '图的来源必须可追溯，答辩要能说清图从哪来');

  expectFail(
    await w.A('place.survey', {
      placeId: created.place._id,
      photos: [{ url: 'https://example.com/c.jpg', source: 'somewhere' }],
    }),
    'INVALID_PARAM'
  );
});

test('重复录入同名同位置的地点被拒绝 —— 不允许出现两条看起来一样的记录', async () => {
  const w = await makeWorld();
  const payload = { name: '重名测试点', location: HB, category: 'meeting', confidence: 'high', confirm: true };
  expectOk(await w.A('place.survey', payload));
  const err = expectFail(await w.A('place.survey', payload), 'INVALID_PARAM');
  assert.match(err.message, /已存在/, '错误信息要告诉录入者该改用 placeId 更新');
});

test('坐标抖动不会产生重复记录（千分位粒度）', async () => {
  const w = await makeWorld();
  expectOk(
    await w.A('place.survey', {
      name: '抖动测试点',
      location: { latitude: 45.7901, longitude: 126.6301 },
      category: 'meeting',
      confidence: 'high',
      confirm: true,
    })
  );
  // 上游坐标抖了 ~7 米（第四位小数），在这个粒度下应当仍判为同一地点
  expectFail(
    await w.A('place.survey', {
      name: '抖动测试点',
      location: { latitude: 45.79017, longitude: 126.63016 },
      category: 'meeting',
      confidence: 'high',
      confirm: true,
    }),
    'INVALID_PARAM'
  );
});

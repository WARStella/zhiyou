'use strict';

/**
 * 多种出行方式的接入层测试。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────
 *
 * 默认测试世界里，地图 provider 的 `distanceMatrix` **不返回数据**
 * （那是刻意的：假 provider 不编造耗时，见 `lib/map/fake.js`）。
 * 所以 `api.test.js` 里那些规划测试只走到"回落估算"这条路径，
 * **看不到"矩阵给了真实值时会怎样"**。
 *
 * 这个文件显式注入矩阵与公交的结果，覆盖真正的新链路：
 *   ① 四种方式的真实耗时都进候选
 *   ② `mode-choice` 选出最短的那个（那段代码在此前没有任何调用方）
 *   ③ 公交赢了的时候，换乘细节（几号线、哪个口）跟着走
 *   ④ 取不到的方式**如实排除**，不拿别的方式冒充
 *   ⑤ 踏勘实测的记录不被接口结果降级
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  legTravelTimes,
  persistLegTimes,
  pickStep,
} = require('../cloudfunctions/api/lib/leg-times');
const { TRAVEL_MODE } = require('../cloudfunctions/api/lib/geo');
const C = require('../cloudfunctions/api/lib/repo/collections');
const { makeWorld, C: COLL, expectOk, NOW } = require('./helpers');

/** 造一个矩阵 provider：按方式返回注入的耗时 */
function stubMatrix(byMode) {
  const calls = [];
  return {
    calls,
    async distanceMatrix(from, tos, mode) {
      calls.push({ mode, tos: tos.length });
      const v = byMode[mode];
      if (!v) {
        return { ok: true, elements: [{ usable: false, failureReason: 'NO_ROAD_NEARBY', distanceMeters: 999, durationMinutes: null }] };
      }
      if (v.fail) return { ok: false, reason: 'UPSTREAM_FAILED', message: v.fail };
      return {
        ok: true,
        elements: [{ usable: true, distanceMeters: v.meters, durationMinutes: v.minutes, durationSeconds: v.minutes * 60 }],
      };
    },
  };
}

/** 造一个公交 provider */
function stubTransit(result) {
  const calls = [];
  return {
    calls,
    keyStatus: () => ({ configured: true }),
    async route(input) {
      calls.push(input);
      return result;
    },
  };
}

/** 一段真实的公交返回（照 `test/fixtures/upstream/` 那份的结构精简） */
function transitWin() {
  return {
    ok: true,
    best: {
      durationMinutes: 12,
      walkingMeters: 400,
      costYuan: 2,
      transferCount: 0,
      hasSubway: true,
      steps: [
        { kind: 'walking', instruction: '步行两百米' },
        {
          kind: 'transit',
          lineName: '地铁2号线(气象台--江北大学城)',
          isSubway: true,
          departureStop: '中央大街',
          arrivalStop: '世茂大道',
        },
        { kind: 'entrance-exit', entranceName: '1号口', exitName: '3号口' },
      ],
    },
  };
}

const FROM = { latitude: 45.7756, longitude: 126.6175 };
const TO_PLACE = { _id: 'p_far', name: '冰雪大世界方向', location: { latitude: 45.8029, longitude: 126.5353 } };

test('四种方式的真实耗时都进候选，并选出最短的那个', async () => {
  const matrix = stubMatrix({
    walking: { minutes: 90, meters: 7000 },
    bicycling: { minutes: 35, meters: 7200 },
    driving: { minutes: 20, meters: 9000 },
  });
  const transit = stubTransit(transitWin());

  const r = await legTravelTimes({
    fromPoint: FROM,
    toPlace: TO_PLACE,
    providers: { map: matrix, transit },
    opts: { transitCity: '0451' },
  });

  const modes = r.candidates.map((c) => c.mode).sort();
  assert.deepEqual(modes, ['bicycling', 'driving', 'transit', 'walking'], '四种方式都要有候选');

  /**
   * 公交 12 分最短 —— **这段在此之前是不可能的**：
   * `mode-choice` 写好了但没有调用方，规划永远只会给步行。
   */
  assert.equal(r.choice.chosen.mode, TRAVEL_MODE.TRANSIT);
  assert.equal(r.choice.chosen.minutes, 12);
  assert.match(r.choice.reason, /公交|12/, '必须给出可展示的理由');
});

test('公交赢了时，换乘细节跟着走（几号线、哪个口）', async () => {
  const r = await legTravelTimes({
    fromPoint: FROM,
    toPlace: TO_PLACE,
    providers: {
      map: stubMatrix({ walking: { minutes: 90, meters: 7000 }, bicycling: { minutes: 35, meters: 7200 } }),
      transit: stubTransit(transitWin()),
    },
    opts: { transitCity: '0451' },
  });

  const t = r.choice.chosen.transit;
  assert.ok(t, '选中的是公交时，换乘细节必须跟着走');
  assert.deepEqual(t.lineNames, ['地铁2号线(气象台--江北大学城)']);
  assert.equal(t.hasSubway, true);
  /**
   * 出入口对集合协同最有用 —— "在 1 号口等"比"在世茂大道站等"清楚得多。
   * 实测发现上游会给这两个字段（文档示例里没提）。
   */
  assert.equal(t.entranceName, '1号口');
  assert.equal(t.exitName, '3号口');
  assert.equal(t.costYuan, 2);
});

test('来源与 provider 必须跟着候选走 —— 否则界面分不清实测与估算', async () => {
  const r = await legTravelTimes({
    fromPoint: FROM,
    toPlace: TO_PLACE,
    providers: {
      map: stubMatrix({ walking: { minutes: 20, meters: 1300 } }),
      transit: stubTransit({ ok: false, emptyReason: 'NO_TRANSIT_ROUTE' }),
    },
    opts: { transitCity: '0451' },
  });

  assert.equal(r.choice.chosen.mode, 'walking');
  assert.equal(r.choice.chosen.provider, 'tencent-matrix');
  assert.equal(r.choice.chosen.source, 'upstream');

  /**
   * ⚠️ 这条断言守着一个很隐蔽的错：`mode-choice.normalize()` 只保留
   * `{mode, minutes, meters}`，于是 `choice.chosen.source` 是 `undefined`，
   * 而调用方回落到默认值 `'upstream'` —— **踏勘实测会被显示成"接口预测"**。
   * 现在 leg-times 会按 mode 把选中的候选充实回完整形态。
   */
  assert.notEqual(r.choice.chosen.source, undefined, 'source 不能丢');
});

test('取不到的方式如实排除，不拿别的方式冒充', async () => {
  const r = await legTravelTimes({
    fromPoint: FROM,
    toPlace: TO_PLACE,
    providers: {
      /** 只有步行可用；骑行/驾车上游说"附近没有路" */
      map: stubMatrix({ walking: { minutes: 25, meters: 1800 } }),
      transit: stubTransit({ ok: false, reason: 'UPSTREAM_FAILED', message: '上游超时' }),
    },
    opts: { transitCity: '0451' },
  });

  assert.equal(r.choice.chosen.mode, 'walking');

  const failed = r.candidates.filter((c) => c.ok === false);
  assert.ok(failed.length >= 2, '取不到的骑行/驾车要出现在候选里并标失败');
  for (const f of failed) {
    assert.ok(f.reason, `${f.mode} 必须给出失败原因，而不是静默消失`);
  }
  /**
   * ⚠️ 关键：失败的方式**不能混进可用候选**。
   * 拿驾车耗时冒充公交，会让人按一个不存在的时间安排行程。
   */
  assert.equal(
    r.candidates.filter((c) => c.ok !== false && !(c.minutes > 0)).length,
    0,
    '不可用候选不得被当成可用'
  );
});

test('踏勘实测的记录不被接口结果降级', async () => {
  const w = await makeWorld();
  const from = await w.repo.get(COLL.PLACES, 'p_zhongyang');
  const to = await w.repo.get(COLL.PLACES, 'p_fanghong');

  /** 夹具里 p_zhongyang → p_fanghong 是踏勘实测 8 分钟 */
  const before = (from.walkableTo || []).find((x) => x.placeId === 'p_fanghong');
  assert.equal(before.walkMin, 8);
  assert.equal(before.source, undefined, '前提：踏勘记录的 source 缺省即 survey');

  const written = await persistLegTimes(w.repo, COLL, [
    {
      fromPlace: from,
      toPlace: to,
      // 矩阵说步行只要 5 分钟
      candidates: [{ mode: 'walking', minutes: 5, meters: 600, source: 'upstream', provider: 'tencent-matrix' }],
    },
  ]);

  const after = await w.repo.get(COLL.PLACES, 'p_zhongyang');
  const rec = (after.walkableTo || []).find((x) => x.placeId === 'p_fanghong');
  assert.equal(rec.walkMin, 8, '踏勘实测的数值不能被接口结果改写');
  assert.equal(rec.source, undefined, '更不能把 survey 降级成 upstream');
  assert.equal(written, 0, '拒绝降级时不该报告"写入了"');
});

test('只写上游取回的真实值 —— 估算绝不进缓存', async () => {
  const w = await makeWorld();
  const from = await w.repo.get(COLL.PLACES, 'p_sofia');
  const to = await w.repo.get(COLL.PLACES, 'p_zhaolin');

  const written = await persistLegTimes(w.repo, COLL, [
    {
      fromPlace: from,
      toPlace: to,
      candidates: [
        { mode: 'walking', minutes: 99, meters: 5000, source: 'estimated', provider: 'estimate' },
        { mode: 'bicycling', minutes: 3, meters: 700, source: 'upstream', provider: 'tencent-matrix' },
      ],
    },
  ]);

  const after = await w.repo.get(COLL.PLACES, 'p_sofia');
  const est = (after.walkableTo || []).find((x) => x.placeId === 'p_zhaolin' && x.mode === 'walking');
  assert.equal(est, undefined, '估算写进缓存会让"一次估算变成永久事实"');
  const bike = (after.walkableTo || []).find((x) => x.placeId === 'p_zhaolin' && x.mode === 'bicycling');
  assert.ok(bike, '真实值要写进去');
  assert.equal(bike.source, 'upstream');
  assert.equal(written, 1);
});

test('没有矩阵数据时回落到**明确标注**的估算，而不是假装有真实值', async () => {
  const r = await legTravelTimes({
    fromPoint: FROM,
    toPlace: TO_PLACE,
    providers: { map: stubMatrix({}), transit: null },
    opts: { params: { walkSpeedMPerMin: 75 } },
  });

  assert.equal(r.choice.chosen.mode, 'walking');
  assert.equal(r.choice.chosen.source, 'estimated', '估算必须标注，界面要能区分');
  /**
   * ⚠️ 这里断言的是 `candidateReason` 而不是 `reason` —— 两者是**两件事**：
   *   · `choice.reason`        说"**为什么选它**"（比第二快的省几分钟）
   *   · `candidate.reason`     说"**这个数可不可信**"（估算？上游没给时长？）
   *
   * 只留前者的话，用户看不到"这是估算"。
   */
  assert.match(r.choice.chosen.candidateReason, /估算/, '要说清这个数是怎么来的');
});

test('公交没配 Key 时连请求都不发 —— 否则测试会去打外网', async () => {
  let called = 0;
  const transit = {
    keyStatus: () => ({ configured: false }),
    async route() {
      called += 1;
      return { ok: true, best: { durationMinutes: 1 } };
    },
  };

  await legTravelTimes({
    fromPoint: FROM,
    toPlace: TO_PLACE,
    providers: { map: stubMatrix({ walking: { minutes: 30, meters: 2000 } }), transit },
    opts: { transitCity: '0451' },
  });

  assert.equal(called, 0, 'Key 没配就不该发请求（慢、不稳、还烧配额）');
});

test('直线距离太近时不问驾车 —— 几百米内开车没意义，省一次配额', async () => {
  const matrix = stubMatrix({ walking: { minutes: 3, meters: 200 }, bicycling: { minutes: 2, meters: 200 } });
  await legTravelTimes({
    fromPoint: FROM,
    toPlace: { _id: 'p_near', name: '很近', location: { latitude: 45.776, longitude: 126.618 } },
    providers: { map: matrix, transit: null },
    opts: { transitCity: '0451' },
  });

  const modesAsked = matrix.calls.map((c) => c.mode);
  assert.ok(!modesAsked.includes('driving'), `太近时不该问驾车，实际问了 ${modesAsked.join(',')}`);
});

test('pickStep 找不到时返回 null，不抛错', () => {
  assert.equal(pickStep([], 'entrance-exit', 'entranceName'), null);
  assert.equal(pickStep([{ kind: 'walking' }], 'entrance-exit', 'entranceName'), null);
  assert.equal(pickStep([{ kind: 'entrance-exit', entranceName: '2号口' }], 'entrance-exit', 'entranceName'), '2号口');
});

test('端到端：公交更快时，时间线上写的是公交而不是步行', async () => {
  /**
   * 这条是整件事的目的：**界面上能看出"这段其实坐地铁更快"**。
   *
   * 在此之前 `travelMode` 被写死成 `'walking'`（注释还写着"字段预留"），
   * 于是无论实际怎么走都显示"步行"。
   */
  const timelineMod = require('../cloudfunctions/api/domain/timeline');

  const placesById = {
    p_a: {
      _id: 'p_a',
      name: '中央大街',
      location: { latitude: 45.7756, longitude: 126.6175 },
      visitDurationMin: { default: 30 },
    },
    p_b: {
      _id: 'p_b',
      name: '冰雪大世界',
      location: { latitude: 45.8029, longitude: 126.5353 },
      visitDurationMin: { default: 60 },
    },
  };

  const tl = timelineMod.buildTimeline({
    startAt: new Date('2026-10-14T01:00:00Z'),
    items: [
      { placeId: 'p_a', stayMin: 30 },
      { placeId: 'p_b', stayMin: 60 },
    ],
    placesById,
    params: { walkSpeedMPerMin: 75, stayMinDefault: 30, meetBufferMin: 5 },
    /** 第二段：地铁 12 分钟 */
    legTimes: {
      p_b: {
        minutes: 12,
        meters: 400,
        mode: 'transit',
        source: 'upstream',
        provider: 'amap-transit',
        reason: '公交比步行省 78 分钟',
        candidateReason: null,
        transit: { lineNames: ['地铁2号线'], hasSubway: true, entranceName: '1号口', exitName: '3号口' },
      },
    },
  });

  const leg = tl.legs[1];
  assert.equal(leg.travelMode, 'transit', '这一段的出行方式应当是公交，不是写死的步行');
  assert.equal(leg.travelFromPrevMin, 12, '要用真实耗时而不是步行估算');
  assert.equal(leg.travelProvider, 'amap-transit');
  assert.match(leg.travelReason, /省 78 分钟/);

  /**
   * ⚠️ 公交的 12 分钟**不能计入步行量**：会开车的 30 分钟被记成"走了 30 分钟"
   * 会让 `maxWalkMinutes`（用户说"少走点路"）永远不触发。
   */
  assert.equal(tl.totalWalkMin, 0, '这一段是坐车，不该计入步行');
  assert.equal(tl.totalRideMin, 12, '非步行方式的耗时单独累计');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeWorld, makeCrew, expectOk, C, createMapProvider } = require('./helpers');
const { createTencentProvider } = require('../cloudfunctions/api/lib/map/tencent');
const { createAmapTransitProvider } = require('../cloudfunctions/api/lib/transit/amap');
const { dependencyStatus } = require('../cloudfunctions/api/lib/config-health');
const { getRepo, resetRepoCache } = require('../cloudfunctions/api/lib/repo');
const { preserveHistory } = require('../cloudfunctions/api/lib/trip-history');
const walking = require('./fixtures/upstream/direction-walking-central-avenue.json');
const transit = require('./fixtures/upstream/direction-transit-integrated-harbin.json');

const places = [0, 1, 2, 3].map(i => ({ name: `回归地点${i + 1}`,
  location: { latitude: 45.77, longitude: 126.62 + i * 0.01 },
  visitDurationMin: { default: 15, min: 5, max: 120 } }));

for (const autoApply of ['never', 'if_no_tradeoff']) {
  test(`调整${autoApply === 'never' ? '确认' : '自动生效'}保留完成、跳过与已到达事实，连续调整不重复历史`, async () => {
    const w = await makeWorld();
    const plan = expectOk(await w.A('trip.plan', { places, startAt: w.NOW }));
    const tripId = plan.tripId;
    let version = plan.version;
    for (const [index, status] of [[0, 'done'], [1, 'skipped'], [2, 'arrived']]) {
      expectOk(await w.A('trip.progress', { tripId, nodeId: plan.nodes[index].nodeId, status }, { expectedVersion: version++ }));
    }
    const original = await w.repo.get(C.TRIPS, tripId);
    for (let round = 0; round < 2; round++) {
      const proposal = expectOk(await w.A('trip.adjust', { tripId, autoApply,
        trigger: { type: 'extend_stay', payload: { nodeId: plan.nodes[3].nodeId, deltaMin: 5 } } }));
      for (const candidate of proposal.candidates) {
        assert.deepEqual(candidate.nodes.slice(0, 2), original.nodes.slice(0, 2), '候选预览必须保留历史');
      }
      if (autoApply === 'never') {
        assert.deepEqual((await w.repo.get(C.TRIPS, tripId)).nodes, original.nodes.map(n => n),
          round === 0 ? '确认前行程不能变化' : undefined);
        const candidate = proposal.candidates.find(c => c.feasible);
        assert.ok(candidate);
        expectOk(await w.A('trip.confirmChange', { proposalId: proposal.proposalId, candidateId: candidate.candidateId }, { expectedVersion: version }));
      } else assert.equal(proposal.applied, true);
      version++;
      const current = await w.repo.get(C.TRIPS, tripId);
      assert.equal(current.nodes.length, 4);
      assert.equal(new Set(current.nodes.map(n => n.nodeId)).size, 4);
      assert.deepEqual(current.nodes.slice(0, 2), original.nodes.slice(0, 2));
      const arrived = current.nodes.find(n => n.nodeId === plan.nodes[2].nodeId);
      assert.equal(arrived.status, 'arrived');
      assert.deepEqual(arrived.actualArriveAt, original.nodes[2].actualArriveAt);
      assert.deepEqual(current.nodes.map(n => n.seq), [0, 1, 2, 3]);
      const snapshot = await w.repo.findOne(C.TRIP_VERSIONS, { tripId, version });
      assert.deepEqual(snapshot.snapshot.nodes, current.nodes);
      original.nodes = current.nodes;
    }
    const firstVersion = await w.repo.findOne(C.TRIP_VERSIONS, { tripId, version: 1 });
    assert.ok(firstVersion.snapshot.nodes.every(n => n.status === 'pending'), '旧版本快照不被改写');
  });
}

test('集合预检候选已含历史时不重复，确认不能用候选中的旧事实覆盖历史', () => {
  const original = [{ nodeId: 'done', seq: 0, status: 'done', actualLeaveAt: 'original' },
    { nodeId: 'pending', seq: 1, status: 'pending' }];
  const merged = preserveHistory(original, [{ nodeId: 'done', status: 'pending' }, original[1]]);
  assert.deepEqual(merged, original);
});

test('起点与站间都回落估算时，失败清单逐段覆盖且不重复', async () => {
  const w = await makeWorld({ createMapProvider: () => createMapProvider('fake', {
    failWith: { reason: 'UPSTREAM_FAILED', message: '模拟上游失败' },
  }) });
  const result = expectOk(await w.A('trip.plan', { places: places.slice(0, 2), startAt: w.NOW,
    startPoint: { latitude: 45.77, longitude: 126.61 } }));
  assert.equal(result.walkTimes.bySource.estimated, 2);
  assert.equal(result.walkTimes.upstreamFailed, 2);
  assert.equal(result.walkTimes.failures.length, 2);
  assert.deepEqual(result.walkTimes.failures.map(f => f.to), places.slice(0, 2).map(p => p.name));
  assert.ok(result.walkTimes.failures.every(f => f.reason && f.message));
  assert.match(result.walkTimes.note, /2 段/);
});

for (const failNetwork of [false, true]) {
  test(`步行、矩阵、公交${failNetwork ? '网络失败' : '成功'}的实际请求总数写入响应与决策`, async () => {
    const observed = { walking: 0, matrix: 0, transit: 0 };
    const http = async url => {
      const u = new URL(url);
      const kind = u.pathname.includes('/matrix') ? 'matrix' : u.pathname.includes('/transit/') ? 'transit' : 'walking';
      observed[kind]++;
      if (failNetwork) throw new Error('模拟网络中断');
      if (kind === 'walking') return { httpStatus: 200, json: walking.body };
      if (kind === 'transit') return { httpStatus: 200, json: transit.body };
      const duration = { walking: 720, bicycling: 300, driving: 60 }[u.searchParams.get('mode')];
      return { httpStatus: 200, json: { status: 0, result: { rows: [{ elements: [{ distance: 900, duration }] }] } } };
    };
    const w = await makeWorld({
      createMapProvider: () => createTencentProvider({ key: 'TEST_MAP_KEY', http }),
      createTransitProvider: () => createAmapTransitProvider({ key: 'TEST_AMAP_KEY', http }),
    });
    const result = expectOk(await w.A('trip.plan', { places: places.slice(0, 2), startAt: w.NOW,
      startPoint: { latitude: 45.77, longitude: 126.61 }, preferredMode: 'walking' }));
    const total = Object.values(observed).reduce((sum, n) => sum + n, 0);
    assert.ok(Object.values(observed).every(n => n > 0));
    assert.deepEqual(result.walkTimes.mapApiCallsByType, observed);
    assert.equal(result.walkTimes.mapApiCalls, total);
    assert.equal(observed.transit, 2, '公交与地铁共用一次响应，每段只发一次请求');
    const decision = await w.repo.findOne(C.DECISIONS, { tripId: result.tripId, kind: 'plan' });
    assert.equal(decision.mapApiCalls, total);
  });
}

test('缺少 Key 的本地拒绝不消耗请求，仍如实显示估算与失败', async () => {
  const http = () => assert.fail('缺少 Key 时不得调用网络');
  const w = await makeWorld({
    createMapProvider: () => createTencentProvider({ key: '', http }),
    createTransitProvider: () => createAmapTransitProvider({ key: '', http }),
  });
  const result = expectOk(await w.A('trip.plan', { places: places.slice(0, 2), startAt: w.NOW,
    startPoint: { latitude: 45.77, longitude: 126.61 } }));
  assert.equal(result.walkTimes.mapApiCalls, 0);
  assert.deepEqual(result.walkTimes.mapApiCallsByType, { walking: 0, matrix: 0, transit: 0 });
  assert.equal(result.walkTimes.upstreamFailed, result.walkTimes.bySource.estimated);
});

test('只有站间步行失败而矩阵成功时，真实方案不被列为估算失败', async () => {
  const w = await makeWorld({ createMapProvider: () => {
    const p = createMapProvider('fake', { matrixResults: [{ durationMinutes: 10, distanceMeters: 900 }] });
    p.walkingRoute = async () => ({ ok: false, reason: 'WALKING_FAILED' });
    return p;
  } });
  const result = expectOk(await w.A('trip.plan', { places: places.slice(0, 2), startAt: w.NOW }));
  assert.ok(result.walkTimes.mapApiCalls > 0);
  assert.equal(result.walkTimes.upstreamFailed, 0);
  assert.deepEqual(result.walkTimes.failures, []);
  assert.equal(result.nodes[1].travelSource, 'upstream');
});

test('健康检查只报告配置：缺 Key、假服务、未知服务及已配 Key 都不冒充已联通', () => {
  const missing = dependencyStatus({});
  assert.equal(missing.transitService.configured, false);
  assert.match(missing.transitService.hint, /AMAP_KEY/);
  const present = dependencyStatus({ MAP_KEY: 'SECRET_MAP', AMAP_KEY: ' SECRET_AMAP ', AI_API_KEY: 'SECRET_AI' });
  for (const name of ['mapService', 'transitService', 'photoService', 'llm']) {
    assert.equal(present[name].configured, true);
    assert.equal(present[name].connectivity, 'not_probed');
  }
  // 校验实际凭据值；ASR_SECRET_ID 这样的配置项名称不是密钥泄漏。
  for (const value of ['SECRET_MAP', 'SECRET_AMAP', 'SECRET_AI']) assert.ok(!JSON.stringify(present).includes(value));
  assert.equal(dependencyStatus({ MAP_PROVIDER: 'fake' }).mapService.configured, true);
  assert.equal(dependencyStatus({ MAP_PROVIDER: 'unknown' }).mapService.configured, false);
});

test('ops.health 返回真实配置结构，不发上游请求', async () => {
  const forbidden = () => assert.fail('配置检查不能初始化网络服务');
  const w = await makeWorld({ createMapProvider: forbidden, createTransitProvider: forbidden });
  const result = expectOk(await w.A('ops.health'));
  assert.equal(result.deps.transitService.check, 'configuration_only');
  assert.equal(result.deps.locationApi.status, 'not_checked');
});

test('仓储未选择时明确报错，显式选择的内存仓储仍可用于本地测试', t => {
  const prior = process.env.ZY_REPO;
  delete process.env.ZY_REPO;
  resetRepoCache();
  t.after(() => { if (prior === undefined) delete process.env.ZY_REPO; else process.env.ZY_REPO = prior; resetRepoCache(); });
  assert.throws(() => getRepo(), /必须显式选择仓储/);
  assert.equal(getRepo('memory').__kind, 'memory');
  assert.throws(() => getRepo('unknown'), /未知的仓储实现/);
});

test('所有已注册 action 均在接口清单中列出，部署所用环境变量有说明', () => {
  const actions = require('../cloudfunctions/api/actions');
  const doc = fs.readFileSync(path.join(__dirname, '../docs/项目计划书.md'), 'utf8');
  const documented = new Set([...doc.matchAll(/^\|\s*`([a-zA-Z]+\.[a-zA-Z]+)`\s*\|/gm)].map(m => m[1]));
  assert.deepEqual(Object.keys(actions).filter(name => !documented.has(name)), []);
  const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
  for (const key of ['AMAP_KEY', 'MAP_TIMEOUT_MS', 'PHOTO_PROVIDER', 'ZY_REPO']) assert.ok(readme.includes('`' + key + '`'));
});

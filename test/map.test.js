'use strict';

/**
 * 地图服务与探针测试。
 *
 * 重点不是"能不能连上腾讯"（那要真 Key、真网络，且有费用），
 * 而是**失败路径是否被正确处理**：
 *   - 地图接口失败时，绝不返回估算值冒充结果
 *   - 缺 Key / 无效 Key 必须被识别为失败
 *   - 请求 URL 里的 Key 必须被脱敏
 *
 * 这几条对应 docs/项目计划书.md#data-model §3 的错误码纪律与计划书 11/12 的密钥要求。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMapProvider } = require('../cloudfunctions/api/lib/map');
const { createFakeProvider } = require('../cloudfunctions/api/lib/map/fake');
const { checkDurationUnit } = require('../cloudfunctions/api/lib/map/tencent');
const { redact, maskSecret } = require('../cloudfunctions/api/lib/http');
const { makeWorld, expectOk, expectFail } = require('./helpers');
const fixtures = require('./fixtures/places');

const ZHONGYANG = fixtures.byId.p_zhongyang.location;
const FANGHONG = fixtures.byId.p_fanghong.location;

// ── 密钥脱敏 ──────────────────────────────────────────────

test('脱敏：请求 URL 里的 Key 不得出现在结果中', () => {
  const url = 'https://apis.map.qq.com/ws/direction/v1/walking/?from=1,2&to=3,4&key=ABC123SECRETKEY';
  const out = redact(url);
  assert.equal(out.includes('ABC123SECRETKEY'), false, '完整 Key 必须被抹掉');
  assert.match(out, /key=\*\*\*REDACTED\*\*\*/);
  assert.match(out, /from=1,2/, '其余参数应保留，便于排查');
});

test('脱敏：掩码只暴露首尾，不泄露完整值', () => {
  const masked = maskSecret('ABCDEFGHIJKLMNOP');
  assert.equal(masked.startsWith('ABCD'), true);
  assert.equal(masked.endsWith('MNOP'), true);
  assert.equal(masked.includes('EFGHIJKL'), false, '中间部分必须被遮住');
  assert.equal(maskSecret(''), null);
  assert.equal(maskSecret(null), null);
  assert.equal(maskSecret('short'), '*****');
});

// ── 假服务的行为（作为真服务的契约参照） ──────────────────

test('假服务：正常返回距离与时长，单位与真实上游一致（米 / 分钟）', async () => {
  const p = createFakeProvider();
  const r = await p.walkingRoute(ZHONGYANG, FANGHONG);

  assert.equal(r.ok, true);
  assert.ok(r.distanceMeters > 0, '距离必须为正数（米）');
  assert.equal(r.durationUnit, 'minute', '单位约定：分钟（见 checkDurationUnit 的实测依据）');
  assert.equal(r.durationMinutes, r.durationRaw, '单位为分钟时，归一化值就是原值');
  assert.ok(r.durationMinutes >= 5 && r.durationMinutes <= 20, '应是分钟量级');
  assert.equal(r.requestUrl, '(fake provider: no HTTP request)');
});

test('假服务：未配置 Key 时明确失败，并给出可执行的修复指引', async () => {
  const p = createMapProvider('fake', { key: '' });
  const r = await p.walkingRoute(ZHONGYANG, FANGHONG);

  assert.equal(r.ok, false, '缺 Key 必须是失败，不能返回估算值');
  assert.equal(r.reason, 'MAP_KEY_NOT_CONFIGURED');
  assert.match(r.message, /MAP_KEY/);
  assert.equal(r.distanceMeters, undefined, '失败时不得带出距离');
});

test('假服务：无效 Key 被识别为鉴权失败', async () => {
  const p = createMapProvider('fake', { key: 'INVALID_KEY_0000' });
  const r = await p.walkingRoute(ZHONGYANG, FANGHONG);

  assert.equal(r.ok, false);
  assert.match(r.reason, /UPSTREAM_STATUS_311/);
});

test('地图服务失败时绝不返回估算值', async () => {
  const p = createMapProvider('fake', { failWith: { reason: 'UPSTREAM_FAILED', message: '模拟上游 500' } });
  const r = await p.walkingRoute(ZHONGYANG, FANGHONG);

  assert.equal(r.ok, false);
  assert.equal(r.distanceMeters, undefined);
  assert.equal(r.durationMinutes, undefined);
  assert.match(r.message, /模拟上游 500/);
});

test('未知的地图服务必须直接报错，而不是静默用默认实现', () => {
  assert.throws(() => createMapProvider('baidu'), /未知的地图服务/);
});

// ── Key 粘贴污染（2026-10-13 真实事故） ───────────────────

test('Key 前后空白必须被自动去除，并被标记出来', async () => {
  // 真实事故复现：从控制台表格复制 Key，把前面的制表符和空格一起带进了环境变量
  const p = createMapProvider('fake', { key: '\t FAKEKEY-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF ' });

  assert.equal(p.keyConfigured, true);
  assert.equal(p.keyWasTrimmed, true, '必须标记出粘贴污染，让使用者去修环境变量');
  assert.equal(p.keyMasked.startsWith('\t'), false, '掩码不得包含空白字符');

  const r = await p.walkingRoute(ZHONGYANG, FANGHONG);
  assert.equal(r.ok, true, 'trim 之后应当能正常调用');
});

test('keyMasked 是发现粘贴污染的关键信号', () => {
  const dirty = createMapProvider('fake', { key: '\t FAKEKEY-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF' });
  const clean = createMapProvider('fake', { key: 'FAKEKEY-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF' });

  assert.equal(dirty.keyMasked, clean.keyMasked, '去除空白后掩码应完全一致');
  assert.equal(dirty.keyWasTrimmed, true);
  assert.equal(clean.keyWasTrimmed, false);
});

test('map.probe：检测到 Key 粘贴污染时给出明确警告', async () => {
  const w = await makeWorld();
  const res = expectOk(
    await w.A('map.probe', { provider: 'fake', overrideKey: '\t FAKEKEY-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF ' })
  );

  assert.equal(res.keyConfigured, true);
  assert.equal(res.keyWasTrimmed, true);
  assert.match(res.keyWarning, /多余空白/);
  assert.match(res.keyWarning, /重新填干净/, '要给出可执行的后续动作');
});

// ── duration 单位（2026-10-14 实测发现） ──────────────────

test('duration 单位自检：用隐含步速判定，而不是靠记忆写死', () => {
  // 真实实测数据：中央大街 → 防洪纪念塔 815 米，duration 返回 12
  const minute = checkDurationUnit(815, 12);
  assert.equal(minute.unit, 'minute', '按分钟理解才合理');
  assert.equal(minute.plausible, true);
  assert.ok(
    minute.impliedMPerMin >= 55 && minute.impliedMPerMin <= 80,
    `隐含步速 ${minute.impliedMPerMin} 米/分应接近真实步行速度（约 68）`
  );

  // 若上游某天改成秒（815 米 / 660 秒 ≈ 74 米/分），自检必须能识别出来
  const second = checkDurationUnit(815, 660);
  assert.equal(second.unit, 'second');
  assert.equal(second.plausible, true);

  // 两种假设都不合理时必须如实标记，而不是默默选一个
  const weird = checkDurationUnit(815, 100000);
  assert.equal(weird.plausible, false);
  assert.match(weird.note, /人工核对/);

  // 缺数据不得抛错
  assert.equal(checkDurationUnit(null, 12).unit, null);
  assert.equal(checkDurationUnit(815, null).unit, null);
  assert.equal(checkDurationUnit(815, 0).unit, null);
});

test('路线时长必须是分钟量级，不能是秒量级的 1/60', async () => {
  const p = createMapProvider('fake');
  const r = await p.walkingRoute(ZHONGYANG, FANGHONG);

  assert.equal(r.durationUnit, 'minute');
  assert.equal(r.unitCheck.plausible, true, '单位自检必须通过');

  // 中央大街 → 防洪纪念塔 直线约 615 米、绕行后约 800 米
  // 按 75 米/分 计应在 10 分钟上下；首版 bug（除以 60）会得到 0.2
  assert.ok(
    r.durationMinutes >= 5 && r.durationMinutes <= 20,
    `durationMinutes 应在分钟量级，实际 ${r.durationMinutes} —— 若为 0.x 说明又按秒处理了`
  );
});

// ── 探针动作 ──────────────────────────────────────────────

test('map.probe：关键用例通过，失败情形被正确拒绝', async () => {
  const w = await makeWorld();
  const res = expectOk(await w.A('map.probe', { provider: 'fake' }));

  assert.equal(res.kind, 'mapProbe');
  assert.equal(res.provider, 'fake');
  assert.equal(res.keyConfigured, true);
  assert.equal(res.total, 1, '判据只看关键用例① —— 那就是 10/14 验收的原文');
  assert.equal(res.passed, 1);
  assert.equal(
    res.informationalCount,
    2,
    '信息项有两个：② 极近距离、⑥ 各出行方式（都不参与判据）'
  );
  assert.match(res.verdict, /关键用例通过/);

  /**
   * ⚠️ ⑥（各出行方式）在**假服务上必须返回"没有路况数据"**，
   * 不能编一份假路况出来 —— 那会让人以为这条链路已经实测过了，
   * 而它的真实结构**恰恰是这次探针要去发现的东西**。
   */
  const modes = res.results.find((r) => /各出行方式/.test(r.name));
  assert.ok(modes, '探针必须包含各出行方式这一项');
  assert.equal(modes.ok, false, '假服务不该声称有路况');
  assert.equal(modes.reason, 'FAKE_PROVIDER_HAS_NO_TRAFFIC');
  assert.match(modes.hint, /真实 provider/, '要指出正确的做法');

  // 主用例必须给出"两个地点之间的路线与时间" —— 这正是 10/14 的验收原文
  const main = res.results[0];
  assert.equal(main.ok, true);
  assert.ok(main.distanceMeters > 0);
  assert.ok(main.durationMinutes > 0);
  assert.match(main.summary, /米 \/ .* 分钟/);

  // 失败情形③④⑤必须被拒绝
  const invalidKey = res.results.find((r) => /无效 Key/.test(r.name));
  const noKey = res.results.find((r) => /未配置 Key/.test(r.name));
  const samePoint = res.results.find((r) => /起终点相同/.test(r.name));
  assert.equal(invalidKey.expectedFailure, true);
  assert.equal(invalidKey.ok, false);
  assert.equal(noKey.ok, false);
  assert.match(noKey.message, /MAP_KEY/);
  assert.equal(samePoint.ok, false, '起终点相同应被上游拒绝（实测 status 374）');
  assert.match(samePoint.summary, /已正确拒绝/);

  // 核对清单必须带上，明天按它逐项确认
  assert.ok(res.checklist.length >= 4);
  assert.match(res.checklist.join(' '), /坐标系/);
  assert.match(res.checklist.join(' '), /分钟/, '单位结论必须写进清单');
});

test('map.probe：把原始返回带出来供核对字段与坐标系', async () => {
  const w = await makeWorld();
  const res = expectOk(await w.A('map.probe', { provider: 'fake' }));

  const main = res.results[0];
  assert.ok(main.rawHead, '必须带原始返回 —— 字段名与坐标系要靠它核对，不能靠记忆');
  assert.ok(main.parsedVia, '必须写明解析用的字段路径，便于发现解析错位');
  assert.ok(main.inputFrom && main.inputTo, '必须回显输入坐标，便于比对坐标系');
  assert.ok(main.polylinePointCount >= 2, '折线点数用于确认返回的是路径而非单点');
});

test('map.probe：Key 不出现在任何返回内容里', async () => {
  const w = await makeWorld();
  // 用真实 provider 名但注入一个可识别的 Key
  const secret = 'TENCENT-SECRET-KEY-1234';
  const res = expectOk(await w.A('map.probe', { provider: 'fake', overrideKey: secret }));

  const serialized = JSON.stringify(res);
  assert.equal(serialized.includes(secret), false, '完整 Key 绝不能出现在响应里');
  assert.ok(res.keyMasked, '只允许出现掩码');
  assert.equal(res.keyMasked.includes('SECRET-KEY'), false);
});

test('map.probe：仅限 dev 环境（会真实调用外部接口并产生费用）', async () => {
  const prod = await makeWorld({ env: 'prod' });
  expectFail(await prod.A('map.probe', { provider: 'fake' }), 'FORBIDDEN_ENV');
});

test('map.probe：调用次数被计入事件日志，供成本核算', async () => {
  const w = await makeWorld();
  await w.A('map.probe', { provider: 'fake' });

  const events = await w.repo.find('events', { type: 'upstream_call' });
  assert.equal(events.length, 1);
  assert.ok(events[0].mapApiCalls >= 4, '每次探针的接口调用次数必须被记录（11/8、11/12 要统计）');
  assert.equal(events[0].detail.provider, 'fake');
});

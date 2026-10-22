'use strict';

/**
 * 出行方式选择的测试。
 *
 * 这一个文件**不需要任何接口**就能跑 —— 这正是把它做成纯函数的意义：
 * 驾车／骑行／公交三个端点还没实测，但"拿到耗时之后怎么选"现在就能钉死。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  chooseMode,
  chooseForLegs,
  BAD_WEATHER_WALK_LIMIT_M,
} = require('../cloudfunctions/api/lib/mode-choice');

/** 造一组候选 */
const c = (mode, minutes, meters, extra) =>
  Object.assign({ mode, minutes, meters }, extra || {});

// ── 一般情况：最短时间优先 ────────────────────────────────

test('一般情况：取耗时最短的方式', () => {
  const r = chooseMode([
    c('walking', 25, 1800),
    c('bicycling', 9, 1800),
    c('driving', 12, 2400),
  ]);
  assert.equal(r.chosen.mode, 'bicycling');
  assert.equal(r.chosen.minutes, 9);
});

test('理由必须写清"选了谁、比谁省多少"', () => {
  /**
   * §6.5 说的是"改得清楚" —— 系统替用户改了出行方式，
   * 就必须说清依据。第二三名差多少，比"推荐骑行"有用得多。
   */
  const r = chooseMode([c('walking', 25, 1800), c('bicycling', 9, 1800)]);
  assert.equal(r.chosen.mode, 'bicycling');
  assert.match(r.reason, /骑行最快/);
  assert.match(r.reason, /9 分钟/);
  assert.match(r.reason, /比步行/);
  assert.match(r.reason, /省 16 分钟/);
});

test('只有一种可用时，如实说"只取到了"而不是假装比较过', () => {
  const r = chooseMode([c('walking', 30, 2200)]);
  assert.equal(r.chosen.mode, 'walking');
  assert.match(r.reason, /只取到了步行/);
});

// ── 接口缺失：不能静默丢掉 ────────────────────────────────

test('取不到用时的方式要进 excluded 并说明原因，不能悄悄不算', () => {
  const r = chooseMode([
    c('walking', 20, 1500),
    c('bicycling', null, null, { ok: false, reason: 'UPSTREAM_STATUS_199' }),
    c('transit', 0, 0, { ok: false, reason: '服务未开通' }),
  ]);
  assert.equal(r.chosen.mode, 'walking');
  assert.equal(r.excluded.length, 2);
  const modes = r.excluded.map((x) => x.mode).sort();
  assert.deepEqual(modes, ['bicycling', 'transit']);
  // 原因要原样带出来 —— 排查"为什么没考虑骑行"靠它
  assert.match(JSON.stringify(r.excluded), /UPSTREAM_STATUS_199/);
  assert.match(JSON.stringify(r.excluded), /服务未开通/);
});

test('一种都取不到时明确失败，不编一个方式出来', () => {
  const r = chooseMode([c('bicycling', null, null, { ok: false, reason: 'X' })]);
  assert.equal(r.chosen, null);
  assert.match(r.reason, /没有可用的出行方式/);
});

test('空输入不抛异常', () => {
  for (const bad of [null, undefined, [], [null], [{}]]) {
    const r = chooseMode(bad);
    assert.equal(r.chosen, null);
    assert.ok(r.reason);
  }
});

// ── 雨雪天：安全优先 ──────────────────────────────────────

test('雨雪天：骑行被排除，理由是"容易打滑"而不是"不推荐"', () => {
  const r = chooseMode(
    // 2 公里的路：步行 25 分钟（超上限）、骑行 9 分钟（不安全）、公交 14 分钟
    [c('walking', 25, 2000), c('bicycling', 9, 2000), c('transit', 14, 2000)],
    { preference: 'safety', weather: '雨雪' }
  );
  assert.equal(r.chosen.mode, 'transit', '骑行更快但不安全，步行又太远，只剩公交');
  assert.match(r.reason, /雨雪天以安全为主/);
  assert.match(r.reason, /骑行（雨雪路面骑行容易打滑）/);
});

test('雨雪天：步行超过距离上限也要排除', () => {
  const r = chooseMode([c('walking', 30, BAD_WEATHER_WALK_LIMIT_M + 100), c('transit', 16, 2000)], {
    preference: 'safety',
  });
  assert.equal(r.chosen.mode, 'transit');
  assert.match(r.reason, /超过雨雪天的 1500 米上限/);
});

test('雨雪天：短距离步行不受影响（近的不该被赶去坐车）', () => {
  const r = chooseMode([c('walking', 6, 400), c('transit', 18, 400)], { preference: 'safety' });
  assert.equal(r.chosen.mode, 'walking', '400 米在雨雪天也没必要坐车');
});

test('雨雪天没有更安全的选择时，退回最快并如实说明', () => {
  /**
   * ⚠️ 不能因为"雨雪天"就一种都不选 —— 那会让用户哪儿也去不了。
   * 退回最快的方式，但**必须说明这是降级**，让用户自己留意。
   */
  const r = chooseMode([c('walking', 40, 3000), c('bicycling', 12, 3000)], {
    preference: 'safety',
  });
  assert.ok(r.chosen, '必须给出一个方式');
  assert.equal(r.chosen.mode, 'bicycling');
  assert.equal(r.degraded, true);
  assert.match(r.reason, /没有更安全的选择/);
  assert.match(r.reason, /留意路况/);
});

test('一般模式不排除骑行 —— 安全偏好必须是用户明确选的', () => {
  const r = chooseMode([c('walking', 30, 2500), c('bicycling', 8, 2500)]);
  assert.equal(r.chosen.mode, 'bicycling', '没说雨雪就不该擅自排除');
  assert.equal(r.excluded.length, 0);
});

test('安全模式与一般模式的取舍可对照', () => {
  const cands = [c('walking', 32, 2400), c('bicycling', 10, 2400), c('driving', 15, 2600)];
  const fast = chooseMode(cands);
  const safe = chooseMode(cands, { preference: 'safety' });
  assert.equal(fast.chosen.mode, 'bicycling');
  assert.equal(safe.chosen.mode, 'driving');
  assert.ok(safe.chosen.minutes > fast.chosen.minutes, '安全模式会牺牲一些时间 —— 这是取舍');
});

// ── 整条路线 ──────────────────────────────────────────────

test('逐段选方式，并统计有多少段不靠走', () => {
  const r = chooseForLegs(
    [
      { fromName: '中央大街', toName: '防洪纪念塔', candidates: [c('walking', 12, 815), c('driving', 9, 1200)] },
      { fromName: '防洪纪念塔', toName: '索菲亚教堂', candidates: [c('walking', 21, 1561)] },
    ],
    {}
  );
  assert.equal(r.legs.length, 2);
  assert.equal(r.legs[0].chosen.mode, 'driving');
  assert.equal(r.legs[0].managed, '驾车', '界面直接用这个中文名，不要各处再映射一次');
  assert.equal(r.legs[1].chosen.mode, 'walking');
  assert.equal(r.nonWalkingLegs, 1);
  assert.match(r.note, /2 段里有 1 段不用步行/);
});

test('全是步行时说清"都可以步行"', () => {
  const r = chooseForLegs([
    { fromName: 'A', toName: 'B', candidates: [c('walking', 8, 600)] },
  ]);
  assert.equal(r.nonWalkingLegs, 0);
  assert.match(r.note, /都可以步行/);
});

test('某一段没有可用方式时该段 chosen 为 null，不影响其他段', () => {
  const r = chooseForLegs([
    { fromName: 'A', toName: 'B', candidates: [c('walking', 8, 600)] },
    { fromName: 'B', toName: 'C', candidates: [c('driving', null, null, { ok: false, reason: 'X' })] },
  ]);
  assert.ok(r.legs[0].chosen);
  assert.equal(r.legs[1].chosen, null);
  assert.ok(r.legs[1].reason);
});

// ── 不猜天气 ──────────────────────────────────────────────

test('不传 preference 时永远是 fastest —— 系统不自己推断天气', () => {
  /**
   * 凭日期猜"冬天可能下雪"然后擅自改出行方式，是替用户做决定 ——
   * 与"点名两个地方却选了十个"是同一类错误。
   */
  const cands = [c('walking', 30, 2500), c('bicycling', 8, 2500)];
  assert.equal(chooseMode(cands).preference, 'fastest');
  assert.equal(chooseMode(cands, {}).preference, 'fastest');
  assert.equal(chooseMode(cands, { weather: '雨雪' }).preference, 'fastest', '只给 weather 不给 preference，仍按最快');
  assert.equal(chooseMode(cands, { preference: '乱写' }).preference, 'fastest', '非法值退回默认');
});

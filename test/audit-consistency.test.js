'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, makeCrew, enableLocation, expectOk, expectFail, C } = require('./helpers');
const time = require('../cloudfunctions/api/lib/time');
const { POLICY_VERSION } = require('../cloudfunctions/api/lib/location-consent');
const point = { latitude: 45.77, longitude: 126.62 };

function holdJoin(w) {
  const original = w.repo.runTransaction.bind(w.repo);
  let entered, release, held = false;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  w.repo.runTransaction = (fn, collections) => original(async tx => {
    const insert = tx.insert.bind(tx);
    tx.insert = async (collection, data) => {
      if (!held && collection === C.CREW_MEMBERS && data.userId === 'openid_B') {
        held = true; entered(); await gate;
      }
      return insert(collection, data);
    };
    return fn(tx);
  }, collections);
  return { ready, release };
}

test('并发加入晚提交的旧计数不能覆盖新人数，旧队伍无 revision 也能兼容', async () => {
  const w = await makeWorld();
  const crew = expectOk(await w.A('crew.create', { name: '并发' }));
  const stored = await w.repo.get(C.CREWS, crew.crewId);
  delete stored.revision;
  await w.repo.__seed(C.CREWS, [stored]);
  const hold = holdJoin(w);
  const b = w.B('crew.join', { inviteCode: crew.inviteCode });
  await hold.ready;
  expectOk(await w.C('crew.join', { inviteCode: crew.inviteCode }));
  hold.release(); expectOk(await b);
  assert.equal((await w.repo.get(C.CREWS, crew.crewId)).memberCount, 3);
  assert.equal(await w.repo.count(C.CREW_MEMBERS, { crewId: crew.crewId, status: 'active' }), 3);
});

test('解散先提交后，暂停中的加入必须失败，成员与人数不能留下半次写入', async () => {
  const w = await makeWorld();
  const crew = expectOk(await w.A('crew.create', { name: '解散并发' }));
  const hold = holdJoin(w);
  const b = w.B('crew.join', { inviteCode: crew.inviteCode });
  await hold.ready;
  expectOk(await w.A('team.close', { crewId: crew.crewId }));
  hold.release(); expectFail(await b, 'FORBIDDEN_NOT_MEMBER');
  assert.equal(await w.repo.findOne(C.CREW_MEMBERS, { crewId: crew.crewId, userId: 'openid_B' }), null);
  assert.equal((await w.repo.get(C.CREWS, crew.crewId)).memberCount, 1);
});

test('同人并发重复加入只保留一个成员，不重复增加人数', async () => {
  const w = await makeWorld();
  const crew = expectOk(await w.A('crew.create', { name: '重复并发' }));
  const results = await Promise.all([1, 2].map(() => w.B('crew.join', { inviteCode: crew.inviteCode })));
  const data = results.map(expectOk);
  assert.equal(data.filter(r => r.joined).length, 1);
  assert.equal((await w.repo.get(C.CREWS, crew.crewId)).memberCount, 2);
  assert.equal(await w.repo.count(C.CREW_MEMBERS, { crewId: crew.crewId, userId: 'openid_B' }), 1);
});

test('并发退出与移除同一人只减一次，重复移除不减成负数', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);
  const results = await Promise.all([w.B('crew.leave', { crewId }), w.A('crew.remove', { crewId, userId: 'openid_B' })]);
  assert.ok(results.some(r => r.ok));
  expectOk(await w.A('crew.remove', { crewId, userId: 'openid_B' }));
  assert.equal((await w.repo.get(C.CREWS, crewId)).memberCount, 2);
  assert.equal(await w.repo.count(C.CREW_MEMBERS, { crewId, status: 'active' }), 2);
});

test('事务中途失败回滚成员变更、计数及同意记录', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);
  const before = await w.repo.get(C.CREWS, crewId);
  const events = await w.repo.count(C.PRIVACY_CONSENTS, {});
  const run = w.repo.runTransaction.bind(w.repo);
  w.repo.runTransaction = (fn, collections) => run(async tx => {
    const update = tx.update.bind(tx);
    tx.update = (collection, ...args) => {
      if (collection === C.CREWS) throw new Error('注入事务提交前失败');
      return update(collection, ...args);
    };
    return fn(tx);
  }, collections);
  const log = console.error; console.error = () => {};
  try { expectFail(await w.B('crew.leave', { crewId }), 'INTERNAL'); }
  finally { console.error = log; }
  assert.deepEqual(await w.repo.get(C.CREWS, crewId), before);
  assert.equal((await w.repo.findOne(C.CREW_MEMBERS, { crewId, userId: 'openid_B' })).status, 'active');
  assert.equal(await w.repo.count(C.PRIVACY_CONSENTS, {}), events);
});

test('北京时间星期在各服务器时区、跨周/月/年边界一致，空时间不伪造星期', t => {
  const previous = process.env.TZ;
  t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
  for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
    process.env.TZ = tz;
    for (const [instant, expected] of [
      ['2026-10-18T15:59:59Z', 0], ['2026-10-18T16:00:00Z', 1],
      ['2026-10-18T23:59:59Z', 1], ['2026-10-31T16:00:00Z', 0],
      ['2026-12-31T16:00:00Z', 5],
    ]) assert.equal(time.weekdayOf(instant), expected, tz + ':' + instant);
  }
  assert.equal(time.weekdayOf(null), null);
  assert.equal(time.weekdayOf('invalid'), null);
});

test('实际规划产生的步行样本以北京时间记录凌晨星期与时段', async () => {
  const w = await makeWorld({ now: '2026-10-18T16:30:00Z' });
  expectOk(await w.A('trip.plan', { startAt: w.NOW, places: [0, 1].map(i => ({ name: '时区样本' + i,
    location: { latitude: 45.77, longitude: 126.62 + i * 0.002 } })) }));
  const samples = await w.repo.find(C.WALK_SAMPLES, {});
  assert.ok(samples.length > 0);
  assert.ok(samples.every(s => s.weekday === 1 && s.timeBucket === 'night'));
});

test('建队/入队和历史共享标记都不能伪造同意；明确开启后才记录本版说明并接受上报', async () => {
  const w = await makeWorld();
  const crew = expectOk(await w.A('crew.create', { name: '同意留痕', shareLocationDefault: true }));
  expectOk(await w.B('crew.join', { inviteCode: crew.inviteCode }));
  assert.equal(await w.repo.count(C.PRIVACY_CONSENTS, {}), 0);
  const member = await w.repo.findOne(C.CREW_MEMBERS, { crewId: crew.crewId, userId: 'openid_A' });
  await w.repo.update(C.CREW_MEMBERS, member._id, { locationSharing: true }); // 历史标记。
  assert.equal(expectOk(await w.A('crew.get', { crewId: crew.crewId })).members.find(m => m.userId === 'openid_A').locationSharing, false);
  expectFail(await w.A('loc.report', { crewId: crew.crewId, point, source: 'gps' }), 'LOCATION_SHARING_OFF');
  expectFail(await w.A('loc.stopSharing', { crewId: crew.crewId, sharing: true }), 'INVALID_PARAM');
  expectFail(await w.A('loc.stopSharing', { crewId: crew.crewId, sharing: true, policyVersion: 'old' }), 'INVALID_PARAM');
  assert.equal(await w.repo.count(C.PRIVACY_CONSENTS, {}), 0);
  await enableLocation(w, 'A', crew.crewId);
  const consent = await w.repo.findOne(C.PRIVACY_CONSENTS, { userId: 'openid_A' });
  assert.equal(consent.policyVersion, POLICY_VERSION);
  assert.equal(consent.purpose, 'crew_location_sharing');
  assert.equal(consent.granted, true);
  assert.equal(new Date(consent.grantedAt).getTime(), w.NOW.getTime());
  assert.equal(consent.point, undefined);
  expectOk(await w.A('loc.report', { crewId: crew.crewId, point, source: 'gps' }));
  const seen = expectOk(await w.B('loc.list', { crewId: crew.crewId }));
  assert.equal(seen.members.find(m => m.userId === 'openid_A').hasLocation, true);
});

test('关闭记录撤回时间且禁止继续上报；重新入队不能恢复旧同意', async () => {
  const w = await makeWorld();
  const { crewId, inviteCode } = await makeCrew(w);
  const later = w.plusMin(10);
  expectOk(await w.B('loc.stopSharing', { crewId, sharing: false }, { now: later }));
  const revoked = await w.repo.findOne(C.PRIVACY_CONSENTS, { userId: 'openid_B', granted: false });
  assert.equal(new Date(revoked.revokedAt).getTime(), later.getTime());
  expectFail(await w.B('loc.report', { crewId, point, source: 'gps' }), 'LOCATION_SHARING_OFF');
  expectOk(await w.B('crew.leave', { crewId }));
  expectOk(await w.B('crew.join', { inviteCode }));
  const member = await w.repo.findOne(C.CREW_MEMBERS, { crewId, userId: 'openid_B' });
  assert.equal(member.locationSharing, false);
  assert.equal(member.locationConsentPolicyVersion, null);
  expectFail(await w.B('loc.report', { crewId, point, source: 'gps' }), 'LOCATION_SHARING_OFF');
});

test('定位上传与关闭共享交错时，关闭先提交则旧上传必须失败', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);
  const run = w.repo.runTransaction.bind(w.repo);
  let entered, release, held = false;
  const ready = new Promise(r => { entered = r; });
  const gate = new Promise(r => { release = r; });
  w.repo.runTransaction = (fn, collections) => run(async tx => {
    const insert = tx.insert.bind(tx);
    tx.insert = async (collection, data) => {
      if (!held && collection === C.LOCATIONS) { held = true; entered(); await gate; }
      return insert(collection, data);
    };
    return fn(tx);
  }, collections);
  const reporting = w.B('loc.report', { crewId, point, source: 'gps' });
  await ready;
  expectOk(await w.B('loc.stopSharing', { crewId, sharing: false }));
  release(); expectFail(await reporting, 'LOCATION_SHARING_OFF');
  assert.equal(await w.repo.count(C.LOCATIONS, { crewId }), 0);
});

test('小程序与云端说明版本一致，服务只在明确开启时上传版本，不因恢复前台补写同意', async () => {
  const client = require('../miniprogram/utils/location-consent');
  assert.equal(client.POLICY_VERSION, POLICY_VERSION);
  const { createLocationSharing } = require('../miniprogram/utils/location-sharing');
  const calls = [];
  const service = createLocationSharing({ wx: { getStorageSync: () => '' }, getCrewId: () => '',
    callApi: async (action, payload) => { calls.push({ action, payload }); return { ok: true }; } });
  await service.setForeground(true);
  assert.equal(calls.length, 0);
});

test('建队时成员写入失败也回滚队伍，不能留下没有队长的队伍', async () => {
  const w = await makeWorld();
  const run = w.repo.runTransaction.bind(w.repo);
  w.repo.runTransaction = (fn, collections) => run(async tx => {
    const insert = tx.insert.bind(tx);
    tx.insert = (collection, data) => {
      if (collection === C.CREW_MEMBERS) throw new Error('注入队长写入失败');
      return insert(collection, data);
    };
    return fn(tx);
  }, collections);
  const log = console.error; console.error = () => {};
  try { expectFail(await w.A('crew.create', { name: '原子建队' }), 'INTERNAL'); }
  finally { console.error = log; }
  assert.equal(await w.repo.count(C.CREWS, {}), 0);
  assert.equal(await w.repo.count(C.CREW_MEMBERS, {}), 0);
});

test('非成员不能记录同意，用户不能借请求字段替别人同意', async () => {
  const w = await makeWorld();
  const crew = expectOk(await w.A('crew.create', { name: '身份边界' }));
  expectFail(await w.B('loc.stopSharing', { crewId: crew.crewId, sharing: true, policyVersion: POLICY_VERSION }), 'FORBIDDEN_NOT_MEMBER');
  assert.equal(await w.repo.count(C.PRIVACY_CONSENTS, {}), 0);
  expectOk(await w.A('loc.stopSharing', { crewId: crew.crewId, sharing: true, policyVersion: POLICY_VERSION, userId: 'openid_B' }));
  assert.equal(await w.repo.count(C.PRIVACY_CONSENTS, { userId: 'openid_B' }), 0);
  assert.equal(await w.repo.count(C.PRIVACY_CONSENTS, { userId: 'openid_A', granted: true }), 1);
});

test('解散先提交时，已读取旧队伍状态的上传不能在解散后落库', async () => {
  const w = await makeWorld();
  const { crewId } = await makeCrew(w);
  const run = w.repo.runTransaction.bind(w.repo);
  let entered, release, held = false;
  const ready = new Promise(r => { entered = r; });
  const gate = new Promise(r => { release = r; });
  w.repo.runTransaction = (fn, collections) => run(async tx => {
    const insert = tx.insert.bind(tx);
    tx.insert = async (collection, data) => {
      if (!held && collection === C.LOCATIONS) { held = true; entered(); await gate; }
      return insert(collection, data);
    };
    return fn(tx);
  }, collections);
  const reporting = w.B('loc.report', { crewId, point, source: 'gps' });
  await ready;
  expectOk(await w.A('team.close', { crewId }));
  release(); expectFail(await reporting, 'FORBIDDEN_NOT_MEMBER');
  assert.equal(await w.repo.count(C.LOCATIONS, { crewId }), 0);
});

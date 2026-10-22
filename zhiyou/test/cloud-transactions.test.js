'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');

const FIELD_SET = Symbol('db.command.set');
const command = { set: value => ({ [FIELD_SET]: value }) };
const isPlain = value => Object.prototype.toString.call(value) === '[object Object]';
// 对齐线上 SDK：普通嵌套对象展开为字段路径，不能在 null 下创建子字段。
// 显式 command.set 则整体替换字段，数组和 Date 也应保留原值。
function applyCloudUpdate(before, patch) {
  const result = structuredClone(before);
  function write(target, key, value) {
    if (value && Object.hasOwn(value, FIELD_SET)) { target[key] = structuredClone(value[FIELD_SET]); return; }
    if (isPlain(value)) {
      if (!Object.keys(value).length) return;
      if (target[key] === null || (target[key] !== undefined && !isPlain(target[key]))) {
        throw new Error("Cannot create field '" + Object.keys(value)[0] + "' in element {" + key + ': null}');
      }
      if (target[key] === undefined) target[key] = {};
      for (const [nestedKey, nestedValue] of Object.entries(value)) write(target[key], nestedKey, nestedValue);
    } else target[key] = structuredClone(value);
  }
  for (const [key, value] of Object.entries(patch)) write(result, key, value);
  return result;
}

function harness(options = {}) {
  const data = new Map([['crews/c1', { _id: 'c1', memberCount: 1, revision: 0 }]]);
  const calls = [];
  let failMissing = Boolean(options.missing);
  const db = {
    command,
    createCollection: async name => { calls.push(['createCollection', name]); },
    async runTransaction(fn) {
      if (failMissing) { failMissing = false; throw { errCode: -502005, errMsg: 'collection not exists' }; }
      const staged = new Map(data);
      const native = { collection: collection => ({
        // where()/count() 故意不提供，防止把内存查询写成云上不支持的事务查询。
        doc: id => ({
          get: async () => { calls.push(['get', collection, id]); return { data: staged.get(collection + '/' + id) || null }; },
          set: async options => {
            assert.ok(options.data, '微信 SDK 的 doc.set 参数是 {data}');
            staged.set(collection + '/' + id, { ...options.data, _id: id });
          },
          update: async options => {
            const key = collection + '/' + id;
            assert.ok(staged.has(key));
            staged.set(key, applyCloudUpdate(staged.get(key), options.data));
          },
        }),
      }) };
      const result = await fn(native);
      data.clear(); for (const [key, value] of staged) data.set(key, value);
      return options.wrapResult ? { result, errMsg: 'runTransaction:ok' } : result;
    },
  };
  const filename = path.join(__dirname, '../cloudfunctions/api/lib/repo/cloud.js');
  const realRequire = createRequire(filename);
  const box = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: box, console,
    require: name => name === 'wx-server-sdk' ? { __zy_inited: true, database: () => db } : realRequire(name),
  }, { filename });
  return { repo: box.exports.createCloudRepo(), data, calls };
}

for (const wrapResult of [false, true]) {
  test(`云仓储事务只用文档操作，原样返回业务值（SDK 包装=${wrapResult}）`, async () => {
    const { repo, data } = harness({ wrapResult });
    const result = await repo.runTransaction(async tx => {
      const crew = await tx.get('crews', 'c1');
      const member = await tx.insert('crew_members', { userId: 'B' });
      await tx.update('crews', 'c1', { memberCount: crew.memberCount + 1, revision: crew.revision + 1 });
      return { joined: true, memberId: member._id };
    });
    assert.equal(result.joined, true);
    assert.equal(data.get('crews/c1').memberCount, 2);
    assert.equal(data.get('crew_members/' + result.memberId).userId, 'B');
  });
}

test('云事务异常不留部分写入，首次缺集合只在事务外建立后重试', async () => {
  const { repo, data, calls } = harness({ missing: true });
  await assert.rejects(repo.runTransaction(async tx => {
    await tx.update('crews', 'c1', { memberCount: 9 });
    throw new Error('reject');
  }, ['privacy_consents']), /reject/);
  assert.equal(data.get('crews/c1').memberCount, 1);
  assert.deepEqual(calls.filter(c => c[0] === 'createCollection'), [['createCollection', 'privacy_consents']]);
});

test('文档读取报缺集合不能被吞成不存在的文档', async () => {
  const { cloudTransactionRepo } = require('../cloudfunctions/api/lib/repo/transaction');
  const missing = { errCode: -502005, errMsg: 'document.get:fail database collection not exist' };
  const tx = cloudTransactionRepo({ collection: () => ({ doc: () => ({ get: async () => { throw missing; } }) }) });
  await assert.rejects(tx.get('privacy_consents', 'id'), e => e === missing);
});

test('云事务将历史 null 的 lastResponse/place 整体写为对象，保留其他字段与日期', async () => {
  const { repo, data } = harness();
  const createdAt = new Date('2026-10-17T00:00:00Z'), expiresAt = new Date('2026-10-17T01:00:00Z');
  data.set('guide_sessions/s1', { _id: 's1', ownerId: 'owner', createdAt, version: 0, place: null, lastResponse: null });
  await repo.runTransaction(tx => tx.update('guide_sessions', 's1', {
    version: 1, place: { name: '中央大街', point: { latitude: 45.77, longitude: 126.62 } },
    lastResponse: { answer: '请确认地点', meetingDraft: null }, expiresAt,
  }));
  const saved = data.get('guide_sessions/s1');
  assert.equal(saved.lastResponse.answer, '请确认地点'); assert.equal(saved.place.point.latitude, 45.77);
  assert.equal(saved.ownerId, 'owner'); assert.deepEqual(saved.createdAt, createdAt);
  assert.deepEqual(saved.expiresAt, expiresAt); assert.ok(saved.updatedAt instanceof Date);
});

test('云事务替换对象时不残留旧回答/集合建议，空对象与空数组可真正清空', async () => {
  const { repo, data } = harness();
  data.set('guide_sessions/s1', { _id: 's1', lastResponse: { answer: '旧回答', removedField: '旧字段',
    meetingDraft: { point: { latitude: 45.77, longitude: 126.62 } } }, place: { name: '旧地点' },
    extras: { old: true }, candidates: [{ id: 'old' }] });
  await repo.runTransaction(tx => tx.update('guide_sessions', 's1', {
    lastResponse: { answer: '新回答', meetingDraft: null }, place: null, extras: {}, candidates: [],
  }));
  const saved = data.get('guide_sessions/s1');
  assert.deepEqual(saved.lastResponse, { answer: '新回答', meetingDraft: null });
  assert.equal(saved.place, null); assert.deepEqual(saved.extras, {}); assert.deepEqual(saved.candidates, []);
});

test('真实助手接口经过云事务更新语义：首次提问、确认、集合建议及换地点均可保存', async () => {
  const { makeWorld, makeCrew, expectOk, C } = require('./helpers');
  const { cloudTransactionRepo } = require('../cloudfunctions/api/lib/repo/transaction');
  const point = { latitude: 45.77, longitude: 126.62 };
  const w = await makeWorld({ createGuideProvider: () => ({ modelAvailable: false, visionAvailable: false }),
    createMapProvider: () => ({ searchPlaces: async options => ({ ok: true, items: [{ title: options.keyword,
      address: '哈尔滨', location: point }] }) }) });
  const { crewId } = await makeCrew(w);
  const memoryTransaction = w.repo.runTransaction.bind(w.repo);
  w.repo.runTransaction = (work, collections) => memoryTransaction(async tx => {
    const native = { collection: collection => ({ doc: id => ({
      get: async () => ({ data: await tx.get(collection, id) }),
      update: async options => tx.update(collection, id, applyCloudUpdate(await tx.get(collection, id), options.data)),
    }) }) };
    return work(cloudTransactionRepo(native, command));
  }, collections);
  const first = expectOk(await w.A('guide.ask', { crewId, text: '介绍中央大街' }));
  assert.equal(first.version, 1); assert.equal(first.place, null);
  const selected = expectOk(await w.A('guide.ask', { crewId, sessionId: first.sessionId,
    candidateId: first.candidates[0].id }, { expectedVersion: first.version }));
  assert.equal(selected.place.name, '中央大街'); assert.ok(selected.evidence.length);
  const meeting = expectOk(await w.A('guide.ask', { crewId, sessionId: first.sessionId,
    text: '在这里集合吧' }, { expectedVersion: selected.version }));
  assert.equal(meeting.meetingDraft.name, '中央大街');
  const changed = expectOk(await w.A('guide.ask', { crewId, sessionId: first.sessionId,
    text: '介绍太阳岛' }, { expectedVersion: meeting.version }));
  assert.equal(changed.place, null); assert.equal(changed.meetingDraft, null);
  const confirmed = expectOk(await w.A('guide.ask', { crewId, sessionId: first.sessionId,
    candidateId: changed.candidates[0].id }, { expectedVersion: changed.version }));
  assert.equal(confirmed.place.name, '太阳岛'); assert.ok(confirmed.sources.some(row => row.id === 'sun-island'));
  const saved = await w.repo.get(C.GUIDE_SESSIONS, first.sessionId);
  assert.equal(saved.lastResponse.meetingDraft, null); assert.equal(saved.lastResponse.place.name, '太阳岛');
  assert.equal(saved.version, 5); assert.equal(await w.repo.count(C.MEET_TASKS), 0);
});

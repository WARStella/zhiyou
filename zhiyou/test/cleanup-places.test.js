const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, expectOk, expectFail, C } = require('./helpers');
test('占位清理跨页删除明确占位记录，保留未核验真实地点，重复执行安全', async () => {
  const w = await makeWorld();
  for(let i=0;i<105;i++) await w.repo.insert(C.PLACES,{name:'地点（占位）'+i});
  const real=await w.repo.insert(C.PLACES,{name:'真实地点',confidence:'low',verifiedAt:null});
  await w.repo.insert(C.PLACES,{name:'旧示例',dataSource:'PLACEHOLDER_待踏勘'});
  expectFail(await w.A('ops.cleanupPlaceholderPlaces',{}),'INVALID_PARAM');
  const listed=expectOk(await w.A('place.list',{}));
  assert.ok(!listed.places.some(p=>p.name.includes('（占位）')));
  assert.equal(expectOk(await w.A('ops.cleanupPlaceholderPlaces',{confirm:true})).removed,106);
  assert.ok(await w.repo.get(C.PLACES,real._id));
  assert.equal(expectOk(await w.A('ops.cleanupPlaceholderPlaces',{confirm:true})).removed,0);
  const prod=await makeWorld({env:'prod'});
  expectFail(await prod.A('ops.cleanupPlaceholderPlaces',{confirm:true}),'FORBIDDEN_ENV');
});

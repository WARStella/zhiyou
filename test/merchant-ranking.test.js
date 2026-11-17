const test = require('node:test');
const assert = require('node:assert/strict');
const { rankMerchants, normalize } = require('../cloudfunctions/api/lib/guide/merchant-ranking');
const rows = [{ id: 'near', name: '近店', distanceMeters: 100, rating: null }, { id: 'better', name: '评分店', distanceMeters: 800, rating: { value: 4.8, scale: 5 }, popularity: { value: 120, metric: '月销量', period: '近30天' } }];
test('AI可结合真实指标改变距离顺序，原指标保留，推荐理由由真实字段生成', async () => {
  const result = await rankMerchants(rows, '想吃评分好的', { rankMerchants: async context => {
    assert.equal(context.merchants[0].rating, null);
    return { ok: true, data: { ranking: [{ id: 'better', factors: ['rating','popularity'] }, { id: 'near', factors: ['distance'] }] } };
  } });
  assert.equal(result.rankingMode, 'ai'); assert.equal(result.items[0].id, 'better');
  assert.deepEqual(result.items[0].reasons, ['评分 4.8/5', '近30天 月销量 120']);
  assert.deepEqual(result.items[0].popularity, rows[1].popularity);
});
test('伪造商户、重复遗漏商户、引用缺失指标或模型失败时明确回退距离排序', async () => {
  for (const ranking of [[{ id:'fake', factors:[] },{ id:'near', factors:[] }], [{ id:'near', factors:[] },{ id:'near', factors:[] }], [{ id:'near', factors:['rating'] },{ id:'better', factors:[] }], []]) {
    const result = await rankMerchants(rows, '', { rankMerchants: async () => ({ ok:true, data:{ranking} }) });
    assert.equal(result.rankingMode, 'distance'); assert.equal(result.items[0].id, 'near');
  }
});
test('缺失、无效评分或人气不变成零，真实零与评分满分保留', () => {
  assert.equal(normalize({ id:'a', distanceMeters:NaN, rating:{value:7,scale:5}, popularity:{value:10} }).rating, null);
  assert.equal(normalize({ id:'a', popularity:{value:10} }).popularity, null);
  assert.equal(normalize({ id:'a', distanceMeters:0, rating:{value:0,scale:5} }).distanceMeters, 0);
});

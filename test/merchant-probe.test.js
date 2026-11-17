const test = require('node:test');
const assert = require('node:assert/strict');
const { createMerchantSearch } = require('../cloudfunctions/api/lib/amap/merchants');
const point = { latitude: 45.767, longitude: 126.625 };
test('复用高德Key请求餐饮详情，评分与消费原样返回，缺失字段不补造', async () => {
  const p = createMerchantSearch({ key:'private-test', http: async url => {
    const u = new URL(url); assert.equal(u.searchParams.get('extensions'),'all'); assert.equal(u.searchParams.get('types'),'050000'); assert.equal(u.searchParams.get('location'),'126.625,45.767');
    return { json:{ status:'1', pois:[{id:'a', name:'餐厅', location:'126.625,45.767', biz_ext:{rating:'4.8',cost:'60'}}, {id:'b',name:'另一餐厅',location:'126.626,45.768',biz_ext:[]}] } };
  } });
  const r = await p.search(point); assert.equal(r.ok,true); assert.equal(r.ratingCount,1); assert.equal(r.costCount,1);
  assert.equal(r.items[0].rating,'4.8'); assert.equal(r.items[1].rating,null); assert.equal(r.items[1].averageCost,null);
  assert.ok(!JSON.stringify(r).includes('private-test'));
});
test('无Key不调用上游，鉴权失败或异常不泄露Key和请求地址', async () => {
  let calls = 0;
  const empty = await createMerchantSearch({key:'',http:async()=>{calls++}}).search(point); assert.equal(calls,0); assert.equal(empty.mapApiCalls,0);
  const denied = await createMerchantSearch({key:'secret',http:async()=>({json:{status:'0',infocode:'10012',info:'secret'}})}).search(point);
  assert.equal(denied.ok,false); assert.match(denied.message,/权限/); assert.ok(!JSON.stringify(denied).includes('secret'));
  const failed = await createMerchantSearch({key:'secret',http:async()=>{throw new Error('secret')}}).search(point); assert.ok(!JSON.stringify(failed).includes('secret'));
});

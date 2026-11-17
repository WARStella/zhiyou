const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, expectOk, C } = require('./helpers');
const { loadPage } = require('./page-harness');
const point = { latitude:45.767, longitude:126.625 };
const merchant = (id, extra={}) => ({ id, name:'餐厅'+id, address:'真实地图地址', location:point, distanceMeters:'80', rating:'4.3', averageCost:'32', ...extra });

test('附近美食直接返回真实商户和AI排序，不要求选景点、不改行程或集合', async () => {
  let searched;
  const w = await makeWorld({ createGuideProvider: () => ({ searchMerchants: async (center,query) => { searched={center,query}; return {ok:true,items:[merchant('a'),merchant('b',{rating:null,averageCost:null}),merchant('a')],mapApiCalls:1}; }, rankMerchants: async () => ({ok:true,data:{ranking:[{id:'a',factors:['rating','cost']},{id:'b',factors:['distance']}]}}) }) });
  const response = await w.A('guide.ask',{ text:'附近有什么好吃的，人均50以内',center:point });
  const r = expectOk(response); assert.deepEqual(searched.center,point); assert.equal(searched.query.types,'050000');
  assert.equal(r.merchants.length,2); assert.equal(r.merchants[1].rating,null); assert.equal(r.merchants[1].averageCost,null);
  assert.deepEqual(r.candidates,[]); assert.equal(r.rankingMode,'ai'); assert.match(r.notices[0],/未提供人气/);
  assert.equal(await w.repo.count(C.MEET_TASKS),0); assert.equal(await w.repo.count(C.TRIPS),0);
  const saved = expectOk(await w.A('guide.get',{sessionId:r.sessionId})); assert.equal(saved.merchants[0].id,'a');
});

test('无定位不调用商户接口，空结果和上游失败说明原因，不触发景点检索', async () => {
  let calls=0;
  const w=await makeWorld({createGuideProvider:()=>({searchMerchants:async()=>{calls++;return {ok:true,items:[],mapApiCalls:1}}})});
  const no=expectOk(await w.A('guide.ask',{text:'附近咖啡店'})); assert.equal(no.needsLocation,true); assert.equal(calls,0);
  const empty=expectOk(await w.A('guide.ask',{text:'附近咖啡店',center:point})); assert.match(empty.answer,/暂未找到/); assert.equal(calls,1);
  const failed=await makeWorld({createGuideProvider:()=>({searchMerchants:async()=>{throw Error('private')}})});
  const error=expectOk(await failed.A('guide.ask',{text:'附近超市',center:point})); assert.match(error.answer,/暂不可用/); assert.ok(!JSON.stringify(error).includes('private'));
});

test('商户导航使用该条历史回答对应商户，定位失败保留草稿且不发送商户请求', async () => {
  const p=loadPage('miniprogram/pages/guide/index.js',{wx:{getLocation:o=>o.success(point)},api:{'guide.ask':payload=>{assert.deepEqual(payload.center,point);return {ok:true,data:{sessionId:'s',version:1,answer:'推荐如下',merchants:[{...merchant('a'),rank:1,distanceMeters:80,rating:{value:4.3,scale:5},averageCost:32,reasons:[]}],rankingNote:'AI排序'}}}}});
  try {
    p.onLoad(); p.onText({detail:{value:'附近有什么好吃的'}}); await p.ask();
    const reply=p.data.messages.at(-1); assert.equal(reply.merchants[0].costLabel,'人均约 ¥32'); assert.equal(reply.merchants[0].distanceLabel,'80 米');
    p.openMerchant({currentTarget:{dataset:{message:reply.id,merchant:'a'}}});
    const opened=p.__wx.find(c=>c.fn==='openLocation'); assert.equal(opened.args.name,'餐厅a'); assert.equal(opened.args.latitude,point.latitude);
  } finally {p.onUnload();p.restore()}
  const denied=loadPage('miniprogram/pages/guide/index.js');
  try {denied.onLoad();denied.onText({detail:{value:'附近咖啡店'}});await denied.ask();assert.equal(denied.__calls.length,0);assert.equal(denied.data.text,'附近咖啡店');assert.equal(denied.data.messages.at(-1).failed,true)} finally {denied.onUnload();denied.restore()}
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMinutes } = require('../miniprogram/utils/stay-duration');
const { loadPage, node } = require('./page-harness');
test('时长接受整数分钟，拒绝空值、负数、小数、非数值与超范围输入', () => {
  assert.equal(parseMinutes(' 25 '), 25);
  for (const v of ['', ' ', '-1', '0', '1.5', '十五', 'Infinity', '1441']) assert.throws(() => parseMinutes(v));
});
function page(response) {
  const p=loadPage('miniprogram/pages/trip/index.js',{
    wx:{showModal:opts=>opts.success(response)},
    api:{'trip.adjust':{ok:true,data:{candidates:[],excludedReasons:[]}}},
  });
  p.applyTrip({tripId:'t1',version:1,nodes:[node('n1','景点','pending',0)],saved:true},'');
  return p;
}
test('个人增加和缩短停留均传递用户填写的分钟数',async()=>{
  for(const key of ['extend','shorten']){
    const p=page({confirm:true,content:'35'});
    await p.nodeAction({currentTarget:{dataset:{nodeid:'n1',key}}});
    const call=p.__calls.find(x=>x.action==='trip.adjust');
    assert.equal(call.payload.trigger.payload.deltaMin,35);
    assert.equal(call.payload.trigger.type,key==='extend'?'extend_stay':'shorten_stay');
  }
});
test('取消和无效时长不会发送调整请求，且恢复按钮状态',async()=>{
  for(const response of [{confirm:false},{confirm:true,content:'-5'}]){
    const p=page(response);
    await p.nodeAction({currentTarget:{dataset:{nodeid:'n1',key:'extend'}}});
    assert.ok(!p.__calls.some(x=>x.action==='trip.adjust'));
    assert.equal(p.data.busy,'');
  }
});

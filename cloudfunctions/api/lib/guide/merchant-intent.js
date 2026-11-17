'use strict';
function merchantIntent(text) {
  if (!/附近|周边|这周围|这附近/.test(text) || /不要推荐|不用推荐|不需要推荐/.test(text)) return null;
  for (const [pattern, keyword, types, label] of [
    [/咖啡/, '咖啡', '050000', '咖啡店'], [/奶茶|饮品/, '奶茶', '050000', '饮品店'], [/甜品|蛋糕/, '甜品', '050000', '甜品店'],
    [/火锅/, '火锅', '050000', '火锅店'], [/烧烤/, '烧烤', '050000', '烧烤店'],
    [/便利店/, '便利店', '060000', '便利店'], [/超市/, '超市', '060000', '超市'], [/药店/, '药店', '090000', '药店'],
    [/酒店|宾馆/, '酒店', '100000', '酒店'], [/商场|购物/, '商场', '060000', '商场'],
    [/好吃|吃点|吃饭|美食|餐厅|饭店|饭馆|餐馆/, '', '050000', '餐饮商户']
  ]) if (pattern.test(text)) return { keyword, types, label };
  return null;
}
module.exports = { merchantIntent };

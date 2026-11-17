'use strict';

// Only an explicit, single-destination request starts initial planning. Questions,
// negation and multi-stop requests must not silently become a one-stop itinerary.
function planningDestination(value) {
  const text = String(value || '').trim();
  if (/(?:不想|不去|不要|不用|别|不需要)|[?？]|(?:吗|么)[。！!]*$/.test(text)) return '';
  let name = text.replace(/^(?:请|能不能|可以)?(?:帮我)?/, '');
  if (/^(?:我)?(?:想要去|想去|打算去|准备去|计划去)/.test(name)) {
    name = name.replace(/^(?:我)?(?:想要去|想去|打算去|准备去|计划去)/, '');
    name = name.replace(/[，,](?:请)?(?:帮我)?(?:规划|安排|生成)(?:一下|一个)?(?:游览)?(?:行程|路线|计划)[。！!]*$/, '');
  } else if (/^(?:规划|安排|生成)(?:一下|一个)?(?:去|到)/.test(name)) {
    name = name.replace(/^(?:规划|安排|生成)(?:一下|一个)?(?:去|到)/, '').replace(/的?(?:游览)?(?:行程|路线|计划)[。！!]*$/, '');
  } else return '';
  name = name.replace(/[。！!]+$/, '').trim();
  if (name.length < 2 || name.length > 40 || /[，,、；;<>:/\\]|然后|再去|还要|以及|和|停留|小时|分钟|明天|今天|后天|上午|下午|晚上|出发|[0-9一二三四五六七八九十]点/.test(name)) return '';
  return name;
}
module.exports = { planningDestination };

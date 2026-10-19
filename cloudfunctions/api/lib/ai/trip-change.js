'use strict';

const { createHttpParser } = require('./http');
const VERSION = 'trip-change-v6';
const SYSTEM_PROMPT = `你是当前旅游行程的修改意图解析器。输入是用户原话和服务器提供的当前行程上下文，输出 JSON。
只解析用户明确提出的修改，不编造地点、时长、距离或开放时间，不把疲惫等感受转换为具体数值。
结构：{"rawText":"原话","operations":[{"type":"extend_stay|shorten_stay|set_stay|skip_node|skip_remaining|protect_node|change_end_time|replace_node|add_node|change_travel_mode","target":"用户指代原站的原文","destination":"替换或新增目的地的原话关键词","mode":"change_travel_mode 时为 walking|bicycling|driving|transit|subway|auto","position":"add_node 时为 after 或 end","evidence":"该操作对应的完整原话片段","minutes":整数或null,"clock":"HH:mm或null"}],"uncertainties":["无法处理的要求"]}。
增减时长与设定总时长严格区分；不去了=skip_node，别删/不要跳过/一定要保留=protect_node；多条修改全部解析，禁止漏掉否定或额外要求。
“都不去了”“剩下的都不去了”“取消剩余行程”是 skip_remaining，取消所有尚未到达的站点；不需要追问是哪一站，不修改已到达或已完成的事实。没有剩余安排时允许结束行程，仍须用户确认。只说不去某一站仍为 skip_node。
这里/当前站只能由明确到达状态确定；再/刚才那里可参考上下文 lastTargetNodeId，无法确定时保留指代并由系统追问。
结束时间采用北京时间：下午五点=17:00，没说上下午的五点不得猜，clock=null。没有结束时间修改时不要产生此操作。
“不去最后一个地方了，改去哈工大”是一个 replace_node，target=最后一个地方，destination=哈工大，不能另输出 skip_node，也不能归为不支持的新增地点。目的地保留用户原话，不扩写简称、不编坐标，由系统搜索并让用户选定具体地点。“改去A”“改成去A”“改为去A”省略原站时 target=null，由系统按行程顺序替换下一待前往站；不得追问原站，也不得沿用最近修改对象或替换已到达站。明确说了原站则以原话为准。
“我去完哈尔滨学院想再去哈工大”是 add_node，target=哈尔滨学院，destination=哈工大，position=after；原站保留，不得改成替换或跳过。“再去哈工大”“新增一站哈工大”是 add_node，target=null，position=end，追加到末尾。地点名和参照站必须出自原话，不编坐标、ID或具体校区；系统检索后由用户选点。一个已完成地点可以作为新增位置的参照，但不能修改它的历史事实。
“我要坐地铁去，然后停留五十分钟”是 change_travel_mode（mode=subway、target=null）与 set_stay（minutes=50、target=null）两项，后项沿用前项站点。出行方式修改针对前往目标站的一段，省略目标时由系统选择下一待游览站。步行=walking，骑行=bicycling，驾车/打车=driving，公交=transit，地铁=subway，自动最快=auto；不编造路线或耗时。
缺少具体分钟或上下午等必要信息时保留字段为空，由系统生成可回答的追问，禁止再将同一缺失写入 uncertainties。省略替换原站时默认下一待前往站，仍须确认具体目的地。
只支持上述十类；重新排序等未支持要求必须放入 uncertainties，不得遗漏。不要输出说明或 Markdown。`;

function isCancelRemaining(text) {
  const s = String(text || '').trim();
  const scope = '(?:(?:后面|接下来|之后|剩下|剩余)(?:的)?(?:所有|全部)?(?:的)?(?:站点|地点|景点|行程)?|(?:所有|全部)(?:的)?(?:站点|地点|景点|行程)?)';
  return new RegExp('^(?:我|我们)?(?:' + scope + ')?(?:都|全|全部)(?:不去(?:了)?|取消(?:了)?|跳过(?:了)?)$').test(s) ||
    new RegExp('^(?:我|我们)?' + scope + '(?:不去(?:了)?|取消(?:了)?|跳过(?:了)?)$').test(s) ||
    new RegExp('^(?:取消|跳过)' + scope + '(?:了)?$').test(s);
}

function travelModeOf(text) {
  const labels = { 地铁: 'subway', 公交: 'transit', 公交车: 'transit', 步行: 'walking', 走路: 'walking',
    骑行: 'bicycling', 骑车: 'bicycling', 骑自行车: 'bicycling', 驾车: 'driving', 开车: 'driving', 打车: 'driving',
    自动: 'auto', 自动最快: 'auto' };
  const found = String(text).match(/地铁|公交车?|步行|走路|骑自行车|骑行|骑车|驾车|开车|打车|自动最快|自动/g) || [];
  const modes = [...new Set(found.map(label => labels[label]))];
  return modes.length === 1 ? modes[0] : null;
}

function number(text) {
  const s = String(text || '').trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (!/^[零〇一二两三四五六七八九十百千]+$/.test(s)) return null;
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let sum = 0, current = 0;
  for (const c of s) {
    if (Object.prototype.hasOwnProperty.call(digits, c)) current = digits[c];
    else { sum += (current || 1) * ({ 十: 10, 百: 100, 千: 1000 }[c]); current = 0; }
  }
  return sum + current;
}

function minutes(text) {
  const s = String(text || '').replace(/^(?:时间|改成|改为|改到|调整为|设为|设成|到|为|成|至|了|再|增加|减少|缩短|延长)+/, '').trim();
  if (s === '半小时' || s === '半个小时') return 30;
  const m = s.match(/^([\d.零〇一二两三四五六七八九十百千]+)(分钟|分|个小时|小时)(半)?$/);
  if (!m) return null;
  const n = number(m[1]);
  return n == null ? null : n * (/小时/.test(m[2]) ? 60 : 1) + (m[3] ? 30 : 0);
}

function clockOf(raw) {
  const s = raw.replace(/^(?:结束时间)?(?:改为|改成|改到|要在|必须在|在|最晚|请在|今天)+/, '')
    .replace(/(?:之前|以前|前)?(?:结束|返程|回去|返回)$/, '').replace(/前$/, '');
  const m = s.match(/^(上午|下午|晚上|中午|早上)?([\d零一二两三四五六七八九十]+)(?:点|:|：)([\d零一二三四五六七八九十]+|半)?(?:分)?$/);
  if (!m) return null;
  let h = number(m[2]); const min = m[3] === '半' ? 30 : m[3] ? number(m[3]) : 0;
  if (!m[1] && !/[:：]/.test(s) && h > 0 && h <= 12) return null;
  if (/^(下午|晚上|中午)$/.test(m[1]) && h < 12) h += 12;
  if (/^(上午|早上)$/.test(m[1]) && h === 12) h = 0;
  if (h == null || min == null || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

function ruleParse(text) {
  const operations = [], uncertainties = [];
  let evidence;
  const push = op => operations.push(Object.assign({ evidence }, op));
  const clauses = text.split(/[，,。；;！!]|(?:然后|并且|同时|但是|而且|但)/).map(s => s.trim()).filter(Boolean);
  for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex++) {
    let s = clauses[clauseIndex], joinedEvidence = null;
    // “去完 A，然后再去 B”跨分句仍是一项新增，不能把“完 A”当成目的地。
    if (/^(?:我)?(?:去完|逛完|游览完|参观完).+?(?:之后|以后|后)?$/.test(s) && !/再(?:去|逛|游览|参观)/.test(s) &&
      /^(?:我)?(?:还想|想|还要|要|还)?再(?:去|逛|游览|参观).+/.test(clauses[clauseIndex + 1] || '')) {
      const next = clauses[++clauseIndex];
      const from = text.indexOf(s), to = text.indexOf(next, from + s.length);
      joinedEvidence = text.slice(from, to + next.length); s += next;
    }
    s = s.replace(/^(?:请|帮我|把|再把|再|继续|我想|我想要)+/, '').replace(/[吧呀啊]$/, '');
    evidence = joinedEvidence || s;
    if (/和|以及|或者|还是|再(?=多|少|把|最后|第)/.test(s)) {
      uncertainties.push(`这句话包含多个或待选要求，请分开说明：“${s}”`); continue;
    }
    if (isCancelRemaining(s)) { push({ type: 'skip_remaining', target: '' }); continue; }
    if (/结束|结束时间|返程|回去|返回/.test(s)) {
      push({ type: 'change_end_time', clock: clockOf(s), target: '' }); continue;
    }
    const protect = s.match(/^(.*?)(别删(?:除)?|不要删(?:除)?|不删(?:除)?|不要取消|别取消|不要跳过|别跳过|必须保留|一定要保留|保留|一定要去|必须去)(.*?)$/);
    if (protect) {
      push({ type: 'protect_node', target: protect[1] || protect[3] }); continue;
    }
    if (/不要|别|不用|不想|不多|不少/.test(s) && !/不去了|不去(?:了)?$/.test(s)) {
      uncertainties.push(`请明确要保留还是调整：“${s}”`); continue;
    }
    const travel = s.match(/^(.*?)(?:改乘|改坐|换乘|换坐|改为|改成|乘坐|坐|乘|用)?(地铁|公交车?|步行|走路|骑自行车|骑行|骑车|驾车|开车|打车|自动最快|自动)(?:去|到)?(.*?)$/);
    if (travel && !/(?:停留|分钟|小时|换成|改去|新增|追加|添加|再去|去完)/.test(s) && !/^(?:站|站口)/.test(travel[3])) {
      const prefix = travel[1].replace(/^(?:我)?(?:想要|想|要)?/, '').replace(/(?:改用|改|出行方式)$/, '').trim();
      push({ type: 'change_travel_mode', mode: travelModeOf(travel[2]), target: prefix || travel[3].trim() }); continue;
    }
    const replacement = s.match(/^(.*?)(?:改成去|改为去|改去|换成|换去|改为|替换为|替换成)(.+)$/);
    if (replacement && !/(?:停留|多停|少停|多待|少待)/.test(replacement[1]) && minutes(replacement[2]) == null) {
      let target = replacement[1].replace(/^(?:不去|取消|跳过)/, '').replace(/(?:不去了|不去|了)$/, '').trim();
      const previous = operations[operations.length - 1];
      if (!target && previous && previous.type === 'skip_node') {
        target = previous.target; operations.pop(); evidence = previous.evidence + '，' + evidence;
      }
      push({ type: 'replace_node', target, destination: replacement[2].replace(/(?:吧|了)$/, '').trim() }); continue;
    }
    const skip = s.match(/^(.*?)(不去了|不去(?:了)?|跳过|取消)(.*?)$/);
    if (skip) { push({ type: 'skip_node', target: (skip[1] || skip[3]).replace(/了$/, '') }); continue; }
    const after = s.match(/^(?:我)?(?:去完|逛完|游览完|参观完)(.+?)(?:之后|以后|后)?(?:我)?(?:还想|想|还要|要|还)?再(?:去|逛|游览|参观)(.+)$/) ||
      s.match(/^(?:在)?(.+?)(?:之后|以后|后)(?:我)?(?:还想|想|还要|要|还|然后)?(?:再)?(?:去|逛|游览|参观)(.+)$/);
    if (after) {
      push({ type: 'add_node', target: after[1].trim(), destination: after[2].trim(), position: 'after' }); continue;
    }
    const addition = s.match(/^(?:我)?(?:还想|想|还要|要|还)?(?:再去|再逛|去(?!完)|追加(?:一站)?|新增(?:一站)?|加(?:上)?(?:一站|一个地点)|添加(?:一站)?)(.+)$/);
    if (addition) {
      push({ type: 'add_node', target: '', destination: addition[1].trim(), position: 'end' }); continue;
    }
    const stay = s.match(/^(.*?)(多(?:待|停留?|玩)|延长(?:停留)?|少(?:待|停留?|玩)|缩短(?:停留)?|停留|待|玩)(.*?)$/);
    if (stay) {
      const type = /^(多|延长)/.test(stay[2]) ? 'extend_stay' : /^(少|缩短)/.test(stay[2]) ? 'shorten_stay' : 'set_stay';
      push({ type, target: stay[1], minutes: minutes(stay[3]) }); continue;
    }
    uncertainties.push(`请明确这项修改的对象和操作：“${s}”`);
  }
  return { rawText: text, operations, uncertainties };
}

function validShape(p) {
  return p && Array.isArray(p.operations) && p.operations.length <= 10 &&
    Array.isArray(p.uncertainties) && p.uncertainties.every(s => typeof s === 'string') &&
    p.operations.every(o => o && ['extend_stay', 'shorten_stay', 'set_stay', 'skip_node', 'skip_remaining', 'protect_node', 'change_end_time', 'replace_node', 'add_node', 'change_travel_mode'].includes(o.type) &&
      typeof o.evidence === 'string' && o.evidence.trim().length > 0 &&
      (o.type !== 'skip_remaining' || isCancelRemaining(o.evidence)) &&
      (o.type !== 'change_travel_mode' || (o.mode && travelModeOf(o.evidence) === o.mode && !/不要|别|不用|不想/.test(o.evidence))) &&
      (!['replace_node', 'add_node'].includes(o.type) || (typeof o.destination === 'string' && o.destination.trim().length > 0 && o.evidence.includes(o.destination))) &&
      (o.type !== 'add_node' || (['after', 'end'].includes(o.position) &&
        (o.position === 'end' ? !o.target : typeof o.target === 'string' && o.target.trim() && o.evidence.includes(o.target)))) &&
      (o.target == null || typeof o.target === 'string'));
}

function grounded(p, text) {
  const operations = p.operations.map(o => {
    const op = Object.assign({}, o);
    if (op.type === 'replace_node') {
      const explicit = ruleParse(op.evidence).operations.find(item => item.type === 'replace_node');
      // 省略原站的口语由服务端取下一目标，模型不得擅自填成最近修改站。
      if (explicit && !explicit.target) { op.target = null; op.destination = explicit.destination; }
    }
    const explicit = (op.evidence.match(/[\d.零〇一二两三四五六七八九十百千]+(?:分钟|分|个小时|小时)(?:半)?|半个?小时/g) || []).map(minutes);
    // 仅有感受或模糊时长时，禁止采用模型猜出的数字；交给追问。
    if (/stay$/.test(op.type) && !explicit.includes(op.minutes)) op.minutes = null;
    if (op.type === 'change_end_time' && clockOf(op.evidence) !== op.clock) op.clock = null;
    return op;
  });
  const combined = [];
  for (const op of operations) {
    const previous = combined[combined.length - 1];
    const clean = s => String(s || '').replace(/[\s的了]/g, '')
      .replace(/^最后(?:一站|一个地方|一个地点|那个)$/, '最后一站');
    if (op.type === 'replace_node' && previous && previous.type === 'skip_node' &&
      (!op.target || clean(op.target) === clean(previous.target))) {
      combined.pop(); op.target = previous.target; op.evidence = text;
    }
    combined.push(op);
  }
  // 缺少原站是可回答的站点追问，不能同时变成永久禁用提交的 rewrite。
  const uncertainties = p.uncertainties.filter(message => !(combined.some(o => o.type === 'replace_node' && !o.target) &&
    /(?:替换|换掉|更换)(?:的|哪|原|目标|具体|站|一)|原站/.test(message) && /未说明|未指定|没说|不明确|追问|确认/.test(message)));
  return Object.assign({}, p, { rawText: text, operations: combined, uncertainties });
}

async function parse(text, context, opts) {
  opts = opts || {};
  const attempts = [];
  if (opts.preferModel !== false) {
    const parser = createHttpParser(Object.assign({}, opts, { systemPrompt: SYSTEM_PROMPT, promptVersion: VERSION }));
    const r = parser.available ? await parser.parse(text, { context }) : { ok: false, reason: 'NOT_CONFIGURED' };
    if (r.ok && validShape(r.parsed) && r.parsed.operations.every(o => text.includes(o.evidence))) {
      const rules = ruleParse(text);
      // 明确的替换句不能被模型遗漏成单独删除，或再次解释为不支持的新增地点。
      if (rules.operations.some(o => o.type === 'replace_node') && !r.parsed.operations.some(o => o.type === 'replace_node')) {
        attempts.push({ parser: 'http', reason: 'AI_MISSING_REPLACEMENT', message: '模型遗漏目的地替换，改用规则解析' });
      } else if (rules.operations.some(o => o.type === 'skip_remaining') && !r.parsed.operations.some(o => o.type === 'skip_remaining')) {
        attempts.push({ parser: 'http', reason: 'AI_MISSING_CANCELLATION', message: '模型遗漏取消剩余行程，改用规则解析' });
      } else if (rules.operations.some(o => o.type === 'add_node' && !r.parsed.operations.some(m =>
        m.type === 'add_node' && m.destination === o.destination && m.position === o.position && (m.target || '') === (o.target || '')))) {
        attempts.push({ parser: 'http', reason: 'AI_MISSING_ADDITION', message: '模型遗漏新增地点或插入位置，改用规则解析' });
      } else if (rules.operations.some(o => o.type === 'change_travel_mode' && !r.parsed.operations.some(m =>
        m.type === o.type && m.mode === o.mode && (m.target || '') === (o.target || '')))) {
        attempts.push({ parser: 'http', reason: 'AI_MISSING_TRAVEL_MODE', message: '模型遗漏出行方式修改，改用规则解析' });
      } else if (rules.operations.some(o => /stay$/.test(o.type) && o.minutes != null &&
        !r.parsed.operations.some(m => m.type === o.type && m.minutes === o.minutes))) {
        attempts.push({ parser: 'http', reason: 'AI_MISSING_STAY', message: '模型遗漏明确的停留时间修改，改用规则解析' });
      } else return { parsed: grounded(r.parsed, text), parser: 'http', model: parser.model,
        promptVersion: VERSION, degraded: false, attempts };
    } else {
      attempts.push({ parser: 'http', reason: r.reason || 'AI_INVALID_CHANGE', message: r.message || null });
    }
  }
  return { parsed: ruleParse(text), parser: 'rulebased', model: null, promptVersion: VERSION + '-rules',
    degraded: attempts.length > 0, attempts };
}

module.exports = { parse, ruleParse, number, minutes, clockOf, validShape, grounded, SYSTEM_PROMPT, VERSION };

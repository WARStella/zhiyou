'use strict';
// Offline visual review of the real WXML and WXSS with explicitly illustrative data.
// No cloud API or paid generation request is made here. Native map controls require device QA.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..'), MP = path.join(ROOT, 'miniprogram');
const OUT = path.join(ROOT, 'output/uiux-approved-preview-20261110');
fs.mkdirSync(OUT, { recursive: true });
const read = file => fs.readFileSync(path.join(MP, file), 'utf8');
const escape = value => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function evaluate(expression, data) { try { return vm.runInNewContext('(' + expression + ')', data, { timeout: 80 }); } catch (_) { return undefined; } }
function interpolate(value, data) { return String(value || '').replace(/\{\{([\s\S]*?)\}\}/g, (_, expression) => { const result = evaluate(expression, data); return result == null ? '' : result; }); }
function expression(value, data) { const match = String(value).match(/^\{\{([\s\S]*)\}\}$/); return match ? evaluate(match[1], data) : value; }
function parse(source) {
  const root = { tag: 'root', children: [] }, stack = [root];
  const tokens = source.replace(/<!--[\s\S]*?-->/g, '').match(/<(?:"[^"]*"|'[^']*'|[^'">])*?>|[^<]+/g) || [];
  for (const token of tokens) {
    if (!token.startsWith('<')) { stack[stack.length - 1].children.push({ text: token }); continue; }
    if (token.startsWith('</')) { stack.pop(); continue; }
    const tag = token.match(/^<([\w-]+)/)?.[1]; if (!tag) continue;
    const attrs = {};
    for (const m of token.slice(tag.length + 1).matchAll(/([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) attrs[m[1]] = m[2] ?? m[3] ?? true;
    const node = { tag, attrs, children: [] }; stack[stack.length - 1].children.push(node);
    if (!token.endsWith('/>') && !['import', 'include', 'br'].includes(tag)) stack.push(node);
  }
  return root.children;
}
const templates = new Map();
function template(file) { if (!templates.has(file)) templates.set(file, parse(read(file))); return templates.get(file); }
const mediaFixture = { tasks: [{ taskId: 'preview-image', kind: 'image', optionId: 'aliyun-image', kindLabel: '讲解配图', status: 'running', stateLabel: '生成中', tone: 'waiting', waiting: true },
  { taskId: 'preview-video', kind: 'video', optionId: 'aliyun-video', kindLabel: '讲解短片', status: 'pending', stateLabel: '排队中', tone: 'waiting', waiting: true }], busy: false, refreshing: false, canRefresh: true, imageLabel: '查看配图状态', videoLabel: '查看短片状态' };
const voiceFixture = { canSpeak: true, busy: false, version: 3, providerLabel: '腾讯云播报', playing: true, hasPlayed: true, statusText: '正在播报新安排', summaryOpen: true, summary: '行程已更新为第3版。下一站圣索菲亚教堂，计划停留20分钟。之后前往防洪纪念塔。' };
function children(nodes, data) {
  let html = '', chain = false;
  for (const node of nodes) {
    const a = node.attrs || {};
    if ('wx:if' in a) { chain = Boolean(expression(a['wx:if'], data)); if (!chain) continue; }
    else if ('wx:elif' in a) { if (chain) continue; chain = Boolean(expression(a['wx:elif'], data)); if (!chain) continue; }
    else if ('wx:else' in a) { if (chain) continue; chain = true; }
    else if (node.tag) chain = false;
    html += render(node, data);
  }
  return html;
}
function render(node, data, iterated) {
  if (node.text !== undefined) return escape(interpolate(node.text, data));
  const a = node.attrs;
  if (a['wx:for'] && !iterated) {
    const rows = expression(a['wx:for'], data) || [];
    return Array.from(rows).map((row, index) => render(node, { ...data, [a['wx:for-item'] || 'item']: row, [a['wx:for-index'] || 'index']: index }, true)).join('');
  }
  if (a.hidden && expression(a.hidden, data)) return '';
  if (node.tag === 'block' || node.tag === 'root') return children(node.children, data);
  if (['import', 'guide-entry', 'voice-input'].includes(node.tag)) return '';
  if (['guide-media', 'route-voice', 'team-chat-composer', 'photo-meeting'].includes(node.tag)) {
    const name = node.tag;
    const props = {};
    for (const [key, value] of Object.entries(a)) props[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = expression(value, data);
    const seed = name === 'guide-media' ? mediaFixture : name === 'route-voice' ? voiceFixture : name === 'photo-meeting'
      ? { imagePath: '', keyword: '', lines: [], candidates: [], searchOpen: false } : { text: '', blocked: false, sending: false, uncertain: false, voiceActive: false, voiceCanStop: false };
    return '<section class="preview-component preview-' + name + '">' + children(template('components/' + name + '/index.wxml'), { ...seed, ...props }) + '</section>';
  }
  const tags = { view: 'div', text: 'span', 'cover-view': 'div', 'cover-image': 'img', image: 'img', map: 'div', 'scroll-view': 'div', picker: 'div', switch: 'div' };
  const tag = tags[node.tag] || node.tag;
  let className = interpolate(a.class || '', data);
  if (node.tag === 'button') className += ' wx-button-size-' + (a.size || 'normal');
  if (node.tag === 'scroll-view') className += ' preview-scroll';
  if (node.tag === 'switch') className += ' preview-switch ' + (expression(a.checked, data) ? 'preview-checked' : '');
  const attrs = ' class="' + escape(className) + '"' + (a.style ? ' style="' + escape(rpx(interpolate(a.style, data))) + '"' : '') +
    (a.disabled && expression(a.disabled, data) ? ' disabled' : '');
  if (node.tag === 'input' || node.tag === 'textarea') {
    const value = interpolate(a.value || '', data), placeholder = interpolate(a.placeholder || '', data);
    return '<' + tag + attrs + ' placeholder="' + escape(placeholder) + '"' + (tag === 'input' ? ' value="' + escape(value) + '" />' : '>' + escape(value) + '</textarea>');
  }
  if (tag === 'img') {
    let src = interpolate(a.src || '', data);
    if (src.startsWith('/assets/')) src = 'file:///' + path.join(MP, src).replace(/\\/g, '/');
    return '<img' + attrs + ' src="' + escape(src) + '" />';
  }
  if (node.tag === 'br') return '<br />';
  const map = node.tag === 'map' ? '<div class="preview-map-art"><span class="preview-street">中央大街</span><span class="preview-landmark">圣索菲亚教堂</span><b class="preview-pin">●</b><b class="preview-person person-one">林</b><b class="preview-person person-two">我</b><b class="preview-person person-three">陈</b><small>地图布局示意 · 非真实位置</small></div>' : '';
  return '<' + tag + attrs + '>' + map + children(node.children, data) + '</' + tag + '>';
}
function rpx(source) { return source.replace(/(-?\d*\.?\d+)rpx\b/g, (_, n) => 'calc(' + n + ' * 100vw / 750)'); }
function css(file) { return rpx(read(file).replace(/(?<![\w.-])page\b/g, 'body').replace(/:host/g, '.preview-component').replace(/\bview(?=[\s:.{])/g, 'div')); }
function scopedCss(source, scope) {
  source = source.replace(/\/\*[\s\S]*?\*\//g, '');
  let result = '', cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('{', cursor); if (start < 0) break;
    let depth = 1, end = start + 1;
    while (end < source.length && depth) { if (source[end] === '{') depth++; if (source[end] === '}') depth--; end++; }
    const selector = source.slice(cursor, start).trim(), body = source.slice(start + 1, end - 1);
    if (selector.startsWith('@')) result += selector + '{' + (/^@(?:media|supports)/.test(selector) ? scopedCss(body, scope) : body) + '}';
    else result += selector.split(',').map(s => s.includes('.preview-component') ? s.replace(/\.preview-component/g, scope) : scope + ' ' + s.trim()).join(',') + '{' + body + '}';
    cursor = end;
  }
  return result;
}
function settingsData() {
  let page;
  const settings = { text: 'deepseek', image: 'aliyun-image', video: 'aliyun-video', tts: 'tencent-tts', autoSpeak: false };
  vm.runInNewContext(read('pages/ai-settings/index.js'), { Page: p => { page = p; }, require: id => id.endsWith('/api') ? {} : { readSettings: () => settings, saveSettings() {} } });
  page.data = { ...page.data }; page.setData = patch => Object.assign(page.data, patch);
  // Placeholder values only; these are never sent anywhere.
  page.options = require('../cloudfunctions/api/lib/media/catalog').catalog({ DEEPSEEK_API_KEY: 'preview', DASHSCOPE_API_KEY: 'preview', TTS_SECRET_ID: 'preview', TTS_SECRET_KEY: 'preview' });
  page.render(); return page.data;
}
const members = ['我', '小林', '阿陈', '小周'].map((label, i) => ({ userId: 'u' + i, initial: label.slice(-1), label, shortLabel: label, arrived: i === 1 || i === 2, status: i === 1 || i === 2 ? 'arrived' : 'confirmed' }));
const team = { crewId: 'preview-crew', crew: { name: '周末漫游小队' }, members, sharing: true, center: {}, markers: [], polyline: [],
  chatPreviewAvailable: true, chatPreview: [{ messageId: '1', initial: '林', name: '小林', text: '我在广场入口等大家' }, { messageId: '2', initial: '陈', name: '阿陈', text: '收到，马上到' }], memberChatCallouts: [],
  meetTime: '14:30', pointName: '广场入口指示牌旁', meetingPoint: { name: '圣索菲亚教堂广场' }, places: [1], nearby: [], currentPhotos: [], isOwner: true, isInitiator: true,
  teamBusy: false, myPoint: { latitude: 45.77, longitude: 126.62 }, mySource: 'gps', myAccuracyM: 12, myLocatedAt: '14:18', locationDetailOpen: false };
const meeting = { meetTaskId: 'preview-meet', status: 'confirmed', statusLabel: '集合中', timeLabel: '14:30', countdownLabel: '还有12分钟', placeName: '圣索菲亚教堂广场', participants: members, arrivedCount: 2, expectedCount: 4, arrivePercent: 50 };
const guide = { chatHeight: 800, scopeLabel: '当前个人行程', textModelLabel: 'DeepSeek V4.1 Flash', text: '', center: null, keyboardHeight: 0, sending: false, busy: false, voiceActive: false, imagePath: '',
  activeReplyId: 'reply', result: { place: { name: '中央大街' } },
  messages: [{ id: 'question', role: 'user', text: '讲讲中央大街的建筑' }, { id: 'reply', role: 'assistant', text: '中央大街沿街保留了多种风格的历史建筑。留意立面、窗饰与街道铺装，步行时会更有发现。', sources: [{ id: 'example', title: '示例来源' }], sourcesOpen: false, mediaAvailable: true, mediaSessionId: 'preview-session', mediaVersion: 1, mediaCrewId: '' }] };
const cases = [
  ['settings', 'AI与语音', 'pages/ai-settings/index', settingsData()],
  ['guide', '随行助手', 'pages/guide/index', guide],
  ['team-create', '队伍', 'pages/map/index', { ...team, meetTask: null }],
  ['team-meeting', '队伍', 'pages/map/index', { ...team, meetingPoint: null, meetTask: meeting }],
  ['team-depart', '队伍', 'pages/map/index', { ...team, meetingPoint: null, meetTask: { ...meeting, status: 'arrived_all', arrivedCount: 4, arrivePercent: 100, allArrivedAt: 'example', arrivedLabel: '14:18', participants: members.map(m => ({ ...m, arrived: true })) }, departureCheck: { canDepart: true, message: '检查通过，可确认出发', tripImpact: {} } }],
  ['route-voice', '行程播报组件', 'components/route-voice/index', { ...voiceFixture }],
];
const base = `*{box-sizing:border-box}html,body{margin:0;padding:0}div{display:block}button,input,textarea{font:inherit}button{border:0;border-radius:8px;cursor:pointer}button.wx-button-size-normal{width:184px;margin-left:auto;margin-right:auto}button:disabled{opacity:.5}img{max-width:100%}input,textarea{border:none}textarea{resize:none}body{padding-top:44px!important}.preview-scroll{overflow:auto}.preview-component{display:block;min-width:0}.preview-native{position:fixed;top:0;left:0;right:0;height:44px;z-index:100;background:#f4f7fb;display:flex;align-items:center;justify-content:center;font:600 16px sans-serif;color:#17324e}.preview-native span{position:absolute;left:18px}.preview-native i{position:absolute;right:18px;font-style:normal}.preview-switch{width:46px;height:28px;border-radius:20px;background:#e0e7ef;position:relative;flex:none}.preview-switch:after{content:'';position:absolute;background:white;border-radius:50%;width:24px;height:24px;left:2px;top:2px;box-shadow:0 1px 3px #aab7c8}.preview-switch.preview-checked{background:#2b5c8a}.preview-checked:after{left:20px}.preview-map-art{position:absolute;inset:0;background:repeating-linear-gradient(35deg,transparent 0 60px,#fff 61px 70px,transparent 71px 140px),repeating-linear-gradient(120deg,#e8edf2 0 55px,#fff 56px 64px,#e3efdf 65px 115px);color:#53687c}.preview-map-art small{position:absolute;bottom:4px;right:10px;font-size:10px}.preview-landmark{position:absolute;top:28%;left:26%;font-size:12px}.preview-street{position:absolute;top:50%;left:5%;font-size:12px;transform:rotate(35deg)}.preview-pin{position:absolute;top:45%;left:48%;color:#e8672b;font-size:26px}.preview-person{position:absolute;display:grid;place-items:center;width:36px;height:36px;border:2px solid #fff;border-radius:50%;background:#bfd9ef;box-shadow:0 2px 4px #9daebb}.person-one{left:20%;top:22%}.person-two{left:65%;top:18%}.person-three{left:58%;top:53%}.preview-review-note{position:fixed;bottom:0;left:0;right:0;z-index:200;background:#edf3f9;color:#667480;font:10px sans-serif;text-align:center;padding:4px}.preview-tabs{position:fixed;bottom:18px;left:0;right:0;height:48px;background:#fff;display:flex;align-items:center;justify-content:space-around;color:#667480;font-size:14px;border-top:1px solid #e6eaf0;z-index:90}.preview-tabs strong{color:#2b5c8a}`;
for (const [name, title, file, data] of cases) {
  let style = css('app.wxss') + css(file + '.wxss');
  for (const component of ['guide-media', 'route-voice', 'team-chat-composer', 'photo-meeting']) style += scopedCss(css('components/' + component + '/index.wxss'), '.preview-' + component);
  // Component styles are isolated in WeChat. In HTML, scope the generic classes to their own wrapper.
  if (file === 'pages/ai-settings/index' || file === 'components/route-voice/index') style = css('app.wxss') + css(file + '.wxss');
  const body = children(template(file + '.wxml'), data);
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + base + style + '</style><body><header class="preview-native"><span>‹</span>' + title + '<i>··· ◉</i></header>' + body +
    (name.startsWith('team') ? '<nav class="preview-tabs"><span>行程</span><strong>队伍</strong><span>我的</span></nav>' : '') + '<div class="preview-review-note">布局检查 · 示例数据 · 原生地图/媒体需真机复核</div><script>document.documentElement.dataset.horizontalOverflow=String(document.documentElement.scrollWidth>innerWidth);</script></body></html>';
  fs.writeFileSync(path.join(OUT, name + '.html'), html);
}
fs.writeFileSync(path.join(OUT, 'README.md'), '# UI布局检查\n\n由真实WXML与WXSS离线渲染，状态和地图为明确标注的示例。用于检查排版，不能作为微信原生地图、录音、媒体播放或线上接口的验收证据。\n');
console.log('Rendered ' + cases.length + ' source-based layout previews to ' + OUT);

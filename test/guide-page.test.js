const test = require('node:test');
const assert = require('node:assert/strict');
const { createGuideAssistant } = require('../miniprogram/utils/guide-assistant');
const { loadPage } = require('./page-harness');
const { makeWorld, makeCrew, expectOk, C } = require('./helpers');
const point = { latitude: 45.77, longitude: 126.62 };
const photo = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=';
const result = (extra = {}) => ({ sessionId: 'session', version: 1, candidates: [{ id: 'candidate', name: '中央大街', address: '哈尔滨', point }],
  messages: [], place: null, evidence: [], sources: [], trace: [], notices: [], ...extra });
function setup(extra = {}) {
  const state = {}, calls = [], removed = [], storage = {};
  let crewId = 'crew';
  const wx = {
    chooseMedia: options => options.success({ tempFiles: [{ tempFilePath: '/photo.jpg' }] }),
    compressImage: options => options.success({ tempFilePath: '/compressed.jpg' }),
    getFileSystemManager: () => ({ stat: options => options.success({ stats: { size: 68 } }),
      readFile: options => options.success({ data: photo }), unlink: options => { removed.push(options.filePath); options.success(); } }),
    getLocation: options => options.success(point),
    showModal: options => options.success({ confirm: true }),
    setStorageSync: (key, value) => { storage[key] = value; },
    switchTab: options => options.success({}), ...extra.wx,
  };
  const controller = createGuideAssistant({ wx, getCrewId: () => crewId,
    onState: patch => Object.assign(state, patch),
    callApi: async (action, payload, options) => {
      calls.push({ action, payload, options });
      return extra.api ? extra.api(action, payload, options) : { ok: true, data: result() };
    } });
  return { state, calls, removed, storage, controller, setCrew(value) { crewId = value; } };
}

test('拍照只本地预览，主动提问才传图；定位需点击、凭据不入页面、成功后清理草稿', async () => {
  const e = setup();
  await e.controller.choose(); assert.equal(e.calls.length, 0); assert.equal(e.state.imagePath, '/photo.jpg');
  await e.controller.locate(); assert.deepEqual(e.state.center, point);
  e.controller.setText('这是什么地方？'); await e.controller.ask();
  assert.equal(e.calls[0].action, 'guide.ask'); assert.equal(e.calls[0].payload.imageBase64, photo);
  assert.deepEqual(e.calls[0].payload.center, point); assert.deepEqual(e.removed, ['/compressed.jpg']);
  assert.equal(e.state.imagePath, ''); assert.equal(e.state.text, ''); assert.ok(!JSON.stringify(e.state).includes(photo));
  await e.controller.ask('fake'); assert.equal(e.calls.length, 1);
  await e.controller.ask('candidate'); assert.equal(e.calls[1].options.expectedVersion, 1);
  assert.equal(e.calls[1].payload.candidateId, 'candidate'); assert.equal(e.calls[1].payload.imageBase64, undefined);
});

test('切页/切队/销毁使迟到请求失效，拍照界面隐藏允许返回本地预览', async () => {
  for (const kind of ['hide', 'switch', 'dispose']) {
    let release;
    const e = setup({ api: () => new Promise(resolve => { release = resolve; }) });
    e.controller.setText('问题草稿'); const pending = e.controller.ask();
    if (kind === 'switch') { e.setCrew('other'); e.controller.show(); } else e.controller[kind]();
    release({ ok: true, data: result({ answer: '旧队伍结果' }) }); await pending;
    assert.ok(!e.state.result); assert.ok(!JSON.stringify(e.state).includes('旧队伍结果'));
  }
  let chooser;
  const e = setup({ wx: { chooseMedia: options => { chooser = options; } } });
  const pending = e.controller.choose(); e.controller.hide();
  chooser.success({ tempFiles: [{ tempFilePath: '/camera.jpg' }] }); await pending;
  assert.equal(e.state.imagePath, '/camera.jpg'); assert.equal(e.calls.length, 0);
});

test('版本冲突读取新会话但不自动重试模型，失败保留问题，过期及撤权清空相应结果', async () => {
  let count = 0;
  const e = setup({ api: async action => {
    count++;
    return count === 1 || action === 'guide.get' ? { ok: true, data: result({ version: count }) }
      : { ok: false, error: { code: 'VERSION_CONFLICT' } };
  } });
  e.controller.setText('中央大街'); await e.controller.ask();
  e.controller.setText('继续讲解'); await e.controller.ask();
  assert.deepEqual(e.calls.map(call => call.action), ['guide.ask', 'guide.ask', 'guide.get']);
  assert.equal(e.state.text, '继续讲解'); assert.equal(e.state.result.version, 3); assert.match(e.state.error, /没有自动重试/);
  for (const code of ['NOT_FOUND', 'FORBIDDEN_NOT_MEMBER']) {
    let first = true;
    const e = setup({ api: async () => { if (first) { first = false; return { ok: true, data: result() }; } return { ok: false, error: { code } }; } });
    e.controller.setText('中央大街'); await e.controller.ask(); e.controller.setText('继续'); await e.controller.ask();
    assert.equal(e.state.result, null);
  }
  const failed = setup({ api: async () => { throw new Error('断网'); } });
  failed.controller.setText('保留的问题'); await failed.controller.ask();
  assert.equal(failed.state.text, '保留的问题'); assert.equal(failed.state.busy, false);
});

test('集合手动确认和切队防回填，清除请求不会触发集合创建', async () => {
  let modal;
  const meetingDraft = { name: '中央大街', address: '哈尔滨', crewId: 'crew', point, action: 'select_meeting_point' };
  const e = setup({ api: async () => ({ ok: true, data: result({ meetingDraft }) }),
    wx: { showModal: options => { modal = options; } } });
  e.controller.setText('在这里集合'); await e.controller.ask();
  const pending = e.controller.useMeeting(); e.setCrew('other'); e.controller.show(); modal.success({ confirm: true }); await pending;
  assert.equal(e.storage['zhiyou-guide-meeting'], undefined);
  const good = setup({ api: async () => ({ ok: true, data: result({ meetingDraft }) }) });
  good.controller.setText('在这里集合'); await good.controller.ask(); await good.controller.useMeeting();
  assert.equal(good.storage['zhiyou-guide-meeting'].name, '中央大街');
  assert.equal(good.calls.some(call => call.action === 'meet.create'), false);
  await good.controller.clear(); assert.equal(good.calls.at(-1).action, 'guide.close'); assert.equal(good.state.result, null);
});

test('集合确认弹窗遵守按钮字数限制，确认后切换真实队伍 tab 并传递所选地点', async () => {
  const meetingDraft = { name: '中央大街', address: '哈尔滨', crewId: 'crew', point };
  const tabs = require('../miniprogram/app.json').tabBar.list.map(item => '/' + item.pagePath);
  let navigations = 0;
  const e = setup({ api: async () => ({ ok: true, data: result({ meetingDraft }) }), wx: {
    showModal: options => {
      if ([...options.confirmText].length > 4) {
        options.fail({ errMsg: 'showModal:fail confirmText length should not be larger than 4' }); return;
      }
      options.success({ confirm: true });
    },
    switchTab: options => { assert.ok(tabs.includes(options.url)); navigations++; options.success({}); },
  } });
  e.controller.setText('在这里集合'); await e.controller.ask(); await e.controller.useMeeting();
  assert.equal(navigations, 1); assert.equal(e.state.error, ''); assert.equal(e.state.busy, false);
  const p = loadPage('miniprogram/pages/map/index.js', { storage: { ...e.storage, 'zhiyou-active-crew': 'crew' } });
  try {
    p.setData({ crewId: 'crew' }); assert.equal(p.applyGuideMeeting(), true);
    assert.equal(p.data.pointName, '中央大街');
    assert.equal(p.data.meetingPoint.latitude, point.latitude); assert.equal(p.data.meetingPoint.longitude, point.longitude);
    assert.equal(p.__storage['zhiyou-guide-meeting'], undefined);
    assert.equal(p.__calls.some(call => call.action === 'meet.create'), false);
  } finally { p.restore(); }
});

test('集合确认取消不跳转，弹窗、保存和导航失败分别反馈且可重试', async () => {
  const meetingDraft = { name: '中央大街', address: '哈尔滨', crewId: 'crew', point };
  for (const stage of ['cancel', 'modal', 'storage', 'navigation']) {
    let navigations = 0, failOnce = stage !== 'cancel';
    const e = setup({ api: async () => ({ ok: true, data: result({ meetingDraft }) }), wx: {
      showModal: options => {
        if (stage === 'modal' && failOnce) { failOnce = false; options.fail({ errMsg: 'showModal:fail' }); return; }
        options.success({ confirm: stage !== 'cancel' });
      },
      ...(stage === 'storage' ? { setStorageSync: () => { if (failOnce) { failOnce = false; throw new Error('full'); } } } : {}),
      switchTab: options => {
        if (stage === 'navigation' && failOnce) { failOnce = false; options.fail({ errMsg: 'switchTab:fail' }); return; }
        navigations++; options.success({});
      },
    } });
    e.controller.setText('集合'); await e.controller.ask(); await e.controller.useMeeting();
    assert.equal(navigations, 0); assert.equal(e.state.busy, false);
    if (stage === 'cancel') { assert.equal(e.state.error, ''); assert.equal(e.storage['zhiyou-guide-meeting'], undefined); }
    else {
      assert.match(e.state.error, stage === 'modal' ? /确认/ : stage === 'storage' ? /保存/ : /队伍页/);
      await e.controller.useMeeting(); assert.equal(navigations, 1); assert.equal(e.state.error, '');
    }
  }
});

test('助手页面与真实接口联通，语音仅追加草稿，地点确认后继续检索有来源讲解', async () => {
  const w = await makeWorld({ createGuideProvider: () => ({ modelAvailable: false, visionAvailable: false }),
    createMapProvider: () => ({ searchPlaces: async () => ({ ok: true, items: [{ title: '中央大街', address: '哈尔滨市', location: point }] }) }) });
  const { crewId } = await makeCrew(w);
  const p = loadPage('miniprogram/pages/guide/index.js', { storage: { 'zhiyou-active-crew': crewId }, api: {
    'guide.ask': (payload, options) => w.A('guide.ask', payload, options),
    'guide.close': payload => w.A('guide.close', payload),
  } });
  try {
    p.onLoad(); p.onShow(); p.onVoiceState({ detail: { active: true } });
    await p.ask(); assert.equal(p.__calls.length, 0);
    p.onVoiceState({ detail: { active: false } }); p.onVoice({ detail: { text: '介绍中央大街' } });
    assert.equal(p.data.text, '介绍中央大街'); assert.equal(p.__calls.length, 0);
    await p.ask(); assert.ok(p.data.result.candidates.length);
    const before = p.data.voiceContext;
    await p.confirmPlace({ currentTarget: { dataset: { id: p.data.result.candidates[0].id } } });
    assert.equal(p.data.result.place.name, '中央大街'); assert.ok(p.data.result.evidence.length);
    assert.notEqual(p.data.voiceContext, before); assert.equal(await w.repo.count(C.MEET_TASKS), 0);
    p.onHide(); p.onVoice({ detail: { text: '不应回填' } }); assert.equal(p.data.text, '');
    p.onShow(); await p.clear(); assert.equal(p.data.result, null);
  } finally { p.onUnload(); p.restore(); }
});

test('队伍页只消费同队两分钟内的手动确认选点，已有集合不覆盖，也不自动发起', async () => {
  const KEY = 'zhiyou-guide-meeting';
  const p = loadPage('miniprogram/pages/map/index.js', { storage: { 'zhiyou-active-crew': 'crew',
    [KEY]: { ...point, name: '中央大街', address: '哈尔滨', crewId: 'crew', at: Date.now() } } });
  try {
    p.setData({ crewId: 'crew' });
    assert.equal(p.applyGuideMeeting(), true); assert.equal(p.data.meetingPoint.fromGuide, true);
    assert.equal(p.data.pointName, '中央大街'); assert.equal(p.__calls.some(call => call.action === 'meet.create'), false);
    assert.equal(p.applyGuideMeeting(), false);
    p.__storage[KEY] = { ...point, name: '不能替换', crewId: 'crew', at: Date.now() };
    p.setData({ meetTask: { meetTaskId: 'active' } });
    assert.equal(p.applyGuideMeeting(), false); assert.equal(p.data.meetingPoint.name, '中央大街');
    p.setData({ meetTask: null }); p.__storage[KEY] = { ...point, name: '已过期', crewId: 'crew', at: Date.now() - 130000 };
    assert.equal(p.applyGuideMeeting(), false);
    p.__storage[KEY] = { ...point, name: '其他队', crewId: 'other', at: Date.now() };
    assert.equal(p.applyGuideMeeting(), false);
  } finally { p.restore(); }
});

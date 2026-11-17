const test = require('node:test');
const assert = require('node:assert/strict');
const { createPhotoMeeting, initialState } = require('../miniprogram/utils/photo-meeting');
const { makeWorld, makeCrew, expectOk, C } = require('./helpers');
const { loadPage, loadComponent } = require('./page-harness');
const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=';
const point = { latitude: 45.7756, longitude: 126.6175 };
const candidate = { id: '0', name: '哈尔滨学院南门', address: '学府路', point, distanceMeters: 0 };
function setup(overrides = {}) {
  let crewId = 'crew1', currentPoint = point;
  const state = initialState(), calls = [], selected = [], removed = [];
  const wx = {
    chooseMedia: opts => opts.success({ tempFiles: [{ tempFilePath: '/chosen.jpg' }] }),
    compressImage: opts => opts.success({ tempFilePath: '/compressed.jpg' }),
    getFileSystemManager: () => ({ stat: opts => opts.success({ stats: { size: 68 } }),
      readFile: opts => opts.success({ data: imageBase64 }), unlink: opts => { removed.push(opts.filePath); opts.success(); } }),
    showModal: opts => {
      if ([...opts.confirmText].length > 4) opts.fail({ errMsg: 'showModal:fail confirmText length should not be larger than 4' });
      else opts.success({ confirm: true });
    },
    openLocation: opts => opts.success({}),
    ...overrides.wx,
  };
  const controller = createPhotoMeeting({ wx,
    getCrewId: () => crewId, getPoint: () => currentPoint,
    onState: patch => Object.assign(state, patch), onSelect: row => selected.push(row),
    callApi: async (action, payload) => {
      calls.push({ action, payload });
      if (overrides.api) return overrides.api(action, payload);
      return { ok: true, data: action === 'ocr.recognize' ? { lines: [{ text: '哈尔滨学院南门', confidence: 97 }] }
        : { candidates: [candidate] } };
    },
  });
  return { controller, state, calls, selected, removed, wx,
    setCrew(value) { crewId = value; }, setPoint(value) { currentPoint = value; } };
}

test('选图仅本地预览，主动识别才发图片；识别/搜索/取消确认均不改变集合点', async () => {
  const e = setup({ wx: { showModal: opts => opts.success({ confirm: false }) } });
  await e.controller.choose(); assert.equal(e.calls.length, 0); assert.equal(e.state.imagePath, '/chosen.jpg');
  await e.controller.recognize();
  assert.equal(e.state.keyword, '哈尔滨学院南门'); assert.deepEqual(e.removed, ['/compressed.jpg']);
  assert.equal(e.calls[0].action, 'ocr.recognize'); assert.equal(e.calls[0].payload.imageBase64, imageBase64);
  await e.controller.search(); assert.equal(e.calls[1].action, 'ocr.searchMeeting');
  assert.deepEqual(e.calls[1].payload.center, point); assert.equal(e.selected.length, 0);
  await e.controller.select('0'); assert.equal(e.selected.length, 0);
  await e.controller.select('forged'); assert.equal(e.selected.length, 0);
  e.controller.keyword('修正后的地点'); assert.equal(e.state.candidates.length, 0);
  e.controller.dispose();
});

test('无位置、取消选图、文件过大、空文字、服务故障都有手动输入退路', async () => {
  const e = setup(); e.setPoint(null); e.controller.keyword('学院');
  await e.controller.search(); assert.equal(e.calls.length, 0); assert.match(e.state.error, /当前位置/);
  e.setPoint(point); e.controller.keyword('门'); await e.controller.search(); assert.equal(e.calls.length, 0);
  const canceled = setup({ wx: { chooseMedia: opts => opts.fail({ errMsg: 'chooseMedia:fail cancel' }) } });
  await canceled.controller.choose(); assert.equal(canceled.state.error, ''); assert.equal(canceled.state.busy, false);
  const large = setup({ wx: { getFileSystemManager: () => ({ stat: opts => opts.success({ stats: { size: 2 * 1024 * 1024 } }),
    readFile() { assert.fail('大图不能读入内存'); }, unlink: opts => opts.success() }) } });
  await large.controller.choose(); await large.controller.recognize(); assert.equal(large.calls.length, 0); assert.match(large.state.error, /发送大小限制/);
  const empty = setup({ api: async () => ({ ok: true, data: { lines: [] } }) });
  await empty.controller.choose(); await empty.controller.recognize(); assert.match(empty.state.note, /没有识别到文字/);
  empty.controller.keyword('手动输入'); assert.equal(empty.state.keyword, '手动输入');
  const broken = setup({ api: async () => ({ ok: false, error: { code: 'OCR_NOT_CONFIGURED', message: '尚未配置 OCR' } }) });
  await broken.controller.choose(); await broken.controller.recognize(); assert.match(broken.state.error, /尚未配置/);
  assert.equal(broken.state.busy, false);
});

test('切页、切队、清除和销毁作废迟到识别，选图界面隐藏仍可返回本地预览', async () => {
  for (const stop of ['hide', 'reset', 'dispose', 'switch']) {
    let resolveApi, mark;
    const started = new Promise(resolve => { mark = resolve; });
    const e = setup({ api: () => { mark(); return new Promise(resolve => { resolveApi = resolve; }); } });
    await e.controller.choose(); const pending = e.controller.recognize(); await started;
    if (stop === 'switch') { e.setCrew('other'); e.controller.reset(); } else e.controller[stop]();
    resolveApi({ ok: true, data: { lines: [{ text: '旧队伍的照片', confidence: 98 }] } }); await pending;
    assert.equal(e.state.lines.length, 0); assert.equal(e.state.keyword, ''); assert.deepEqual(e.removed, ['/compressed.jpg']);
  }
  let chooser;
  const e = setup({ wx: { chooseMedia: opts => { chooser = opts; } } });
  const pending = e.controller.choose(); e.controller.hide();
  chooser.success({ tempFiles: [{ tempFilePath: '/camera.jpg' }] }); await pending;
  assert.equal(e.state.imagePath, '/camera.jpg'); assert.equal(e.calls.length, 0);
});

test('搜索结果、选点确认迟到不能跨队回填；撤权清空照片并禁用操作', async () => {
  let release;
  const e = setup({ api: () => new Promise(resolve => { release = resolve; }) });
  e.controller.keyword('学院'); const pending = e.controller.search();
  e.setCrew('crew2'); e.controller.reset(); release({ ok: true, data: { candidates: [candidate] } }); await pending;
  assert.deepEqual(e.state.candidates, []);
  const denied = setup({ api: async () => ({ ok: false, error: { code: 'FORBIDDEN_NOT_MEMBER', message: '已退出' } }) });
  await denied.controller.choose(); await denied.controller.recognize();
  assert.equal(denied.state.imagePath, ''); assert.equal(denied.state.blocked, true);
  await denied.controller.choose(); assert.equal(denied.state.imagePath, '');
  let modal;
  const confirm = setup({ wx: { showModal: opts => { modal = opts; } } });
  confirm.controller.keyword('学院'); await confirm.controller.search();
  const selecting = confirm.controller.select('0'); confirm.controller.reset(); modal.success({ confirm: true });
  await selecting; assert.equal(confirm.selected.length, 0);
});

test('真实 OCR→真实附近搜索→用户确认→地图选点→发起集合，只采用 POI 坐标且不自动创建任务', async () => {
  const w = await makeWorld({ createOcrProvider: () => ({ recognize: async () => ({ lines: [{ text: candidate.name, confidence: 98 }], provider: 'test' }) }),
    createMapProvider: () => ({ searchPlaces: async () => ({ ok: true, items: [{ title: candidate.name, address: candidate.address, location: point }] }) }) });
  const { crewId } = await makeCrew(w);
  const e = setup({ api: (action, payload) => w.A(action, { ...payload, crewId }) });
  await e.controller.choose(); await e.controller.recognize(); await e.controller.search();
  assert.equal(await w.repo.count(C.MEET_TASKS), 0); assert.equal(e.selected.length, 0);
  await e.controller.select('0'); assert.deepEqual(e.selected[0], { name: candidate.name, address: candidate.address, ...point });
  const p = loadPage('miniprogram/pages/map/index.js', { api: { 'meet.create': payload => w.A('meet.create', payload) } });
  try {
    p.setData({ crewId, myPoint: point, meetTime: '23:59' });
    p.onPhotoMeetingSelected({ detail: e.selected[0] });
    assert.deepEqual({ latitude: p.data.meetingPoint.latitude, longitude: p.data.meetingPoint.longitude }, point);
    assert.equal(p.data.meetingPoint.fromPhoto, true); assert.equal(await w.repo.count(C.MEET_TASKS), 0);
    // 页面时间按真实当天校验，真实 action 使用测试世界的服务端当天；统一到测试时刻。
    let submitted;
    p.doTeam = (action, payload) => {
      payload.plannedMeetAt = w.plusMin(30).toISOString();
      assert.equal(payload.method, 'manual'); assert.equal(payload.placeId, undefined);
      submitted = w.A(action, { ...payload, crewId }).then(expectOk);
    };
    p.createMeeting();
    await submitted;
    assert.equal(await w.repo.count(C.MEET_TASKS), 1);
    const task = (await w.repo.find(C.MEET_TASKS))[0];
    assert.deepEqual(task.point, point); assert.equal(task.placeName, candidate.name);
  } finally { p.restore(); }
});

test('真实组件绑定识别、搜索、位置预览及确认事件，地图注册入口且回退手动选点', async () => {
  const fs = require('node:fs');
  const apiPath = require.resolve('../miniprogram/utils/api'), saved = require.cache[apiPath];
  delete require.cache[apiPath];
  const w = await makeWorld({ createOcrProvider: () => ({ recognize: async () => ({ lines: [{ text: candidate.name, confidence: 98 }], provider: 'test' }) }),
    createMapProvider: () => ({ searchPlaces: async () => ({ ok: true, items: [{ title: candidate.name, address: candidate.address, location: point }] }) }) });
  const { crewId } = await makeCrew(w);
  const e = setup();
  let preview;
  const c = loadComponent('miniprogram/components/photo-meeting/index.js', { properties: { crewId, myPoint: point },
    wx: { ...e.wx, openLocation: opts => { preview = opts; opts.success({}); },
      cloud: { callFunction: async ({ data }) => ({ result: await w.A(data.action, data.payload) }) } } });
  try {
    c.__attached(); await c.choose(); await c.recognize(); await c.search();
    assert.equal(c.data.candidates[0].name, candidate.name);
    await c.preview({ currentTarget: { dataset: { id: '0' } } });
    assert.equal(preview.latitude, point.latitude); assert.equal(preview.longitude, point.longitude);
    assert.equal(c.__wx.filter(row => row.fn === 'triggerEvent').length, 0);
    await c.select({ currentTarget: { dataset: { id: '0' } } });
    const selected = c.__wx.find(row => row.fn === 'triggerEvent').args;
    assert.equal(selected.name, 'selected'); assert.equal(selected.detail.name, candidate.name);
    c.manual(); assert.equal(c.data.imagePath, '');
    assert.equal(c.__wx.filter(row => row.fn === 'triggerEvent').at(-1).args.name, 'manual');
    const config = JSON.parse(fs.readFileSync('miniprogram/pages/map/index.json', 'utf8'));
    assert.equal(config.usingComponents['photo-meeting'], '/components/photo-meeting/index');
    const template = fs.readFileSync('miniprogram/pages/map/index.wxml', 'utf8');
    assert.match(template, /bind:selected="onPhotoMeetingSelected"/); assert.match(template, /bind:manual="startPick"/);
  } finally { c.photo.dispose(); c.__restoreGlobals(); if (saved) require.cache[apiPath] = saved; else delete require.cache[apiPath]; }
});

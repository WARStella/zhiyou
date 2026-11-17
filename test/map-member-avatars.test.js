const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./page-harness');

test('位置接口头像映射本人和队友；缓存复用，切页后迟到响应不回填', async () => {
  const point = { latitude: 30, longitude: 120 };
  const members = ['a', 'b'].map(userId => ({ userId, nickname: userId, avatarFileId: 'cloud://' + userId,
    hasLocation: true, point, source: 'gps' }));
  let request, count = 0;
  const page = loadPage('miniprogram/pages/map/index.js', {
    api: { 'loc.list': { ok: true, data: { members } } },
    wx: { cloud: { getTempFileURL: options => { request = options; count++; } } },
  });
  try {
    page.setData({ crewId: 'crew', me: 'a', myPoint: point });
    await page.refreshTeamLocations();
    assert.ok(page.data.markers.every(m => m.iconPath === '/assets/avatar-default.png'));
    request.success({ fileList: members.map(m => ({ fileID: m.avatarFileId, tempFileURL: 'https://avatar.example/' + m.userId })) });
    assert.deepEqual(page.data.markers.map(m => m.iconPath), ['https://avatar.example/a', 'https://avatar.example/b']);
    assert.deepEqual(page.data.markers.map(m => m.callout.content), ['a', 'b']);
    await page.refreshTeamLocations();
    assert.equal(count, 1);
    members[1].avatarFileId = 'cloud://new-b';
    await page.refreshTeamLocations();
    page.stopChatPreview();
    request.success({ fileList: [{ fileID: 'cloud://new-b', tempFileURL: 'https://avatar.example/late' }] });
    assert.equal(page.memberAvatar(members[1]), '/assets/avatar-default.png');
  } finally { page.restore(); }
});

test('本人图钉独立读取个人头像，未入队也显示本地头像图片，不改变定位坐标', async () => {
  const point = { latitude: 30, longitude: 120 };
  const page = loadPage('miniprogram/pages/map/index.js', {
    api: { 'user.getProfile': { ok: true, data: { profile: { nickname: '本人', avatarFileId: 'cloud://my-avatar' } } } },
    wx: { getImageInfo: o => o.success({ path: 'wxfile://tmp/my-avatar.png' }) },
  });
  try {
    page.setData({ crewId: '', myPoint: point });
    await page.loadOwnMarkerProfile();
    const marker = page.data.markers.find(m => m.id === 999);
    assert.equal(marker.iconPath, 'wxfile://tmp/my-avatar.png');
    assert.equal(marker.callout.content, '本人');
    assert.equal(marker.latitude, point.latitude);
    assert.equal(marker.longitude, point.longitude);
    page.setData({ crewId: 'new-crew', members: [] });
    page.locationMembers = null;
    page.refreshMarkers();
    assert.equal(page.data.markers.find(m => m.id === 999).iconPath, marker.iconPath);
  } finally { page.restore(); }
});

test('队伍位置读取失败或关闭共享不会把本人头像换回默认图标', async () => {
  const page = loadPage('miniprogram/pages/map/index.js', { api: {
    'user.getProfile': { ok: true, data: { profile: { nickname: '我', avatarFileId: 'cloud://own' } } },
    'loc.list': { ok: false, error: { message: '暂时离线' } },
  } });
  try {
    page.setData({ crewId: 'crew', me: 'own', myPoint: { latitude: 30, longitude: 120 } });
    await page.loadOwnMarkerProfile();
    const icon = page.data.markers.find(m => m.id === 999).iconPath;
    assert.match(icon, /^https:/);
    await page.refreshTeamLocations();
    assert.equal(page.data.markers.find(m => m.id === 999).iconPath, icon);
    page.locationMembers = [{ userId: 'own', sharingOff: true, hasLocation: false }];
    page.refreshMarkers();
    assert.equal(page.data.markers.find(m => m.id === 999).iconPath, icon);
  } finally { page.restore(); }
});

test('返回队伍页会读取更新的个人头像，未设置头像时才显示默认图标', async () => {
  let fileId = 'cloud://old';
  const page = loadPage('miniprogram/pages/map/index.js', { api: {
    'user.getProfile': () => ({ ok: true, data: { profile: { nickname: '当前昵称', avatarFileId: fileId } } }),
  } });
  try {
    page.setData({ myPoint: { latitude: 30, longitude: 120 } });
    await page.loadOwnMarkerProfile();
    assert.equal(page.data.markers[0].iconPath, 'https://temp.example/' + encodeURIComponent('cloud://old'));
    fileId = 'cloud://new';
    await page.loadOwnMarkerProfile();
    assert.equal(page.data.markers[0].iconPath, 'https://temp.example/' + encodeURIComponent('cloud://new'));
    fileId = '';
    await page.loadOwnMarkerProfile();
    assert.equal(page.data.markers[0].iconPath, '/assets/avatar-default.png');
  } finally { page.restore(); }
});

test('头像转换的迟到响应不会覆盖新头像或在切页后回填', async () => {
  let fileId = 'cloud://old';
  const requests = [];
  const page = loadPage('miniprogram/pages/map/index.js', { api: {
    'user.getProfile': () => ({ ok: true, data: { profile: { avatarFileId: fileId } } }),
  }, wx: { cloud: { getTempFileURL: o => requests.push(o) } } });
  try {
    page.setData({ myPoint: { latitude: 30, longitude: 120 } });
    const first = page.loadOwnMarkerProfile();
    await new Promise(resolve => setImmediate(resolve));
    fileId = 'cloud://new';
    const second = page.loadOwnMarkerProfile();
    await new Promise(resolve => setImmediate(resolve));
    requests[1].success({ fileList: [{ fileID: 'cloud://new', tempFileURL: 'https://avatar.example/new' }] });
    await second;
    requests[0].success({ fileList: [{ fileID: 'cloud://old', tempFileURL: 'https://avatar.example/old' }] });
    await first;
    assert.equal(page.data.markers[0].iconPath, 'https://avatar.example/new');
    fileId = 'cloud://later';
    const third = page.loadOwnMarkerProfile();
    await new Promise(resolve => setImmediate(resolve));
    page.stopOwnMarkerProfile();
    requests[2].success({ fileList: [{ fileID: 'cloud://later', tempFileURL: 'https://avatar.example/late' }] });
    await third;
    assert.notEqual(page.ownMarkerAvatar.fileId, 'cloud://later');
  } finally { page.restore(); }
});

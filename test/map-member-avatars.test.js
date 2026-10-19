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

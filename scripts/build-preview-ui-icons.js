'use strict';
// Vector UI assets matching the approved mockups. Run with sharp available in NODE_PATH.
const fs = require('node:fs'), path = require('node:path'), sharp = require('sharp');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'miniprogram/assets/ui');
const vectors = path.join(root, 'design/uiux-approved-20261110/icons');
fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(vectors, { recursive: true });
const paths = {
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
  film: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5"/>',
  mic: '<rect x="8" y="2" width="8" height="13" rx="4"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
  camera: '<path d="M8 6 9.5 3h5L16 6h4a2 2 0 0 1 2 2v11H2V8a2 2 0 0 1 2-2z"/><circle cx="12" cy="12" r="4"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0z"/><circle cx="12" cy="10" r="2.7"/>',
  users: '<circle cx="9" cy="7" r="3"/><path d="M2 21v-3a7 7 0 0 1 14 0v3zM16 4a3 3 0 0 1 0 6M19 14a6 6 0 0 1 3 5v2"/>',
  crosshair: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/>',
  settings: '<path d="m9 2-1 3-3 1-2 4 2 3v4l4 3 3-1 4 1 3-4-1-3 2-3-2-4-3-1-2-3z"/><circle cx="11" cy="11" r="3"/>',
  chat: '<path d="M21 11a9 9 0 0 1-9 9H7l-5 2 2-5v-6a9 9 0 1 1 17 0z"/><path d="M7 11h.01M12 11h.01M17 11h.01"/>',
  plus: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M7 12h10"/>',
  send: '<path d="m3 11 18-8-7 18-3-8-8-2zM11 13 21 3"/>',
  text: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 7h8M8 11h8M8 15h5M8 19h3"/>',
  route: '<circle cx="5" cy="18" r="3"/><circle cx="19" cy="5" r="3"/><path d="M5 15v-5a3 3 0 0 1 3-3h7M19 8v5a3 3 0 0 1-3 3h-5"/>',
  edit: '<path d="m15 3 6 6-11 11H4v-6zM13 5l6 6M3 22h19"/>',
  walk: '<circle cx="13" cy="3" r="2"/><path d="m8 10 4-4 4 5 4 1M12 7l-2 8-5 6M10 15l5 2 1 5M8 10l-3 3"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="3"/><path d="M7 1v6M17 1v6M3 10h18m-13 5 3 3 5-5"/>',
  profile: '<circle cx="12" cy="7" r="4"/><path d="M3 22v-3a9 9 0 0 1 18 0v3z"/>',
  sound: '<path d="M3 9h4l5-5v16l-5-5H3zM16 8a6 6 0 0 1 0 8M19 4a11 11 0 0 1 0 16"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 10v7M12 6v1"/>',
  search: '<circle cx="10" cy="10" r="7"/><path d="m16 16 6 6"/>',
  expand: '<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>',
  check: '<path d="m5 12 4 4L20 5"/>',
};
(async () => {
  for (const [name, shape] of Object.entries(paths)) for (const [tone, color] of Object.entries({ navy: '#153350', blue: '#138cff', gray: '#647287', white: '#ffffff', green: '#319c39', orange: '#ff8a00' })) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="' + color + '" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + shape + '</svg>';
    fs.writeFileSync(path.join(vectors, name + '-' + tone + '.svg'), svg);
    await sharp(Buffer.from(svg)).resize(72, 72).png().toFile(path.join(out, name + '-' + tone + '.png'));
  }
  const sparkle = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><defs><linearGradient id="a" x2="1" y2="1"><stop stop-color="#66c4ff"/><stop offset="1" stop-color="#1084ff"/></linearGradient></defs><path d="M23 3c2 14 5 17 19 19-14 2-17 5-19 19-2-14-5-17-19-19C18 20 21 17 23 3" fill="url(#a)"/><path d="M39 30c.8 5 2 6.2 7 7-5 .8-6.2 2-7 7-.8-5-2-6.2-7-7 5-.8 6.2-2 7-7" fill="#2d96ff"/></svg>';
  fs.writeFileSync(path.join(vectors, 'sparkle.svg'), sparkle);
  await sharp(Buffer.from(sparkle)).resize(144, 144).png().toFile(path.join(out, 'sparkle.png'));
  for (const [name, icon] of [['trip', 'calendar'], ['team', 'users'], ['me', 'profile']]) for (const active of [false, true]) {
    fs.copyFileSync(path.join(out, icon + '-' + (active ? 'blue' : 'gray') + '.png'), path.join(root, 'miniprogram/assets/tabbar', name + (active ? '-active' : '') + '.png'));
  }
  console.log('UI line icons and tab assets built');
})().catch(error => { console.error(error.message); process.exitCode = 1; });

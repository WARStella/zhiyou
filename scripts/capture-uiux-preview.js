'use strict';
// Capture source-based HTML with a precise mobile viewport through a local review browser.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const out = path.resolve(__dirname, '../output/uiux-approved-preview-20261110');
(async () => {
  const tabs = await (await fetch('http://127.0.0.1:9347/json')).json();
  const socket = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0; const pending = new Map();
  socket.onmessage = event => { const result = JSON.parse(event.data); const callback = pending.get(result.id); if (callback) { pending.delete(result.id); result.error ? callback.reject(new Error(result.error.message)) : callback.resolve(result.result); } };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })); });
  try {
    await send('Page.enable');
    const checks = [];
    for (const width of [390, 320]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 2, mobile: true });
      for (const name of ['settings', 'guide', 'team-create', 'team-meeting', 'team-depart', 'route-voice']) {
        await send('Page.navigate', { url: pathToFileURL(path.join(out, name + '.html')).href });
        await new Promise(resolve => setTimeout(resolve, 180));
        const layout = await send('Runtime.evaluate', { expression: '({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight})', returnByValue: true });
        checks.push({ name, viewport: width, ...layout.result.value });
        const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        fs.writeFileSync(path.join(out, name + (width === 390 ? '' : '-320') + '.png'), Buffer.from(screenshot.data, 'base64'));
        if (width === 390 && name.startsWith('team')) {
          const full = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: layout.result.value.height, scale: 1 } });
          fs.writeFileSync(path.join(out, name + '-full.png'), Buffer.from(full.data, 'base64'));
          if (name === 'team-depart') {
            await send('Runtime.evaluate', { expression: 'scrollTo(0, document.documentElement.scrollHeight)' });
            await new Promise(resolve => setTimeout(resolve, 80));
            const lower = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            fs.writeFileSync(path.join(out, name + '-actions.png'), Buffer.from(lower.data, 'base64'));
          }
        }
      }
    }
    fs.writeFileSync(path.join(out, 'layout-check.json'), JSON.stringify(checks, null, 2));
    console.log(JSON.stringify(checks, null, 2));
    if (checks.some(c => c.scrollWidth > c.viewport)) process.exitCode = 1;
  } finally { socket.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });

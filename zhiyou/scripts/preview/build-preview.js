'use strict'
/**
 * 用**真实页面数据**渲染行程页预览图。
 * 数据来源：test/helpers 的 makeWorld + test/page-harness 加载真实页面并 applyTrip。
 * 输出：design/preview/trip-render.html / trip-full.png
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { makeWorld, expectOk, defaultMapFactory } = require('../../test/helpers')
const { loadPage } = require('../../test/page-harness')
const { renderPage, wxssToCss, BASE_CSS } = require('./wxml-render')

const ROOT = path.resolve(__dirname, '..', '..')
const MP = path.join(ROOT, 'miniprogram')
const OUT = path.join(ROOT, 'design', 'preview')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

async function buildData() {
  // DEMO_FASTEST=1：把"骑行"造成最快方式，用来预览「（最快）」标记
  const demo = process.env.DEMO_FASTEST === '1'
  // DEMO_PLANNING=1：不生成行程，渲染"今天想去哪"的空白规划态
  const planning = process.env.DEMO_PLANNING === '1'
  const world = await makeWorld(demo ? {
    createMapProvider: (...a) => {
      const p = defaultMapFactory(...a)
      p.distanceMatrix = async (from, tos, mode) => ({
        ok: true,
        elements: [{ usable: true, distanceMeters: 584,
          durationMinutes: { walking: 9, bicycling: 3.4, driving: 5 }[mode] }],
      })
      return p
    },
  } : {})
  if (planning) {
    const page = loadPage('miniprogram/pages/trip/index.js', { api: {} })
    try {
      page.setData({ startAtText: '13:37', keyword: '',
        planningAdvancedOpen: process.env.DEMO_PLANNING_OPEN === '1' })
      return JSON.parse(JSON.stringify(page.data))
    } finally {
      if (page.restore) page.restore()
    }
  }
  const plan = expectOk(await world.A('trip.plan', {
    placeIds: ['p_zhongyang', 'p_fanghong', 'p_sofia', 'p_zhaolin'],
    startAt: world.NOW.toISOString(),
    constraints: [],
    startPoint: { latitude: 45.7691, longitude: 126.6168, label: '我的位置' },
    preferredMode: demo ? 'auto' : 'walking',
  }))
  const page = loadPage('miniprogram/pages/trip/index.js', { api: {} })
  try {
    page.applyTrip(plan, '')
    const data = JSON.parse(JSON.stringify(page.data))
    return data
  } finally {
    if (page.restore) page.restore()
  }
}

function shellHtml(body) {
  return `
  <div class="phone">
    <div class="statusbar"><span>9:41</span><span>··· ▮</span></div>
    <div class="navbar"><span class="nav-back">‹</span><span class="nav-title">行程</span></div>
    <div class="content">${body}</div>
    <div class="tabbar"><div class="tab on">行程</div><div class="tab">队伍</div><div class="tab">我的</div></div>
  </div>`
}

function buildHtml(data) {
  const body = renderPage({ wxmlPath: path.join(MP, 'pages/trip/index.wxml'), data, root: MP })
  const appCss = wxssToCss(fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8'))
  const pageCss = wxssToCss(fs.readFileSync(path.join(MP, 'pages/trip/index.wxss'), 'utf8'))
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>行程页预览</title>
<style>${BASE_CSS}</style>
<style>${appCss}</style>
<style>${pageCss}</style>
</head><body>${shellHtml(body)}</body></html>`
}

function shot(htmlPath, pngPath, height) {
  fs.rmSync(pngPath, { force: true })
  execFileSync(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--allow-file-access-from-files',
    '--force-device-scale-factor=2',
    `--window-size=375,${height}`,
    `--screenshot=${pngPath}`,
    'file:///' + htmlPath.replace(/\\/g, '/'),
  ], { stdio: 'pipe', timeout: 120000 })
  if (!fs.existsSync(pngPath)) throw new Error('截图失败：' + pngPath)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const data = await buildData()
  console.log('timeline=%d legPicker=%d legPickerOpen=%s currentLeg=%s',
    (data.timeline || []).length, (data.legPicker || []).length, data.legPickerOpen,
    data.currentLeg && data.currentLeg.mode)
  const html = buildHtml(data)
  const demoTag = process.env.DEMO_PLANNING === '1' ? '-planning'
    : process.env.DEMO_FASTEST === '1' ? '-fastest' : ''
  const htmlPath = path.join(OUT, `trip-render${demoTag}.html`)
  fs.writeFileSync(htmlPath, html, 'utf8')
  shot(htmlPath, path.join(OUT, `trip-full${demoTag}.png`), 2600)
  shot(htmlPath, path.join(OUT, `trip-screen${demoTag}.png`), 812)
  console.log('written', path.join(OUT, 'trip-full.png'))
}

main().catch((e) => { console.error(e); process.exit(1) })

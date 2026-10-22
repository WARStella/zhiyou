'use strict'
/**
 * 极简 WXML → HTML 渲染器（只服务预览图，不追求完整语义）。
 * 支持：{{表达式}}、wx:if/elif/else、wx:for(+item/index)、block、import、template is/data。
 */
const fs = require('fs')
const path = require('path')

const VOID = new Set(['image', 'input', 'voice-input', 'guide-entry', 'switch'])

function stripComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '')
}

function parseAttrs(raw) {
  const attrs = {}
  const re = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g
  let m
  while ((m = re.exec(raw))) {
    const name = m[1]
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : ''
    attrs[name] = value
  }
  return attrs
}

function parse(src) {
  const clean = stripComments(src)
  const root = { tag: '#root', attrs: {}, children: [] }
  const stack = [root]
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/g
  let last = 0
  let m
  const pushText = (text) => {
    if (text && text.trim()) stack[stack.length - 1].children.push({ tag: '#text', text })
  }
  while ((m = re.exec(clean))) {
    pushText(clean.slice(last, m.index))
    last = re.lastIndex
    const [, closing, tag, attrRaw, selfClose] = m
    if (closing) {
      if (stack.length > 1 && stack[stack.length - 1].tag === tag) stack.pop()
      continue
    }
    const node = { tag, attrs: parseAttrs(attrRaw), children: [] }
    stack[stack.length - 1].children.push(node)
    if (!selfClose && !VOID.has(tag)) stack.push(node)
  }
  pushText(clean.slice(last))
  return root
}

function evalExpr(expr, scope) {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('__scope', `with(__scope){return (${expr})}`)
    return fn(scope)
  } catch (e) {
    return undefined
  }
}

function interp(value, scope) {
  if (typeof value !== 'string') return value
  const whole = value.match(/^\s*\{\{([\s\S]*)\}\}\s*$/)
  if (whole && !whole[1].includes('}}')) {
    const expr = whole[1]
    const direct = evalExpr(expr, scope)
    if (direct !== undefined) return direct
    // WXML 的 data="{{a: b, c: d}}" 是对象字面量简写
    const obj = evalExpr(`({${expr}})`, scope)
    return obj
  }
  return value.replace(/\{\{([\s\S]*?)\}\}/g, (_, expr) => {
    const v = evalExpr(expr, scope)
    return v === undefined || v === null ? '' : String(v)
  })
}

function collectTemplates(ast, map) {
  if (ast.tag === 'template' && ast.attrs.name) map[ast.attrs.name] = ast
  for (const c of ast.children || []) collectTemplates(c, map)
}

const OUT_TAG = { view: 'div', text: 'span', image: 'img', picker: 'div', switch: 'span', textarea: 'div', input: 'div', map: 'div', 'cover-view': 'div' }

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderNodes(nodes, scope, ctx) {
  let out = ''
  let chain = null // null | 'taken' | 'skipped'
  for (const node of nodes) {
    if (node.tag === '#text') {
      const text = node.text.replace(/\{\{([\s\S]*?)\}\}/g, (_, expr) => {
        const v = evalExpr(expr, scope)
        return v === undefined || v === null ? '' : String(v)
      })
      if (text.trim()) out += esc(text)
      chain = null
      continue
    }
    if (node.tag === 'import') continue
    if (node.tag === 'template' && node.attrs.name) continue

    if (node.attrs['wx:if'] !== undefined) {
      const ok = !!interp(node.attrs['wx:if'], scope)
      chain = ok ? 'taken' : 'skipped'
      if (!ok) continue
    } else if (node.attrs['wx:elif'] !== undefined) {
      const ok = chain === 'skipped' && !!interp(node.attrs['wx:elif'], scope)
      chain = ok ? 'taken' : chain === 'taken' ? 'taken' : 'skipped'
      if (!ok) continue
    } else if (node.attrs['wx:else'] !== undefined) {
      const ok = chain === 'skipped'
      chain = 'taken'
      if (!ok) continue
    } else {
      chain = null
    }

    if (node.attrs['wx:for'] !== undefined) {
      const list = interp(node.attrs['wx:for'], scope) || []
      const itemName = node.attrs['wx:for-item'] || 'item'
      const indexName = node.attrs['wx:for-index'] || 'index'
      const clone = { tag: node.tag, attrs: Object.assign({}, node.attrs), children: node.children }
      delete clone.attrs['wx:for']
      delete clone.attrs['wx:for-item']
      delete clone.attrs['wx:for-index']
      const arr = Array.isArray(list) ? list : []
      arr.forEach((item, i) => {
        const s = Object.create(scope)
        s[itemName] = item
        s[indexName] = i
        out += renderElement(clone, s, ctx)
      })
      continue
    }
    out += renderElement(node, scope, ctx)
  }
  return out
}

function renderElement(node, scope, ctx) {
  if (node.tag === 'block') return renderNodes(node.children, scope, ctx)
  if (node.tag === 'template') {
    const name = node.attrs.is
    const def = ctx.templates[name]
    if (!def) return ''
    const dataRaw = node.attrs.data
    let data = {}
    if (dataRaw) {
      const t = interp(dataRaw, scope)
      data = t && typeof t === 'object' ? t : {}
    }
    return renderNodes(def.children, data, ctx)
  }
  if (node.tag === 'voice-input' || node.tag === 'guide-entry') {
    return node.tag === 'voice-input' ? '<span class="wx-voice">🎙</span>' : ''
  }
  if (node.tag === 'map') {
    const cls = interp(node.attrs.class || '', scope)
    return `<div class="route-map map-placeholder ${cls}">地图</div>`
  }
  const outTag = OUT_TAG[node.tag] || 'div'
  const attrs = []
  let hidden = false
  for (const [k, v] of Object.entries(node.attrs)) {
    if (k.startsWith('wx:') || k.startsWith('bind') || k.startsWith('catch') || k === 'data-') continue
    if (k === 'hidden') { hidden = !!interp(v, scope); continue }
    if (k === 'data' && node.tag !== 'object') continue
    if (k === 'src') {
      const src = String(interp(v, scope) || '')
      if (!src) continue
      const abs = src.startsWith('/') ? 'file:///' + path.join(ctx.root, src.slice(1)).replace(/\\/g, '/') : src
      attrs.push(`src="${esc(abs)}" alt=""`)
      continue
    }
    if (k === 'class') {
      const cls = String(interp(v, scope) || '').replace(/\s+/g, ' ').trim()
      if (cls) attrs.push(`class="${esc(cls)}"`)
      continue
    }
    if (k === 'style') {
      const st = String(interp(v, scope) || '').trim()
      if (st) attrs.push(`style="${esc(st)}"`)
      continue
    }
    if (k === 'disabled') {
      const dis = !!interp(v, scope)
      if (dis) attrs.push('disabled', 'class="button-disabled"')
      continue
    }
    if (k === 'aria-label' || k === 'role' || k === 'id') {
      attrs.push(`${k}="${esc(String(interp(v, scope) || ''))}"`)
      continue
    }
    // 其余（data-* 等）忽略
  }
  let style = ''
  if (hidden) style = 'display:none'
  if (outTag === 'img') return `<img ${attrs.join(' ')} ${style ? `style="${style}"` : ''}/>`
  if (outTag === 'button') {
    return `<button type="button" ${attrs.join(' ')} ${style ? `style="${style}"` : ''}>${renderNodes(node.children, scope, ctx)}</button>`
  }
  return `<${outTag} ${attrs.join(' ')} ${style ? `style="${style}"` : ''}>${renderNodes(node.children, scope, ctx)}</${outTag}>`
}

function loadWxml(file, ctx, seen = new Set()) {
  const src = fs.readFileSync(file, 'utf8')
  const ast = parse(src)
  collectTemplates(ast, ctx.templates)
  const imports = src.match(/<import\s+src="([^"]+)"/g) || []
  for (const imp of imports) {
    const rel = imp.match(/src="([^"]+)"/)[1]
    const abs = path.resolve(path.dirname(file), rel)
    if (!seen.has(abs) && fs.existsSync(abs)) {
      seen.add(abs)
      loadWxml(abs, ctx, seen)
    }
  }
  return ast
}

function renderPage({ wxmlPath, data, root }) {
  const ctx = { templates: {}, root }
  const ast = loadWxml(wxmlPath, ctx)
  return renderNodes(ast.children, data, ctx)
}

/** WXSS → CSS：去掉注释、rpx→px（375 宽下 2rpx=1px）、标签选择器改名。 */
function wxssToCss(src) {
  let css = src.replace(/\/\*[\s\S]*?\*\//g, '')
  css = css.replace(/(-?\d*\.?\d+)rpx/g, (_, n) => `${Number(n) / 2}px`)
  const mapTag = (s) => s
    .replace(/(^|[\s,>+~])page(?=[\s,{:.#\[]|$)/g, '$1body')
    .replace(/(^|[\s,>+~])view(?=[\s,{:.#\[]|$)/g, '$1div')
    .replace(/(^|[\s,>+~])text(?=[\s,{:.#\[]|$)/g, '$1span')
    .replace(/(^|[\s,>+~])image(?=[\s,{:.#\[]|$)/g, '$1img')
  return css.replace(/([^{}]+)\{/g, (m, sel) => mapTag(sel) + '{')
}

const BASE_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { width: 375px; overflow-x: hidden; }
  div { display: block; }
  span { display: inline; }
  img { display: inline-block; }
  button { border: 0; margin: 0; padding: 0; background: transparent; font: inherit; color: inherit; line-height: inherit; }
  button::after { display: none; }
  .wx-voice { display: inline-block; opacity: .35; }
  .phone { width: 375px; margin: 0 auto; background: #f7fafc; position: relative; }
  .statusbar { height: 44px; display: flex; align-items: center; justify-content: space-between; padding: 0 18px; font-size: 13px; font-weight: 600; color: #14202b; background: #fbfcff; }
  .navbar { height: 44px; display: flex; align-items: center; justify-content: center; position: relative; background: #fbfcff; border-bottom: .5px solid #eef2f7; }
  .nav-title { font-size: 17px; font-weight: 600; color: #14202b; }
  .nav-back { position: absolute; left: 14px; font-size: 26px; line-height: 1; color: #14202b; }
  .content { position: relative; }
  .tabbar { height: 50px; display: flex; background: #fff; border-top: .5px solid #e6eaf0; }
  .tab { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; font-size: 10px; color: #6f7d89; }
  .tab.on { color: #2b5c8a; font-weight: 600; }
  .page-bg, .page-bg-scrim { z-index: 0 !important; }
  .page-bg { object-fit: cover; }
  .page > *:not(.page-bg):not(.page-bg-scrim) { position: relative; z-index: 1; }
  .map-placeholder { width: 100%; height: 210px; border-radius: 9px; background: linear-gradient(135deg, #e8f2ea, #dbe9f2 55%, #eef4f8); display: flex; align-items: center; justify-content: center; color: #7a8b99; font-size: 13px; }
`

module.exports = { renderPage, wxssToCss, BASE_CSS }

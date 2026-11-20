// ---------- small helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const NS = 'http://www.w3.org/2000/svg';
const PT = 96 / 72;                       // CSS pixels per PDF point at 100%
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
let _uid = 0;
const uid = () => 'n' + (++_uid).toString(36) + Math.random().toString(36).slice(2, 6);

function el(tag, props = {}, ...kids) {
  const [name, ...cls] = tag.split('.');
  const e = document.createElement(name || 'div');
  if (cls.length) e.className = cls.join(' ');
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style') Object.assign(e.style, v);
    else if (k === 'data') Object.assign(e.dataset, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else if (v !== undefined && v !== null && v !== false) e[k] = v;
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}
function svg(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  return e;
}
const ICON = (name) => document.getElementById('ico-' + name)?.innerHTML || '';

function b64ToBytes(b64) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(b64);
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
// Everything the app needs is embedded in this file (gzip + base64), so it works with no internet.
async function assetBytes(id) {
  const node = document.getElementById('asset-' + id);
  if (!node) throw new Error('Missing embedded asset: ' + id);
  return gunzip(b64ToBytes(node.textContent.trim()));
}
const blobUrl = (bytes, type = 'text/javascript') => URL.createObjectURL(new Blob([bytes], { type }));

const packs = {};
function loadPack(name) {
  return packs[name] ??= (async () => JSON.parse(new TextDecoder().decode(await assetBytes('pack-' + name))))();
}
class EmbeddedData {
  constructor() {}
  async fetch({ kind, filename }) {
    const pack = await loadPack(kind === 'cMapUrl' ? 'cmaps' : kind === 'standardFontDataUrl' ? 'fonts' : 'wasm');
    const b64 = pack[filename];
    if (!b64) throw new Error('Not bundled: ' + filename);
    return b64ToBytes(b64);
  }
}

// ---------- PDF engines ----------
const pdfjsLib = await import(blobUrl(await assetBytes('pdfjs')));
const workerUrl = blobUrl(await assetBytes('pdfworker'));

// When a PDF names a common font without carrying it, PDF.js first looks for that font on this computer
// and otherwise asks for a bundled stand-in by address ("fonts/LiberationSans-Regular.ttf"). There is no
// such address (everything lives inside this one file), so hand over the stand-in from the bundled pack.
let fontPack = null;
{
  const RealFontFace = window.FontFace, standIns = new Map();
  window.FontFace = function FontFace(family, source, descriptors) {
    if (typeof source === 'string' && fontPack) {
      source = source.replace(/url\(fonts\/([^)]+)\)/g, (whole, file) => {
        if (!fontPack[file]) return whole;
        if (!standIns.has(file)) standIns.set(file, URL.createObjectURL(new Blob([b64ToBytes(fontPack[file])], { type: 'font/ttf' })));
        return `url(${standIns.get(file)})`;
      });
    }
    return new RealFontFace(family, source, descriptors);
  };
  window.FontFace.prototype = RealFontFace.prototype;
}

let _pdfLib;
function loadPdfLib() {
  return _pdfLib ??= (async () => {
    const url = blobUrl(await assetBytes('pdflib'));
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = url; s.onload = res; s.onerror = () => rej(new Error('Could not start the PDF writer'));
      document.head.append(s);
    });
    return window.PDFLib;
  })();
}

// ---------- app state ----------
const S = {
  sources: new Map(),   // id -> { id, name, doc (pdf.js), n, hasForms, fields }
  primary: null,        // id of the document that was opened (others are merged in)
  pages: [],            // [{ id, src, idx, rot, bw, bh, annots: [] }]
  views: new Map(),     // page id -> PageView
  assets: new Map(),    // image id -> { bytes, mime, w, h, url }
  scale: PT, zoomMode: 'auto',
  tool: 'select',
  cur: 0,
  sel: null,            // { id, pageId } selected annotation
  editing: null,
  thumbSel: new Set(),
  name: '', handle: null, fileSize: 0,
  dirty: false, formDirty: false, savedIdx: -1,
  history: [], hIdx: -1,
};
const hasDoc = () => S.pages.length > 0;
const viewSize = (rec) => (rec.rot % 180 ? [rec.bh, rec.bw] : [rec.bw, rec.bh]);
const recIndex = (id) => S.pages.findIndex((p) => p.id === id);
const getPdfPage = (rec) => S.sources.get(rec.src).doc.getPage(rec.idx + 1);

// Desktop app, first start after updating from 1.2.1 or earlier: take over the settings and saved
// signatures that the old version kept under its file:// address (see main.js).
if (window.native?.legacyStorage) {
  try {
    const old = await window.native.legacyStorage();
    if (old) for (const [k, v] of Object.entries(old)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
  } catch (e) { console.warn('earlier settings were not carried over', e); }
}
const PREF_KEY = 'pdfeditor.prefs';
const prefs = Object.assign({
  theme: null, zoom: 'auto', sidebar: true,
  text: { font: 'sans', size: 12, bold: false, italic: false, color: '#111111' },
  hl: { mode: 'highlight', color: '#FFE45C' },
  draw: { color: '#1F4FD8', sw: 2, marker: false },
  shape: { kind: 'rect', stroke: '#D92D20', fill: null, sw: 1.5 },
  whiteout: { fill: 'auto' },
  check: { kind: 'check', color: '#111111', size: 14 },
}, (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } })());
let _prefT;
function savePrefs() {
  clearTimeout(_prefT);
  _prefT = setTimeout(() => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} }, 300);
}

// ---------- feedback ----------
let _toastT;
function toast(msg, isErr = false, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.classList.toggle('err', !!isErr);
  // shown as a popover so it stays on top of any open dialog (such as the print screen)
  try { if (t.matches(':popover-open')) t.hidePopover(); t.showPopover(); } catch {}
  clearTimeout(_toastT);
  _toastT = setTimeout(() => { try { t.hidePopover(); } catch {} }, isErr ? 6000 : ms);
}
function fail(what, e) {
  console.error(what, e);
  toast(`${what}. ${e?.message || e || ''}`.trim(), true);
}
let _busyN = 0, _busyT = 0;
async function busy(text, fn) {
  $('#busyText').textContent = text;
  // quick jobs finish before this fires, so the screen does not flicker
  if (_busyN++ === 0) _busyT = setTimeout(() => { $('#busy').hidden = false; }, 180);
  await new Promise((r) => setTimeout(r));
  try { return await fn(); }
  finally { if (--_busyN === 0) { clearTimeout(_busyT); $('#busy').hidden = true; } }
}
function ask({ title, text = '', buttons, input = false }) {
  return new Promise((resolve) => {
    const d = $('#dlgAsk'), inp = $('#askInput');
    $('#askTitle').textContent = title; $('#askText').textContent = text;
    $('#askText').hidden = !text;
    inp.hidden = !input; inp.value = '';
    const box = $('#askBtns'); box.replaceChildren();
    let done = false;
    const finish = (v) => { if (done) return; done = true; d.close(); resolve(input ? (v ? inp.value : null) : v); };
    for (const b of buttons) {
      box.append(el('button' + (b.primary ? '.primary' : b.warn ? '.warn' : ''), { type: 'button', textContent: b.label, onclick: () => finish(b.value) }));
    }
    d.oncancel = (e) => { e.preventDefault(); finish(null); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } };
    d.showModal();
    (input ? inp : box.querySelector('.primary') || box.lastChild).focus();
  });
}
const isTyping = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

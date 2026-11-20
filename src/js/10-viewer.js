// ---------- viewer: layout, rendering, zoom, navigation ----------
const scroller = $('#scroller'), pagesEl = $('#pages');
const GAP = 14, PAD = 16;
let tops = [];
let renderRunning = 0;

class PageView {
  constructor(rec) {
    this.rec = rec; this.index = 0; this.token = 0;
    this.canvas = null; this.rendered = false; this.rScale = 0; this.rRot = -1; this.textKey = null;
    this.div = el('div.page', { data: { id: rec.id } });
    this.loadingEl = el('div.loading', { textContent: rec.src ? 'Loading' : '' });
    this.findLayer = el('div.layer.findLayer');
    this.mulLayer = el('div.layer.mulLayer');      // highlighter ink: blends with the page like a real marker
    this.widgetLayer = el('div.layer.widgetLayer');
    this.annoLayer = el('div.layer.annoLayer');
    this.capture = el('div.capture');
    this.div.append(this.loadingEl, this.findLayer, this.mulLayer, this.widgetLayer, this.annoLayer, this.capture);
    this.annoEls = new Map();
  }
  applySize() {
    const [w, h] = viewSize(this.rec), s = S.scale;
    this.cssW = Math.round(w * s); this.cssH = Math.round(h * s);
    const st = this.div.style;
    st.width = this.cssW + 'px'; st.height = this.cssH + 'px';
    st.setProperty('--total-scale-factor', s); st.setProperty('--scale-factor', s);
    for (const l of [this.findLayer, this.mulLayer, this.widgetLayer, this.annoLayer]) {
      l.style.width = w + 'px'; l.style.height = h + 'px'; l.style.transform = `scale(${s})`;
    }
  }
  needsRender() { return !this.rendered || this.rScale !== S.scale || this.rRot !== this.rec.rot; }
  async render() {
    const rec = this.rec, token = ++this.token, scale = S.scale;
    if (!rec.src) { this.rendered = true; this.rScale = scale; this.rRot = rec.rot; this.loadingEl.remove(); return; }
    const src = S.sources.get(rec.src);
    const page = await getPdfPage(rec);
    if (token !== this.token) return;
    const rot = (page.rotate + rec.rot) % 360;
    let os = Math.min(window.devicePixelRatio || 1, 3);
    const vp0 = page.getViewport({ scale, rotation: rot });
    const maxPx = 2.6e7;
    if (vp0.width * vp0.height * os * os > maxPx) os = Math.sqrt(maxPx / (vp0.width * vp0.height));
    const vp = page.getViewport({ scale: scale * os, rotation: rot });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(vp.width)); canvas.height = Math.max(1, Math.floor(vp.height));
    try { this.task?.cancel(); } catch {}
    const task = this.task = page.render({
      canvas, viewport: vp,
      annotationMode: src.hasForms ? pdfjsLib.AnnotationMode.ENABLE_FORMS : pdfjsLib.AnnotationMode.ENABLE,
    });
    try { await task.promise; }
    catch (e) { if (e?.name === 'RenderingCancelledException') return; throw e; }
    finally { if (this.task === task) this.task = null; }
    if (token !== this.token) return;
    if (this.canvas) { this.canvas.width = 0; this.canvas.remove(); }
    this.canvas = canvas; this.div.prepend(canvas); this.loadingEl.remove();
    this.rendered = true; this.rScale = scale; this.rRot = rec.rot;
    const key = rec.src + ':' + rec.idx + ':' + rot;
    if (this.textKey !== key) {
      await this.renderText(page, rot, scale);
      if (token !== this.token) return;
      this.textKey = key;
      await this.renderWidgets(page, rot, src);
    } else if (this.tl) {
      try { this.tl.update({ viewport: page.getViewport({ scale, rotation: rot }) }); } catch {}
    }
    this.renderFind();
  }
  async renderText(page, rot, scale) {
    const tc = await page.getTextContent();
    const div = el('div.textLayer');
    const tl = new pdfjsLib.TextLayer({ textContentSource: tc, container: div, viewport: page.getViewport({ scale, rotation: rot }) });
    await tl.render();
    this.textDiv?.remove();
    this.textDiv = div; this.tl = tl;
    this.textItems = tc.items.filter((i) => i.str !== undefined);
    this.pageRot = rot; this.pdfPage = page;
    this.findLayer.after(div);
  }
  async renderWidgets(page, rot, src) {
    const layer = this.widgetLayer; layer.replaceChildren();
    let annots = [];
    try { annots = await page.getAnnotations({ intent: 'display' }); } catch { return; }
    const vp1 = page.getViewport({ scale: 1, rotation: rot });
    for (const a of annots) {
      if (!a.rect) continue;
      const [ax, ay] = vp1.convertToViewportPoint(a.rect[0], a.rect[1]), [bx, by] = vp1.convertToViewportPoint(a.rect[2], a.rect[3]);
      const x = Math.min(ax, bx), y = Math.min(ay, by), w = Math.abs(bx - ax), h = Math.abs(by - ay);
      const pos = { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' };
      if (a.subtype === 'Link') {
        if (!a.url && !a.dest) continue;
        const link = el('a', { style: pos, title: a.url || 'Go to linked page' });
        link.addEventListener('click', (e) => {
          if (S.tool !== 'select') return;
          e.preventDefault();
          if (a.url) openLink(a.url);
          else gotoDest(src, a.dest);
        });
        layer.append(link);
      } else if (a.subtype === 'Widget' && src.hasForms && !a.hidden) {
        const w = formWidget(a, src, pos, h);
        if (w) layer.append(w);
      }
    }
  }
  renderAnnots() {
    this.annoLayer.replaceChildren(); this.mulLayer.replaceChildren(); this.annoEls.clear();
    for (const a of this.rec.annots) {
      const e = annotEl(a, this.rec);
      e.dataset.id = a.id; this.annoEls.set(a.id, e); (isMultiply(a) ? this.mulLayer : this.annoLayer).append(e);
      if (a.type === 'text') { a.w = e.offsetWidth; a.h = e.offsetHeight; }
    }
    if (S.sel && S.sel.pageId === this.rec.id) drawSelBox();
  }
  renderFind() { if (typeof paintFind === 'function') paintFind(this); }
  evict() {
    this.token++;
    try { this.task?.cancel(); } catch {}
    if (this.canvas) { this.canvas.width = 0; this.canvas.remove(); this.canvas = null; }
    this.textDiv?.remove(); this.textDiv = null; this.tl = null; this.textKey = null; this.textItems = null;
    this.widgetLayer.replaceChildren(); this.findLayer.replaceChildren();
    this.rendered = false;
    if (this.rec.src && !this.loadingEl.isConnected) this.div.prepend(this.loadingEl);
  }
  destroy() { this.evict(); this.div.remove(); }
  // client coordinates -> page coordinates in points (as displayed)
  pt(e) {
    const r = this.div.getBoundingClientRect();
    return { x: (e.clientX - r.left) / S.scale, y: (e.clientY - r.top) / S.scale };
  }
}

function layout() {
  const keep = new Set(), frag = document.createDocumentFragment();
  tops = []; let y = PAD;
  S.pages.forEach((rec, i) => {
    let v = S.views.get(rec.id);
    if (!v) { v = new PageView(rec); S.views.set(rec.id, v); }
    v.rec = rec; v.index = i; v.applySize(); keep.add(rec.id);
    tops.push(y); y += v.cssH + GAP;
    frag.append(v.div);
  });
  for (const [id, v] of S.views) if (!keep.has(id)) { v.destroy(); S.views.delete(id); }
  pagesEl.replaceChildren(frag);
  for (const rec of S.pages) S.views.get(rec.id).renderAnnots();
}
function resize() {      // sizes only (zoom): no DOM reordering
  tops = []; let y = PAD;
  for (const rec of S.pages) { const v = S.views.get(rec.id); v.applySize(); tops.push(y); y += v.cssH + GAP; }
}
const viewAt = (i) => S.views.get(S.pages[i]?.id);
function pageIndexAtY(y) {
  let lo = 0, hi = tops.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tops[mid] <= y) lo = mid; else hi = mid - 1; }
  return lo;
}
function visibleRange() {
  const st = scroller.scrollTop;
  return [pageIndexAtY(st), pageIndexAtY(st + scroller.clientHeight)];
}
function viewAtClient(x, y) {
  const [a, b] = visibleRange();
  for (let i = a; i <= b; i++) {
    const v = viewAt(i); if (!v) continue;
    const r = v.div.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return v;
  }
  return null;
}

function pump() {
  if (!hasDoc()) return;
  const [a, b] = visibleRange();
  const mid = (a + b) / 2, want = [];
  for (let i = Math.max(0, a - 1); i <= Math.min(S.pages.length - 1, b + 2); i++) want.push(i);
  want.sort((p, q) => Math.abs(p - mid) - Math.abs(q - mid));
  for (const i of want) {
    const v = viewAt(i);
    if (!v || v.rendering || !v.needsRender()) continue;
    if (renderRunning >= 2) break;
    renderRunning++; v.rendering = true;
    v.render().catch((e) => { console.error('render', e); v.rendered = true; v.rScale = S.scale; v.rRot = v.rec.rot; v.loadingEl.textContent = 'This page could not be displayed'; })
      .finally(() => { v.rendering = false; renderRunning--; pump(); });
  }
  for (const [, v] of S.views) if ((v.index < a - 8 || v.index > b + 8) && (v.rendered || v.canvas)) v.evict();
}
let _pumpT;
const pumpSoon = (ms = 120) => { clearTimeout(_pumpT); _pumpT = setTimeout(pump, ms); };

// ---------- zoom ----------
function computeScale(mode) {
  const rec = S.pages[S.cur] || S.pages[0];
  if (!rec) return PT;
  const [w, h] = viewSize(rec);
  const availW = scroller.clientWidth - PAD * 2 - 2, availH = scroller.clientHeight - PAD * 2;
  const fitW = availW / w, fitP = Math.min(fitW, availH / h);
  if (mode === 'width') return fitW;
  if (mode === 'page') return fitP;
  return Math.min(fitW, 1.3 * PT);
}
function setZoom(z, anchor) {
  if (!hasDoc()) return;
  S.zoomMode = z;
  const ns = clamp(typeof z === 'number' ? z * PT : computeScale(z), 0.1 * PT, 8 * PT);
  if (typeof z !== 'number') { prefs.zoom = z; savePrefs(); }     // a fit mode is remembered; a one-off zoom level is not
  if (Math.abs(ns - S.scale) > 1e-4) {
    const r = scroller.getBoundingClientRect();
    const ay = anchor ? anchor.y - r.top : 0, ax = anchor ? anchor.x - r.left : scroller.clientWidth / 2;
    const docY = scroller.scrollTop + ay, i = pageIndexAtY(docY), v = viewAt(i);
    const fy = (docY - tops[i]) / v.cssH, fx = (scroller.scrollLeft + ax - v.div.offsetLeft) / v.cssW;
    S.scale = ns; resize();
    scroller.scrollTop = tops[i] + fy * v.cssH - ay;
    scroller.scrollLeft = v.div.offsetLeft + fx * v.cssW - ax;
    hideSelPop();
    pumpSoon(140);
  }
  if (typeof z !== 'number' && !anchor) centerPage();
  syncZoomUI();
}
// Keep the page being read in the middle of the window, even when other pages in the file are wider.
function centerPage() {
  const v = viewAt(S.cur);
  if (v) scroller.scrollLeft = Math.max(0, v.div.offsetLeft - (scroller.clientWidth - v.cssW) / 2);
}
function syncZoomUI() {
  const sel = $('#zoomSel'), z = S.zoomMode;
  const pct = Math.round((S.scale / PT) * 100);
  if (typeof z === 'number') {
    const opt = [...sel.options].find((o) => Number(o.value) === z);
    if (opt) sel.value = opt.value;
    else { const c = sel.querySelector('[value="custom"]'); c.hidden = false; c.textContent = pct + '%'; sel.value = 'custom'; }
  } else sel.value = z;
  sel.title = `Zoom: ${pct}%`;
}
const zoomBy = (f, anchor) => setZoom(clamp(Math.round((S.scale / PT) * f * 100) / 100, 0.1, 8), anchor);

// ---------- navigation ----------
function goToPage(i, yPt = 0) {
  i = clamp(i, 0, S.pages.length - 1);
  scroller.scrollTop = tops[i] - 8 + yPt * S.scale;
  updateCurrent(); pump();
}
function updateCurrent() {
  if (!hasDoc()) return;
  const i = pageIndexAtY(scroller.scrollTop + scroller.clientHeight * 0.35);
  if (i !== S.cur || $('#pageInput').value === '') {
    S.cur = i;
    $('#pageInput').value = i + 1;
    markCurrentThumb();
    rememberPosition();
  }
  $('#btnPrev').disabled = i <= 0; $('#btnNext').disabled = i >= S.pages.length - 1;
}
let _scrollRaf = 0;
scroller.addEventListener('scroll', () => {
  if (_scrollRaf) return;
  _scrollRaf = requestAnimationFrame(() => { _scrollRaf = 0; updateCurrent(); pump(); hideSelPop(); });
}, { passive: true });

document.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  if (!hasDoc() || !e.target.closest('#desk')) return;
  const f = Math.exp(-clamp(e.deltaY, -25, 25) * 0.007);      // about 19% per wheel notch; gentle steps for a touchpad pinch
  setZoom(clamp((S.scale / PT) * f, 0.1, 8), { x: e.clientX, y: e.clientY });
}, { passive: false });

new ResizeObserver(() => {
  if (hasDoc() && typeof S.zoomMode !== 'number') setZoom(S.zoomMode);
  pumpSoon(60);
}).observe(scroller);

// A link inside a PDF can point anywhere. Show the address and let the reader decide.
async function openLink(url) {
  let safe = null;
  try { const u = new URL(url); if (/^(https?|mailto):$/.test(u.protocol)) safe = u.href; } catch {}
  if (!safe) return toast('This link cannot be opened');
  const go = await ask({ title: 'Open this link?', text: safe.length > 300 ? safe.slice(0, 300) + '…' : safe,
    buttons: [{ label: 'Cancel', value: false }, { label: 'Open in browser', value: true, primary: true }] });
  if (go) window.open(safe, '_blank', 'noopener');
}
async function gotoDest(src, dest) {
  try {
    if (typeof dest === 'string') dest = await src.doc.getDestination(dest);
    if (!Array.isArray(dest)) return;
    const ref = dest[0];
    const idx = typeof ref === 'object' && ref !== null ? await src.doc.getPageIndex(ref) : Number(ref);
    const i = S.pages.findIndex((p) => p.src === src.id && p.idx === idx);
    if (i < 0) return toast('That page is no longer in this document');
    goToPage(i);
  } catch (e) { console.warn('dest', e); }
}

// ---------- form fields (filled in place, written into the file on save) ----------
function formWidget(a, src, pos, h) {
  const store = src.doc.annotationStorage;
  const siblings = fieldWidgets(src, a.fieldName).filter((f) => f.id && f.id !== a.id);
  const fs = clamp(a.defaultAppearanceData?.fontSize || h * 0.62, 5, a.multiLine ? 12 : Math.max(5, h * 0.8));
  const changed = () => { S.formDirty = true; syncDirty(); };
  let e;
  if (a.fieldType === 'Tx') {
    const val = store.getValue(a.id, { value: a.fieldValue ?? '' }).value ?? '';
    e = a.multiLine ? el('textarea') : el('input', { type: a.password ? 'password' : 'text' });
    e.value = val;
    if (a.maxLen) e.maxLength = a.maxLen;
    e.style.fontSize = fs + 'px';
    if (a.textAlignment === 1) e.style.textAlign = 'center'; else if (a.textAlignment === 2) e.style.textAlign = 'right';
    e.addEventListener('input', () => {
      store.setValue(a.id, { value: e.value });
      for (const s of siblings) store.setValue(s.id, { value: e.value });
      for (const o of $$(`.widgetLayer [data-field="${CSS.escape(a.fieldName)}"]`)) if (o !== e && 'value' in o) o.value = e.value;
      changed();
    });
  } else if (a.fieldType === 'Btn' && a.checkBox) {
    e = el('input', { type: 'checkbox' });
    e.checked = !!store.getValue(a.id, { value: a.exportValue === a.fieldValue }).value;
    e.addEventListener('change', () => {
      store.setValue(a.id, { value: e.checked });
      for (const s of siblings) {
        const same = s.exportValues === a.exportValue;
        if (same) store.setValue(s.id, { value: e.checked }); else if (e.checked) store.setValue(s.id, { value: false });
      }
      refreshFieldEls(a.fieldName, src); changed();
    });
  } else if (a.fieldType === 'Btn' && a.radioButton) {
    e = el('input', { type: 'radio', name: src.id + a.fieldName });
    e.checked = !!store.getValue(a.id, { value: a.fieldValue === a.buttonValue }).value;
    e.addEventListener('change', () => {
      for (const s of siblings) store.setValue(s.id, { value: false });
      store.setValue(a.id, { value: true });
      refreshFieldEls(a.fieldName, src); changed();
    });
  } else if (a.fieldType === 'Ch') {
    e = el('select');
    if (a.multiSelect) e.multiple = true;
    if (!a.combo) e.size = Math.max(2, Math.min(a.options.length, Math.round(h / (fs * 1.3))));
    const cur = store.getValue(a.id, { value: a.fieldValue }).value;
    const curSet = new Set(Array.isArray(cur) ? cur : [cur]);
    if (a.combo && !a.options.some((o) => curSet.has(o.exportValue))) e.append(el('option', { value: '', textContent: '' }));
    for (const o of a.options) e.append(el('option', { value: o.exportValue, textContent: o.displayValue, selected: curSet.has(o.exportValue) }));
    e.style.fontSize = fs + 'px';
    e.addEventListener('change', () => {
      const v = a.multiSelect ? [...e.selectedOptions].map((o) => o.value) : e.value;
      store.setValue(a.id, { value: v });
      for (const s of siblings) store.setValue(s.id, { value: v });
      changed();
    });
  } else return null;
  Object.assign(e.style, pos);
  e.dataset.field = a.fieldName; e.dataset.aid = a.id;
  if (a.readOnly) e.disabled = true;
  if (a.alternativeText) e.title = a.alternativeText;
  return e;
}
// every widget of one form field (a field can appear in several places)
function fieldWidgets(src, name) {
  const f = src.fields;
  return (f instanceof Map ? f.get(name) : f?.[name]) || [];
}
function refreshFieldEls(name, src) {
  for (const o of $$(`.widgetLayer [data-field="${CSS.escape(name)}"]`)) {
    if (o.type !== 'checkbox' && o.type !== 'radio') continue;
    const v = src.doc.annotationStorage.getValue(o.dataset.aid, { value: o.checked }).value;
    o.checked = !!v;
  }
}

// ---------- thumbnails ----------
const thumbsEl = $('#thumbs');
const thumbEls = new Map();   // page id -> { el, canvas, key }
const THUMB_W = 124;
let thumbQueue = [], thumbBusy = false;
const thumbIO = new IntersectionObserver((entries) => {
  for (const en of entries) if (en.isIntersecting) { thumbQueue.push(en.target.dataset.id); }
  runThumbs();
}, { root: thumbsEl, rootMargin: '400px 0px' });

function buildThumbs() {
  const keep = new Set(), frag = document.createDocumentFragment();
  S.pages.forEach((rec, i) => {
    let t = thumbEls.get(rec.id);
    if (!t) {
      const tc = el('div.tc'), tn = el('div.tn');
      const d = el('div.thumb', { draggable: true, data: { id: rec.id } }, tc, tn);
      t = { el: d, tc, tn, key: null }; thumbEls.set(rec.id, t); thumbIO.observe(d);
    }
    const [w, h] = viewSize(rec);
    t.tc.style.width = THUMB_W + 'px'; t.tc.style.height = Math.round((THUMB_W * h) / w) + 'px';
    t.tn.textContent = i + 1;
    t.el.classList.toggle('sel', S.thumbSel.has(rec.id));
    t.el.classList.toggle('cur', i === S.cur);
    if (t.key !== null && t.key !== rec.rot) thumbQueue.push(rec.id);
    keep.add(rec.id); frag.append(t.el);
  });
  for (const [id, t] of thumbEls) if (!keep.has(id)) { thumbIO.unobserve(t.el); t.el.remove(); thumbEls.delete(id); }
  thumbsEl.replaceChildren(frag);
  runThumbs();
}
async function runThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  try {
    while (thumbQueue.length) {
      const id = thumbQueue.shift(), t = thumbEls.get(id), i = recIndex(id);
      if (!t || i < 0) continue;
      const rec = S.pages[i];
      if (t.key === rec.rot) continue;
      if (!rec.src) { t.tc.replaceChildren(); t.tc.classList.add('blank'); t.key = rec.rot; continue; }
      try {
        const page = await getPdfPage(rec), rot = (page.rotate + rec.rot) % 360;
        const base = page.getViewport({ scale: 1, rotation: rot });
        const vp = page.getViewport({ scale: (THUMB_W * Math.min(window.devicePixelRatio || 1, 2)) / base.width, rotation: rot });
        const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        await page.render({ canvas: c, viewport: vp }).promise;
        t.tc.replaceChildren(c); t.key = rec.rot;
      } catch (e) { console.warn('thumb', e); t.key = rec.rot; }
    }
  } finally { thumbBusy = false; }
}
function markCurrentThumb() {
  for (const [id, t] of thumbEls) t.el.classList.toggle('cur', S.pages[S.cur]?.id === id);
  const t = thumbEls.get(S.pages[S.cur]?.id);
  if (t && !document.documentElement.classList.contains('nosidebar') && !thumbsEl.hidden) {
    const r = t.el.getBoundingClientRect(), pr = thumbsEl.getBoundingClientRect();
    if (r.top < pr.top || r.bottom > pr.bottom) thumbsEl.scrollTop += r.top - pr.top - pr.height / 2 + r.height / 2;
  }
}
function selectedPageIndices() {
  const idx = S.pages.map((p, i) => (S.thumbSel.has(p.id) ? i : -1)).filter((i) => i >= 0);
  return idx.length ? idx : hasDoc() ? [S.cur] : [];
}
let thumbAnchor = null;
thumbsEl.addEventListener('click', (e) => {
  const t = e.target.closest('.thumb'); if (!t) { S.thumbSel.clear(); buildThumbs(); return; }
  const id = t.dataset.id, i = recIndex(id);
  if (e.shiftKey && thumbAnchor != null && recIndex(thumbAnchor) >= 0) {
    const a = recIndex(thumbAnchor); S.thumbSel.clear();
    for (let k = Math.min(a, i); k <= Math.max(a, i); k++) S.thumbSel.add(S.pages[k].id);
  } else if (e.ctrlKey || e.metaKey) {
    S.thumbSel.has(id) ? S.thumbSel.delete(id) : S.thumbSel.add(id); thumbAnchor = id;
  } else { S.thumbSel.clear(); S.thumbSel.add(id); thumbAnchor = id; goToPage(i); }
  buildThumbs();
});

// ---------- find ----------
const F = { q: '', hits: [], cur: -1, token: 0, focus: false, cache: new Map() };
async function pageText(rec) {
  const key = rec.src + ':' + rec.idx;
  if (F.cache.has(key)) return F.cache.get(key);
  const page = await getPdfPage(rec);
  const items = (await page.getTextContent()).items.filter((i) => i.str !== undefined);
  let str = ''; const starts = [];
  for (const it of items) { starts.push(str.length); str += it.str; if (it.hasEOL) str += ' '; }
  const t = { str: str.toLowerCase(), starts, lens: items.map((i) => i.str.length) };
  F.cache.set(key, t);
  return t;
}
async function runFind(q) {
  const token = ++F.token;
  F.q = q.toLowerCase(); F.hits = []; F.cur = -1;
  for (const [, v] of S.views) v.findLayer.replaceChildren();
  if (!F.q) { $('#findCount').textContent = ''; return; }
  $('#findCount').textContent = 'Searching';
  const startAt = S.cur;
  for (let i = 0; i < S.pages.length; i++) {
    const rec = S.pages[i];
    if (!rec.src) continue;
    let t; try { t = await pageText(rec); } catch { continue; }
    if (token !== F.token) return;
    let from = 0, at, found = false;
    while ((at = t.str.indexOf(F.q, from)) >= 0) { F.hits.push({ id: rec.id, s: at, e: at + F.q.length }); from = at + Math.max(1, F.q.length); found = true; }
    if (found) S.views.get(rec.id)?.renderFind();
    if (F.cur < 0 && found && i >= startAt) { F.cur = F.hits.findIndex((h) => h.id === rec.id); focusHit(); }
    if (i % 20 === 19) { showFindCount(true); await new Promise((r) => setTimeout(r)); if (token !== F.token) return; }
  }
  if (F.cur < 0 && F.hits.length) { F.cur = 0; focusHit(); }
  showFindCount(false);
}
function showFindCount(searching) {
  $('#findCount').textContent = F.hits.length ? `${F.cur + 1} of ${F.hits.length}${searching ? '+' : ''}` : searching ? 'Searching' : F.q ? 'No matches' : '';
}
function stepFind(d) {
  if (!F.hits.length) return;
  F.cur = (F.cur + d + F.hits.length) % F.hits.length;
  focusHit(); showFindCount(false);
}
function focusHit() {
  const h = F.hits[F.cur]; if (!h) return;
  const i = recIndex(h.id); if (i < 0) return;
  F.focus = true;
  const v = viewAt(i);
  if (!v.textDiv) goToPage(i);
  for (const [, o] of S.views) if (o.findLayer.childElementCount) o.renderFind();
  v.renderFind();
}
function paintFind(v) {
  v.findLayer.replaceChildren();
  if (!F.q || !v.textDiv || !v.tl) return;
  const hits = F.hits.filter((h) => h.id === v.rec.id); if (!hits.length) return;
  const t = F.cache.get(v.rec.src + ':' + v.rec.idx); if (!t) return;
  const divs = v.tl.textDivs, pr = v.div.getBoundingClientRect(), range = document.createRange();
  const locate = (off) => {
    let lo = 0, hi = t.starts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (t.starts[m] <= off) lo = m; else hi = m - 1; }
    return [lo, Math.min(off - t.starts[lo], t.lens[lo])];
  };
  for (const h of hits) {
    const [i0, o0] = locate(h.s), [i1, o1] = locate(h.e);
    const n0 = divs[i0]?.firstChild, n1 = divs[i1]?.firstChild;
    if (!n0 || !n1 || n0.nodeType !== 3 || n1.nodeType !== 3) continue;
    try { range.setStart(n0, Math.min(o0, n0.length)); range.setEnd(n1, Math.min(o1, n1.length)); } catch { continue; }
    const isCur = F.hits[F.cur] === h; let first = null;
    for (const r of range.getClientRects()) {
      if (r.width < 0.5 || r.height < 0.5) continue;
      const m = el('i' + (isCur ? '.cur' : ''), { style: {
        left: (r.left - pr.left) / S.scale + 'px', top: (r.top - pr.top) / S.scale + 'px',
        width: r.width / S.scale + 'px', height: r.height / S.scale + 'px' } });
      v.findLayer.append(m); first ??= r;
    }
    if (isCur && first && F.focus) {
      F.focus = false;
      const sr = scroller.getBoundingClientRect();
      if (first.top < sr.top + 70 || first.bottom > sr.bottom - 40) scroller.scrollTop += first.top - sr.top - sr.height * 0.35;
      if (first.left < sr.left || first.right > sr.right) scroller.scrollLeft += first.left - sr.left - sr.width / 2;
    }
  }
}

// ---------- outline (table of contents) ----------
async function buildOutline() {
  const box = $('#outline'); box.replaceChildren();
  const src = S.sources.get(S.primary);
  let items = null;
  try { items = await src?.doc.getOutline(); } catch {}
  if (!items?.length) { box.append(el('div.empty', { textContent: 'This document has no table of contents.' })); return; }
  const make = (list) => {
    const ul = el('ul');
    for (const it of list) {
      const a = el('a', { textContent: it.title, title: it.title });
      a.addEventListener('click', () => { if (it.dest) gotoDest(src, it.dest); else if (it.url) openLink(it.url); });
      const li = el('li', {}, a);
      if (it.items?.length) li.append(make(it.items));
      ul.append(li);
    }
    return ul;
  };
  box.append(make(items));
}

// ---------- remember where you were ----------
let _posT;
function rememberPosition() {
  clearTimeout(_posT);
  _posT = setTimeout(() => {
    if (!S.name) return;
    try {
      const key = S.name + '.' + S.fileSize;
      const list = positions().filter((p) => p[0] !== key);
      list.unshift([key, S.cur]);
      localStorage.setItem(POS_KEY, JSON.stringify(list.slice(0, POS_MAX)));      // only the most recent files are kept
    } catch {}
  }, 500);
}
function recallPosition() {
  const hit = positions().find((p) => p[0] === S.name + '.' + S.fileSize);
  return hit ? Number(hit[1]) || 0 : 0;
}
const POS_KEY = 'pdfeditor.positions', POS_MAX = 50;
function positions() { try { const l = JSON.parse(localStorage.getItem(POS_KEY)); return Array.isArray(l) ? l : []; } catch { return []; } }
// Earlier versions kept one entry per file ever opened, with no limit. Fold those into the capped list.
try {
  const old = Object.keys(localStorage).filter((k) => k.startsWith('pdfeditor.pos.'));
  if (old.length) {
    const list = positions();
    for (const k of old.slice(-POS_MAX)) list.push([k.slice('pdfeditor.pos.'.length), Number(localStorage.getItem(k)) || 0]);
    for (const k of old) localStorage.removeItem(k);
    localStorage.setItem(POS_KEY, JSON.stringify(list.slice(0, POS_MAX)));
  }
} catch {}

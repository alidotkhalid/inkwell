// ---------- annotations: model, drawing on screen, tools ----------
const FONTS = {
  sans: 'Arial, Helvetica, "Liberation Sans", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", serif',
  mono: '"Courier New", Courier, "Liberation Mono", monospace',
};
const LH = 1.2;
const _blCache = {};
// distance from the top of a line box to the text baseline, as a fraction of font size
function baselineRatio(font, bold, italic) {
  const key = font + (bold ? 'b' : '') + (italic ? 'i' : '');
  if (_blCache[key]) return _blCache[key];
  const d = el('div', { style: { position: 'absolute', visibility: 'hidden', left: '-9999px', top: '0', whiteSpace: 'pre', lineHeight: LH,
    fontFamily: FONTS[font], fontSize: '200px', fontWeight: bold ? '700' : '400', fontStyle: italic ? 'italic' : 'normal' } });
  const m = el('span', { style: { display: 'inline-block', width: '1px', height: '0', verticalAlign: 'baseline' } });
  d.append('Hg', m); document.body.append(d);
  const r = (m.getBoundingClientRect().top - d.getBoundingClientRect().top) / 200;
  d.remove();
  return (_blCache[key] = r > 0.5 && r < 1.2 ? r : 0.94);
}

const isMultiply = (a) => (a.type === 'hl' && a.mode === 'highlight') || (a.type === 'ink' && !!a.marker);
function bbox(a) {
  switch (a.type) {
    case 'text': return { x: a.x, y: a.y, w: a.w || 8, h: a.h || a.size * LH };
    case 'line': return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
    case 'ink': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of a.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const p = a.sw / 2; return { x: x0 - p, y: y0 - p, w: x1 - x0 + a.sw, h: y1 - y0 + a.sw };
    }
    case 'hl': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const r of a.rects) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    default: return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
}
function moveBy(a, dx, dy) {
  switch (a.type) {
    case 'line': a.x1 += dx; a.x2 += dx; a.y1 += dy; a.y2 += dy; break;
    case 'ink': for (const p of a.pts) { p[0] += dx; p[1] += dy; } break;
    case 'hl': for (const r of a.rects) { r.x += dx; r.y += dy; } break;
    default: a.x += dx; a.y += dy;
  }
}
// Rotate an annotation with its page. cw=true: quarter turn clockwise. W,H: page size before the turn.
function rotateAnnot(a, cw, W, H) {
  const T = cw ? (x, y) => [H - y, x] : (x, y) => [y, W - x];
  const rr = (r) => { const [ax, ay] = T(r.x, r.y), [bx, by] = T(r.x + r.w, r.y + r.h); return { x: Math.min(ax, bx), y: Math.min(ay, by), w: r.h, h: r.w }; };
  switch (a.type) {
    case 'line': [a.x1, a.y1] = T(a.x1, a.y1); [a.x2, a.y2] = T(a.x2, a.y2); break;
    case 'ink': a.pts = a.pts.map(([x, y]) => T(x, y)); break;
    case 'hl': a.rects = a.rects.map(rr); break;
    case 'rect': case 'ellipse': Object.assign(a, rr(a)); break;
    default: { const b = bbox(a), [cx, cy] = T(b.x + b.w / 2, b.y + b.h / 2); a.x = cx - b.w / 2; a.y = cy - b.h / 2; }
  }
}
function arrowGeom(a) {
  const dx = a.x2 - a.x1, dy = a.y2 - a.y1, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
  const head = Math.min(len, Math.max(7, a.sw * 4.5)), hw = head * 0.38;
  const bx = a.x2 - ux * head, by = a.y2 - uy * head;
  return { end: [a.x2 - ux * head * 0.7, a.y2 - uy * head * 0.7], tri: [[a.x2, a.y2], [bx - uy * hw, by + ux * hw], [bx + uy * hw, by - ux * hw]] };
}
const hlMarks = (a) => a.rects.map((r) => {
  if (a.mode === 'highlight') return r;
  const t = clamp(r.h * 0.07, 0.7, 2);
  return { x: r.x, w: r.w, h: t, y: a.mode === 'underline' ? r.y + r.h - t * 1.2 : r.y + r.h * 0.52 };
});

function annotEl(a, rec) {
  const [W, H] = viewSize(rec);
  if (a.type === 'text') {
    return el('div.an.txt', { textContent: a.text, style: {
      left: a.x + 'px', top: a.y + 'px', fontFamily: FONTS[a.font], fontSize: a.size + 'px', minHeight: a.size * LH + 'px',
      fontWeight: a.bold ? '700' : '400', fontStyle: a.italic ? 'italic' : 'normal', color: a.color } });
  }
  if (a.type === 'image') {
    return el('img.an', { src: S.assets.get(a.asset)?.url || '', draggable: false, alt: '',
      style: { left: a.x + 'px', top: a.y + 'px', width: a.w + 'px', height: a.h + 'px' } });
  }
  const s = svg('svg', { class: 'an', width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  const hitW = (sw) => Math.max(sw, 9);
  if (a.type === 'rect' || a.type === 'ellipse') {
    const g = a.type === 'rect' ? { x: a.x, y: a.y, width: a.w, height: a.h }
      : { cx: a.x + a.w / 2, cy: a.y + a.h / 2, rx: a.w / 2, ry: a.h / 2 };
    const tag = a.type === 'rect' ? 'rect' : 'ellipse';
    s.append(svg(tag, { ...g, class: 'vis', fill: a.fill || 'none', stroke: a.stroke || 'none', 'stroke-width': a.sw }));
    if (!a.fill) s.append(svg(tag, { ...g, class: 'hit', 'stroke-width': hitW(a.sw) }));
  } else if (a.type === 'line') {
    let ex = a.x2, ey = a.y2;
    if (a.arrow) {
      const g = arrowGeom(a); [ex, ey] = g.end;
      s.append(svg('path', { class: 'vis', d: 'M' + g.tri.map((p) => p.join(' ')).join('L') + 'Z', fill: a.stroke }));
    }
    s.append(svg('line', { class: 'vis', x1: a.x1, y1: a.y1, x2: ex, y2: ey, stroke: a.stroke, 'stroke-width': a.sw, 'stroke-linecap': a.arrow ? 'butt' : 'round' }));
    s.append(svg('line', { class: 'hit', x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, 'stroke-width': hitW(a.sw) }));
  } else if (a.type === 'ink') {
    const d = 'M' + a.pts.map((p) => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('L') + (a.pts.length === 1 ? 'l0.01 0' : '');
    s.append(svg('path', { class: 'vis', d, fill: 'none', stroke: a.stroke, 'stroke-width': a.sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    s.append(svg('path', { class: 'hit', d, 'stroke-width': hitW(a.sw) }));
  } else if (a.type === 'hl') {
    const d = hlMarks(a).map((r) => `M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}Z`).join('');
    s.append(svg('path', { class: 'vis', d, fill: a.color }));
    if (a.mode !== 'highlight') s.append(svg('path', { class: 'hit', d, 'stroke-width': 6 }));
  }
  return s;
}

// ---------- history ----------
function commit() {
  if (S.savedIdx > S.hIdx) S.savedIdx = -1;          // the saved state was in the redo branch that is now gone
  S.history.length = S.hIdx + 1;
  S.history.push(JSON.stringify(S.pages));
  if (S.history.length > 80) { S.history.shift(); S.savedIdx--; }
  S.hIdx = S.history.length - 1;
  syncDirty();
}
function resetHistory() { S.history = [JSON.stringify(S.pages)]; S.hIdx = 0; S.savedIdx = 0; S.formDirty = false; }
// There are unsaved changes when the document is not at the undo step it was last saved (or opened) at,
// or a form field was filled in since. Undoing everything therefore clears the mark again.
function syncDirty() { S.dirty = S.formDirty || S.hIdx !== S.savedIdx; updateUI(); }
function markSaved() { S.savedIdx = S.hIdx; S.formDirty = false; syncDirty(); }
function timeTravel(d) {
  const n = S.hIdx + d;
  if (n < 0 || n >= S.history.length) return;
  if (S.editing) finishEdit();
  S.hIdx = n; S.pages = JSON.parse(S.history[n]);
  S.sel = null; S.dirty = S.formDirty || S.hIdx !== S.savedIdx;
  S.cur = clamp(S.cur, 0, S.pages.length - 1);
  refreshAll();
}

// ---------- selection ----------
const HANDLES = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
function findAnnot(sel = S.sel) {
  if (!sel) return {};
  const rec = S.pages.find((p) => p.id === sel.pageId), a = rec?.annots.find((x) => x.id === sel.id);
  return { rec, a, view: rec && S.views.get(rec.id) };
}
function select(id, pageId) {
  S.sel = id ? { id, pageId } : null;
  for (const b of $$('.selbox')) b.remove();
  drawSelBox(); renderOptbar();
}
function drawSelBox() {
  const { a, view } = findAnnot();
  if (!view) return;
  view.annoLayer.querySelector('.selbox')?.remove();
  if (!a) return;
  const b = bbox(a), pad = a.type === 'text' ? 2 : 0;
  const box = el('div.selbox', { style: { left: b.x - pad + 'px', top: b.y - pad + 'px', width: b.w + pad * 2 + 'px', height: b.h + pad * 2 + 'px' } });
  const k = 1 / S.scale;   // keep handles the same size on screen at any zoom
  const addHandle = (name, fx, fy, round) => box.append(el('b' + (round ? '.round' : ''), { data: { h: name },
    style: { left: fx * 100 + '%', top: fy * 100 + '%', transform: `scale(${k})`, cursor: round ? 'crosshair' : name + '-resize' } }));
  if (a.type === 'line') {
    box.classList.add('line');
    addHandle('p1', b.w ? (a.x1 - b.x) / b.w : 0, b.h ? (a.y1 - b.y) / b.h : 0, true);
    addHandle('p2', b.w ? (a.x2 - b.x) / b.w : 0, b.h ? (a.y2 - b.y) / b.h : 0, true);
  } else if (a.type === 'rect' || a.type === 'ellipse') {
    for (const [n, [fx, fy]] of Object.entries(HANDLES)) addHandle(n, fx, fy);
  } else if (a.type === 'image') {
    for (const n of ['nw', 'ne', 'se', 'sw']) addHandle(n, ...HANDLES[n]);
  }
  box.style.borderWidth = k + 'px';
  view.annoLayer.append(box);
}
function deleteSelected() {
  const { rec, a, view } = findAnnot(); if (!a) return;
  rec.annots.splice(rec.annots.indexOf(a), 1);
  S.sel = null; view.renderAnnots(); view.annoLayer.querySelector('.selbox')?.remove();
  renderOptbar(); commit();
}
function addAnnot(view, a, { selectIt = false, noCommit = false } = {}) {
  a.id = uid();
  view.rec.annots.push(a); view.renderAnnots();
  if (selectIt) select(a.id, view.rec.id);
  if (!noCommit) commit();
  return a;
}

// ---------- text editing ----------
function startEdit(view, a, selectAll) {
  select(null);
  const d = view.annoEls.get(a.id); if (!d) return;
  S.editing = { view, a, d, orig: a.text };
  d.classList.add('editing'); d.contentEditable = 'plaintext-only'; document.body.classList.add('editing');
  d.focus();
  const r = document.createRange(); r.selectNodeContents(d); if (!selectAll) r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  d.addEventListener('blur', finishEdit, { once: true });
  d.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); d.blur(); } });   // ends typing; the tool stays as it is
  renderOptbar();
}
function finishEdit(ev) {
  const ed = S.editing; if (!ed) return;
  S.editing = null; document.body.classList.remove('editing');
  const { view, a, d, orig } = ed;
  const text = d.textContent.replace(/\t/g, '    ').replace(/\s+$/, '');
  d.contentEditable = 'false'; d.classList.remove('editing');
  const rec = view.rec, drop = (x) => { const i = rec.annots.indexOf(x); if (i >= 0) rec.annots.splice(i, 1); };
  if (ed.withCover && text === orig) { drop(a); drop(ed.withCover); view.renderAnnots(); }      // nothing changed: leave the page alone
  else if (!text) { drop(a); view.renderAnnots(); if (orig) commit(); }
  else { a.text = text; view.renderAnnots(); if (text !== orig || ed.withCover || ed.styled) commit(); }
  _lastEdit = ed;
  if (!ev?.relatedTarget?.closest?.('#optbar')) renderOptbar();
}
let _lastEdit = null;

// "Edit existing text": cover the original run and put an editable copy on top of it.
function editExistingText(view, span) {
  const divs = view.tl?.textDivs || [], items = view.textItems || [];
  const i0 = divs.indexOf(span); if (i0 < 0 || !items[i0]) return;
  const pr = view.div.getBoundingClientRect(), s = S.scale;
  const rc = (d) => { const r = d.getBoundingClientRect(); return { x: (r.left - pr.left) / s, y: (r.top - pr.top) / s, w: r.width / s, h: r.height / s }; };
  const base = rc(span), cy = base.y + base.h / 2;
  // gather the pieces of the same line that sit right next to each other
  const line = [];
  divs.forEach((d, i) => {
    if (!d.isConnected || !items[i] || !items[i].str.trim()) return;
    const r = rc(d);
    if (Math.abs(r.y + r.h / 2 - cy) < base.h * 0.35 && Math.abs(r.h - base.h) < base.h * 0.25) line.push({ i, r });
  });
  line.sort((p, q) => p.r.x - q.r.x);
  const at = line.findIndex((p) => p.i === i0);
  if (at < 0) return;
  let lo = at, hi = at;
  while (lo > 0 && line[lo].r.x - (line[lo - 1].r.x + line[lo - 1].r.w) < base.h * 0.9) lo--;
  while (hi < line.length - 1 && line[hi + 1].r.x - (line[hi].r.x + line[hi].r.w) < base.h * 0.9) hi++;
  const run = line.slice(lo, hi + 1);
  let text = '';
  run.forEach((p, k) => {
    const str = items[p.i].str;
    if (k > 0) { const gap = p.r.x - (run[k - 1].r.x + run[k - 1].r.w); if (gap > base.h * 0.18 && !/\s$/.test(text) && !/^\s/.test(str)) text += ' '; }
    text += str;
  });
  const x0 = run[0].r.x, x1 = run.at(-1).r.x + run.at(-1).r.w;
  const y0 = Math.min(...run.map((p) => p.r.y)), y1 = Math.max(...run.map((p) => p.r.y + p.r.h));
  const first = items[run[0].i];
  // font: size from the text matrix, family and weight from the embedded font's name
  const vp1 = view.pdfPage.getViewport({ scale: 1, rotation: view.pageRot });
  const size = Math.round(Math.hypot(first.transform[2], first.transform[3]) * 10) / 10 || 12;
  const [bxv, byv] = vp1.convertToViewportPoint(first.transform[4], first.transform[5]);
  let fam = getComputedStyle(run[0] && divs[run[0].i]).fontFamily.toLowerCase(), name = '';
  try { name = view.pdfPage.commonObjs.get(first.fontName)?.name || ''; } catch {}
  const font = /mono|courier|consol/.test(fam + name.toLowerCase()) ? 'mono' : /sans|arial|helvet|calibri|verdana|tahoma|segoe/.test(fam + name.toLowerCase()) ? 'sans' : /serif|times|georgia|garamond|roman|minion/.test(fam + name.toLowerCase()) ? 'serif' : 'sans';
  const bold = /bold|black|heavy|semibold|demi/i.test(name), italic = /italic|oblique/i.test(name);
  // cover the whole run, including the tails of letters like g and y that hang below the line
  const top = Math.min(y0, byv - size * 0.92) - 0.5, bottom = Math.max(y1, byv + size * 0.3) + 0.5;
  const cover = { x: x0 - 1, y: top, w: x1 - x0 + 2, h: bottom - top };
  const { bg, fg } = sampleColors(view, cover);
  const coverA = addAnnot(view, { type: 'rect', ...cover, fill: bg, stroke: null, sw: 0, cover: true }, { noCommit: true });
  const a = addAnnot(view, { type: 'text', x: bxv, y: byv - baselineRatio(font, bold, italic) * size, text, font, size, bold, italic, color: fg }, { noCommit: true });
  startEdit(view, a, true);
  S.editing.withCover = coverA;
}
// Look at the rendered page to find the paper colour around a box and the ink colour inside it.
function sampleColors(view, box) {
  const out = { bg: '#ffffff', fg: '#111111' };
  const c = view.canvas; if (!c) return out;
  try {
    const k = c.width / viewSize(view.rec)[0];
    const sx = clamp(Math.floor(box.x * k), 0, c.width - 1), sy = clamp(Math.floor(box.y * k), 0, c.height - 1);
    const sw = clamp(Math.ceil(box.w * k), 1, c.width - sx), sh = clamp(Math.ceil(box.h * k), 1, c.height - sy);
    const t = document.createElement('canvas'); t.width = sw; t.height = sh;
    const ctx = t.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh);
    const d = ctx.getImageData(0, 0, sw, sh).data, count = new Map();
    const q = (i) => ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
    const edge = (x, y) => { const key = q((y * sw + x) * 4); count.set(key, (count.get(key) || 0) + 1); };
    for (let x = 0; x < sw; x++) { edge(x, 0); edge(x, sh - 1); }
    for (let y = 0; y < sh; y++) { edge(0, y); edge(sw - 1, y); }
    let best = 0, bk = 0x7fff;
    for (const [key, n] of count) if (n > best) { best = n; bk = key; }
    const bgc = [((bk >> 10) & 31) * 8 + 4, ((bk >> 5) & 31) * 8 + 4, (bk & 31) * 8 + 4].map((v) => (v > 247 ? 255 : v < 8 ? 0 : v));
    out.bg = rgbHex(...bgc);
    let far = 0, fg = null;
    for (let i = 0; i < d.length; i += 16) {
      const dist = Math.abs(d[i] - bgc[0]) + Math.abs(d[i + 1] - bgc[1]) + Math.abs(d[i + 2] - bgc[2]);
      if (dist > far) { far = dist; fg = [d[i], d[i + 1], d[i + 2]]; }
    }
    if (fg && far > 90) out.fg = rgbHex(...fg);
    else if (bgc[0] + bgc[1] + bgc[2] < 300) out.fg = '#ffffff';
  } catch (e) { console.warn('sample', e); }
  return out;
}

// ---------- highlights from selected text ----------
function selectionRectsByView() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return null;
  const node = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
  if (!node?.closest?.('.textLayer')) return null;
  const out = new Map();
  for (const r of sel.getRangeAt(0).getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const view = viewAtClient(r.left + r.width / 2, r.top + r.height / 2); if (!view) continue;
    const pr = view.div.getBoundingClientRect();
    if (r.height > pr.height * 0.2 && r.width > pr.width * 0.5) continue;       // a container, not a line of text
    const q = { x: (r.left - pr.left) / S.scale, y: (r.top - pr.top) / S.scale, w: r.width / S.scale, h: r.height / S.scale };
    if (!out.has(view)) out.set(view, []);
    out.get(view).push(q);
  }
  for (const [view, rects] of out) {
    rects.sort((a, b) => a.y - b.y || a.x - b.x);
    const merged = [];
    for (const r of rects) {
      const m = merged.find((m) => Math.abs(m.y + m.h / 2 - (r.y + r.h / 2)) < Math.min(m.h, r.h) * 0.5 && r.x <= m.x + m.w + m.h * 0.8 && r.x + r.w >= m.x - m.h * 0.8);
      if (m) { const x1 = Math.max(m.x + m.w, r.x + r.w), y1 = Math.max(m.y + m.h, r.y + r.h); m.x = Math.min(m.x, r.x); m.y = Math.min(m.y, r.y); m.w = x1 - m.x; m.h = y1 - m.y; }
      else merged.push({ ...r });
    }
    out.set(view, merged);
  }
  return out.size ? out : null;
}
function markSelection(mode, color) {
  const by = selectionRectsByView(); if (!by) return false;
  for (const [view, rects] of by) addAnnot(view, { type: 'hl', rects, mode, color }, { noCommit: true });
  getSelection().removeAllRanges(); hideSelPop(); commit();
  return true;
}
const selPop = $('#selPop');
function hideSelPop() { selPop.hidden = true; }
function maybeShowSelPop() {
  const sel = getSelection();
  if (S.tool !== 'select' || !sel.rangeCount || sel.isCollapsed || !selectionRectsByView()) return hideSelPop();
  const rects = [...sel.getRangeAt(0).getClientRects()].filter((r) => r.width > 1 && r.height > 1 && r.height < 200);
  if (!rects.length) return hideSelPop();
  const r = rects[0];
  selPop.hidden = false;
  selPop.style.left = clamp(r.left, 8, innerWidth - selPop.offsetWidth - 8) + 'px';
  selPop.style.top = Math.max(54, r.top - selPop.offsetHeight - 8) + 'px';
}
selPop.addEventListener('pointerdown', (e) => e.preventDefault());
selPop.addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act; if (!act) return;
  if (act === 'copy') { navigator.clipboard?.writeText(getSelection().toString()).then(() => toast('Copied'), () => document.execCommand('copy')); hideSelPop(); return; }
  const color = act === 'highlight' ? prefs.hl.color : act === 'underline' ? '#1F4FD8' : '#D92D20';
  markSelection(act === 'strike' ? 'strike' : act, color);
});

// ---------- pointer tools ----------
const DRAW_TOOLS = new Set(['text', 'draw', 'shape', 'whiteout', 'check']);
let drag = null;

function setTool(t) {
  if (S.editing) S.editing.d.blur();
  if (t === 'image') { $('#fileImg').click(); return; }
  if (t === 'sign') { openSignDialog(); return; }
  S.tool = t;
  document.body.dataset.tool = t;
  document.body.classList.toggle('drawing', DRAW_TOOLS.has(t));
  for (const b of $$('#rail .tb')) b.classList.toggle('on', b.dataset.tool === t);
  if (t !== 'select') select(null);
  hideSelPop(); renderOptbar();
}

pagesEl.addEventListener('pointerdown', (e) => {
  if (e.button === 1) return startPan(e);
  if (e.button !== 0) return;
  const pageDiv = e.target.closest('.page');
  const view = pageDiv && S.views.get(pageDiv.dataset.id);
  if (S.tool === 'hand') return startPan(e);
  if (!view) { if (S.tool === 'select') select(null); return; }
  const p = view.pt(e);

  if (S.tool === 'select') {
    const handle = e.target.closest('.selbox b');
    if (handle) { e.preventDefault(); return beginDrag(e, view, { kind: 'resize', h: handle.dataset.h }); }
    const anEl = e.target.closest('.an');
    if (anEl && !anEl.classList.contains('editing')) {
      e.preventDefault(); getSelection().removeAllRanges(); hideSelPop();
      select(anEl.dataset.id, view.rec.id);
      return beginDrag(e, view, { kind: 'move' });
    }
    if (!e.target.closest('.editing')) select(null);
    return;
  }
  if (S.tool === 'edittext') {
    const span = e.target.closest('.textLayer span');
    if (span && !S.editing) { e.preventDefault(); editExistingText(view, span); }
    return;
  }
  if (S.tool === 'hl') {
    if (e.target.closest('.textLayer span')) { drag = { kind: 'hltext' }; return; }   // let the browser select text
    e.preventDefault();
    return beginDrag(e, view, { kind: 'new', a: { type: 'hl', mode: 'highlight', color: prefs.hl.color, rects: [{ x: p.x, y: p.y, w: 0, h: 0 }] }, x0: p.x, y0: p.y });
  }
  e.preventDefault();
  if (S.tool === 'text') {
    if (S.editing) { S.editing.d.blur(); return; }      // this click only closes the text box being typed in
    const hit = document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.classList?.contains('txt'));
    if (hit) { const a = view.rec.annots.find((x) => x.id === hit.dataset.id); if (a) return startEdit(view, a, false); }
    const t = prefs.text;
    const a = addAnnot(view, { type: 'text', x: p.x, y: p.y - t.size * 0.62, text: '', ...t }, { noCommit: true });
    startEdit(view, a, false);
    return;
  }
  if (S.tool === 'check') {
    const c = prefs.check, s = c.size, k = c.kind;
    const shape = k === 'check' ? [[[-0.45, 0.02], [-0.12, 0.36], [0.5, -0.4]]] : k === 'cross' ? [[[-0.4, -0.4], [0.4, 0.4]], [[0.4, -0.4], [-0.4, 0.4]]] : [[[0, 0]]];
    for (const stroke of shape) addAnnot(view, { type: 'ink', pts: stroke.map(([x, y]) => [p.x + x * s, p.y + y * s]), stroke: c.color, sw: k === 'dot' ? s * 0.6 : Math.max(1, s * 0.13) }, { noCommit: true });
    commit();
    return;
  }
  if (S.tool === 'draw') {
    const d = prefs.draw;
    return beginDrag(e, view, { kind: 'new', a: { type: 'ink', pts: [[p.x, p.y]], stroke: d.color, sw: d.marker ? Math.max(8, d.sw * 4) : d.sw, marker: d.marker } });
  }
  if (S.tool === 'shape') {
    const sh = prefs.shape;
    const a = sh.kind === 'line' || sh.kind === 'arrow'
      ? { type: 'line', x1: p.x, y1: p.y, x2: p.x, y2: p.y, stroke: sh.stroke || '#D92D20', sw: sh.sw, arrow: sh.kind === 'arrow' }
      : { type: sh.kind, x: p.x, y: p.y, w: 0, h: 0, stroke: sh.stroke, fill: sh.fill, sw: sh.sw };
    return beginDrag(e, view, { kind: 'new', a, x0: p.x, y0: p.y });
  }
  if (S.tool === 'whiteout') {
    return beginDrag(e, view, { kind: 'new', a: { type: 'rect', x: p.x, y: p.y, w: 0, h: 0, fill: '#ffffff', stroke: null, sw: 0, cover: true }, x0: p.x, y0: p.y, whiteout: true });
  }
});

function beginDrag(e, view, d) {
  drag = d; d.view = view; d.sx = e.clientX; d.sy = e.clientY; d.moved = false; d.last = view.pt(e);
  if (d.kind === 'new') { d.a.id = uid(); view.rec.annots.push(d.a); view.renderAnnots(); }
  else { const { a } = findAnnot(); d.a = a; d.orig = JSON.stringify(a); }
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd, { once: true });
  window.addEventListener('pointercancel', onDragEnd, { once: true });
}
function onDragMove(e) {
  const d = drag; if (!d || !d.view) return;
  const p = d.view.pt(e), a = d.a;
  if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return;
  d.moved = true;
  if (d.kind === 'move') { moveBy(a, p.x - d.last.x, p.y - d.last.y); d.last = p; }
  else if (d.kind === 'new') {
    if (a.type === 'ink') { const l = a.pts.at(-1); if (Math.hypot(p.x - l[0], p.y - l[1]) > 0.6 / Math.max(1, S.scale / PT)) a.pts.push([p.x, p.y]); }
    else if (a.type === 'line') { a.x2 = p.x; a.y2 = p.y; if (e.shiftKey) snapLine(a); }
    else {
      let w = p.x - d.x0, h = p.y - d.y0;
      if (e.shiftKey && a.type !== 'hl') { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
      const r = { x: Math.min(d.x0, d.x0 + w), y: Math.min(d.y0, d.y0 + h), w: Math.abs(w), h: Math.abs(h) };
      if (a.type === 'hl') a.rects = [r]; else Object.assign(a, r);
    }
  } else if (d.kind === 'resize') {
    const o = JSON.parse(d.orig);
    if (a.type === 'line') { if (d.h === 'p1') { a.x1 = p.x; a.y1 = p.y; } else { a.x2 = p.x; a.y2 = p.y; if (e.shiftKey) snapLine(a); } }
    else {
      let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
      if (d.h.includes('w')) x0 = Math.min(p.x, x1 - 4); if (d.h.includes('e')) x1 = Math.max(p.x, x0 + 4);
      if (d.h.includes('n')) y0 = Math.min(p.y, y1 - 4); if (d.h.includes('s')) y1 = Math.max(p.y, y0 + 4);
      if (a.type === 'image' && !e.shiftKey) {       // keep the picture's proportions
        const ratio = o.w / o.h; let w = x1 - x0, h = y1 - y0;
        if (w / h > ratio) w = h * ratio; else h = w / ratio;
        if (d.h.includes('w')) x0 = x1 - w; else x1 = x0 + w;
        if (d.h.includes('n')) y0 = y1 - h; else y1 = y0 + h;
      }
      Object.assign(a, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
  }
  const old = d.view.annoEls.get(a.id), neu = annotEl(a, d.view.rec);
  neu.dataset.id = a.id; old?.replaceWith(neu); d.view.annoEls.set(a.id, neu);
  if (d.kind !== 'new') drawSelBox();
}
function snapLine(a) {
  const dx = a.x2 - a.x1, dy = a.y2 - a.y1, len = Math.hypot(dx, dy);
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  a.x2 = a.x1 + Math.cos(ang) * len; a.y2 = a.y1 + Math.sin(ang) * len;
}
function onDragEnd() {
  window.removeEventListener('pointermove', onDragMove);
  const d = drag; drag = null;
  if (!d || !d.view) return;
  const { view, a } = d;
  if (d.kind === 'new') {
    const b = bbox(a);
    const tiny = a.type === 'ink' ? false : a.type === 'line' ? Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 3 : b.w < 3 || b.h < 3;
    if (tiny) { view.rec.annots.splice(view.rec.annots.indexOf(a), 1); view.renderAnnots(); return; }
    if (d.whiteout) a.fill = prefs.whiteout.fill === 'auto' ? sampleColors(view, { x: a.x - 1, y: a.y - 1, w: a.w + 2, h: a.h + 2 }).bg : prefs.whiteout.fill;
    view.renderAnnots(); commit();
  } else if (d.moved) { view.renderAnnots(); commit(); }
}
document.addEventListener('pointerup', () => {
  if (drag?.kind === 'hltext') { drag = null; setTimeout(() => markSelection(prefs.hl.mode, prefs.hl.color), 0); return; }
  if (S.tool === 'select') setTimeout(maybeShowSelPop, 0);
});
pagesEl.addEventListener('dblclick', (e) => {
  if (S.tool !== 'select') return;
  const t = e.target.closest('.an.txt'); if (!t) return;
  const view = S.views.get(t.closest('.page').dataset.id), a = view.rec.annots.find((x) => x.id === t.dataset.id);
  if (a) startEdit(view, a, false);
});

function startPan(e) {
  e.preventDefault();
  const sx = e.clientX, sy = e.clientY, l = scroller.scrollLeft, t = scroller.scrollTop;
  document.body.classList.add('panning');
  const mv = (ev) => { scroller.scrollLeft = l - (ev.clientX - sx); scroller.scrollTop = t - (ev.clientY - sy); };
  const up = () => { window.removeEventListener('pointermove', mv); document.body.classList.remove('panning'); };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up, { once: true });
}
scroller.addEventListener('pointerdown', (e) => {
  if (e.target === scroller || e.target === pagesEl) { if (S.tool === 'hand' || e.button === 1) startPan(e); else if (S.tool === 'select') select(null); }
});

// ---------- images & signatures ----------
// Phone cameras store photos unrotated and add an EXIF note saying which way up they belong.
// Returns that note (1 = already upright).
function jpegOrientation(b) {
  if (b[0] !== 0xFF || b[1] !== 0xD8) return 1;
  let p = 2;
  while (p + 4 < b.length && b[p] === 0xFF) {
    const marker = b[p + 1], len = (b[p + 2] << 8) | b[p + 3];
    if (marker === 0xDA || marker === 0xD9) break;                       // picture data starts: no EXIF ahead
    if (marker === 0xE1 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66) {   // "Exif"
      const t = p + 10, le = b[t] === 0x49;
      const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
      const u32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])) >>> 0;
      const ifd = t + u32(t + 4);
      if (ifd + 2 > b.length) return 1;
      for (let i = 0, n = u16(ifd); i < n && ifd + 14 + i * 12 <= b.length; i++) if (u16(ifd + 2 + i * 12) === 0x0112) return u16(ifd + 10 + i * 12) || 1;
      return 1;
    }
    p += 2 + len;
  }
  return 1;
}
// SVG drawings are turned into a PNG picture (the PDF writer takes PNG and JPEG only).
async function rasterizeSvg(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image(); img.src = url; await img.decode();
    const w = img.naturalWidth || 600, h = img.naturalHeight || 600, k = clamp(1600 / Math.max(w, h), 1, 8);
    const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('empty'))), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}
async function addImageAsset(blob) {
  let mime = blob.type, bmp;
  try {
    if (mime === 'image/svg+xml' || /\.svg$/i.test(blob.name || '')) { blob = await rasterizeSvg(blob); mime = 'image/png'; }
    bmp = await createImageBitmap(blob);       // applies the camera rotation, so width and height are as seen on screen
  } catch { throw new Error('This kind of image cannot be read. PNG, JPEG, WebP, GIF, BMP and SVG work.'); }
  let bytes = new Uint8Array(await blob.arrayBuffer());
  let w = bmp.width, h = bmp.height;
  const tooBig = Math.max(w, h) > 4000;
  // A rotated phone photo must be re-drawn upright: the PDF would otherwise get the unrotated pixels.
  const turned = mime === 'image/jpeg' && jpegOrientation(bytes) !== 1;
  if ((mime !== 'image/png' && mime !== 'image/jpeg') || tooBig || turned) {
    const k = tooBig ? 4000 / Math.max(w, h) : 1;
    const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const out = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const b = await new Promise((r) => c.toBlob(r, out, 0.92));
    bytes = new Uint8Array(await b.arrayBuffer()); mime = out; w = c.width; h = c.height;
  }
  bmp.close?.();
  const id = uid();
  S.assets.set(id, { bytes, mime, w, h, url: URL.createObjectURL(new Blob([bytes], { type: mime })) });
  return id;
}
async function placeImage(blob, maxFrac = 0.45) {
  if (!hasDoc()) return;
  const asset = await addImageAsset(blob), info = S.assets.get(asset);
  const view = viewAt(S.cur), [W, H] = viewSize(view.rec);
  let w = Math.min(info.w * 0.75, W * maxFrac), h = (w * info.h) / info.w;
  if (h > H * 0.6) { h = H * 0.6; w = (h * info.w) / info.h; }
  // centre of the part of the page that is on screen
  const pr = view.div.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
  const cy = (clamp((sr.top + sr.bottom) / 2, pr.top, pr.bottom) - pr.top) / S.scale;
  const cx = (clamp((sr.left + sr.right) / 2, pr.left, pr.right) - pr.left) / S.scale;
  setTool('select');
  addAnnot(view, { type: 'image', asset, x: clamp(cx - w / 2, 0, Math.max(0, W - w)), y: clamp(cy - h / 2, 0, Math.max(0, H - h)), w, h }, { selectIt: true });
}

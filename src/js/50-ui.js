// ---------- interface wiring ----------
function updateUI() {
  const on = hasDoc();
  for (const id of ['btnSave', 'btnSaveAs', 'btnPrint', 'btnFind', 'btnZoomIn', 'btnZoomOut', 'zoomSel', 'pageInput',
    'btnAddPdf', 'btnBlank', 'btnRotL', 'btnRotR', 'btnDup', 'btnExtract', 'btnDelPage']) $('#' + id).disabled = !on;
  $('#btnUndo').disabled = !on || S.hIdx <= 0;
  $('#btnRedo').disabled = !on || S.hIdx >= S.history.length - 1;
  $('#docName').textContent = on ? S.name : 'Inkwell';
  $('#docTitle').title = on ? S.name : '';
  $('#dirtyDot').hidden = !S.dirty;
  document.title = on ? `${S.dirty ? '• ' : ''}${S.name} - Inkwell` : 'Inkwell';
  $('#pageCount').textContent = on ? `of ${S.pages.length}` : '';
  native?.docState(on);
  if (!on) { $('#zoomSel').value = 'auto'; $('#pageInput').value = ''; $('#btnPrev').disabled = $('#btnNext').disabled = true; $('#optbar').hidden = true; $('#findbar').hidden = true; }
}

// ---------- options bar ----------
const INK = ['#111111', '#D92D20', '#1F4FD8', '#16803C', '#F79009', '#7A3FF2'];
const HLC = ['#FFE45C', '#A8F0A0', '#FFB3D1', '#9AD8FF', '#FFC56B'];
let _commitT;
const commitSoon = () => { clearTimeout(_commitT); _commitT = setTimeout(commit, 350); };
const keepFocus = (e) => e.preventDefault();   // clicking an option must not close the text box being typed in

function optTarget() {
  const { a, view } = findAnnot();
  if (a) return { a, view };
  if (S.editing) return { a: S.editing.a, view: S.editing.view };
  if (S.tool === 'text' && _lastEdit && _lastEdit.view.rec.annots.includes(_lastEdit.a) && S.views.get(_lastEdit.view.rec.id) === _lastEdit.view) return { a: _lastEdit.a, view: _lastEdit.view, soft: true };
  return {};
}
function styleText(d, a) {
  Object.assign(d.style, { fontFamily: FONTS[a.font], fontSize: a.size + 'px', minHeight: a.size * LH + 'px', fontWeight: a.bold ? '700' : '400', fontStyle: a.italic ? 'italic' : 'normal', color: a.color });
}
function renderOptbar() {
  const bar = $('#optbar');
  if (!hasDoc()) { bar.hidden = true; return; }
  const { a, view, soft } = optTarget();
  const tool = S.tool, kids = [];
  const set = (obj, prop, val, live) => {
    obj[prop] = val;
    if (obj === a) {
      if (a.type === 'text') { prefs.text[prop] = val; savePrefs(); }
      if (S.editing?.a === a) { styleText(S.editing.d, a); S.editing.styled = true; }
      else { view.renderAnnots(); live ? commitSoon() : commit(); }
    } else savePrefs();
    if (!live) renderOptbar();
  };
  const label = (t) => el('label', { textContent: t });
  const sep = () => el('span.sep');
  const colors = (obj, prop, list, allowNone) => {
    const out = [];
    if (allowNone) out.push(el('button.sw.none' + (obj[prop] ? '' : '.on'), { title: 'None', onpointerdown: keepFocus, onclick: () => set(obj, prop, null) }));
    for (const c of list) out.push(el('button.sw' + ((obj[prop] || '').toLowerCase() === c.toLowerCase() ? '.on' : ''), { title: c, style: { background: c }, onpointerdown: keepFocus, onclick: () => set(obj, prop, c) }));
    const custom = obj[prop] && !list.some((c) => c.toLowerCase() === String(obj[prop]).toLowerCase()) && obj[prop] !== 'auto';
    const inp = el('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(obj[prop] || '') ? obj[prop] : '#000000', oninput: () => set(obj, prop, inp.value, true), onchange: () => renderOptbar() });
    out.push(el('span.sw.custom' + (custom ? '.on' : ''), { title: 'Another colour' }, inp));
    return out;
  };
  const seg = (obj, prop, opts) => el('span.seg', {}, ...opts.map(([v, lab, title]) => el('button' + (obj[prop] === v ? '.on' : ''), { type: 'button', html: lab, title: title || '', onpointerdown: keepFocus, onclick: () => set(obj, prop, v) })));
  const num = (obj, prop, min, max, step, title) => { const i = el('input', { type: 'number', min, max, step, value: obj[prop], title, onchange: () => set(obj, prop, clamp(Number(i.value) || min, min, max)) }); return i; };
  const range = (obj, prop, min, max, step, title) => { const i = el('input', { type: 'range', min, max, step, value: obj[prop], title, oninput: () => set(obj, prop, Number(i.value), true) }); return i; };
  const toggle = (obj, prop, icon, title) => el('button.ib' + (obj[prop] ? '.on' : ''), { html: icon, title, onpointerdown: keepFocus, onclick: () => set(obj, prop, !obj[prop]) });
  const hint = (t) => el('span.hint', { textContent: t });
  const textOpts = (o) => {
    const sel = el('select', { title: 'Font', onchange: () => set(o, 'font', sel.value) },
      el('option', { value: 'sans', textContent: 'Sans' }), el('option', { value: 'serif', textContent: 'Serif' }), el('option', { value: 'mono', textContent: 'Mono' }));
    sel.value = o.font;
    return [sel, num(o, 'size', 4, 144, 1, 'Text size'), toggle(o, 'bold', `{{i:bold}}`, 'Bold'), toggle(o, 'italic', `{{i:italic}}`, 'Italic'), sep(), ...colors(o, 'color', INK)];
  };

  if (a) {
    if (a.type === 'text') kids.push(...textOpts(a));
    else if (a.type === 'rect' && a.cover) kids.push(label('Cover colour'), ...colors(a, 'fill', ['#FFFFFF', '#111111']));
    else if (a.type === 'rect' || a.type === 'ellipse') kids.push(label('Line'), ...colors(a, 'stroke', INK, true), range(a, 'sw', 0.5, 12, 0.5, 'Line thickness'), sep(), label('Fill'), ...colors(a, 'fill', [...INK.slice(1, 4), '#FFE45C', '#FFFFFF'], true));
    else if (a.type === 'line') kids.push(...colors(a, 'stroke', INK), range(a, 'sw', 0.5, 12, 0.5, 'Line thickness'), toggle(a, 'arrow', `{{i:move-up-right}}`, 'Arrow head'));
    else if (a.type === 'ink') kids.push(...colors(a, 'stroke', a.marker ? HLC : INK), range(a, 'sw', 0.5, a.marker ? 30 : 12, 0.5, 'Thickness'));
    else if (a.type === 'hl') kids.push(...colors(a, 'color', a.mode === 'highlight' ? HLC : INK));
    else if (a.type === 'image') kids.push(hint('Drag a corner to resize'));
    if (!S.editing && !soft) kids.push(sep(), el('button.ib.danger', { html: `{{i:trash-2}}`, title: 'Delete (Del)', onclick: deleteSelected }));
  } else if (tool === 'text') kids.push(...textOpts(prefs.text));
  else if (tool === 'edittext') kids.push(hint('Click any text on the page to change it'));
  else if (tool === 'hl') {
    const o = prefs.hl;
    // a pale highlighter colour makes a poor underline, and the reverse
    if ([...HLC, ...INK].includes(o.color) && (o.mode === 'highlight') !== HLC.includes(o.color)) o.color = o.mode === 'highlight' ? HLC[0] : INK[1];
    kids.push(seg(o, 'mode', [['highlight', `{{i:highlighter}}`, 'Highlight'], ['underline', `{{i:underline}}`, 'Underline'], ['strike', `{{i:strikethrough}}`, 'Strike through']]), sep(), ...colors(o, 'color', o.mode === 'highlight' ? HLC : INK));
  } else if (tool === 'draw') {
    const o = prefs.draw;
    if ([...HLC, ...INK].includes(o.color) && o.marker !== HLC.includes(o.color)) o.color = o.marker ? HLC[0] : INK[2];
    kids.push(seg(o, 'marker', [[false, `{{i:pen}}`, 'Pen'], [true, `{{i:highlighter}}`, 'Marker']]), sep(), ...colors(o, 'color', o.marker ? HLC : INK), range(o, 'sw', 0.5, 12, 0.5, 'Thickness'));
  } else if (tool === 'shape') {
    const o = prefs.shape, isLine = o.kind === 'line' || o.kind === 'arrow';
    kids.push(seg(o, 'kind', [['rect', `{{i:square}}`, 'Rectangle (R)'], ['ellipse', `{{i:circle}}`, 'Ellipse (O)'], ['line', `{{i:minus}}`, 'Line (L)'], ['arrow', `{{i:move-up-right}}`, 'Arrow (A)']]),
      sep(), label('Line'), ...colors(o, 'stroke', INK, !isLine), range(o, 'sw', 0.5, 12, 0.5, 'Line thickness'));
    if (!isLine) kids.push(sep(), label('Fill'), ...colors(o, 'fill', [...INK.slice(1, 4), '#FFE45C', '#FFFFFF'], true));
  } else if (tool === 'whiteout') {
    const o = prefs.whiteout;
    kids.push(seg(o, 'fill', [['auto', 'Match the page', 'Use the paper colour around the area'], ['#ffffff', 'White'], ['#111111', 'Black']]), hint('Drag over what you want to cover'));
  } else if (tool === 'check') {
    const o = prefs.check;
    kids.push(seg(o, 'kind', [['check', `{{i:check}}`, 'Tick'], ['cross', `{{i:x}}`, 'Cross'], ['dot', '●', 'Dot']]), sep(), ...colors(o, 'color', INK), range(o, 'size', 6, 40, 1, 'Size'));
  }
  bar.replaceChildren(...kids);
  bar.hidden = kids.length === 0;
}

// ---------- top bar ----------
async function openPicker() {
  if (window.showOpenFilePicker) {
    try {
      const [h] = await showOpenFilePicker({ types: PDF_TYPES });
      return openFile(await h.getFile(), h);
    } catch (e) { if (e.name === 'AbortError') return; console.warn(e); }
  }
  $('#fileOpen').click();
}
$('#fileOpen').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openFile(f); });
$('#fileAdd').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) insertFiles(fs); });
$('#fileImg').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) placeImage(f).catch((err) => fail('That image could not be added', err)); });

$('#btnOpen').onclick = $('#btnOpenBig').onclick = openPicker;
$('#btnSave').onclick = () => saveDocument(false);
$('#btnSaveAs').onclick = () => saveDocument(true);
$('#btnPrint').onclick = printDocument;
$('#btnUndo').onclick = () => timeTravel(-1);
$('#btnRedo').onclick = () => timeTravel(1);
$('#btnPrev').onclick = () => goToPage(S.cur - 1);
$('#btnNext').onclick = () => goToPage(S.cur + 1);
$('#btnZoomIn').onclick = () => zoomBy(1.2);
$('#btnZoomOut').onclick = () => zoomBy(1 / 1.2);
$('#zoomSel').onchange = (e) => { const v = e.target.value; setZoom(isNaN(Number(v)) ? v : Number(v)); scroller.focus({ preventScroll: true }); };
$('#pageInput').addEventListener('change', (e) => { const n = parseInt(e.target.value, 10); if (n >= 1) goToPage(n - 1); else e.target.value = S.cur + 1; e.target.blur(); });
$('#pageInput').addEventListener('focus', (e) => e.target.select());
$('#btnSidebar').onclick = () => { prefs.sidebar = document.documentElement.classList.toggle('nosidebar') === false; savePrefs(); $('#btnSidebar').classList.toggle('on', prefs.sidebar); };
$('#rail').addEventListener('click', (e) => { const b = e.target.closest('.tb'); if (b && hasDoc()) setTool(b.dataset.tool); });

$('#btnAddPdf').onclick = () => $('#fileAdd').click();
$('#btnBlank').onclick = insertBlank;
$('#btnRotL').onclick = () => rotatePages(selectedPageIndices(), false);
$('#btnRotR').onclick = () => rotatePages(selectedPageIndices(), true);
$('#btnDup').onclick = () => duplicatePages(selectedPageIndices());
$('#btnExtract').onclick = extractPages;
$('#btnDelPage').onclick = () => deletePages(selectedPageIndices());
$('#sideTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  for (const o of $$('#sideTabs button')) o.classList.toggle('on', o === b);
  const thumbs = b.dataset.tab === 'thumbs';
  thumbsEl.hidden = !thumbs; $('#pageTools').hidden = !thumbs; $('#outline').hidden = thumbs;
});

// theme
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  native?.setTheme(t);
  $('#btnTheme').innerHTML = t === 'dark' ? `{{i:sun}}` : `{{i:moon}}`;
}
applyTheme(prefs.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('#btnTheme').onclick = () => { prefs.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; applyTheme(prefs.theme); savePrefs(); };

// find
function openFind() { if (!hasDoc()) return; $('#findbar').hidden = false; const i = $('#findInput'); i.focus(); i.select(); if (i.value) runFind(i.value); }
function closeFind() { $('#findbar').hidden = true; runFind(''); scroller.focus({ preventScroll: true }); }
let _findT;
$('#btnFind').onclick = () => ($('#findbar').hidden ? openFind() : closeFind());
$('#findInput').addEventListener('input', (e) => { clearTimeout(_findT); _findT = setTimeout(() => runFind(e.target.value.trim()), 180); });
$('#findInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (e.target.value.trim().toLowerCase() !== F.q) { clearTimeout(_findT); runFind(e.target.value.trim()); } else stepFind(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('#findNext').onclick = () => stepFind(1);
$('#findPrev').onclick = () => stepFind(-1);
$('#findClose').onclick = closeFind;

// ---------- keyboard ----------
let clip = null;
document.addEventListener('keydown', (e) => {
  if ($('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && !e.altKey) {
    if (k === 'o') { e.preventDefault(); return openPicker(); }
    if (k === 's') { e.preventDefault(); return saveDocument(e.shiftKey); }
    if (k === 'p') { e.preventDefault(); return printDocument(); }
    if (k === 'f') { e.preventDefault(); return openFind(); }
    if (k === '=' || k === '+') { e.preventDefault(); return zoomBy(1.2); }
    if (k === '-') { e.preventDefault(); return zoomBy(1 / 1.2); }
    if (k === '0') { e.preventDefault(); return setZoom('auto'); }
    if (isTyping(e.target)) return;
    if (k === 'z') { e.preventDefault(); return timeTravel(e.shiftKey ? 1 : -1); }
    if (k === 'y') { e.preventDefault(); return timeTravel(1); }
    if (k === 'c' && S.sel) { const { a } = findAnnot(); if (a) { clip = JSON.stringify(a); e.preventDefault(); } return; }
    if (k === 'v' && clip && getSelection().isCollapsed) {
      const a = JSON.parse(clip), view = viewAt(S.cur);
      if (S.assets.has(a.asset) || a.type !== 'image') { e.preventDefault(); moveBy(a, 12, 12); clip = JSON.stringify(a); setTool('select'); addAnnot(view, a, { selectIt: true }); }
      return;
    }
    if (k === 'a' && thumbsEl.contains(document.activeElement)) { e.preventDefault(); S.thumbSel = new Set(S.pages.map((p) => p.id)); buildThumbs(); }
    return;
  }
  if (isTyping(e.target) || !hasDoc() || e.altKey) return;
  if (k === 'delete' || k === 'backspace') {
    if (S.sel) { e.preventDefault(); deleteSelected(); }
    else if (thumbsEl.contains(document.activeElement) && S.thumbSel.size) { e.preventDefault(); deletePages(selectedPageIndices()); }
    return;
  }
  if (k === 'escape') { if (S.sel) select(null); else if (!$('#findbar').hidden) closeFind(); else setTool('select'); getSelection().removeAllRanges(); hideSelPop(); return; }
  if (S.sel && k.startsWith('arrow')) {
    const { a, view } = findAnnot(); if (!a) return;
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    moveBy(a, k === 'arrowleft' ? -d : k === 'arrowright' ? d : 0, k === 'arrowup' ? -d : k === 'arrowdown' ? d : 0);
    view.renderAnnots(); commitSoon(); return;
  }
  const page = scroller.clientHeight * 0.9;
  if (k === 'pagedown' || (k === ' ' && !e.shiftKey)) { e.preventDefault(); return scroller.scrollBy(0, page); }
  if (k === 'pageup' || (k === ' ' && e.shiftKey)) { e.preventDefault(); return scroller.scrollBy(0, -page); }
  if (k === 'home') { e.preventDefault(); return goToPage(0); }
  if (k === 'end') { e.preventDefault(); return goToPage(S.pages.length - 1); }
  if (k === 'arrowright') { e.preventDefault(); return goToPage(S.cur + 1); }
  if (k === 'arrowleft') { e.preventDefault(); return goToPage(S.cur - 1); }
  if (k === 'arrowdown') { e.preventDefault(); return scroller.scrollBy(0, 60); }
  if (k === 'arrowup') { e.preventDefault(); return scroller.scrollBy(0, -60); }
  const tools = { v: 'select', h: 'hand', t: 'text', e: 'edittext', u: 'hl', d: 'draw', w: 'whiteout', i: 'image', s: 'sign', c: 'check' };
  const shapes = { r: 'rect', o: 'ellipse', l: 'line', a: 'arrow' };
  if (tools[k]) { e.preventDefault(); setTool(tools[k]); }
  else if (shapes[k]) { e.preventDefault(); prefs.shape.kind = shapes[k]; savePrefs(); setTool('shape'); }
});

document.addEventListener('paste', (e) => {
  if (!hasDoc() || isTyping(e.target)) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); placeImage(item.getAsFile()).catch((err) => fail('That image could not be pasted', err)); }
});

// ---------- drag files onto the window ----------
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer?.types?.includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; if (!e.target.closest?.('#sidebar')) $('#dropHint').hidden = false; });
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').hidden = true; } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); $('#dropHint').hidden = !!e.target.closest?.('#sidebar'); } });
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('#dropHint').hidden = true;
  const files = [...e.dataTransfer.files];
  const pdfAt = files.findIndex(isPdf);
  if (pdfAt >= 0) {
    let handle = null;
    if (native) { const p = native.pathForFile(files[pdfAt]); if (p) handle = nativeHandle(p); }
    else {
      try { const it = [...e.dataTransfer.items].filter((i) => i.kind === 'file')[pdfAt]; handle = (await it?.getAsFileSystemHandle?.()) || null; } catch {}
      if (handle && handle.kind !== 'file') handle = null;
    }
    return openFile(files[pdfAt], handle);
  }
  const img = files.find((f) => f.type.startsWith('image/'));
  if (img && hasDoc()) return placeImage(img).catch((err) => fail('That image could not be added', err));
  toast('Only PDF files can be opened here', true);
});

window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ---------- recent files ----------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('pdfeditor', 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (db.objectStoreNames.contains('recent')) db.deleteObjectStore('recent');      // v1 was keyed by file name, so two "invoice.pdf" files collided
      db.createObjectStore('recent', { keyPath: 'id', autoIncrement: true });
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const idbReq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function rememberRecent(handle) {
  if (handle.native) { await native.opened(handle.path); return showRecent(); }
  try {
    const db = await idb();
    const before = await idbReq(db.transaction('recent').objectStore('recent').getAll());
    const same = [];
    for (const r of before) { try { if (await r.handle.isSameEntry(handle)) same.push(r.id); } catch {} }     // the same file, wherever it is
    const st = db.transaction('recent', 'readwrite').objectStore('recent');
    for (const id of same) st.delete(id);
    st.put({ name: handle.name, handle, ts: Date.now() });
    const keep = before.filter((r) => !same.includes(r.id)).sort((a, b) => b.ts - a.ts);
    for (const old of keep.slice(7)) st.delete(old.id);
    await new Promise((res, rej) => { st.transaction.oncomplete = res; st.transaction.onerror = () => rej(st.transaction.error); });
    db.close();
  } catch (e) { console.warn('recent', e); }
  showRecent();
}
async function showRecent() {
  let all = [];
  if (native) all = (await native.recents()).map((r) => ({ name: r.name, title: r.path, handle: nativeHandle(r.path) }));
  else {
    try { const db = await idb(); all = await idbReq(db.transaction('recent').objectStore('recent').getAll()); db.close(); } catch {}
    all.sort((a, b) => b.ts - a.ts);
  }
  $('#recent').hidden = !all.length;
  $('#recentList').replaceChildren(...all.map((r) => el('li', {}, el('button', { textContent: r.name, title: r.title || r.name, onclick: async () => {
    try {
      if ((await r.handle.requestPermission?.({ mode: 'read' })) === 'denied') return;
      await openFile(await r.handle.getFile(), r.handle);
    } catch (e) {
      toast(`${r.name} is no longer where it was`, true);
      if (native) await native.forget(r.title);
      else { try { const db = await idb(); db.transaction('recent', 'readwrite').objectStore('recent').delete(r.id); db.close(); } catch {} }
      showRecent();
    }
  } }))));
}

// ---------- signature ----------
const SIG_KEY = 'pdfeditor.signatures';
const pad = $('#signPad'), pctx = pad.getContext('2d');
let padDirty = false, signMode = 'draw';
function clearPad() { pctx.clearRect(0, 0, pad.width, pad.height); padDirty = false; $('#signText').value = ''; }
pad.addEventListener('pointerdown', (e) => {
  pad.setPointerCapture(e.pointerId);
  const k = pad.width / pad.getBoundingClientRect().width, r = pad.getBoundingClientRect();
  let last = { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k }, lastMid = last;
  pctx.lineCap = pctx.lineJoin = 'round'; pctx.strokeStyle = '#10182b'; pctx.lineWidth = 4.2;
  pctx.beginPath(); pctx.arc(last.x, last.y, 2.1, 0, 7); pctx.fillStyle = '#10182b'; pctx.fill();
  padDirty = true;
  const mv = (ev) => {
    const p = { x: (ev.clientX - r.left) * k, y: (ev.clientY - r.top) * k }, mid = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
    pctx.beginPath(); pctx.moveTo(lastMid.x, lastMid.y); pctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y); pctx.stroke();
    last = p; lastMid = mid;
  };
  const up = () => { pad.removeEventListener('pointermove', mv); };
  pad.addEventListener('pointermove', mv);
  pad.addEventListener('pointerup', up, { once: true }); pad.addEventListener('pointercancel', up, { once: true });
});
function trimCanvas(c) {
  const ctx = c.getContext('2d'), d = ctx.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const p = 6; x0 = Math.max(0, x0 - p); y0 = Math.max(0, y0 - p); x1 = Math.min(c.width - 1, x1 + p); y1 = Math.min(c.height - 1, y1 + p);
  const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return o;
}
function savedSigs() { try { return JSON.parse(localStorage.getItem(SIG_KEY)) || []; } catch { return []; } }
function openSignDialog() {
  if (!hasDoc()) return;
  clearPad();
  const list = savedSigs();
  // In the browser edition every local HTML file shares one storage area, so remembering is opt-in there.
  $('#signRemember').checked = prefs.signRemember ?? !!native;
  $('#signSaved').hidden = !list.length;
  $('#signSavedList').replaceChildren(...list.map((url) => el('button', { type: 'button', title: 'Use this signature', onclick: () => useSignature(url, false) }, el('img', { src: url, alt: 'Saved signature' }))));
  $('#dlgSign').showModal();
}
async function useSignature(dataUrl, remember) {
  $('#dlgSign').close();
  if (remember) { try { localStorage.setItem(SIG_KEY, JSON.stringify([dataUrl, ...savedSigs().filter((u) => u !== dataUrl)].slice(0, 3))); } catch {} }
  const blob = new Blob([b64ToBytes(dataUrl.slice(dataUrl.indexOf(',') + 1))], { type: 'image/png' });
  await placeImage(blob, 0.3);
}
$('#signMode').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  signMode = b.dataset.mode;
  for (const o of $$('#signMode button')) o.classList.toggle('on', o === b);
  $('#signDrawWrap').hidden = signMode !== 'draw'; $('#signTypeWrap').hidden = signMode !== 'type';
  if (signMode === 'type') $('#signText').focus();
});
$('#signClear').onclick = clearPad;
$('#signForget').onclick = () => { try { localStorage.removeItem(SIG_KEY); } catch {} $('#signSaved').hidden = true; toast('Saved signatures removed'); };
$('#signCancel').onclick = () => $('#dlgSign').close();
$('#signText').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#signUse').click(); } });
$('#signUse').onclick = () => {
  let c = null;
  if (signMode === 'draw') { if (padDirty) c = trimCanvas(pad); }
  else {
    const t = $('#signText').value.trim();
    if (t) {
      const tmp = document.createElement('canvas'); tmp.width = 1600; tmp.height = 320;
      const ctx = tmp.getContext('2d');
      ctx.font = '120px "Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive'; ctx.fillStyle = '#10182b'; ctx.textBaseline = 'middle';
      ctx.fillText(t, 20, 160, 1560);
      c = trimCanvas(tmp);
    }
  }
  if (!c) return toast(signMode === 'draw' ? 'Draw your signature in the box first' : 'Type your name first');
  prefs.signRemember = $('#signRemember').checked; savePrefs();
  useSignature(c.toDataURL('image/png'), prefs.signRemember).catch((e) => fail('The signature could not be placed', e));
};

// ---------- start ----------
document.body.classList.add('nodoc');
document.body.dataset.tool = 'select';
document.documentElement.classList.toggle('nosidebar', !prefs.sidebar);
$('#btnSidebar').classList.toggle('on', !!prefs.sidebar);
if (native) {
  // The desktop window stays hidden until there is something finished to look at: the PDF it
  // was asked to open, or the start screen. It is never shown half-way through.
  // A hidden window is not given animation frames, and the PDF engine draws on them. Until the
  // window is revealed, stand in for them with short timers so the first page can be drawn unseen.
  const realRAF = window.requestAnimationFrame, realCAF = window.cancelAnimationFrame, standIns = new Set();
  window.requestAnimationFrame = (cb) => { const id = setTimeout(() => { standIns.delete(id); cb(performance.now()); }, 4); standIns.add(id); return id; };
  window.cancelAnimationFrame = (id) => { if (standIns.delete(id)) clearTimeout(id); else realCAF.call(window, id); };
  const painted = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const firstPageDrawn = async () => {
    const t0 = performance.now();
    while (hasDoc() && performance.now() - t0 < 4000) {
      const v = viewAt(S.cur);
      if (v && v.rendered && v.rScale === S.scale) break;
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  const openPath = async (p) => {
    try { const h = nativeHandle(p); await openFile(await h.getFile(), h); }
    catch (e) { fail(`${p.split(/[\\/]/).pop()} could not be opened`, e); }
  };
  native.onOpenFile(openPath);
  native.onSaveAndClose(async () => { if (await saveDocument(false)) native.closeWindow(); });
  document.body.classList.add('launching');
  updateUI();
  const first = await native.initialFile();
  if (first) {
    $('#docName').textContent = first.split(/[\\/]/).pop();
    await openPath(first);
    await firstPageDrawn();
  }
  document.body.classList.remove('launching');
  await showRecent().catch(() => {});
  await painted();
  window.requestAnimationFrame = realRAF; window.cancelAnimationFrame = realCAF;
  native.contentReady();
} else { updateUI(); showRecent(); }
window.pdfEditor = { S, prefs, pdfjsLib, buildPdf, openFile, insertFiles, setTool, setZoom, goToPage, runFind, F, loadPdfLib };

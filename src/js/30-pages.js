// ---------- opening files and organising pages ----------
const DOC_OPTS = {
  cMapUrl: 'cmaps/', cMapPacked: true, standardFontDataUrl: 'fonts/', wasmUrl: 'wasm/',
  useWorkerFetch: false, BinaryDataFactory: EmbeddedData, disableWorkerRendering: true,
};
// Password-protected and edit-restricted PDFs carry an /Encrypt entry.
function hasEncryptEntry(b) {
  const pat = [0x2F, 0x45, 0x6E, 0x63, 0x72, 0x79, 0x70, 0x74];      // "/Encrypt"
  outer: for (let i = b.indexOf(0x2F); i >= 0 && i + 8 <= b.length; i = b.indexOf(0x2F, i + 1)) {
    for (let k = 1; k < 8; k++) if (b[i + k] !== pat[k]) continue outer;
    return true;
  }
  return false;
}
async function loadSource(bytes, name) {
  fontPack ??= await loadPack('fonts');
  const locked = hasEncryptEntry(bytes);         // checked now: the bytes are handed over to the reader below
  const thread = new Worker(workerUrl);
  const worker = new pdfjsLib.PDFWorker({ port: thread });
  const task = pdfjsLib.getDocument({ data: bytes, worker, ...DOC_OPTS });
  let tries = 0, password = null;
  task.onPassword = (update) => {
    ask({ title: tries++ ? 'That password did not work' : 'This PDF is locked', text: `Enter the password for ${name}.`, input: true,
      buttons: [{ label: 'Cancel', value: false }, { label: 'Unlock', value: true, primary: true }] })
      .then((pw) => { if (pw == null) task.destroy(); else { password = pw; update(pw); } });
  };
  let doc;
  try { doc = await task.promise; }
  catch (e) { try { worker.destroy(); } catch {} thread.terminate(); throw e; }
  const src = { id: uid(), name, doc, n: doc.numPages, fields: null, hasForms: false, password, locked: locked || password != null, worker, thread };
  try { src.fields = await doc.getFieldObjects(); src.hasForms = src.fields instanceof Map ? src.fields.size > 0 : !!src.fields && Object.keys(src.fields).length > 0; } catch {}
  return src;
}
function dropSource(s) {
  s.doc.loadingTask.destroy().catch(() => {}).finally(() => { try { s.worker.destroy(); } catch {} s.thread.terminate(); });
}
async function recsFor(src) {
  const first = await src.doc.getPage(1), vp = first.getViewport({ scale: 1 });
  const recs = [];
  for (let i = 0; i < src.n; i++) recs.push({ id: uid(), src: src.id, idx: i, rot: 0, bw: vp.width, bh: vp.height, annots: [] });
  return recs;
}
// Pages can differ in size; measure them in the background and settle the layout once.
async function refineSizes(src) {
  let changed = false;
  for (let i = 1; i < src.n; i++) {
    let page; try { page = await src.doc.getPage(i + 1); } catch { continue; }
    if (!S.sources.has(src.id)) return;
    const vp = page.getViewport({ scale: 1 });
    for (const rec of S.pages) if (rec.src === src.id && rec.idx === i && (Math.abs(rec.bw - vp.width) > 0.01 || Math.abs(rec.bh - vp.height) > 0.01)) { rec.bw = vp.width; rec.bh = vp.height; changed = true; }
    if (i % 200 === 0) await new Promise((r) => setTimeout(r));
  }
  if (!changed) return;
  // sizes are not an edit: fold them into every undo step so undo cannot bring the first guess back
  const sizes = new Map(S.pages.filter((r) => r.src === src.id).map((r) => [r.idx, r]));
  S.history = S.history.map((h) => {
    const ps = JSON.parse(h);
    for (const p of ps) { const f = p.src === src.id && sizes.get(p.idx); if (f) { p.bw = f.bw; p.bh = f.bh; } }
    return JSON.stringify(ps);
  });
  const keep = S.cur, off = scroller.scrollTop - (tops[keep] || 0);
  resize(); buildThumbs();
  scroller.scrollTop = (tops[keep] || 0) + off;
  centerPage(); pump();
}

async function closeDocument() {
  if (S.editing) finishEdit();
  for (const [, v] of S.views) v.destroy();
  S.views.clear(); pagesEl.replaceChildren();
  for (const [, t] of thumbEls) { thumbIO.unobserve(t.el); t.el.remove(); }
  thumbEls.clear(); thumbQueue = [];
  for (const [, s] of S.sources) dropSource(s);
  S.sources.clear();
  for (const [, a] of S.assets) URL.revokeObjectURL(a.url);
  S.assets.clear();
  Object.assign(S, { primary: null, pages: [], cur: 0, sel: null, editing: null, name: '', handle: null, fileSize: 0, dirty: false, formDirty: false, savedIdx: -1, history: [], hIdx: -1 });
  S.thumbSel.clear(); F.cache.clear(); F.hits = []; F.q = ''; F.cur = -1; F.token++;
}

async function confirmDiscard(action) {
  if (!S.dirty) return true;
  const r = await ask({ title: 'Save your changes first?', text: `${S.name} has changes that are not saved yet.`,
    buttons: [{ label: 'Cancel', value: null }, { label: `Don't save`, value: 'discard', warn: true }, { label: 'Save', value: 'save', primary: true }] });
  if (r === 'save') return await saveDocument(false);
  return r === 'discard';
}

async function openFile(file, handle = null) {
  if (!(await confirmDiscard())) return;
  await busy('Opening', async () => {
    let src, recs, size;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      size = bytes.length;
      src = await loadSource(bytes, file.name);
      recs = await recsFor(src);
    } catch (e) {
      if (src) dropSource(src);
      if (e?.name === 'PasswordException' || /destroy/i.test(e?.message || '')) return toast(`${file.name} was not opened`);
      return fail(`${file.name} could not be opened`, e?.name === 'InvalidPDFException' ? 'It does not look like a valid PDF.' : e);
    }
    await closeDocument();      // only now let go of the document that was open
    S.sources.set(src.id, src);
    S.primary = src.id; S.name = file.name; S.handle = handle; S.fileSize = size; S.pages = recs;
    resetHistory();
    document.body.classList.remove('nodoc');
    const z = ['auto', 'width', 'page'].includes(prefs.zoom) ? prefs.zoom : 'auto';
    S.zoomMode = z; S.scale = clamp(typeof z === 'number' ? z * PT : computeScale(z), 0.1 * PT, 8 * PT);
    refreshAll(); syncZoomUI();
    const at = clamp(recallPosition(), 0, S.pages.length - 1);
    scroller.scrollTop = 0; if (at > 0) goToPage(at);
    centerPage();
    buildOutline();
    refineSizes(src);
    if (handle) rememberRecent(handle);
    scroller.focus({ preventScroll: true });
  });
}

function refreshAll() {
  document.body.classList.toggle('nodoc', !hasDoc());
  if (hasDoc()) {
    S.cur = clamp(S.cur, 0, S.pages.length - 1);
    for (const id of [...S.thumbSel]) if (recIndex(id) < 0) S.thumbSel.delete(id);
    layout(); buildThumbs();
    $('#pageInput').value = ''; updateCurrent(); pump();
  }
  if (F.q) runFind(F.q);
  updateUI(); renderOptbar();
}

// ---------- page operations ----------
function rotatePages(idxs, cw) {
  for (const i of idxs) {
    const rec = S.pages[i], [W, H] = viewSize(rec);
    for (const a of rec.annots) rotateAnnot(a, cw, W, H);
    rec.rot = (rec.rot + (cw ? 90 : 270)) % 360;
  }
  S.sel = null; commit(); keepPlace(() => refreshAll());
}
function deletePages(idxs) {
  if (idxs.length >= S.pages.length) return toast('A PDF needs at least one page');
  const kill = new Set(idxs);
  S.pages = S.pages.filter((_, i) => !kill.has(i));
  S.thumbSel.clear(); S.sel = null; commit(); refreshAll();
  toast(idxs.length === 1 ? 'Page deleted. Ctrl+Z brings it back.' : `${idxs.length} pages deleted. Ctrl+Z brings them back.`);
}
function duplicatePages(idxs) {
  const copies = idxs.map((i) => { const c = JSON.parse(JSON.stringify(S.pages[i])); c.id = uid(); for (const a of c.annots) a.id = uid(); return c; });
  S.pages.splice(Math.max(...idxs) + 1, 0, ...copies);
  S.thumbSel = new Set(copies.map((c) => c.id)); commit(); refreshAll();
}
function movePages(idxs, at) {
  const moving = idxs.map((i) => S.pages[i]), set = new Set(moving);
  const before = S.pages.slice(0, at).filter((p) => !set.has(p)).length;
  const rest = S.pages.filter((p) => !set.has(p));
  rest.splice(before, 0, ...moving);
  if (rest.every((p, i) => p === S.pages[i])) return;
  S.pages = rest; commit(); refreshAll();
}
function insertBlank() {
  const ref = S.pages[S.cur], [w, h] = viewSize(ref);
  const rec = { id: uid(), src: null, idx: 0, rot: 0, bw: w, bh: h, annots: [] };
  const at = Math.max(...selectedPageIndices()) + 1;
  S.pages.splice(at, 0, rec); S.thumbSel = new Set([rec.id]); commit(); refreshAll(); goToPage(at);
}
function keepPlace(fn) {
  const i = S.cur; fn(); if (hasDoc()) { scroller.scrollTop = tops[clamp(i, 0, tops.length - 1)] - 8; updateCurrent(); pump(); }
}
async function insertFiles(files, at) {
  if (!hasDoc()) { const pdf = files.find(isPdf); if (pdf) await openFile(pdf); return; }
  at ??= Math.max(...selectedPageIndices()) + 1;
  await busy('Adding pages', async () => {
    const added = [];
    for (const f of files) {
      try {
        if (isPdf(f)) {
          const src = await loadSource(new Uint8Array(await f.arrayBuffer()), f.name);
          S.sources.set(src.id, src);
          const recs = await recsFor(src); added.push(...recs); refineSizes(src);
        } else if (f.type.startsWith('image/')) {
          const asset = await addImageAsset(f), info = S.assets.get(asset);
          const land = info.w > info.h, pw = land ? 841.89 : 595.28, ph = (pw * info.h) / info.w;
          added.push({ id: uid(), src: null, idx: 0, rot: 0, bw: pw, bh: ph, annots: [{ id: uid(), type: 'image', asset, x: 0, y: 0, w: pw, h: ph }] });
        }
      } catch (e) { if (e?.name !== 'PasswordException') fail(`${f.name} could not be added`, e); }
    }
    if (!added.length) return;
    S.pages.splice(at, 0, ...added);
    S.thumbSel = new Set(added.map((r) => r.id));
    commit(); refreshAll(); goToPage(at);
    toast(`${added.length} page${added.length === 1 ? '' : 's'} added`);
  });
}
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

// drag pages in the side panel to reorder; drop files there to insert them
let dropLine = null;
function dropIndex(e) {
  const ts = $$('.thumb', thumbsEl);
  let at = ts.length, y = null;
  for (let i = 0; i < ts.length; i++) {
    const r = ts[i].getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) { at = i; y = r.top; break; }
  }
  const pr = thumbsEl.getBoundingClientRect();
  if (y == null) { const l = ts.at(-1)?.getBoundingClientRect(); y = l ? l.bottom : pr.top; }
  return { at, y: y - pr.top + thumbsEl.scrollTop - 2 };
}
thumbsEl.addEventListener('dragstart', (e) => {
  const t = e.target.closest('.thumb'); if (!t) return;
  if (!S.thumbSel.has(t.dataset.id)) { S.thumbSel = new Set([t.dataset.id]); buildThumbs(); }
  e.dataTransfer.setData('application/x-pdfeditor-pages', '1'); e.dataTransfer.effectAllowed = 'move';
  for (const id of S.thumbSel) thumbEls.get(id)?.el.classList.add('dragging');
});
thumbsEl.addEventListener('dragend', () => { for (const [, t] of thumbEls) t.el.classList.remove('dragging'); dropLine?.remove(); dropLine = null; });
thumbsEl.addEventListener('dragover', (e) => {
  const types = e.dataTransfer.types;
  if (!types.includes('application/x-pdfeditor-pages') && !types.includes('Files')) return;
  e.preventDefault(); e.stopPropagation();
  e.dataTransfer.dropEffect = types.includes('Files') ? 'copy' : 'move';
  if (!dropLine) { dropLine = el('div', { id: 'dropLine' }); thumbsEl.append(dropLine); }
  dropLine.style.top = dropIndex(e).y + 'px';
  const pr = thumbsEl.getBoundingClientRect();
  if (e.clientY < pr.top + 40) thumbsEl.scrollTop -= 12; else if (e.clientY > pr.bottom - 40) thumbsEl.scrollTop += 12;
});
thumbsEl.addEventListener('dragleave', (e) => { if (!thumbsEl.contains(e.relatedTarget)) { dropLine?.remove(); dropLine = null; } });
thumbsEl.addEventListener('drop', (e) => {
  const { at } = dropIndex(e);
  dropLine?.remove(); dropLine = null; $('#dropHint').hidden = true;
  if (e.dataTransfer.types.includes('Files')) {
    e.preventDefault(); e.stopPropagation();
    insertFiles([...e.dataTransfer.files], at);
  } else if (e.dataTransfer.types.includes('application/x-pdfeditor-pages')) {
    e.preventDefault(); e.stopPropagation();
    movePages(selectedPageIndices(), at);
  }
});

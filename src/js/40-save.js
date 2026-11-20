// ---------- writing the PDF ----------
const STD_FONTS = {
  sans: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  serif: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  mono: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
};

async function sourceBytes(src) {
  if (src.doc.annotationStorage.size > 0) {
    try { return await src.doc.saveDocument(); } catch (e) { console.warn('form values could not be written', e); }
  }
  return src.doc.getData();
}
async function libDocFor(L, src, flattenForms) {
  const bytes = await sourceBytes(src);
  const opts = { updateMetadata: false };
  let doc;
  try { doc = await L.PDFDocument.load(bytes, opts); }
  catch (e) {
    // password-protected files (including ones that open freely but restrict editing) are unlocked for the saved copy
    doc = await L.PDFDocument.load(bytes, { ...opts, password: src.password ?? '' });
    src.wasLocked = true;
  }
  if (flattenForms && src.hasForms) { try { doc.getForm().flatten(); } catch (e) { console.warn('flatten', e); } }
  return doc;
}

async function buildPdf(recs = S.pages) {
  const L = await loadPdfLib();
  const { PDFDocument, PDFName, degrees } = L;
  const usesPrimary = recs.some((r) => r.src === S.primary);
  const prim = S.sources.get(S.primary);
  const identity = usesPrimary && recs.length === prim.n && recs.every((r, i) => r.src === S.primary && r.idx === i);

  const out = usesPrimary ? await libDocFor(L, prim, false) : await PDFDocument.create();
  let outPages;
  if (identity) {
    outPages = out.getPages();
    if (prim.wasLocked) sweepUnused(L, out);      // an unlocked copy must not carry the old lock's leftovers
  }
  else {
    const orig = usesPrimary ? out.getPages() : [];
    // pages may inherit their size and rotation from a parent node; pin those down before moving anything
    for (const p of orig) for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
      const n = PDFName.of(k);
      if (!p.node.get(n)) { const v = p.node.getInheritableAttribute(n); if (v) p.node.set(n, v); }
    }
    const used = new Set(), plan = [], wanted = new Map();     // wanted: source id -> [{ slot, idx }]
    recs.forEach((r, slot) => {
      if (!r.src) plan[slot] = null;
      else if (r.src === S.primary && !used.has(r.idx)) { used.add(r.idx); plan[slot] = orig[r.idx]; }
      else { if (!wanted.has(r.src)) wanted.set(r.src, []); wanted.get(r.src).push({ slot, idx: r.idx }); }
    });
    for (const [srcId, list] of wanted) {
      const from = await libDocFor(L, S.sources.get(srcId), srcId !== S.primary);
      const copied = await out.copyPages(from, list.map((w) => w.idx));
      list.forEach((w, k) => (plan[w.slot] = copied[k]));
    }
    if (usesPrimary) {
      outPages = recs.map((r, slot) => { if (plan[slot]) return plan[slot]; const b = L.PDFPage.create(out); b.setSize(r.bw, r.bh); return b; });
      const kept = new Set(outPages);
      setPageTree(L, out, outPages, orig.filter((p) => !kept.has(p)));
    } else outPages = recs.map((r, slot) => (plan[slot] ? out.addPage(plan[slot]) : out.addPage([r.bw, r.bh])));
  }

  const cache = { fonts: {}, images: {}, charsets: {} };
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i], page = outPages[i];
    let srcRot = 0, box = [0, 0, rec.bw, rec.bh];
    if (rec.src) { const pg = await getPdfPage(rec); srcRot = pg.rotate; box = pg.view; }
    const R = (((srcRot + rec.rot) % 360) + 360) % 360;
    if (rec.rot || !rec.src) page.setRotation(degrees(R));
    if (rec.annots.length) await bakeAnnots(L, out, page, rec, box, R, cache);
  }
  return out.save();
}

// Put the pages in a new order inside the original file (so its form fields, bookmarks and
// document settings survive), then remove everything that is no longer used, so that
// deleted pages are really gone from the saved file and not just hidden.
function setPageTree(L, out, pages, dropped) {
  const { PDFName, PDFRef, PDFDict, PDFArray, PDFStream } = L, ctx = out.context;
  const key = (r) => r.objectNumber + ' ' + r.generationNumber;
  const rootRef = out.catalog.get(PDFName.of('Pages')), root = ctx.lookup(rootRef);
  root.set(PDFName.of('Kids'), ctx.obj(pages.map((p) => p.ref)));
  root.set(PDFName.of('Count'), ctx.obj(pages.length));
  for (const p of pages) p.node.set(PDFName.of('Parent'), rootRef);
  out.pageCount = pages.length;
  out.pageCache?.invalidate?.();
  if (out.pageMap) { out.pageMap.clear(); for (const p of pages) out.pageMap.set(p.node, p); }

  // Form fields are listed centrally, not on their page, so a deleted page would otherwise leave its
  // fields (and whatever was typed into them) behind. Drop every field that now has no place on a kept page.
  const acro = out.catalog.lookup(PDFName.of('AcroForm'));
  if (acro instanceof PDFDict && dropped.length) {
    const annotKeys = (p) => { const a = p.node.lookup(PDFName.of('Annots')); return a instanceof PDFArray ? a.asArray().filter((x) => x instanceof PDFRef).map(key) : []; };
    const onKept = new Set(pages.flatMap(annotKeys)), onDropped = new Set(dropped.flatMap(annotKeys));
    const droppedPages = new Set(dropped.map((p) => key(p.ref))), removed = new Set();
    const gone = (ref) => {
      const k = key(ref), node = ctx.lookup(ref);
      if (!(node instanceof PDFDict)) return false;
      const kids = node.lookup(PDFName.of('Kids'));
      let out_ = false;
      if (kids instanceof PDFArray && kids.size() > 0) {
        const keep = kids.asArray().filter((kid) => !(kid instanceof PDFRef) || !gone(kid));
        if (keep.length === 0) out_ = true;
        else if (keep.length < kids.size()) node.set(PDFName.of('Kids'), ctx.obj(keep));
      } else if (!onKept.has(k)) {
        const pg = node.get(PDFName.of('P'));
        out_ = onDropped.has(k) || (pg instanceof PDFRef && droppedPages.has(key(pg)));
      }
      if (out_) removed.add(k);
      return out_;
    };
    for (const list of ['Fields', 'CO']) {
      const arr = acro.lookup(PDFName.of(list));
      if (!(arr instanceof PDFArray)) continue;
      const keep = arr.asArray().filter((f) => !(f instanceof PDFRef) || !(list === 'Fields' ? gone(f) : removed.has(key(f))));
      if (keep.length < arr.size()) acro.set(PDFName.of(list), ctx.obj(keep));
    }
  }

  sweepUnused(L, out, dropped.map((p) => p.ref));
}
// Remove every object that can no longer be reached from the document root, so that nothing which was
// taken out (deleted pages, a removed password lock) lingers in the saved file. `dead` objects are
// treated as gone even if something still points at them, such as a bookmark to a deleted page.
function sweepUnused(L, out, deadRefs = []) {
  const { PDFRef, PDFDict, PDFArray, PDFStream } = L, ctx = out.context;
  const key = (r) => r.objectNumber + ' ' + r.generationNumber;
  const dead = new Set(deadRefs.map(key)), seen = new Set(), stack = [];
  const visit = (o) => {
    if (!o) return;
    if (o instanceof PDFRef) { const k = key(o); if (!seen.has(k) && !dead.has(k)) { seen.add(k); stack.push(ctx.lookup(o)); } }
    else if (o instanceof PDFDict) { for (const [, v] of o.entries()) visit(v); }
    else if (o instanceof PDFArray) { for (const v of o.asArray()) visit(v); }
    else if (o instanceof PDFStream) visit(o.dict);
  };
  const t = ctx.trailerInfo;
  for (const k of ['Root', 'Info', 'Encrypt', 'ID']) visit(t[k]);
  while (stack.length) visit(stack.pop());
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(key(ref))) ctx.delete(ref);
}

async function bakeAnnots(L, out, page, rec, box, R, cache) {
  const { rgb, degrees } = L;
  const [x0, y0, x1, y1] = box;
  // displayed position (points from the top-left of the page as shown) -> PDF user space
  const P = (vx, vy) => (R === 0 ? [x0 + vx, y1 - vy] : R === 90 ? [x0 + vy, y0 + vx] : R === 180 ? [x1 - vx, y0 + vy] : [x1 - vy, y1 - vx]);
  const col = (hex) => { const [r, g, b] = hexRgb(hex); return rgb(r / 255, g / 255, b / 255); };
  let multGs = null;
  const mult = () => (multGs ??= page.node.newExtGState('GSmul', out.context.obj({ Type: 'ExtGState', BM: 'Multiply' })));
  const path = (subpaths, { fillC, strokeC, sw = 1, close = false, multiply = false, butt = false, miter = false }) => {
    const ops = [L.pushGraphicsState()];
    if (multiply) ops.push(L.setGraphicsState(mult()));
    if (strokeC) ops.push(L.setStrokingColor(col(strokeC)), L.setLineWidth(sw), L.setLineCap(butt ? L.LineCapStyle.Butt : L.LineCapStyle.Round), L.setLineJoin(miter ? L.LineJoinStyle.Miter : L.LineJoinStyle.Round));
    if (fillC) ops.push(L.setFillingColor(col(fillC)));
    for (const pts of subpaths) {
      pts.forEach(([vx, vy], i) => { const [x, y] = P(vx, vy); ops.push(i ? L.lineTo(x, y) : L.moveTo(x, y)); });
      if (pts.length === 1) { const [x, y] = P(...pts[0]); ops.push(L.lineTo(x, y)); }
      if (close) ops.push(L.closePath());
    }
    ops.push(fillC && strokeC ? L.fillAndStroke() : fillC ? L.fill() : L.stroke(), L.popGraphicsState());
    page.pushOperators(...ops);
  };
  const corners = (r) => [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
  const drawImageAt = (img, r) => { const [x, y] = P(r.x, r.y + r.h); page.drawImage(img, { x, y, width: r.w, height: r.h, rotate: degrees(R) }); };

  // highlighter ink goes down first, as it does on screen
  for (const a of [...rec.annots.filter(isMultiply), ...rec.annots.filter((a) => !isMultiply(a))]) {
    if (a.type === 'rect') {
      if (a.fill || a.stroke) path([corners(a)], { fillC: a.fill, strokeC: a.stroke && a.sw > 0 ? a.stroke : null, sw: a.sw, close: true, miter: true });
    } else if (a.type === 'ellipse') {
      const [x, y] = P(a.x + a.w / 2, a.y + a.h / 2), odd = R % 180 !== 0;
      page.drawEllipse({ x, y, xScale: (odd ? a.h : a.w) / 2, yScale: (odd ? a.w : a.h) / 2,
        color: a.fill ? col(a.fill) : undefined, borderColor: a.stroke ? col(a.stroke) : undefined, borderWidth: a.stroke ? a.sw : 0 });
    } else if (a.type === 'line') {
      if (a.arrow) { const g = arrowGeom(a); path([[[a.x1, a.y1], g.end]], { strokeC: a.stroke, sw: a.sw, butt: true }); path([g.tri], { fillC: a.stroke, close: true }); }
      else path([[[a.x1, a.y1], [a.x2, a.y2]]], { strokeC: a.stroke, sw: a.sw });
    } else if (a.type === 'ink') {
      path([a.pts], { strokeC: a.stroke, sw: a.sw, multiply: !!a.marker });
    } else if (a.type === 'hl') {
      path(hlMarks(a).map(corners), { fillC: a.color, close: true, multiply: a.mode === 'highlight' });
    } else if (a.type === 'image') {
      const info = S.assets.get(a.asset); if (!info) continue;
      const img = (cache.images[a.asset] ??= await (info.mime === 'image/png' ? out.embedPng(info.bytes) : out.embedJpg(info.bytes)));
      drawImageAt(img, a);
    } else if (a.type === 'text') {
      const name = STD_FONTS[a.font][(a.bold ? 1 : 0) + (a.italic ? 2 : 0)];
      const font = (cache.fonts[name] ??= await out.embedFont(L.StandardFonts[name]));
      const lines = a.text.split('\n'), br = baselineRatio(a.font, a.bold, a.italic);
      // The built-in PDF fonts only cover Western European characters, and the PDF writer swaps anything
      // else for "?" without complaining. So check every character against the font before trusting it.
      const known = (cache.charsets[name] ??= new Set(font.getCharacterSet()));
      const plain = lines.every((l) => [...l].every((ch) => known.has(ch.codePointAt(0))));
      if (plain) {
        lines.forEach((l, i) => {
          if (!l) return;
          const [x, y] = P(a.x, a.y + i * a.size * LH + br * a.size);
          page.drawText(l, { x, y, size: a.size, font, color: col(a.color), rotate: degrees(R) });
        });
      } else {
        // characters the built-in PDF fonts cannot write (other scripts, symbols, emoji): place the text as a sharp picture
        const k = 4, w = Math.max(1, a.w || 10), h = Math.max(1, a.h || a.size * LH * lines.length);
        const c = document.createElement('canvas'); c.width = Math.ceil(w * k); c.height = Math.ceil(h * k);
        const ctx = c.getContext('2d');
        ctx.font = `${a.italic ? 'italic ' : ''}${a.bold ? '700 ' : ''}${a.size * k}px ${FONTS[a.font]}`;
        ctx.fillStyle = a.color; ctx.textBaseline = 'alphabetic';
        lines.forEach((l, i) => ctx.fillText(l, 0, (i * a.size * LH + br * a.size) * k));
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        drawImageAt(await out.embedPng(new Uint8Array(await blob.arrayBuffer())), { x: a.x, y: a.y, w, h });
      }
    }
  }
}

// ---------- save, print, extract ----------
const PDF_TYPES = [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }];
const baseName = () => S.name.replace(/\.pdf$/i, '') || 'document';

async function pickSaveHandle(suggestedName) {
  if (!window.showSaveFilePicker) return null;
  try { return await showSaveFilePicker({ suggestedName, types: PDF_TYPES }); }
  catch (e) { if (e.name === 'AbortError') return false; console.warn(e); return null; }
}
async function writeTo(handle, bytes) {
  const w = await handle.createWritable();
  await w.write(bytes); await w.close();
}
function download(bytes, name) {
  const a = el('a', { href: blobUrl(bytes, 'application/pdf'), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
// Inkwell cannot keep a PDF's password protection, so say so before the first save, not after.
async function confirmUnlock(recs = S.pages) {
  const locked = [...new Set(recs.map((r) => r.src))].map((id) => S.sources.get(id)).filter((s) => s && s.locked && !s.unlockOk);
  if (!locked.length) return true;
  const ok = await ask({ title: 'Save without the password?',
    text: `${locked[0].name} is password-protected. Inkwell cannot keep that protection: the saved copy will open without a password and without its restrictions.`,
    buttons: [{ label: 'Cancel', value: false }, { label: 'Save without password', value: true, primary: true }] });
  if (ok) for (const s of locked) s.unlockOk = true;
  return !!ok;
}
async function saveDocument(saveAs) {
  if (!hasDoc()) return false;
  if (S.editing) finishEdit();
  if (!(await confirmUnlock())) return false;
  try {
    let handle = saveAs ? null : S.handle;
    if (handle) {
      const ok = (await handle.requestPermission?.({ mode: 'readwrite' })) ?? 'granted';
      if (ok !== 'granted') handle = null;
    }
    if (!handle) {
      handle = await pickSaveHandle(saveAs ? `${baseName()} (edited).pdf` : S.name);
      if (handle === false) return false;
    }
    const bytes = await busy('Saving', () => buildPdf());
    const unlocked = [...S.sources.values()].some((x) => x.wasLocked) ? ' The saved copy has no password lock.' : '';
    if (handle) { await writeTo(handle, bytes); S.handle = handle; S.name = handle.name; rememberRecent(handle); toast(`Saved ${handle.name}.${unlocked}`); }
    else { download(bytes, saveAs ? `${baseName()} (edited).pdf` : S.name); toast(`Saved to your Downloads folder.${unlocked}`); }
    markSaved();
    return true;
  } catch (e) { fail('The file could not be saved', e); return false; }
}
async function extractPages() {
  const idxs = selectedPageIndices(); if (!idxs.length) return;
  const label = idxs.length === 1 ? `page ${idxs[0] + 1}` : `${idxs.length} pages`;
  const name = `${baseName()} (${label}).pdf`;
  if (!(await confirmUnlock(idxs.map((i) => S.pages[i])))) return;
  try {
    const handle = await pickSaveHandle(name);
    if (handle === false) return;
    const bytes = await busy('Saving pages', () => buildPdf(idxs.map((i) => S.pages[i])));
    if (handle) { await writeTo(handle, bytes); toast(`Saved ${label} as ${handle.name}`); }
    else { download(bytes, name); toast(`Saved ${label} to your Downloads folder`); }
  } catch (e) { fail('The pages could not be saved', e); }
}
// Printing: the finished PDF (with every edit in it) is drawn page by page into this window's print view.
async function printDocument() {
  if (!hasDoc()) return;
  if (native) return openPrintDialog();      // the desktop app has its own print screen with a preview
  if (S.editing) finishEdit();
  const area = $('#printArea'), urls = [];
  const cleanup = () => { area.replaceChildren(); for (const u of urls) URL.revokeObjectURL(u); urls.length = 0; };
  try {
    const ready = await busy('Preparing to print', async () => {
      const bytes = await buildPdf();
      if (S.pages.length > 200) {      // very long documents: hand the finished file to the browser's own print view
        const url = blobUrl(bytes, 'application/pdf');
        if (!window.open(url, '_blank')) toast('Allow pop-ups for this page to print long documents', true);
        else toast('Opened in a new tab. Print from there to choose a page range.');
        setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
        return false;
      }
      const thread = new Worker(workerUrl), worker = new pdfjsLib.PDFWorker({ port: thread });
      try {
        const doc = await pdfjsLib.getDocument({ data: bytes, worker, ...DOC_OPTS }).promise;
        const n = doc.numPages, dpi = n <= 40 ? 200 : 150, kids = [];
        let size = null;
        for (let i = 1; i <= n; i++) {
          $('#busyText').textContent = `Preparing to print (page ${i} of ${n})`;
          const pg = await doc.getPage(i), vp = pg.getViewport({ scale: dpi / 72 });
          size ??= pg.getViewport({ scale: 1 });
          const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
          await pg.render({ canvas: c, viewport: vp, intent: 'print' }).promise;
          const blob = await new Promise((r) => c.toBlob(r, n <= 60 ? 'image/png' : 'image/jpeg', 0.93));
          c.width = 0; pg.cleanup();
          const url = URL.createObjectURL(blob); urls.push(url);
          kids.push(el('div.pp', {}, el('img', { src: url, alt: '' })));
        }
        await doc.loadingTask.destroy();
        area.replaceChildren(el('style', { textContent: `@page { size: ${size.width}pt ${size.height}pt; margin: 0; }` }), ...kids);
        await Promise.all(kids.map((k) => k.firstChild.decode().catch(() => {})));
      } finally { try { worker.destroy(); } catch {} thread.terminate(); }
      return true;
    });
    if (!ready) return;
    window.addEventListener('afterprint', () => setTimeout(cleanup, 1000), { once: true });
    window.print();
  } catch (e) { cleanup(); fail('The document could not be printed', e); }
}

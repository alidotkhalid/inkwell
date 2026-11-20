// ---------- print preview (desktop app) ----------
// The finished PDF, with every edit in it, is shown sheet by sheet exactly as it will come
// out of the printer. Printing then sends those same sheets straight to the chosen printer.
const PAPERS = { A4: [595.28, 841.89], Letter: [612, 792], Legal: [612, 1008], A3: [841.89, 1190.55], A5: [419.53, 595.28] };
const PRINT_INSET = 11.34;      // 4 mm: most printers cannot print right up to the edge
const PR = { doc: null, worker: null, thread: null, sizes: [], cache: new Map(), io: null, queue: [], busy: false, token: 0 };
prefs.print = Object.assign({ printer: '', paper: 'A4', orient: 'auto', scale: 'fit', color: true, duplex: 'simplex' }, prefs.print || {});

function parsePageList(text, n) {
  const out = new Set();
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) { const a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : n; for (let i = Math.max(1, Math.min(a, b)); i <= Math.min(n, Math.max(a, b)); i++) out.add(i - 1); }
    else if (/^\d+$/.test(part)) { const i = +part; if (i >= 1 && i <= n) out.add(i - 1); }
  }
  return [...out].sort((a, b) => a - b);
}
function printPlan() {
  const o = prefs.print, n = PR.sizes.length;
  const which = $('#prPages').value;
  const pages = which === 'current' ? [clamp(S.cur, 0, n - 1)] : which === 'custom' ? parsePageList($('#prRange').value, n) : PR.sizes.map((_, i) => i);
  const [pw, ph] = PAPERS[o.paper] || PAPERS.A4;
  const landscape = o.orient === 'landscape';
  const paper = landscape ? [ph, pw] : [pw, ph];
  const sheets = pages.map((i) => {
    const [w, h] = PR.sizes[i];
    // "Automatic" turns a wide page a quarter turn so it fills the sheet, as a printer's auto-rotate does
    const turn = o.orient === 'auto' && w > h * 1.02;
    const [cw, ch] = turn ? [h, w] : [w, h];
    const f = o.scale === 'actual' ? 1 : Math.min((paper[0] - PRINT_INSET * 2) / cw, (paper[1] - PRINT_INSET * 2) / ch);
    return { i, turn, w, h, f, sheet: turn ? [paper[1], paper[0]] : paper };
  });
  return { pages, paper, landscape, sheets };
}

async function openPrintDialog() {
  if (!hasDoc()) return;
  if (S.editing) finishEdit();
  try {
    await busy('Preparing the preview', async () => {
      const bytes = await buildPdf();
      PR.thread = new Worker(workerUrl); PR.worker = new pdfjsLib.PDFWorker({ port: PR.thread });
      PR.doc = await pdfjsLib.getDocument({ data: bytes, worker: PR.worker, ...DOC_OPTS }).promise;
      PR.sizes = S.pages.map((r) => viewSize(r));
      const printers = await native.printers();
      const sel = $('#prPrinter');
      sel.replaceChildren(...printers.map((p) => el('option', { value: p.name, textContent: p.label })));
      if (!printers.length) sel.append(el('option', { value: '', textContent: 'No printer found' }));
      const want = printers.find((p) => p.name === prefs.print.printer) || printers.find((p) => p.isDefault) || printers[0];
      if (want) sel.value = want.name;
    });
  } catch (e) { closePrintDialog(); return fail('The print preview could not be prepared', e); }
  const o = prefs.print;
  $('#prPaper').value = PAPERS[o.paper] ? o.paper : 'A4'; $('#prOrient').value = o.orient; $('#prScale').value = o.scale;
  $('#prColor').value = o.color ? 'color' : 'mono'; $('#prDuplex').value = o.duplex;
  $('#prCopies').value = 1; $('#prPages').value = 'all'; $('#prRange').value = ''; $('#prRange').hidden = true;
  $('#dlgPrint').showModal();
  renderPrintPreview();
  $('#prGo').focus();
}
function closePrintDialog() {
  PR.token++; PR.queue = []; PR.io?.disconnect(); PR.io = null;
  for (const [, c] of PR.cache) c.canvas.width = 0;
  PR.cache.clear();
  $('#prPreview').replaceChildren();
  const { doc, worker, thread } = PR; PR.doc = PR.worker = PR.thread = null;
  if (doc) doc.loadingTask.destroy().catch(() => {}).finally(() => { try { worker.destroy(); } catch {} thread.terminate(); });
  if ($('#dlgPrint').open) $('#dlgPrint').close();
}

function renderPrintPreview() {
  const box = $('#prPreview'), plan = printPlan(), o = prefs.print;
  const token = ++PR.token;
  PR.io?.disconnect(); PR.queue = [];
  const n = plan.sheets.length, copies = clamp(parseInt($('#prCopies').value, 10) || 1, 1, 99);
  $('#prInfo').textContent = !n ? 'No pages match. Try something like 1-3, 5.' : `${n} page${n === 1 ? '' : 's'}${copies > 1 ? `, ${copies} copies` : ''} on ${o.paper} paper`;
  $('#prGo').disabled = $('#prSystem').disabled = !n;
  if (!n) { box.replaceChildren(el('div.prNone', { textContent: 'Nothing to print' })); return; }
  const widest = Math.max(...plan.sheets.map((s) => s.sheet[0]));
  const k = clamp((box.clientWidth - 72) / widest, 0.2, 1.1);       // screen pixels per point
  PR.io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { PR.queue.push(en.target); PR.io?.unobserve(en.target); }
    runPrintPreview(token);
  }, { root: box, rootMargin: '600px 0px' });
  const kids = plan.sheets.map((s, at) => {
    const cw = s.w * s.f * k, ch = s.h * s.f * k;        // preview keeps the page upright; a turned page is shown on a turned sheet
    const slot = el('div.prPage', { style: { width: cw + 'px', height: ch + 'px' } });
    slot._job = { i: s.i, px: cw };
    const sheet = el('div.prSheet' + (o.color ? '' : '.mono'), { style: { width: s.sheet[0] * k + 'px', height: s.sheet[1] * k + 'px' } }, slot);
    const cached = PR.cache.get(s.i);
    if (cached) { slot.append(cached.canvas); }
    if (!cached || cached.px < cw * 0.9) PR.io.observe(slot);
    return el('div.prItem', {}, sheet, el('div.prLabel', { textContent: `Page ${s.i + 1}${n > 1 ? `  (${at + 1} of ${n})` : ''}` }));
  });
  const keep = box.scrollTop;
  box.replaceChildren(...kids);
  box.scrollTop = keep;
}
async function runPrintPreview(token) {
  if (PR.busy) return;
  PR.busy = true;
  try {
    while (PR.queue.length && token === PR.token && PR.doc) {
      const slot = PR.queue.shift(), { i, px } = slot._job;
      try {
        const pg = await PR.doc.getPage(i + 1), base = pg.getViewport({ scale: 1 });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const vp = pg.getViewport({ scale: (px * dpr) / base.width });
        const c = document.createElement('canvas'); c.width = Math.max(1, Math.floor(vp.width)); c.height = Math.max(1, Math.floor(vp.height));
        await pg.render({ canvas: c, viewport: vp, intent: 'print' }).promise;
        if (token !== PR.token) { c.width = 0; break; }
        const old = PR.cache.get(i); if (old) old.canvas.width = 0;
        PR.cache.set(i, { canvas: c, px });
        slot.replaceChildren(c);
      } catch (e) { console.warn('preview', e); }
    }
  } finally { PR.busy = false; if (PR.queue.length && token === PR.token) runPrintPreview(PR.token); }
}

async function sendToPrinter(system) {
  const plan = printPlan(), o = prefs.print, n = plan.sheets.length;
  if (!n || !PR.doc) return;
  const area = $('#printArea'), urls = [], wrap = $('#prWrap'), info = $('#prInfo');
  const cleanup = () => { area.replaceChildren(); for (const u of urls) URL.revokeObjectURL(u); wrap.inert = false; };
  const printer = $('#prPrinter').value, copies = clamp(parseInt($('#prCopies').value, 10) || 1, 1, 99);
  wrap.inert = true;                       // no changes while the job is being put together
  try {
    const dpi = n <= 15 ? 300 : n <= 60 ? 220 : 150, kids = [];
    for (let at = 0; at < n; at++) {
      const s = plan.sheets[at];
      info.textContent = `Getting page ${at + 1} of ${n} ready`;
      await new Promise((r) => setTimeout(r));
      const pg = await PR.doc.getPage(s.i + 1), base = pg.getViewport({ scale: 1 });
      let sc = (dpi / 72) * s.f;           // enough pixels for the size it will have on paper
      const px = base.width * base.height * sc * sc;
      if (px > 4e7) sc *= Math.sqrt(4e7 / px);
      const vp = pg.getViewport({ scale: sc, rotation: (pg.rotate + (s.turn ? 90 : 0)) % 360 });
      const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      await pg.render({ canvas: c, viewport: vp, intent: 'print' }).promise;
      const blob = await new Promise((r) => c.toBlob(r, n <= 60 ? 'image/png' : 'image/jpeg', 0.93));
      c.width = 0; pg.cleanup();
      const url = URL.createObjectURL(blob); urls.push(url);
      const [cw, ch] = s.turn ? [s.h, s.w] : [s.w, s.h];
      const img = o.scale === 'actual'
        ? el('img', { src: url, alt: '', style: { width: cw + 'pt', height: ch + 'pt', maxWidth: 'none', maxHeight: 'none' } })
        : el('img.fit', { src: url, alt: '' });
      kids.push(el('div.pp', {}, img));
    }
    area.replaceChildren(el('style', { textContent: `@page { size: ${plan.paper[0]}pt ${plan.paper[1]}pt; margin: 0; }` }), ...kids);
    await Promise.all(kids.map((kid) => kid.firstChild.decode().catch(() => {})));
    info.textContent = system ? 'Opening the Windows print window' : 'Sending to the printer';
    const result = await native.print({ system, deviceName: printer, copies, landscape: plan.landscape, pageSize: o.paper, color: o.color, duplex: o.duplex });
    cleanup();
    if (result.ok) { const name = $('#prPrinter').selectedOptions[0]?.textContent; closePrintDialog(); toast(system || !name ? 'Sent to the printer' : `Sent to ${name}`); }
    else { renderPrintPreview(); if (!/cancel/i.test(result.reason || '')) toast(`The printer did not accept the job. ${result.reason || ''}`.trim(), true); }
  } catch (e) { cleanup(); renderPrintPreview(); fail('The document could not be printed', e); }
}

{
  const opt = (id, key, map = (v) => v) => $(id).addEventListener('change', (e) => { prefs.print[key] = map(e.target.value); savePrefs(); renderPrintPreview(); });
  opt('#prPaper', 'paper'); opt('#prOrient', 'orient'); opt('#prScale', 'scale'); opt('#prDuplex', 'duplex');
  opt('#prColor', 'color', (v) => v === 'color'); opt('#prPrinter', 'printer');
  $('#prPages').addEventListener('change', (e) => { const custom = e.target.value === 'custom'; $('#prRange').hidden = !custom; if (custom) $('#prRange').focus(); renderPrintPreview(); });
  let t; $('#prRange').addEventListener('input', () => { clearTimeout(t); t = setTimeout(renderPrintPreview, 250); });
  $('#prCopies').addEventListener('input', renderPrintPreview);
  $('#prCancel').onclick = closePrintDialog;
  $('#prGo').onclick = () => sendToPrinter(false);
  $('#prSystem').onclick = () => sendToPrinter(true);
  $('#dlgPrint').addEventListener('cancel', (e) => { e.preventDefault(); closePrintDialog(); });
  $('#dlgPrint').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.target.closest('button') && e.target.id !== 'prRange') { e.preventDefault(); if (!$('#prGo').disabled) sendToPrinter(false); } });
  let rt; window.addEventListener('resize', () => { if ($('#dlgPrint').open) { clearTimeout(rt); rt = setTimeout(renderPrintPreview, 150); } });
}

// Shared helpers for the test suite: start a browser on the built app, feed it files,
// save through the real Save button, and read the saved PDF back.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { PDFDocument, PDFName, PDFDict, PDFRawStream, StandardFonts, degrees } from '@cantoo/pdf-lib';

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const appFile = path.join(root, 'dist', 'Inkwell.html');

export async function startApp() {
  if (!fs.existsSync(appFile)) throw new Error('dist/Inkwell.html is missing. Run "npm run build" first.');
  const opts = { headless: true, args: ['--no-sandbox'] };
  if (process.env.INKWELL_CHROME) opts.executablePath = process.env.INKWELL_CHROME;
  let browser;
  try { browser = await chromium.launch(opts); }
  catch (e) { browser = await chromium.launch({ ...opts, channel: 'chrome' }); }       // fall back to an installed Chrome
  const context = await browser.newContext({ viewport: { width: 1366, height: 800 }, acceptDownloads: true });
  // headless Chrome cannot show the system file pickers; without them the app uses plain uploads and downloads
  await context.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push('page error: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console error: ' + m.text()); });
  await page.goto(pathToFileURL(appFile).href);
  await page.waitForFunction(() => window.pdfEditor, null, { timeout: 30000 });
  return { browser, page, problems };
}

export async function openPdf(page, bytes, name = 'test.pdf') {
  await page.evaluate(() => { window.pdfEditor.S.formDirty = false; window.pdfEditor.S.savedIdx = window.pdfEditor.S.hIdx; window.pdfEditor.S.dirty = false; });   // no "save first?" prompt between tests
  await page.setInputFiles('#fileOpen', { name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await page.waitForFunction((n) => window.pdfEditor.S.name === n && document.querySelector('.page canvas'), name, { timeout: 30000 });
  await page.evaluate(() => window.pdfEditor.setTool('select'));      // every test starts from the Select tool
  await page.waitForTimeout(250);
}

// Save with Ctrl+S and return the bytes of the file the app produced.
export async function save(page) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.keyboard.press('Control+s')]);
  const file = await download.path();
  return new Uint8Array(fs.readFileSync(file));
}

// Position on page `index` given in PDF points from its top-left corner -> screen coordinates.
export async function at(page, index, x, y) {
  return page.evaluate(({ index, x, y }) => {
    const r = document.querySelectorAll('.page')[index].getBoundingClientRect(), s = window.pdfEditor.S.scale;
    return [r.left + x * s, r.top + y * s];
  }, { index, x, y });
}
export async function drag(page, index, x0, y0, x1, y1) {
  const [a, b] = await at(page, index, x0, y0), [c, d] = await at(page, index, x1, y1);
  await page.mouse.move(a, b); await page.mouse.down();
  await page.mouse.move((a + c) / 2, (b + d) / 2, { steps: 4 }); await page.mouse.move(c, d, { steps: 4 });
  await page.mouse.up();
}
export const annots = (page, index = 0) => page.evaluate((i) => window.pdfEditor.S.pages[i].annots.map((a) => a.type), index);

// ---- reading saved PDFs
let pdfjs;
export async function textOf(bytes) {
  pdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) pages.push((await (await doc.getPage(i)).getTextContent()).items.map((it) => it.str).join(' '));
  await doc.loadingTask.destroy();
  return pages;
}
export async function imagesOf(bytes) {       // [{ width, height }] of every picture stored in the file
  const doc = await PDFDocument.load(bytes), out = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) out.push({ width: obj.dict.get(PDFName.of('Width')).asNumber(), height: obj.dict.get(PDFName.of('Height')).asNumber() });
  }
  return out;
}

// ---- fixtures, made on the fly so the repository holds no binary test files
export async function samplePdf(pages = 3) {
  const d = await PDFDocument.create(), f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const p = d.addPage([595, 842]);
    p.drawText(`Heading of page ${i}`, { x: 60, y: 760, size: 22, font: f });
    for (let l = 0; l < 8; l++) p.drawText(`Line ${l + 1} on page ${i}: the quick brown fox jumps over the lazy dog.`, { x: 60, y: 700 - l * 24, size: 12, font: f });
    p.drawText(`MARKER-PAGE-${i}`, { x: 60, y: 80, size: 12, font: f });
  }
  return d.save();
}
export async function formPdf() {
  const d = await PDFDocument.create(), f = await d.embedFont(StandardFonts.Helvetica), form = d.getForm();
  const p1 = d.addPage([595, 842]), p2 = d.addPage([595, 842]);
  p1.drawText('Form, page 1', { x: 50, y: 780, size: 18, font: f });
  p2.drawText('Form, page 2', { x: 50, y: 780, size: 18, font: f });
  const name = form.createTextField('name'); name.setText('Old name'); name.addToPage(p1, { x: 130, y: 700, width: 250, height: 24 });
  form.createCheckBox('agree').addToPage(p1, { x: 130, y: 650, width: 18, height: 18 });
  const secret = form.createTextField('secret2'); secret.setText('TOPSECRET-FIELD'); secret.addToPage(p2, { x: 130, y: 700, width: 250, height: 24 });
  return d.save();
}
export async function linkPdf(url) {
  const d = await PDFDocument.create(), f = await d.embedFont(StandardFonts.Helvetica), p = d.addPage([595, 842]);
  p.drawText('A link', { x: 100, y: 700, size: 20, font: f });
  const link = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [90, 690, 300, 730], Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: (await import('@cantoo/pdf-lib')).PDFString.of(url) } }));
  p.node.set(PDFName.of('Annots'), d.context.obj([link]));
  return d.save();
}
export async function lockedPdf() {
  const d = await PDFDocument.create(); d.addPage([595, 842]).drawText('This file is restricted', { x: 60, y: 760, size: 20 });
  await d.encrypt({ ownerPassword: 'owner-secret', userPassword: '', permissions: { modifying: false } });
  return d.save();
}
// A wide JPEG with a camera note saying "turn me a quarter turn": upright, it is tall.
export async function phonePhoto(page) {
  const b64 = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 200; c.height = 100;
    const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 200, 100); g.fillStyle = '#fff'; g.fillRect(10, 10, 60, 30);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const u = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s);
  });
  const jpeg = Buffer.from(b64, 'base64');
  const exif = Buffer.from([0xFF, 0xE1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,      // APP1 "Exif"
    0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01,                             // big-endian TIFF, one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00,                 // Orientation = 6
    0x00, 0x00, 0x00, 0x00]);
  return Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
}
export { PDFDocument, PDFName, PDFDict, degrees };

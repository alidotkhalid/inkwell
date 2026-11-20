// Tests of the Windows/desktop shell: the real Electron app is started and probed from inside its window,
// including deliberate attempts to get past its file and network rules.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron } from 'playwright';
import { root, samplePdf, PDFDocument } from './helpers.mjs';

const desktop = path.join(root, 'desktop');
let electronPath = null;
try { electronPath = createRequire(path.join(desktop, 'package.json'))('electron'); } catch {}
const noDisplay = process.platform === 'linux' && !process.env.DISPLAY;
const skip = !electronPath ? 'run "npm install" in the desktop folder first' : noDisplay ? 'needs a display (use xvfb-run on Linux)' : !fs.existsSync(path.join(desktop, 'app', 'index.html')) ? 'run "npm run build" first' : false;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-desktop-'));
const profile = path.join(tmp, 'profile'), doc = path.join(tmp, 'My report.pdf'), secret = path.join(tmp, 'secret.txt');
const launch = (...args) => _electron.launch({ executablePath: electronPath, args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), `--user-data-dir=${profile}`, ...args] });
let app, win;
async function mainWindow(app) {
  for (let i = 0; i < 200; i++) {
    const w = app.windows().find((p) => p.url().startsWith('app://inkwell/'));
    if (w) return w;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the Inkwell window did not open');
}

before(async () => {
  if (skip) return;
  fs.writeFileSync(doc, await samplePdf(2)); fs.writeFileSync(secret, 'PRIVATE');
  // a profile left behind by version 1.2.1, to check that settings survive the update
  const seed = await launch(path.join(root, 'tests', 'seed-legacy.cjs'));
  await new Promise((r) => seed.process().once('exit', r));
  app = await launch(desktop, doc);
  win = await mainWindow(app);
  await win.waitForFunction(() => window.pdfEditor && document.querySelector('.page canvas'), null, { timeout: 30000 });
});
after(async () => {
  if (app) { await win.evaluate(() => { const S = window.pdfEditor.S; S.formDirty = false; S.savedIdx = S.hIdx; S.dirty = false; }).catch(() => {}); await app.close().catch(() => {}); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('opens the PDF it was started with, on its own address', { skip }, async () => {
  assert.equal(await win.title(), 'My report.pdf - Inkwell');
  assert.equal(await win.evaluate(() => location.href), 'app://inkwell/index.html');
  assert.equal(await win.evaluate(() => window.pdfEditor.S.pages.length), 2);
  for (let i = 0; i < 40 && !(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true, 'the window is shown once the page is drawn');
});

test('settings saved by version 1.2.1 are carried over', { skip }, async () => {
  assert.equal(await win.evaluate(() => JSON.parse(localStorage.getItem('pdfeditor.prefs')).theme), 'dark');
  assert.equal(await win.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.equal(await win.evaluate(() => JSON.parse(localStorage.getItem('pdfeditor.signatures')).length), 1);
  assert.equal(await win.evaluate(() => localStorage.getItem('unrelated')), null);
});

test('the page has no access to Node.js', { skip }, async () => {
  assert.deepEqual(await win.evaluate(() => [typeof require, typeof process, typeof module]), ['undefined', 'undefined', 'undefined']);
});

test('the bridge only reads and writes files the person opened', { skip }, async () => {
  const read = await win.evaluate((p) => window.native.readFile(p).then(() => 'read', (e) => e.message), secret);
  assert.match(read, /not opened through Inkwell/);
  const write = await win.evaluate((p) => window.native.writeFile(p, new Uint8Array([1])).then(() => 'written', (e) => e.message), secret);
  assert.match(write, /not opened through Inkwell/);
  assert.equal(fs.readFileSync(secret, 'utf8'), 'PRIVATE');
});

test('the page cannot read local files through file:// (S1)', { skip }, async () => {
  const url = 'file://' + (process.platform === 'win32' ? '/' : '') + secret.replace(/\\/g, '/');
  const result = await win.evaluate(async (url) => {
    const out = {};
    out.fetch = await fetch(url).then((r) => r.text(), () => 'blocked');
    out.xhr = await new Promise((res) => { try { const x = new XMLHttpRequest(); x.open('GET', url); x.onload = () => res(x.responseText); x.onerror = () => res('blocked'); x.send(); } catch { res('blocked'); } });
    out.frame = await new Promise((res) => { const f = document.createElement('iframe'); f.onload = () => { try { res(f.contentDocument?.body?.innerText || 'blocked'); } catch { res('blocked'); } }; f.onerror = () => res('blocked'); f.src = url; document.body.append(f); setTimeout(() => res('blocked'), 1500); });
    out.image = await new Promise((res) => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('blocked'); i.src = url; });
    return out;
  }, url);
  assert.deepEqual(result, { fetch: 'blocked', xhr: 'blocked', frame: 'blocked', image: 'blocked' });
});

test('the page cannot reach the network (S2)', { skip }, async () => {
  assert.equal(await win.evaluate(() => fetch('https://example.com/').then(() => 'fetched', () => 'blocked')), 'blocked');
});

test('permission requests are refused (S3)', { skip }, async () => {
  assert.equal(await win.evaluate(() => Notification.requestPermission()), 'denied');
  const where = await win.evaluate(() => new Promise((res) => navigator.geolocation.getCurrentPosition(() => res('granted'), (e) => res(e.code === e.PERMISSION_DENIED ? 'denied' : 'other'), { timeout: 3000 })));
  assert.equal(where, 'denied');
});

test('the removed print-window handler is gone (S5)', { skip }, async () => {
  assert.equal(await win.evaluate(() => typeof window.native.viewPdf), 'undefined');
});

test('Ctrl+S writes the edited PDF back to the file it came from', { skip }, async () => {
  const before = fs.statSync(doc).size;
  await win.keyboard.press('r');
  const box = await win.evaluate(() => { const r = document.querySelector('.page').getBoundingClientRect(); return [r.left, r.top]; });
  await win.mouse.move(box[0] + 300, box[1] + 200); await win.mouse.down(); await win.mouse.move(box[0] + 420, box[1] + 260, { steps: 4 }); await win.mouse.up();
  await win.keyboard.press('Control+s');
  await win.waitForFunction(() => !window.pdfEditor.S.dirty, null, { timeout: 20000 });
  assert.ok(fs.statSync(doc).size > before);
  assert.equal((await PDFDocument.load(fs.readFileSync(doc))).getPageCount(), 2);
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.includes('inkwell-saving')), []);
});

test('the reader for old settings copes with deletions, long values and compacted storage', { skip }, async () => {
  const { readLegacyLocalStorage } = createRequire(import.meta.url)(path.join(desktop, 'app', 'legacy-storage.js'));
  const old = readLegacyLocalStorage(profile);
  assert.deepEqual(Object.keys(old).sort(), ['pdfeditor.prefs', 'pdfeditor.signatures']);          // the deleted and the unrelated keys are left out
  assert.equal(JSON.parse(old['pdfeditor.prefs']).note, 'café – naïve');
  assert.ok(JSON.parse(old['pdfeditor.signatures'])[0].length > 30000);
  assert.deepEqual(readLegacyLocalStorage(path.join(tmp, 'no-such-profile')), {});
});

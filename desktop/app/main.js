// Inkwell: desktop shell. The whole editor lives in index.html; this file gives it
// a window, real file access, and the hooks Windows needs to open PDFs with it.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, protocol, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { readLegacyLocalStorage } = require('./legacy-storage');

const norm = (p) => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
const isPdfPath = (p) => typeof p === 'string' && /\.pdf$/i.test(p) && !p.startsWith('--');

// The page may only read or write files the person actually chose (opened, dropped, picked
// in a dialog, or listed under Recent), never an arbitrary path.
const granted = new Set();
const grant = (p) => { granted.add(norm(p)); return p; };
const check = (p) => { if (typeof p !== 'string' || !granted.has(norm(p))) throw new Error('That file was not opened through Inkwell'); return p; };

const dataFile = (name) => path.join(app.getPath('userData'), name);
const readJson = (name, fallback) => { try { return JSON.parse(fs.readFileSync(dataFile(name), 'utf8')); } catch { return fallback; } };
const writeJson = (name, value) => fsp.writeFile(dataFile(name), JSON.stringify(value)).catch(() => {});

let recents = [];
function addRecent(p) {
  recents = [p, ...recents.filter((x) => norm(x) !== norm(p))].slice(0, 10);
  writeJson('recent.json', recents);
  try { app.addRecentDocument(p); } catch {}
}

const pdfFromArgs = (argv, cwd) => {
  const arg = argv.slice(1).find(isPdfPath);
  return arg ? path.resolve(cwd || process.cwd(), arg) : null;
};

// ---- where the page runs
// The editor is served from its own address, app://inkwell/index.html, and not from file://.
// A file:// page can read any file on the computer; a page on app:// can read nothing but itself,
// so the only way to a file is the checked read-file / write-file bridge above.
const APP_URL = 'app://inkwell/index.html';
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);
let pageHtml = null, pageCsp = '';
function servePage(request) {
  let u; try { u = new URL(request.url); } catch { u = null; }
  if (!u || u.host !== 'inkwell' || u.pathname !== '/index.html') return new Response('Not found', { status: 404 });
  if (!pageHtml) {
    pageHtml = fs.readFileSync(path.join(__dirname, 'index.html'));
    // the page carries its Content-Security-Policy as a meta tag; send the same policy as a header too
    const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(pageHtml.subarray(0, 4096).toString('utf8'));
    pageCsp = m ? m[1] : "default-src 'none'";
  }
  return new Response(pageHtml, { headers: {
    'content-type': 'text/html; charset=utf-8', 'content-security-policy': pageCsp, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } });
}

// ---- settings saved by versions up to 1.2.1
// Those versions ran the page from file://, so the person's settings and saved signatures sit in that
// address's browser storage, which the new page cannot see. Read them once from the storage files
// (see legacy-storage.js) and hand them to the page, which copies across whatever it does not have yet.
let legacy = null;
function readLegacyStorage() {
  if (readJson('storage.json', {}).moved) return;
  try { legacy = readLegacyLocalStorage(app.getPath('userData')); }
  catch (err) { console.warn('earlier settings were not read:', err && err.message); legacy = null; }
  if (!legacy || !Object.keys(legacy).length) { legacy = null; writeJson('storage.json', { moved: true }); }      // nothing to bring over: do not look again
}

// ---- hardening that applies to every window, including any added later
app.on('web-contents-created', (e, wc) => {
  // links leave the app only as web or mail addresses, and only through the system browser
  wc.setWindowOpenHandler(({ url }) => {
    try { const u = new URL(url); if (['http:', 'https:', 'mailto:'].includes(u.protocol)) shell.openExternal(u.href); } catch {}
    return { action: 'deny' };
  });
  wc.on('will-navigate', (ev) => ev.preventDefault());
  wc.on('will-attach-webview', (ev) => ev.preventDefault());
});
function lockDownSession() {
  const s = session.defaultSession;
  // the app needs no camera, microphone, location, notifications or anything else a page can ask for
  s.setPermissionRequestHandler((wc, permission, done) => done(false));
  s.setPermissionCheckHandler(() => false);
  // and it never talks to the network: only its own page and data it created in memory may load
  s.webRequest.onBeforeRequest((d, done) => {
    const ok = d.url.startsWith('app://inkwell/') || d.url.startsWith('blob:app://inkwell/') || d.url.startsWith('data:') || d.url.startsWith('devtools://');
    done({ cancel: !ok });
  });
}

const windows = new Map();   // webContents id -> { win, pending, hasDoc, ready }
function createWindow(file) {
  const saved = readJson('window.json', {});
  const anchor = BrowserWindow.getFocusedWindow();
  const theme = readJson('theme.json', {}).theme;
  const dark = theme ? theme === 'dark' : nativeTheme.shouldUseDarkColors;
  const opts = { width: saved.width || 1280, height: saved.height || 860 };
  if (anchor) { const b = anchor.getBounds(); opts.x = b.x + 28; opts.y = b.y + 28; opts.width = b.width; opts.height = b.height; }
  const win = new BrowserWindow({
    ...opts, minWidth: 720, minHeight: 480, show: false, title: 'Inkwell',
    backgroundColor: dark ? '#14171C' : '#D9DEE4',
    icon: process.platform === 'linux' ? path.join(__dirname, 'icon.png') : undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  const wc = win.webContents, state = { win, pending: file ? grant(file) : null, hasDoc: false, ready: false };
  windows.set(wc.id, state);
  // Keep the window hidden until the page says it has drawn the PDF (or the start screen), so it
  // appears once, finished. If a file is slow to load, show the window anyway after a short wait.
  let shown = false;
  state.reveal = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    if (!anchor && saved.maximized) win.maximize(); else win.show();
  };
  win.once('ready-to-show', () => setTimeout(state.reveal, 1200));
  wc.once('did-fail-load', state.reveal);
  wc.once('render-process-gone', state.reveal);
  win.on('close', () => { if (shown && !win.isMinimized()) writeJson('window.json', { ...win.getNormalBounds(), maximized: win.isMaximized() }); });
  win.on('closed', () => windows.delete(wc.id));

  // the page blocks closing while there are unsaved changes; ask what to do
  wc.on('will-prevent-unload', (e) => {
    const r = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Save', `Don't save`, 'Cancel'], defaultId: 0, cancelId: 2, noLink: true,
      message: 'Save your changes before closing?', detail: win.getTitle().replace(/^• /, '').replace(/ - Inkwell$/, ''),
    });
    if (r === 1) e.preventDefault();                   // close without saving
    else if (r === 0) wc.send('save-and-close');
  });
  win.loadURL(APP_URL);
  return win;
}
function openPath(file) {
  if (!file) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); } else createWindow();
    return;
  }
  // reuse a window that has nothing open; otherwise each PDF gets its own window
  const free = [...windows.values()].find((s) => s.ready && !s.hasDoc);
  if (free) { grant(file); free.hasDoc = true; free.win.webContents.send('open-file', file); if (free.win.isMinimized()) free.win.restore(); free.win.focus(); }
  else createWindow(file);
}

const stateOf = (e) => windows.get(e.sender.id);
ipcMain.handle('initial-file', (e) => { const s = stateOf(e); if (!s) return null; s.ready = true; const p = s.pending; s.pending = null; if (p) s.hasDoc = true; return p; });
ipcMain.handle('read-file', async (e, p) => fsp.readFile(check(p)));
ipcMain.handle('write-file', async (e, p, data) => {
  check(p);
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const tmp = p + '.inkwell-saving';
  try { await fsp.writeFile(tmp, buf); await fsp.rename(tmp, p); }       // never leave a half-written PDF behind
  catch (err) { await fsp.rm(tmp, { force: true }).catch(() => {}); await fsp.writeFile(p, buf); }
  return true;
});
ipcMain.handle('open-dialog', async (e) => {
  const s = stateOf(e); if (!s) return null;
  const r = await dialog.showOpenDialog(s.win, { title: 'Open a PDF', properties: ['openFile'], filters: [{ name: 'PDF documents', extensions: ['pdf'] }] });
  return r.canceled || !r.filePaths[0] ? null : grant(r.filePaths[0]);
});
ipcMain.handle('save-dialog', async (e, suggested, current) => {
  const s = stateOf(e); if (!s) return null;
  const dir = typeof current === 'string' && granted.has(norm(current)) ? path.dirname(current) : app.getPath('documents');
  const r = await dialog.showSaveDialog(s.win, { title: 'Save PDF', defaultPath: path.join(dir, path.basename(String(suggested || 'document.pdf'))), filters: [{ name: 'PDF documents', extensions: ['pdf'] }] });
  if (r.canceled || !r.filePath) return null;
  return grant(/\.pdf$/i.test(r.filePath) ? r.filePath : r.filePath + '.pdf');
});
ipcMain.on('grant-dropped', (e, p) => { if (isPdfPath(p) && fs.existsSync(p)) grant(p); });
ipcMain.handle('recents', () => { recents = recents.filter((p) => fs.existsSync(p)); return recents.map((p) => ({ path: grant(p), name: path.basename(p) })); });
ipcMain.handle('opened', (e, p) => { addRecent(check(p)); });
ipcMain.handle('forget', (e, p) => { recents = recents.filter((x) => norm(x) !== norm(String(p))); writeJson('recent.json', recents); });
ipcMain.handle('legacy-storage', () => { if (legacy) writeJson('storage.json', { moved: true }); return legacy; });
ipcMain.on('content-ready', (e) => { stateOf(e)?.reveal(); });
ipcMain.on('theme', (e, t) => { if (t === 'dark' || t === 'light') writeJson('theme.json', { theme: t }); });
ipcMain.on('doc-state', (e, on) => { const s = stateOf(e); if (s) s.hasDoc = !!on; });
ipcMain.on('close-window', (e) => { stateOf(e)?.win.destroy(); });
// ---- printing
function defaultPrinterName() {      // Windows keeps the default printer here as "Name,driver,port"
  if (process.platform !== 'win32') return Promise.resolve('');
  return new Promise((resolve) => {
    try {
      require('node:child_process').execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows', '/v', 'Device'], { windowsHide: true, timeout: 3000 },
        (err, out) => { const m = !err && /REG_SZ\s+(.+)/.exec(out || ''); resolve(m ? m[1].split(',')[0].trim() : ''); });
    } catch { resolve(''); }
  });
}
ipcMain.handle('printers', async (e) => {
  try {
    const [list, def] = await Promise.all([e.sender.getPrintersAsync(), defaultPrinterName()]);
    return list.map((p) => ({ name: p.name, label: p.displayName || p.name, isDefault: p.name === def }));
  } catch { return []; }
});
const PAGE_SIZES = ['A3', 'A4', 'A5', 'Legal', 'Letter'];
// Printing is silent (no Windows dialog) because the app shows its own preview first. Only the app's
// own print screen calls this; the options are checked here rather than trusted.
ipcMain.handle('print', (e, o = {}) => new Promise((resolve) => {
  const opts = {
    silent: !o.system, printBackground: true, margins: { marginType: 'none' }, collate: true,
    landscape: !!o.landscape, pageSize: PAGE_SIZES.includes(o.pageSize) ? o.pageSize : 'A4',
    copies: Math.min(99, Math.max(1, parseInt(o.copies, 10) || 1)), color: o.color !== false,
    duplexMode: ['simplex', 'shortEdge', 'longEdge'].includes(o.duplex) ? o.duplex : 'simplex',
  };
  if (typeof o.deviceName === 'string' && o.deviceName) opts.deviceName = o.deviceName;
  try { e.sender.print(opts, (ok, reason) => resolve({ ok, reason: reason || '' })); }
  catch (err) { resolve({ ok: false, reason: String(err && err.message || err) }); }
}));

// Inkwell was first released under the name Blue Pencil (1.0 and 1.1). For people who still have that
// version's settings folder, bring its settings, saved signatures and recent files across the first
// time Inkwell starts. The installer (installer.nsh) removes the old program itself.
try {
  const from = path.join(app.getPath('appData'), 'Blue Pencil'), to = app.getPath('userData');
  if (fs.existsSync(from) && !fs.existsSync(path.join(to, 'Local Storage'))) {
    const skip = /(^|[\\/])(Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|Crashpad|blob_storage|Session Storage|lockfile|SingletonLock|SingletonCookie|SingletonSocket)([\\/]|$)/;
    fs.cpSync(from, to, { recursive: true, filter: (src) => !skip.test(src.slice(from.length)) });
  }
} catch (err) { console.warn('settings were not carried over:', err && err.message); }

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (e, argv, cwd) => openPath(pdfFromArgs(argv, cwd)));
  app.on('open-file', (e, p) => { e.preventDefault(); if (app.isReady()) openPath(p); else app.once('ready', () => openPath(p)); });   // macOS
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    lockDownSession();
    protocol.handle('app', servePage);
    readLegacyStorage();
    recents = readJson('recent.json', []).filter((p) => typeof p === 'string');
    const first = pdfFromArgs(process.argv, process.cwd());
    createWindow(first && fs.existsSync(first) ? first : null);
  });
}

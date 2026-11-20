// Test helper: plays the part of Inkwell 1.2.1, which ran its page from file:// and kept its settings
// in that page's browser storage. Writes a few settings there into the profile folder, then quits.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
app.whenReady().then(async () => {
  const page = path.join(app.getPath('userData'), 'old-page.html');
  fs.writeFileSync(page, '<!doctype html><title>old</title>');
  const w = new BrowserWindow({ show: false });
  await w.loadFile(page);
  const big = 'data:image/png;base64,' + 'iVBORw0KGgoAAAANSUhEUgAA'.repeat(1500);          // a signature-sized value
  await w.webContents.executeJavaScript(`
    localStorage.setItem('pdfeditor.prefs', JSON.stringify({ theme: 'light', sidebar: true }));
    localStorage.setItem('pdfeditor.temp', 'to be deleted'); localStorage.removeItem('pdfeditor.temp');
    localStorage.setItem('pdfeditor.prefs', JSON.stringify({ theme: 'dark', sidebar: false, note: 'café – naïve' }));
    localStorage.setItem('pdfeditor.signatures', JSON.stringify([${JSON.stringify(big)}]));
    localStorage.setItem('unrelated', 'x'); true`);
  await new Promise((r) => setTimeout(r, 400));
  app.quit();
});

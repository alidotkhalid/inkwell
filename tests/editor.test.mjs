// End-to-end tests of the editor in a real browser: every test drives the app with the mouse and
// keyboard, saves through the Save button, and inspects the PDF that comes out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPdf, save, at, drag, annots, textOf, imagesOf, samplePdf, formPdf, linkPdf, lockedPdf, phonePhoto, PDFDocument } from './helpers.mjs';

let browser, page, problems;
before(async () => { ({ browser, page, problems } = await startApp()); });
after(async () => { await browser?.close(); });
const click = async (index, x, y) => page.mouse.click(...(await at(page, index, x, y)));
const typeText = async (x, y, text) => { await page.keyboard.press('Escape'); await page.keyboard.press('t'); await click(0, x, y); await page.keyboard.insertText(text); await page.keyboard.press('Escape'); };

test('opens a PDF, draws it, and reports no errors', async () => {
  await openPdf(page, await samplePdf());
  assert.equal(await page.evaluate(() => window.pdfEditor.S.pages.length), 3);
  assert.ok(await page.locator('.textLayer span').count() > 5, 'text layer is filled');
  assert.equal(await page.locator('#pageCount').textContent(), 'of 3');
  assert.deepEqual(problems, []);
});

test('typed text is saved as real, selectable text', async () => {
  await openPdf(page, await samplePdf());
  await typeText(300, 60, 'Typed in Inkwell: café €5');
  const [first] = await textOf(await save(page));
  assert.match(first, /Typed in Inkwell: café €5/);
});

test('text in other scripts is saved as written, never as question marks (B1)', async () => {
  await openPdf(page, await samplePdf(1));
  await typeText(300, 60, 'Привет 你好 😀');
  const bytes = await save(page), [first] = await textOf(bytes);
  assert.doesNotMatch(first, /\?\?/, 'no run of question marks');
  assert.ok((await imagesOf(bytes)).length >= 1, 'the text is carried as a picture of itself');
});

test('every drawing tool leaves its mark and the saved file is a valid PDF', async () => {
  await openPdf(page, await samplePdf(1));
  await page.keyboard.press('d'); await drag(page, 0, 300, 150, 420, 185);
  await page.keyboard.press('r'); await drag(page, 0, 300, 200, 400, 225);
  await page.keyboard.press('o'); await drag(page, 0, 300, 240, 400, 265);
  await page.keyboard.press('l'); await drag(page, 0, 300, 280, 400, 290);
  await page.keyboard.press('a'); await drag(page, 0, 300, 300, 400, 312);
  await page.keyboard.press('w'); await drag(page, 0, 300, 322, 400, 340);
  await page.keyboard.press('c'); await click(0, 320, 360);
  await page.keyboard.press('u'); await drag(page, 0, 70, 139, 250, 139);       // across the first line of text
  await page.waitForTimeout(150);
  assert.deepEqual(await annots(page), ['ink', 'rect', 'ellipse', 'line', 'line', 'rect', 'ink', 'hl']);
  const doc = await PDFDocument.load(await save(page));
  assert.equal(doc.getPageCount(), 1);
  assert.deepEqual(problems, []);
});

test('undoing every change clears the unsaved-changes mark (B6)', async () => {
  await openPdf(page, await samplePdf(1));
  await page.keyboard.press('r'); await drag(page, 0, 300, 220, 400, 260);
  assert.equal(await page.locator('#dirtyDot').isVisible(), true);
  await page.keyboard.press('Control+z');
  assert.equal(await page.locator('#dirtyDot').isVisible(), false);
  await page.keyboard.press('Control+y');
  assert.equal(await page.locator('#dirtyDot').isVisible(), true);
});

test('Esc ends typing without changing the tool (B7)', async () => {
  await openPdf(page, await samplePdf(1));
  await page.keyboard.press('t'); await click(0, 300, 60); await page.keyboard.type('still the text tool');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.pdfEditor.S.tool), 'text');
  assert.equal(await page.evaluate(() => !!window.pdfEditor.S.editing), false);
});

test('a deleted page is gone from the saved file, text and all', async () => {
  await openPdf(page, await samplePdf(3));
  await page.locator('.thumb').nth(1).click(); await page.click('#btnDelPage');
  const bytes = await save(page), pages = await textOf(bytes);
  assert.equal(pages.length, 2);
  assert.ok(!Buffer.from(bytes).includes('MARKER-PAGE-2') && !pages.join(' ').includes('MARKER-PAGE-2'));
  const raw = await PDFDocument.load(bytes);
  assert.ok(raw.context.enumerateIndirectObjects().length < 25, 'unused objects were swept out');
});

test('pages can be rotated, duplicated and reordered', async () => {
  await openPdf(page, await samplePdf(3));
  await page.locator('.thumb').nth(0).click(); await page.click('#btnRotR');
  await page.locator('.thumb').nth(2).click(); await page.click('#btnDup');
  await page.dragAndDrop('.thumb >> nth=3', '.thumb >> nth=0', { targetPosition: { x: 60, y: 8 } });
  const bytes = await save(page), doc = await PDFDocument.load(bytes), text = await textOf(bytes);
  assert.equal(doc.getPageCount(), 4);
  assert.match(text[0], /MARKER-PAGE-3/); assert.match(text[1], /MARKER-PAGE-1/);
  assert.equal(doc.getPage(1).getRotation().angle, 90);
});

test('form fields are filled in and saved', async () => {
  await openPdf(page, await formPdf());
  await page.fill('.widgetLayer input[data-field="name"]', 'New name');
  await page.click('.widgetLayer input[type="checkbox"]');
  const form = (await PDFDocument.load(await save(page))).getForm();
  assert.equal(form.getTextField('name').getText(), 'New name');
  assert.equal(form.getCheckBox('agree').isChecked(), true);
});

test('deleting a page also removes its form fields and what was typed in them (B4)', async () => {
  await openPdf(page, await formPdf());
  await page.locator('.thumb').nth(1).click(); await page.click('#btnDelPage');
  const bytes = await save(page), doc = await PDFDocument.load(bytes);
  assert.deepEqual(doc.getForm().getFields().map((f) => f.getName()).sort(), ['agree', 'name']);
  assert.ok(!Buffer.from(await doc.save({ useObjectStreams: false })).includes('TOPSECRET-FIELD'));
});

test('a rotated phone photo is saved upright, not sideways and squashed (B2)', async () => {
  await openPdf(page, await samplePdf(1));
  await page.setInputFiles('#fileImg', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: await phonePhoto(page) });
  await page.waitForFunction(() => window.pdfEditor.S.pages[0].annots.length === 1);
  const a = await page.evaluate(() => window.pdfEditor.S.pages[0].annots[0]);
  assert.ok(a.h > a.w, 'shown tall on screen');
  const [img] = await imagesOf(await save(page));
  assert.deepEqual(img, { width: 100, height: 200 });
});

test('an SVG drawing can be placed (B5)', async () => {
  await openPdf(page, await samplePdf(1));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#06c"/><circle cx="60" cy="30" r="20" fill="#fff"/></svg>';
  await page.setInputFiles('#fileImg', { name: 'drawing.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  await page.waitForFunction(() => window.pdfEditor.S.pages[0].annots.length === 1);
  const [img] = await imagesOf(await save(page));
  assert.equal(img.width / img.height, 2);
});

test('a link shows its address and asks before opening (B8)', async () => {
  await openPdf(page, await linkPdf('https://example.com/some/page'));
  await click(0, 150, 842 - 710);
  await page.waitForSelector('#dlgAsk[open]');
  assert.match(await page.locator('#askText').textContent(), /https:\/\/example\.com\/some\/page/);
  await page.click('#askBtns button:has-text("Cancel")');
  assert.equal(page.context().pages().length, 1, 'nothing was opened');
});

test('a password-protected PDF asks before it is saved without its protection (S7)', async () => {
  await openPdf(page, await lockedPdf(), 'locked.pdf');
  await page.keyboard.press('r'); await drag(page, 0, 300, 220, 400, 260);
  await page.keyboard.press('Control+s');
  await page.waitForSelector('#dlgAsk[open]');
  assert.match(await page.locator('#askTitle').textContent(), /without the password/i);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#askBtns button.primary')]);
  const saved = await PDFDocument.load(new Uint8Array((await import('node:fs')).readFileSync(await download.path())));
  assert.equal(saved.getPageCount(), 1, 'the saved copy opens without a password');
});

test('the page cannot reach the network (S2)', async () => {
  assert.match(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), /default-src 'none'.*connect-src 'none'/);
  const outcome = await page.evaluate(() => fetch('https://example.com/').then(() => 'fetched', () => 'blocked'));
  assert.equal(outcome, 'blocked');
  const img = await page.evaluate(() => new Promise((r) => { const i = new Image(); i.onload = () => r('loaded'); i.onerror = () => r('blocked'); i.src = 'https://example.com/x.png'; }));
  assert.equal(img, 'blocked');
});

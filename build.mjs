// Builds the whole app into one self-contained HTML file.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { thirdPartyNotices } from './notices.mjs';

// fileURLToPath copes with spaces in the folder name and with Windows drive letters
const root = path.dirname(fileURLToPath(import.meta.url));
const nm = (p) => path.join(root, 'node_modules', p);
const read = (p) => fs.readFileSync(p, 'utf8');
const gzb64 = (buf) => zlib.gzipSync(buf, { level: 9 }).toString('base64');

// ---- icons
const icon = (name) => {
  const raw = read(nm(`lucide-static/icons/${name}.svg`));
  return raw.replace(/<!--[\s\S]*?-->/g, '').replace(/\s*\n\s*/g, ' ').replace(/\s+(width|height)="24"/g, '').replace(/> </g, '><').trim();
};
const icons = (s) => s.replace(/\{\{i:([a-z0-9-]+)\}\}/g, (_, n) => icon(n));

// ---- css
const viewerCss = read(nm('pdfjs-dist/web/pdf_viewer.css'));
const tlStart = viewerCss.indexOf('\n.textLayer {');
const tlEnd = viewerCss.indexOf('\n}\n', tlStart) + 3;
const textLayerCss = viewerCss.slice(tlStart, tlEnd) + `
.textLayer[data-main-rotation="90"] { transform: rotate(90deg) translateY(-100%); }
.textLayer[data-main-rotation="180"] { transform: rotate(180deg) translate(-100%, -100%); }
.textLayer[data-main-rotation="270"] { transform: rotate(270deg) translateX(-100%); }
`;
if (!textLayerCss.includes('.endOfContent')) throw new Error('text layer css not found');
const font = fs.readFileSync(nm('@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2')).toString('base64');
const css = read(path.join(root, 'src/style.css')).replace('/*FONT*/', font) + '\n' + textLayerCss;

// ---- js
const jsDir = path.join(root, 'src/js');
let js = fs.readdirSync(jsDir).sort().map((f) => read(path.join(jsDir, f))).join('\n');
js = icons(js);
if (/<\/script/i.test(js)) throw new Error('script close tag inside app js');

// ---- embedded assets
const pack = (dir, filter) => {
  const o = {};
  for (const f of fs.readdirSync(dir).sort()) if (filter(f)) o[f] = fs.readFileSync(path.join(dir, f)).toString('base64');
  return Buffer.from(JSON.stringify(o));
};
// A page opened straight from disk may start classic workers but not module workers,
// so turn the worker module into a classic script (it only needs two small changes).
function classicWorker() {
  let s = read(nm('pdfjs-dist/legacy/build/pdf.worker.min.mjs'));
  const n = s.length;
  s = s.replace(/export\s*\{\s*WorkerMessageHandler\s*\}\s*;?/, '').replace(/import\.meta\.url/g, 'self.location.href');
  if (s.length === n || /import\.meta/.test(s) || /\bexport\s*\{/.test(s.slice(-2000))) throw new Error('worker conversion failed');
  return s;
}
const assets = {
  pdfjs: fs.readFileSync(nm('pdfjs-dist/legacy/build/pdf.min.mjs')),
  pdfworker: Buffer.from(classicWorker()),
  pdflib: fs.readFileSync(nm('@cantoo/pdf-lib/dist/pdf-lib.min.js')),
  'pack-cmaps': pack(nm('pdfjs-dist/cmaps'), (f) => f.endsWith('.bcmap')),
  'pack-fonts': pack(nm('pdfjs-dist/standard_fonts'), (f) => /\.(pfb|ttf)$/.test(f)),
  'pack-wasm': pack(nm('pdfjs-dist/wasm'), (f) => ['openjpeg.wasm', 'jbig2.wasm', 'qcms_bg.wasm'].includes(f)),
};
const assetTags = Object.entries(assets).map(([id, buf]) => {
  const b = gzb64(buf);
  console.log(`  ${id.padEnd(12)} ${(buf.length / 1024).toFixed(0).padStart(6)} KB -> ${(b.length / 1024).toFixed(0).padStart(6)} KB`);
  return `<script type="application/octet-stream" id="asset-${id}">${b}</script>`;
}).join('\n');

// ---- licences of the bundled parts: written to THIRD_PARTY_NOTICES.md and carried inside the app file itself
const notices = thirdPartyNotices(root);
fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), notices + '\n');
const noticesTag = `<script type="text/plain" id="third-party-notices">\n${notices.replace(/<\/script/gi, '<\\/script')}\n</script>`;

const licenses = `<!--
Inkwell, a PDF viewer and editor. Built from open-source parts, all bundled in this one file:
  PDF.js ${JSON.parse(read(nm('pdfjs-dist/package.json'))).version} (Mozilla, Apache-2.0) with its bundled CMaps, standard fonts, OpenJPEG, JBIG2 and qcms decoders
  pdf-lib ${JSON.parse(read(nm('@cantoo/pdf-lib/package.json'))).version} (Andrew Dillon and Cantoo, MIT)
  Lucide icons (ISC)
  Instrument Sans (SIL Open Font License 1.1)
Inkwell itself is MIT licensed. The full licence texts of the bundled parts are at the end of this file
(search for "third-party-notices") and in THIRD_PARTY_NOTICES.md.
-->`;

let html = read(path.join(root, 'src/index.html'));
html = icons(html)
  .replace('/*CSS*/', () => css)
  .replace('<!--ASSETS-->', () => assetTags + '\n' + noticesTag)
  .replace('/*JS*/', () => js)
  .replace('<head>', () => '<head>\n' + licenses);

// ---- Content-Security-Policy
// Only the two scripts written into this file may run (they are named by their SHA-256 hash), plus the
// PDF engines the app unpacks from itself into blob: URLs. Nothing may be loaded from, or sent to, the network.
const inline = [...html.matchAll(/<script(?: type="module")?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (inline.length !== 2) throw new Error(`expected 2 inline scripts, found ${inline.length}`);
const hashes = inline.map((code) => `'sha256-${crypto.createHash('sha256').update(code, 'utf8').digest('base64')}'`).join(' ');
const csp = [
  `default-src 'none'`,
  `script-src ${hashes} blob: 'wasm-unsafe-eval'`,
  `worker-src blob:`,
  `style-src 'unsafe-inline'`,
  `img-src data: blob:`,
  `font-src data: blob:`,
  `connect-src 'none'`,
  `object-src 'none'`, `frame-src 'none'`, `base-uri 'none'`, `form-action 'none'`,
].join('; ');
html = html.replace('/*CSP*/', () => csp);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'Inkwell.html');
fs.writeFileSync(out, html);
// the desktop app loads the very same file; writing it here means a release can never ship a stale copy
const desktopApp = path.join(root, 'desktop', 'app');
if (fs.existsSync(desktopApp)) fs.writeFileSync(path.join(desktopApp, 'index.html'), html);
console.log(`${out}  ${(html.length / 1048576).toFixed(2)} MB`);

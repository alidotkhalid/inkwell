// Reads the settings that Inkwell 1.2.1 and earlier kept in the browser storage of their file:// page.
//
// Those versions ran the editor from file://. From 1.3.0 it runs from app://inkwell, which has its own,
// empty storage, and the hardened app no longer lets any file:// page use storage at all. So the old
// values cannot be read by opening a page; this module reads them straight from the storage files
// (a LevelDB database in "<profile>/Local Storage/leveldb") the first time the new version starts.
//
// It only ever reads. Anything unexpected makes it return what it has found so far, or nothing.
const fs = require('node:fs');
const path = require('node:path');

function varint(buf, pos) {
  let value = 0, shift = 0, b;
  do { b = buf[pos.p++]; value += (b & 0x7f) * 2 ** shift; shift += 7; } while (b >= 0x80 && pos.p < buf.length);
  return value;
}
function snappy(buf) {                      // Snappy "raw" format, as LevelDB uses for its blocks
  const pos = { p: 0 }, out = Buffer.alloc(varint(buf, pos));
  let p = pos.p, o = 0;
  while (p < buf.length && o < out.length) {
    const tag = buf[p++], kind = tag & 3;
    if (kind === 0) {
      let n = tag >> 2;
      if (n >= 60) { const extra = n - 59; n = 0; for (let i = 0; i < extra; i++) n += buf[p++] * 2 ** (8 * i); }
      n += 1; buf.copy(out, o, p, p + n); p += n; o += n;
    } else {
      let n, back;
      if (kind === 1) { n = ((tag >> 2) & 7) + 4; back = ((tag >> 5) << 8) | buf[p++]; }
      else if (kind === 2) { n = (tag >> 2) + 1; back = buf[p] | (buf[p + 1] << 8); p += 2; }
      else { n = (tag >> 2) + 1; back = buf.readUInt32LE(p); p += 4; }
      if (back === 0 || back > o) throw new Error('bad snappy data');
      for (let i = 0; i < n; i++, o++) out[o] = out[o - back];
    }
  }
  return out;
}
function eachEntry(block, fn) {             // entries of one table block, with their shared key prefixes expanded
  const restarts = block.readUInt32LE(block.length - 4), end = block.length - 4 - restarts * 4, pos = { p: 0 };
  let key = Buffer.alloc(0);
  while (pos.p < end) {
    const shared = varint(block, pos), unshared = varint(block, pos), size = varint(block, pos);
    key = Buffer.concat([key.subarray(0, shared), block.subarray(pos.p, pos.p + unshared)]); pos.p += unshared;
    fn(key, block.subarray(pos.p, pos.p + size)); pos.p += size;
  }
}
function tableBlock(file, offset, size) {
  const raw = file.subarray(offset, offset + size), kind = file[offset + size];
  if (kind === 0) return raw;
  if (kind === 1) return snappy(raw);
  throw new Error('unknown block compression');
}
function readTable(file, put) {             // a .ldb file
  if (file.length < 48 || file.readUInt32LE(file.length - 8) !== 0x8b80fb57 || file.readUInt32LE(file.length - 4) !== 0xdb477524) return;
  const footer = file.subarray(file.length - 48), pos = { p: 0 };
  varint(footer, pos); varint(footer, pos);                       // metaindex block: not needed
  const indexOffset = varint(footer, pos), indexSize = varint(footer, pos);
  eachEntry(tableBlock(file, indexOffset, indexSize), (k, handle) => {
    const h = { p: 0 }, offset = varint(handle, h), size = varint(handle, h);
    try {
      eachEntry(tableBlock(file, offset, size), (ikey, value) => {
        if (ikey.length < 8) return;
        const n = ikey.length, seq = ikey.readUIntLE(n - 7, 6) + ikey[n - 1] * 2 ** 48;
        put(ikey.subarray(0, n - 8), seq, ikey[n - 8] === 1 ? Buffer.from(value) : null);
      });
    } catch {}
  });
}
function readLog(file, put) {               // a .log file: the most recent writes, not yet moved into a table
  let record = [];
  for (let block = 0; block < file.length; block += 32768) {
    let p = block; const end = Math.min(block + 32768, file.length);
    while (p + 7 <= end) {
      const size = file.readUInt16LE(p + 4), kind = file[p + 6];
      if (kind === 0 && size === 0) break;                        // padding to the end of the block
      const chunk = file.subarray(p + 7, p + 7 + size); p += 7 + size;
      if (kind === 1 || kind === 2) record = [chunk]; else record.push(chunk);
      if (kind !== 1 && kind !== 4) continue;
      const batch = Buffer.concat(record); record = [];
      if (batch.length < 12) continue;
      const first = batch.readUIntLE(0, 6) + batch[6] * 2 ** 48, count = batch.readUInt32LE(8), pos = { p: 12 };
      for (let i = 0; i < count && pos.p < batch.length; i++) {
        const isPut = batch[pos.p++] === 1, klen = varint(batch, pos), key = batch.subarray(pos.p, pos.p + klen); pos.p += klen;
        let value = null;
        if (isPut) { const vlen = varint(batch, pos); value = Buffer.from(batch.subarray(pos.p, pos.p + vlen)); pos.p += vlen; }
        put(key, first + i, value);
      }
    }
  }
}
// Chromium writes each string with a leading byte: 0 = UTF-16, 1 = Latin-1.
const text = (b) => (b.length === 0 ? '' : b[0] === 0 ? b.subarray(1).toString('utf16le') : b.subarray(1).toString('latin1'));

// Returns { key: value } for every entry of the file:// page whose key starts with `prefix`.
function readLegacyLocalStorage(profileDir, prefix = 'pdfeditor.') {
  const dir = path.join(profileDir, 'Local Storage', 'leveldb'), origin = Buffer.from('_file://\0', 'latin1');
  const latest = new Map();
  const put = (key, seq, value) => {
    if (key.length <= origin.length || !key.subarray(0, origin.length).equals(origin)) return;
    const name = text(key.subarray(origin.length));
    if (!name.startsWith(prefix)) return;
    const had = latest.get(name);
    if (!had || seq >= had.seq) latest.set(name, { seq, value });
  };
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return {}; }
  for (const name of names) {
    try {
      if (name.endsWith('.ldb') || name.endsWith('.sst')) readTable(fs.readFileSync(path.join(dir, name)), put);
      else if (name.endsWith('.log')) readLog(fs.readFileSync(path.join(dir, name)), put);
    } catch {}
  }
  const out = {};
  for (const [name, { value }] of latest) if (value) out[name] = text(value);
  return out;
}
module.exports = { readLegacyLocalStorage };

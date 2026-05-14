// Minimal STORE-only zip writer.
//
// One function: produce a Blob containing a valid .zip with the given
// files, no compression. STORE-mode keeps the implementation tiny
// (~80 LOC) and avoids pulling in a deflate library — for markdown
// files of typical conversation length this is the right trade-off.
// The user opens the zip with the OS's built-in tool and sees
// per-conversation .md files inside.

interface ZipFile {
  filename: string;
  // UTF-8 string body. We accept strings only because every caller
  // produces markdown; if a future use needs binary, take Uint8Array.
  content: string;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

// Precomputed CRC32 table. Generated once at module load.
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

// DOS date/time encoding. Truncates seconds to even (DOS limitation).
function dosTime(d: Date): { date: number; time: number } {
  const time =
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    ((d.getSeconds() >>> 1) & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0x0f) << 5) |
    (d.getDate() & 0x1f);
  return { date, time };
}

// TextEncoder.encode returns Uint8Array<ArrayBufferLike>, which strict
// TS rejects as a BlobPart (BlobPart wants Uint8Array<ArrayBuffer>
// specifically). Wrap once at the boundary so the rest of the file
// stays uncluttered.
function encodeUtf8(s: string): Uint8Array<ArrayBuffer> {
  const tmp = new TextEncoder().encode(s);
  const buf = new ArrayBuffer(tmp.byteLength);
  const out = new Uint8Array(buf);
  out.set(tmp);
  return out;
}

export function buildZip(files: ZipFile[]): Blob {
  const now = new Date();
  const { date, time } = dosTime(now);

  // First pass: encode each file's bytes + name, compute CRCs and
  // record offsets so the central directory can point at them.
  interface Entry {
    nameBytes: Uint8Array<ArrayBuffer>;
    contentBytes: Uint8Array<ArrayBuffer>;
    crc: number;
    localOffset: number;
  }
  const entries: Entry[] = [];
  // BlobPart over Uint8Array sidesteps a strict-mode type mismatch
  // between Uint8Array<ArrayBufferLike> (what `new Uint8Array(N)`
  // returns under recent TS lib) and BlobPart's ArrayBuffer-only
  // constraint.
  const chunks: BlobPart[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = encodeUtf8(f.filename);
    const contentBytes = encodeUtf8(f.content);
    const crc = crc32(contentBytes);

    // Local file header (30 bytes) + filename + content.
    // Allocate via ArrayBuffer rather than `new Uint8Array(N)` so the
    // resulting view is typed Uint8Array<ArrayBuffer> (BlobPart-
    // compatible under strict TypeScript), not Uint8Array<ArrayBufferLike>.
    const headerBuf = new ArrayBuffer(30);
    const header = new Uint8Array(headerBuf);
    const dv = new DataView(headerBuf);
    dv.setUint32(0, SIG_LOCAL, true);
    dv.setUint16(4, 20, true); // version needed
    dv.setUint16(6, 0x0800, true); // flags: bit 11 = UTF-8 filename
    dv.setUint16(8, 0, true); // method: 0 = STORE
    dv.setUint16(10, time, true);
    dv.setUint16(12, date, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, contentBytes.length, true);
    dv.setUint32(22, contentBytes.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true); // extra field length

    entries.push({ nameBytes, contentBytes, crc, localOffset: offset });
    chunks.push(header, nameBytes, contentBytes);
    offset += 30 + nameBytes.length + contentBytes.length;
  }

  // Central directory.
  const centralStart = offset;
  for (const e of entries) {
    const cdBuf = new ArrayBuffer(46);
    const cd = new Uint8Array(cdBuf);
    const dv = new DataView(cdBuf);
    dv.setUint32(0, SIG_CENTRAL, true);
    dv.setUint16(4, 20, true); // version made by
    dv.setUint16(6, 20, true); // version needed
    dv.setUint16(8, 0x0800, true); // flags (UTF-8)
    dv.setUint16(10, 0, true); // method: STORE
    dv.setUint16(12, time, true);
    dv.setUint16(14, date, true);
    dv.setUint32(16, e.crc, true);
    dv.setUint32(20, e.contentBytes.length, true);
    dv.setUint32(24, e.contentBytes.length, true);
    dv.setUint16(28, e.nameBytes.length, true);
    dv.setUint16(30, 0, true); // extra
    dv.setUint16(32, 0, true); // comment
    dv.setUint16(34, 0, true); // disk
    dv.setUint16(36, 0, true); // internal attrs
    dv.setUint32(38, 0, true); // external attrs
    dv.setUint32(42, e.localOffset, true);

    chunks.push(cd, e.nameBytes);
    offset += 46 + e.nameBytes.length;
  }
  const centralSize = offset - centralStart;

  // End-of-central-directory record.
  const eocdBuf = new ArrayBuffer(22);
  const eocd = new Uint8Array(eocdBuf);
  const ev = new DataView(eocdBuf);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // disk with central
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true); // comment length
  chunks.push(eocd);

  return new Blob(chunks, { type: 'application/zip' });
}

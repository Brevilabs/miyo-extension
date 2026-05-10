// Minimal STORE-method (uncompressed) zip writer.
//
// Why hand-rolled instead of a library:
//   - Keeps the extension's runtime dep count at zero, which matters
//     for Chrome Web Store review surface and for users who audit
//     what they're loading.
//   - STORE-method zips are universally readable (every OS unzipper
//     supports them) and the format is small — ~100 lines including
//     the CRC32 table.
//
// Trade-off vs DEFLATE: markdown is text and would compress 3–4x,
// but typical histories are tens of MB so the larger zip is fine.
// If users start hitting truly large exports (>1GB) we can swap in
// CompressionStream-backed DEFLATE without changing the public API.
//
// Format reference: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

// General purpose bit flag bit 11 = filename is UTF-8.
const GP_FLAG_UTF8 = 0x0800;

let crcTable: Uint32Array | null = null;
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c;
  }
  crcTable = t;
  return t;
}

function crc32(data: Uint8Array): number {
  const t = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = t[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Zip stores DOS time/date. Encoded as two little-endian 16-bit
// values from a JS Date.
function dosTimeDate(date: Date): { time: number; date: number } {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    Math.floor(date.getSeconds() / 2);
  const dateField =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { time, date: dateField };
}

interface PreparedFile {
  nameBytes: Uint8Array;
  data: Uint8Array;
  crc: number;
  time: number;
  date: number;
  // Offset of the local file header in the final zip.
  offset: number;
}

const encoder = new TextEncoder();

export interface ZipFile {
  // Path inside the archive. Forward slashes only.
  name: string;
  // File contents.
  data: string | Uint8Array;
  // Modification timestamp encoded into the entry. Defaults to now.
  mtime?: Date;
}

// Builds a zip in memory and returns it as a Blob. All input is
// processed up-front; we don't stream. For a 500MB markdown buffer
// this peaks at ~500MB of Uint8Arrays plus the final Blob — fine for
// modern desktop Chrome but not infinite. If we ever need to support
// truly huge exports, swap to a streaming writer that pipes into a
// File System Access writable.
export function buildZip(files: ZipFile[]): Blob {
  const now = new Date();
  const prepared: PreparedFile[] = [];

  // First pass: encode names + data, compute CRCs, accumulate
  // offsets. Local headers + payloads come first, central directory
  // after.
  let offset = 0;
  for (const f of files) {
    const nameBytes = encoder.encode(f.name);
    const data = typeof f.data === 'string' ? encoder.encode(f.data) : f.data;
    const { time, date } = dosTimeDate(f.mtime ?? now);
    prepared.push({ nameBytes, data, crc: crc32(data), time, date, offset });
    // 30 byte local header + name + data (no extra field, no data
    // descriptor since sizes are known up front).
    offset += 30 + nameBytes.length + data.length;
  }

  // Build local file headers + data into chunks. Each preserves byte
  // order; the final Blob concatenates them. The cast to BlobPart is
  // a TS lib quirk: Uint8Array<ArrayBufferLike> is technically wider
  // than what Blob() now accepts, but TextEncoder always backs its
  // output with a plain ArrayBuffer in practice.
  const chunks: BlobPart[] = [];
  for (const p of prepared) {
    const header = new ArrayBuffer(30);
    const view = new DataView(header);
    view.setUint32(0, SIG_LOCAL, true);
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, GP_FLAG_UTF8, true);
    view.setUint16(8, 0, true); // compression: store
    view.setUint16(10, p.time, true);
    view.setUint16(12, p.date, true);
    view.setUint32(14, p.crc, true);
    view.setUint32(18, p.data.length, true); // compressed size
    view.setUint32(22, p.data.length, true); // uncompressed size
    view.setUint16(26, p.nameBytes.length, true);
    view.setUint16(28, 0, true); // extra field length
    chunks.push(header, p.nameBytes as BlobPart, p.data as BlobPart);
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const p of prepared) {
    const entry = new ArrayBuffer(46);
    const view = new DataView(entry);
    view.setUint32(0, SIG_CENTRAL, true);
    view.setUint16(4, 20, true); // version made by
    view.setUint16(6, 20, true); // version needed
    view.setUint16(8, GP_FLAG_UTF8, true);
    view.setUint16(10, 0, true); // compression: store
    view.setUint16(12, p.time, true);
    view.setUint16(14, p.date, true);
    view.setUint32(16, p.crc, true);
    view.setUint32(20, p.data.length, true);
    view.setUint32(24, p.data.length, true);
    view.setUint16(28, p.nameBytes.length, true);
    view.setUint16(30, 0, true); // extra field length
    view.setUint16(32, 0, true); // comment length
    view.setUint16(34, 0, true); // disk number
    view.setUint16(36, 0, true); // internal attrs
    view.setUint32(38, 0, true); // external attrs
    view.setUint32(42, p.offset, true);
    chunks.push(entry, p.nameBytes as BlobPart);
    centralSize += 46 + p.nameBytes.length;
  }

  const end = new ArrayBuffer(22);
  const endView = new DataView(end);
  endView.setUint32(0, SIG_END, true);
  endView.setUint16(4, 0, true); // disk number
  endView.setUint16(6, 0, true); // disk where central starts
  endView.setUint16(8, prepared.length, true); // entries on this disk
  endView.setUint16(10, prepared.length, true); // total entries
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralStart, true);
  endView.setUint16(20, 0, true); // comment length
  chunks.push(end);

  return new Blob(chunks, { type: 'application/zip' });
}

// Minimal STORE-only zip writer.
//
// We don't need compression — markdown compresses poorly without
// deflate, and we'd otherwise have to ship a deflate implementation
// or take on a dependency. STORE produces a slightly larger zip but
// "open in any unzipper" still works perfectly. Browsers/macOS
// Archive Utility handle STORE-only zips natively.

export interface ZipFile {
  filename: string;
  content: string; // utf-8 text
}

export function buildZip(files: ZipFile[]): Blob {
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.filename);
    const dataBytes = encoder.encode(file.content);
    const crc = crc32(dataBytes);

    // Local file header (30 bytes + filename).
    const localHeader = new Uint8Array(new ArrayBuffer(30 + nameBytes.length));
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // general purpose bit flag
    lv.setUint16(8, 0, true); // STORE
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true); // compressed size
    lv.setUint32(22, dataBytes.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    localHeader.set(nameBytes, 30);

    localChunks.push(localHeader, dataBytes);

    // Central directory entry (46 bytes + filename).
    const centralHeader = new Uint8Array(new ArrayBuffer(46 + nameBytes.length));
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true); // STORE
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, dataBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    centralHeader.set(nameBytes, 46);

    centralChunks.push(centralHeader);

    offset += localHeader.length + dataBytes.length;
  }

  const centralStart = offset;
  const centralSize = centralChunks.reduce((s, c) => s + c.length, 0);

  // End of central directory record.
  const eocd = new Uint8Array(new ArrayBuffer(22));
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true); // comment length

  // Cast to BlobPart[] — TS strict mode under es2024 lib distinguishes
  // Uint8Array<ArrayBuffer> from Uint8Array<ArrayBufferLike>, but the
  // Blob constructor accepts either at runtime.
  return new Blob([...localChunks, ...centralChunks, eocd] as BlobPart[], {
    type: 'application/zip',
  });
}

// CRC32 (IEEE 802.3) — table built once, ~10 KB.
let CRC_TABLE: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (CRC_TABLE === null) {
    CRC_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      CRC_TABLE[i] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

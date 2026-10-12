/*
 * Minimal, read-only ZIP reader built on the browser's own
 * DecompressionStream — no third-party code, so there is nothing in this
 * page that isn't in this repo.
 *
 * It reads the zip's central directory from the end of the file and then
 * only the entries it is asked for, straight from disk (Blob.slice), so a
 * multi-GB ChatGPT export full of images never has to fit in memory — only
 * the conversations*.json entries are ever decompressed.
 *
 * Supports stored (0) and deflate (8) entries and ZIP64 archives. Encrypted
 * entries and other compression methods are reported, not guessed at.
 */

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

async function readBytes(blob, start, end) {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

function u64(view, offset) {
  // Archive offsets/sizes stay far below 2^53, so a Number is exact.
  return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 0x100000000;
}

async function findCentralDirectory(blob) {
  // The end-of-central-directory record is 22 bytes plus an optional
  // comment of up to 65535 bytes, so it's somewhere in the last 64 KiB.
  const tailStart = Math.max(0, blob.size - (22 + 65535));
  const tail = await readBytes(blob, tailStart, blob.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This doesn't look like a zip file.");

  let count = tail.getUint16(eocd + 10, true);
  let size = tail.getUint32(eocd + 12, true);
  let offset = tail.getUint32(eocd + 16, true);

  const locator = eocd - 20;
  if (locator >= 0 && tail.getUint32(locator, true) === ZIP64_LOCATOR_SIG) {
    const z64Offset = u64(tail, locator + 8);
    const z64 = await readBytes(blob, z64Offset, z64Offset + 56);
    if (z64.getUint32(0, true) !== ZIP64_EOCD_SIG) throw new Error("This zip file looks damaged (bad ZIP64 record).");
    count = u64(z64, 32);
    size = u64(z64, 40);
    offset = u64(z64, 48);
  }
  return { count, size, offset };
}

function applyZip64Extra(view, start, length, entry) {
  // Only fields that were 0xFFFFFFFF in the fixed header appear here, in
  // this fixed order.
  let p = start;
  const end = start + length;
  while (p + 4 <= end) {
    const id = view.getUint16(p, true);
    const len = view.getUint16(p + 2, true);
    if (id === 0x0001) {
      let q = p + 4;
      if (entry.uncompressedSize === 0xffffffff) { entry.uncompressedSize = u64(view, q); q += 8; }
      if (entry.compressedSize === 0xffffffff) { entry.compressedSize = u64(view, q); q += 8; }
      if (entry.localOffset === 0xffffffff) { entry.localOffset = u64(view, q); }
      return;
    }
    p += 4 + len;
  }
}

/**
 * List a zip's entries in central-directory order. Each entry is
 * {name, compressedSize, uncompressedSize, text()} — text() decompresses
 * just that entry and decodes it as UTF-8.
 */
export async function listZipEntries(blob) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser is too old to open zip files here. Please update it, or unzip the export and choose the folder instead.");
  }
  const cd = await findCentralDirectory(blob);
  const view = await readBytes(blob, cd.offset, cd.offset + cd.size);
  const decoder = new TextDecoder("utf-8");
  const entries = [];
  let p = 0;
  for (let i = 0; i < cd.count; i++) {
    if (view.getUint32(p, true) !== CENTRAL_SIG) throw new Error("This zip file looks damaged (bad directory entry).");
    const flags = view.getUint16(p + 8, true);
    const entry = {
      method: view.getUint16(p + 10, true),
      encrypted: (flags & 1) === 1,
      compressedSize: view.getUint32(p + 20, true),
      uncompressedSize: view.getUint32(p + 24, true),
      localOffset: view.getUint32(p + 42, true),
    };
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    entry.name = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + p + 46, nameLen));
    applyZip64Extra(view, p + 46 + nameLen, extraLen, entry);
    p += 46 + nameLen + extraLen + commentLen;
    if (entry.name.endsWith("/")) continue; // directory
    entries.push(makeEntry(blob, entry));
  }
  return entries;
}

function makeEntry(blob, entry) {
  return {
    name: entry.name,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    async text() {
      if (entry.encrypted) throw new Error(`${entry.name} is password-protected, so it can't be read.`);
      const local = await readBytes(blob, entry.localOffset, entry.localOffset + 30);
      if (local.getUint32(0, true) !== LOCAL_SIG) throw new Error("This zip file looks damaged (bad file header).");
      const dataStart = entry.localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
      const data = blob.slice(dataStart, dataStart + entry.compressedSize);
      if (entry.method === 0) return data.text();
      if (entry.method === 8) {
        return new Response(data.stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
      }
      throw new Error(`${entry.name} uses a compression method this page can't read (${entry.method}). Unzip the export and choose the folder instead.`);
    },
  };
}

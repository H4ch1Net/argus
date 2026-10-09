// A small reader for a single-entry .zip (the GDELT 2.0 exports), on Node's
// own zlib: no package. It reads the central directory (the sizes there are
// right even when the local header defers them to a data descriptor), refuses
// what it does not need to support (several entries, encryption, zip64,
// multi-disk, methods other than stored and deflate), caps the inflated size
// before inflating, and checks the length and CRC-32 of what comes out.

import zlib from 'node:zlib';
import { promisify } from 'node:util';

const inflateRaw = promisify(zlib.inflateRaw);

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export class ZipError extends Error {}

// CRC-32 (IEEE 802.3), table driven. zlib.crc32 is newer than the Node 18 the
// Android app embeds, so this does not rely on it.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of a buffer, as an unsigned 32-bit number. */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * The one entry of a single-entry zip.
 * @param {Buffer} buf
 * @param {{ maxBytes?: number, name?: RegExp }} [opts] maxBytes caps the
 *   inflated size; name, when given, must match the entry's name.
 * @returns {Promise<{ name: string, data: Buffer }>}
 */
export async function readSingleEntry(buf, { maxBytes = 32 * 1024 * 1024, name } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('not a zip');
  // The end-of-central-directory record: the last 22 bytes plus a comment of
  // at most 64 KiB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('no end of central directory');
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0)
    throw new ZipError('multi-disk zip');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count !== 1) throw new ZipError(`expected one entry, found ${count}`);
  if (cdOffset === 0xffffffff) throw new ZipError('zip64 is not supported');
  if (cdOffset + 46 > eocd || buf.readUInt32LE(cdOffset) !== CENTRAL)
    throw new ZipError('bad central directory');

  const c = cdOffset;
  const flags = buf.readUInt16LE(c + 8);
  const method = buf.readUInt16LE(c + 10);
  const crc = buf.readUInt32LE(c + 16);
  const compressed = buf.readUInt32LE(c + 20);
  const size = buf.readUInt32LE(c + 24);
  const nameLen = buf.readUInt16LE(c + 28);
  const local = buf.readUInt32LE(c + 42);
  if (c + 46 + nameLen > eocd) throw new ZipError('bad central directory');
  const entryName = buf.toString('utf8', c + 46, c + 46 + nameLen);
  if (flags & 0x1) throw new ZipError('encrypted entry');
  if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff)
    throw new ZipError('zip64 is not supported');
  if (method !== 0 && method !== 8) throw new ZipError(`unsupported method ${method}`);
  if (size > maxBytes) throw new ZipError('entry too large');
  if (name && !name.test(entryName)) throw new ZipError('unexpected entry name');

  if (local + 30 > cdOffset || buf.readUInt32LE(local) !== LOCAL)
    throw new ZipError('bad local header');
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  if (start + compressed > cdOffset) throw new ZipError('truncated entry');
  const raw = buf.subarray(start, start + compressed);

  let data;
  if (method === 0) data = Buffer.from(raw);
  else {
    try {
      data = await inflateRaw(raw, { maxOutputLength: maxBytes });
    } catch {
      throw new ZipError('corrupt or oversized deflate data');
    }
  }
  if (data.length !== size) throw new ZipError('size mismatch');
  if (crc32(data) !== crc) throw new ZipError('CRC mismatch');
  return { name: entryName, data };
}

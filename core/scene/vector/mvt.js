// Mapbox Vector Tile (MVT 2.1) decoder: protobuf bytes in, the layers and
// features the ctOS basemap draws out. Pure (no DOM, no Cesium): it runs in the
// basemap worker, on the main thread as a fallback, and under node --test.
//
// A tile holds named layers; each feature has a geometry type (1 point,
// 2 line, 3 polygon), integer tags indexing the layer's keys and values, and a
// command stream (MoveTo, LineTo, ClosePath) of zigzag deltas in tile units
// (`extent`, 4096 for OpenMapTiles). Only the layers asked for are decoded, and
// only the properties a style reads are kept.

const LEN = 2; // wire type: length-delimited
const VARINT = 0;
const FIXED64 = 1;
const FIXED32 = 5;

/** A cursor over protobuf bytes (the subset MVT needs). */
class Reader {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  varint() {
    const b = this.buf;
    let v = 0;
    let shift = 0;
    let byte;
    do {
      byte = b[this.pos++];
      // Above 2^31 a shift would overflow 32 bits: multiply instead.
      v += shift < 28 ? (byte & 0x7f) << shift : (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80 && shift < 70);
    return v;
  }
  zigzag() {
    const v = this.varint();
    return v % 2 === 1 ? (v + 1) / -2 : v / 2;
  }
  skip(wire) {
    if (wire === VARINT) this.varint();
    else if (wire === FIXED64) this.pos += 8;
    else if (wire === LEN) this.pos += this.varint();
    else if (wire === FIXED32) this.pos += 4;
    else throw new Error(`mvt: unknown wire type ${wire}`);
  }
  string() {
    const len = this.varint();
    const s = utf8(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
}

const decoder = typeof TextDecoder === 'function' ? new TextDecoder() : null;
function utf8(buf, start, end) {
  if (decoder) return decoder.decode(buf.subarray(start, end));
  let s = '';
  for (let i = start; i < end; i += 1) s += String.fromCharCode(buf[i]);
  return s;
}

function readValue(r, end) {
  let v = null;
  while (r.pos < end) {
    const tag = r.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1) v = r.string();
    else if (field === 2) {
      v = r.view.getFloat32(r.pos, true);
      r.pos += 4;
    } else if (field === 3) {
      v = r.view.getFloat64(r.pos, true);
      r.pos += 8;
    } else if (field === 4 || field === 5) v = r.varint();
    else if (field === 6) v = r.zigzag();
    else if (field === 7) v = Boolean(r.varint());
    else r.skip(wire);
  }
  return v;
}

const unzigzag = (n) => (n % 2 === 1 ? (n + 1) / -2 : n / 2);

/**
 * Turn a command stream into rings (arrays of [x, y, x, y, ...] in tile
 * units) and the feature's bounding box.
 */
export function decodeGeometry(cmds) {
  const parts = [];
  let part = null;
  let x = 0;
  let y = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let i = 0;
  while (i < cmds.length) {
    const c = cmds[i++];
    const id = c & 7;
    const count = c >> 3;
    if (id === 1 || id === 2) {
      for (let k = 0; k < count && i + 1 < cmds.length; k += 1) {
        x += unzigzag(cmds[i++]);
        y += unzigzag(cmds[i++]);
        if (id === 1) {
          part = [];
          parts.push(part);
        }
        part?.push(x, y);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    } else if (id === 7) {
      if (part && part.length >= 2) part.push(part[0], part[1]);
    } else {
      break; // unknown command: stop rather than misread
    }
  }
  return { parts, bbox: [minX, minY, maxX, maxY] };
}

// Geometry arrives as raw varints (zigzag decoded in decodeGeometry, which
// sees the encoded values: command ints and zigzag parameters alike).
function readPacked(r) {
  const end = r.varint() + r.pos;
  const out = [];
  while (r.pos < end) out.push(r.varint());
  return out;
}

function readFeature(r, end) {
  const f = { id: null, type: 0, tags: [], cmds: [] };
  while (r.pos < end) {
    const tag = r.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1) f.id = r.varint();
    else if (field === 2 && wire === LEN) f.tags = readPacked(r);
    else if (field === 3) f.type = r.varint();
    else if (field === 4 && wire === LEN) f.cmds = readPacked(r);
    else r.skip(wire);
  }
  return f;
}

function readLayer(r, end, wantKeys) {
  const layer = { name: '', extent: 4096, keys: [], values: [], raw: [] };
  while (r.pos < end) {
    const tag = r.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1) layer.name = r.string();
    else if (field === 2) {
      const len = r.varint();
      layer.raw.push([r.pos, r.pos + len]);
      r.pos += len;
    } else if (field === 3) layer.keys.push(r.string());
    else if (field === 4) {
      const len = r.varint();
      layer.values.push(readValue(r, r.pos + len));
    } else if (field === 5) layer.extent = r.varint();
    else r.skip(wire);
  }
  // Features last: keys and values may follow them in the stream.
  const keep = wantKeys ? new Set(wantKeys) : null;
  layer.features = layer.raw.map(([s, e]) => {
    r.pos = s;
    const f = readFeature(r, e);
    const props = {};
    for (let i = 0; i + 1 < f.tags.length; i += 2) {
      const k = layer.keys[f.tags[i]];
      if (keep && !keep.has(k)) continue;
      props[k] = layer.values[f.tags[i + 1]];
    }
    const { parts, bbox } = decodeGeometry(f.cmds);
    return { id: f.id, type: f.type, props, parts, bbox };
  });
  delete layer.raw;
  delete layer.keys;
  delete layer.values;
  return layer;
}

/**
 * Decode a vector tile.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {Record<string, string[]|null>} [want] layer name -> property keys to
 *   keep (null keeps all); layers not named are skipped. Omit for every layer.
 * @returns {Record<string, { name: string, extent: number, features: object[] }>}
 */
export function decodeTile(bytes, want) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const r = new Reader(buf);
  const out = {};
  while (r.pos < r.end) {
    const tag = r.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field !== 3 || wire !== LEN) {
      r.skip(wire);
      continue;
    }
    const len = r.varint();
    const end = r.pos + len;
    // Peek the name (field 1 comes first in practice, but do not rely on it).
    const name = layerName(buf, r.pos, end);
    if (!want || Object.hasOwn(want, name)) {
      const layer = readLayer(new Reader(buf, r.pos, end), end, want ? want[name] : null);
      out[layer.name] = layer;
    }
    r.pos = end;
  }
  return out;
}

function layerName(buf, start, end) {
  const r = new Reader(buf, start, end);
  while (r.pos < end) {
    const tag = r.varint();
    if (tag >> 3 === 1 && (tag & 7) === LEN) return r.string();
    r.skip(tag & 7);
  }
  return '';
}

// A layered character canvas for the terminal map. Pure (no I/O).
//
// Two kinds of content:
//   - "inks": braille dot layers (coastlines, graticule, orbit tracks). Each cell
//     packs 2x4 dots; the cell shows the OR of every ink's dots, coloured by the
//     highest-priority ink present.
//   - glyphs: one character per cell for entities and labels, drawn over the
//     inks; a higher priority glyph wins a contested cell.
//
// toCells() resolves everything into { ch, fg, bold } per cell for the renderer.

const BRAILLE_BASE = 0x2800;
// Braille bit for dot (x, y) inside a cell, x in 0..1, y in 0..3.
const BIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

export function createCanvas(cols, rows) {
  const size = cols * rows;
  /** @type {{ name: string, color: string, priority: number, bits: Uint8Array }[]} */
  const inks = [];
  const glyphs = new Array(size).fill(null);
  const dotsW = cols * 2;
  const dotsH = rows * 4;

  function ink(name, color, priority = 0) {
    let k = inks.find((i) => i.name === name);
    if (!k) {
      k = { name, color, priority, bits: new Uint8Array(size) };
      inks.push(k);
      inks.sort((a, b) => b.priority - a.priority);
    }
    return k;
  }

  function dot(k, x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= dotsW || yi >= dotsH) return;
    const idx = (yi >> 2) * cols + (xi >> 1);
    k.bits[idx] |= BIT[yi & 3][xi & 1];
  }

  // Liang-Barsky clip of a segment to the dot rectangle; null when fully outside.
  function clip(x0, y0, x1, y1) {
    let t0 = 0;
    let t1 = 1;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const edges = [
      [-dx, x0],
      [dx, dotsW - 1 - x0],
      [-dy, y0],
      [dy, dotsH - 1 - y0],
    ];
    for (const [p, q] of edges) {
      if (p === 0) {
        if (q < 0) return null;
      } else {
        const r = q / p;
        if (p < 0) {
          if (r > t1) return null;
          if (r > t0) t0 = r;
        } else {
          if (r < t0) return null;
          if (r < t1) t1 = r;
        }
      }
    }
    return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
  }

  function line(k, ax, ay, bx, by) {
    const c = clip(ax, ay, bx, by);
    if (!c) return;
    let [x0, y0, x1, y1] = c.map(Math.round);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let guard = 0; guard < 20000; guard += 1) {
      dot(k, x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  /** Put a glyph in a cell; higher priority wins. */
  function glyph(col, row, ch, fg, { priority = 0, bold = false } = {}) {
    if (col < 0 || row < 0 || col >= cols || row >= rows) return false;
    const i = row * cols + col;
    const cur = glyphs[i];
    if (cur && cur.priority > priority) return false;
    glyphs[i] = { ch, fg, bold, priority };
    return true;
  }

  /** Write a text label left to right from (col, row); never overwrites entities. */
  function text(col, row, str, fg, { priority = -1, bold = false } = {}) {
    let c = col;
    for (const ch of String(str)) {
      if (c >= cols) break;
      if (c >= 0) {
        const cur = glyphs[row * cols + c];
        if (!cur || cur.priority <= priority) glyph(c, row, ch, fg, { priority, bold });
      }
      c += 1;
    }
  }

  /** True when every cell in [col, col + width) on `row` is free of glyphs. */
  function free(col, row, width = 1) {
    if (row < 0 || row >= rows || col < 0 || col + width > cols) return false;
    for (let c = col; c < col + width; c += 1) if (glyphs[row * cols + c]) return false;
    return true;
  }

  /** Resolve to one { ch, fg, bold } per cell. `ascii` swaps braille for '.'. */
  function toCells({ ascii = false } = {}) {
    const out = new Array(size);
    for (let i = 0; i < size; i += 1) {
      const g = glyphs[i];
      if (g) {
        out[i] = { ch: g.ch, fg: g.fg, bold: g.bold };
        continue;
      }
      let bits = 0;
      let color = null;
      for (const k of inks) {
        const b = k.bits[i];
        if (b) {
          bits |= b;
          if (color === null) color = k.color;
        }
      }
      if (!bits) out[i] = { ch: ' ', fg: null, bold: false };
      else if (ascii) out[i] = { ch: bitsToAscii(bits), fg: color, bold: false };
      else
        out[i] = { ch: String.fromCharCode(BRAILLE_BASE + bits), fg: color, bold: false };
    }
    return out;
  }

  return { cols, rows, dotsW, dotsH, ink, dot, line, glyph, text, free, toCells };
}

// A rough ASCII stand-in for a braille cell: denser cells read darker.
function bitsToAscii(bits) {
  let n = 0;
  for (let b = bits; b; b >>= 1) n += b & 1;
  if (n <= 2) return '.';
  if (n <= 4) return ':';
  return '#';
}

// A styled cell grid for one terminal frame. Pure. Panels write text into it;
// toLines() serializes each row, emitting an escape sequence only when the style
// changes, so frames stay small (this matters over SSH).

import { seq } from './ansi.js';

const BLANK = Object.freeze({
  ch: ' ',
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  inverse: false,
});

export function createScreen(cols, rows) {
  const cells = new Array(cols * rows).fill(BLANK);

  function put(col, row, ch, style = {}) {
    if (col < 0 || row < 0 || col >= cols || row >= rows) return;
    cells[row * cols + col] = {
      ch,
      fg: style.fg ?? null,
      bg: style.bg ?? null,
      bold: Boolean(style.bold),
      dim: Boolean(style.dim),
      inverse: Boolean(style.inverse),
    };
  }

  /**
   * Write a string (clipped at maxWidth, or the right edge). Returns columns used.
   * Control characters (from upstream text such as a radio station's name) are
   * drawn as '?' so they can never act on the terminal as escape sequences.
   */
  function text(col, row, str, style = {}, maxWidth = cols - col) {
    let n = 0;
    for (const raw of String(str ?? '')) {
      if (n >= maxWidth) break;
      const cp = raw.codePointAt(0);
      const ch = cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) ? '?' : raw;
      put(col + n, row, ch, style);
      n += 1;
    }
    return n;
  }

  function fill(col, row, width, height, ch = ' ', style = {}) {
    for (let r = row; r < row + height; r += 1) {
      for (let c = col; c < col + width; c += 1) put(c, r, ch, style);
    }
  }

  function hline(col, row, width, ch, style) {
    for (let c = col; c < col + width; c += 1) put(c, row, ch, style);
  }

  function vline(col, row, height, ch, style) {
    for (let r = row; r < row + height; r += 1) put(col, r, ch, style);
  }

  /** Serialize to one string per row using a styler from ansi.js. */
  function toLines(style) {
    const lines = [];
    for (let r = 0; r < rows; r += 1) {
      let out = '';
      let current = null;
      for (let c = 0; c < cols; c += 1) {
        const cell = cells[r * cols + c];
        const key = `${cell.fg}|${cell.bg}|${cell.bold}|${cell.dim}|${cell.inverse}`;
        if (key !== current) {
          const prefix = style(cell.fg, cell);
          out += (current === null ? '' : seq.reset) + prefix;
          current = key;
        }
        out += cell.ch;
      }
      lines.push(out + seq.reset);
    }
    return lines;
  }

  /** Plain text rows (no escapes), for tests and snapshots. */
  function toPlain() {
    const lines = [];
    for (let r = 0; r < rows; r += 1) {
      lines.push(
        cells
          .slice(r * cols, (r + 1) * cols)
          .map((c) => c.ch)
          .join(''),
      );
    }
    return lines;
  }

  return { cols, rows, put, text, fill, hline, vline, toLines, toPlain };
}

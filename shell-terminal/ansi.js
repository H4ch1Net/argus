// ANSI escape helpers for the terminal shell. Pure string builders.
//
// Colour depth is chosen once from the environment: truecolor when the terminal
// advertises it (most Linux terminals, including Kali's defaults, do), the
// 256-colour cube otherwise, and none for NO_COLOR / --no-color / dumb terminals.

export const ESC = '\x1b[';

export const seq = {
  altScreenOn: '\x1b[?1049h',
  altScreenOff: '\x1b[?1049l',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clear: '\x1b[2J',
  home: '\x1b[H',
  reset: '\x1b[0m',
  // SGR mouse: clicks + wheel, reported with absolute cell coordinates.
  mouseOn: '\x1b[?1000h\x1b[?1006h',
  mouseOff: '\x1b[?1000l\x1b[?1006l',
  moveTo: (row, col) => `\x1b[${row + 1};${col + 1}H`,
  clearLine: '\x1b[2K',
};

/** Pick a colour mode from the environment and options. */
export function detectColorMode(env = process.env, { noColor = false } = {}) {
  if (noColor || 'NO_COLOR' in env || env.TERM === 'dumb') return 'none';
  const ct = String(env.COLORTERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor';
  return '256';
}

/** True when the locale can show Unicode (braille, arrows); otherwise use ASCII. */
export function detectUnicode(env = process.env) {
  const loc = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (/utf-?8/i.test(loc)) return true;
  // Windows Terminal and most modern terminals are UTF-8 even without a locale.
  return Boolean(env.WT_SESSION || env.TERM_PROGRAM);
}

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Nearest entry in xterm's 6x6x6 colour cube (or its grey ramp).
export function rgbTo256([r, g, b]) {
  const toCube = (v) =>
    v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40));
  const cr = toCube(r);
  const cg = toCube(g);
  const cb = toCube(b);
  const cubeIdx = 16 + 36 * cr + 6 * cg + cb;
  const levels = [0, 95, 135, 175, 215, 255];
  const cubeDist = (levels[cr] - r) ** 2 + (levels[cg] - g) ** 2 + (levels[cb] - b) ** 2;
  const grey = Math.round((r + g + b) / 3);
  const gi = Math.max(0, Math.min(23, Math.round((grey - 8) / 10)));
  const gv = 8 + gi * 10;
  const greyDist = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return greyDist < cubeDist ? 232 + gi : cubeIdx;
}

/**
 * Build a style function for one colour mode. style(fg, { bold, bg, dim }) returns
 * the SGR prefix; the renderer appends seq.reset when the style changes.
 */
export function createStyler(mode) {
  const cache = new Map();
  const color = (hex, layer) => {
    if (!hex || mode === 'none') return '';
    const key = `${layer}${hex}`;
    let s = cache.get(key);
    if (s === undefined) {
      const rgb = hexToRgb(hex);
      const base = layer === 'bg' ? 48 : 38;
      s =
        mode === 'truecolor'
          ? `${base};2;${rgb.join(';')}`
          : `${base};5;${rgbTo256(rgb)}`;
      cache.set(key, s);
    }
    return s;
  };
  return function style(
    fg,
    { bold = false, bg = null, dim = false, inverse = false } = {},
  ) {
    if (mode === 'none') return inverse ? '\x1b[7m' : '';
    const parts = [];
    if (bold) parts.push('1');
    if (dim) parts.push('2');
    if (inverse) parts.push('7');
    const f = color(fg, 'fg');
    if (f) parts.push(f);
    const b = color(bg, 'bg');
    if (b) parts.push(b);
    return parts.length ? `${ESC}${parts.join(';')}m` : '';
  };
}

// Visible length of a plain string (no escapes). Glyphs used here are all single
// width, so this is the code point count.
export const visibleLength = (s) => [...String(s)].length;

/** Pad or truncate plain text to exactly `width` columns. */
export function fit(s, width, ellipsis = '…') {
  if (width <= 0) return '';
  const chars = [...String(s ?? '')];
  if (chars.length > width) return chars.slice(0, width - 1).join('') + ellipsis;
  return chars.join('') + ' '.repeat(width - chars.length);
}

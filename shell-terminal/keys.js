// Terminal input decoding. Pure: a chunk of raw stdin text -> key events.
//
// Handles printable characters, control keys, CSI / SS3 cursor keys (with
// modifiers), Home/End/PgUp/PgDn/Delete, and SGR mouse reports (clicks and the
// wheel), which is everything the terminal shell binds.

const CSI_FINAL = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'backtab',
};
const TILDE = {
  1: 'home',
  2: 'insert',
  3: 'delete',
  4: 'end',
  5: 'pageup',
  6: 'pagedown',
  7: 'home',
  8: 'end',
};

function modifiers(code) {
  // xterm encodes modifiers as 1 + (shift 1 | alt 2 | ctrl 4).
  const m = Math.max(0, (Number(code) || 1) - 1);
  return { shift: Boolean(m & 1), alt: Boolean(m & 2), ctrl: Boolean(m & 4) };
}

/**
 * @param {string} input
 * @returns {Array<{ name: string, ch?: string, ctrl?: boolean, shift?: boolean, alt?: boolean,
 *   x?: number, y?: number, button?: number, release?: boolean }>}
 */
export function parseKeys(input) {
  const out = [];
  const s = String(input);
  let i = 0;
  while (i < s.length) {
    const c = s[i];

    if (c === '\x1b') {
      const next = s[i + 1];
      // SGR mouse: ESC [ < b ; x ; y (M|m)
      if (next === '[' && s[i + 2] === '<') {
        // Matched after the ESC byte, so the pattern holds no control characters.
        const m = /^\[<(\d+);(\d+);(\d+)([Mm])/.exec(s.slice(i + 1));
        if (m) {
          const b = Number(m[1]);
          const ev = {
            name: 'mouse',
            button: b & 3,
            x: Number(m[2]) - 1,
            y: Number(m[3]) - 1,
            release: m[4] === 'm',
            shift: Boolean(b & 4),
            alt: Boolean(b & 8),
            ctrl: Boolean(b & 16),
          };
          if (b & 64) ev.name = (b & 1) === 0 ? 'wheelup' : 'wheeldown';
          else if (b & 32) ev.name = 'drag';
          out.push(ev);
          i += 1 + m[0].length;
          continue;
        }
      }
      // CSI: ESC [ params final
      if (next === '[') {
        const m = /^\[([0-9;]*)([A-Za-z~])/.exec(s.slice(i + 1));
        if (m) {
          const params = m[1].split(';');
          const final = m[2];
          if (final === '~') {
            const name = TILDE[params[0]];
            if (name) out.push({ name, ...modifiers(params[1]) });
          } else if (CSI_FINAL[final]) {
            out.push({ name: CSI_FINAL[final], ...modifiers(params[1]) });
          }
          i += 1 + m[0].length;
          continue;
        }
      }
      // SS3: ESC O final (application cursor mode)
      if (next === 'O' && s[i + 2] && CSI_FINAL[s[i + 2]]) {
        out.push({ name: CSI_FINAL[s[i + 2]] });
        i += 3;
        continue;
      }
      // Alt+key arrives as ESC followed by the key.
      if (next && next !== '\x1b' && next >= ' ' && next !== '[' && next !== 'O') {
        out.push({ name: next, ch: next, alt: true });
        i += 2;
        continue;
      }
      out.push({ name: 'escape' });
      i += 1;
      continue;
    }

    if (c === '\r' || c === '\n') out.push({ name: 'enter' });
    else if (c === '\t') out.push({ name: 'tab' });
    else if (c === '\x7f' || c === '\b') out.push({ name: 'backspace' });
    else if (c === '\x03') out.push({ name: 'c', ctrl: true });
    else if (c < ' ') {
      // Ctrl+letter: \x01 is Ctrl-A ... \x1a is Ctrl-Z.
      out.push({ name: String.fromCharCode(c.charCodeAt(0) + 96), ctrl: true });
    } else {
      const cp = s.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      out.push({ name: ch, ch });
      i += ch.length;
      continue;
    }
    i += 1;
  }
  return out;
}

// Tiny DOM helpers shared by the ctOS components. No framework: h() builds an
// element from a tag with classes, attributes and children; esc() escapes text
// for the few places that build markup strings.

/**
 * h('button.ct-btn', { type: 'button', onclick }, 'LABEL', child, ...)
 * The tag may carry classes after dots. Attributes starting with "on" bind
 * listeners; `dataset` and `style` objects are merged; false/null skip.
 */
export function h(tag, attrs = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class') el.className += ` ${v}`;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Zero-padded fixed-width number, the ctOS readout style (12 -> "012"). */
export const pad = (n, width = 3) =>
  String(Math.max(0, Math.round(Number(n) || 0))).padStart(width, '0');

/** A two-digit tracking id (0..99), as Bagley labels its nodes. */
export const id2 = (n) => String(((n % 100) + 100) % 100).padStart(2, '0');

/** The ctOS diamond (os-icon) as an inline SVG string, white by default. */
export const DIAMOND_SVG = (size = 16, color = 'currentColor') =>
  `<svg width="${size}" height="${size}" viewBox="0 0 136 136" aria-hidden="true"><path fill="${color}" d="M68 0 0 68l68 68 68-68L68 0Zm-.4 2.1V70l-23.3 23.3L1.7 68 67.6 2.1Zm.8 0L134.3 68l-42.5 25.3-23.4-23.3V2.1ZM4.2 70.5l40.7 24.1 22.7 22.6v16.7L4.2 70.5Zm127.6 0-63.4 63.4v-16.7l22.4-22.4 41-24.3Z"/></svg>`;

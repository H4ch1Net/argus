import { h } from './dom.js';

// Small ctOS controls the menus are built from: a titled section, a section
// that folds (collapsible / disclosure), a segmented single choice, and a
// switch row. Core builds them; main.js composes menus.

/** A section: a ct-head title followed by its content. */
export function section(title, ...children) {
  return h(
    'section.ct-section',
    {},
    h('div.ct-head', {}, title),
    h('div.ct-section__body', {}, ...children),
  );
}

// Which folded sections were left open, on this device (a convenience only).
const OPEN_KEY = 'argus.ui.open';
function readOpen() {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
function writeOpen(id, open) {
  try {
    const s = readOpen();
    if (open) s.add(id);
    else s.delete(id);
    localStorage.setItem(OPEN_KEY, JSON.stringify([...s].slice(-64)));
  } catch {
    // storage blocked: the section just starts folded next time
  }
}

/**
 * Fold a section (from section(), or any module's ct-section): its title
 * becomes a header button, TITLE ........ [+], and its body shows only while
 * open. `id` remembers the state on this device. A section without the usual
 * head and body is returned as it is.
 * @param {HTMLElement} el
 * @param {{ id?: string, open?: boolean, meta?: HTMLElement|string }} [opts]
 *   meta: a small value shown before the caret (a count, SET 3/30)
 * @returns {HTMLElement & { setOpen?: (open: boolean) => void }}
 */
export function collapsible(el, { id, open = false, meta } = {}) {
  const head = el?.querySelector?.(':scope > .ct-head');
  const body = el?.querySelector?.(':scope > .ct-section__body');
  if (!head || !body || head.tagName === 'BUTTON') return el;
  let isOpen = id && readOpen().has(id) ? true : Boolean(open);
  const caret = h('span.ct-fold__caret');
  const metaEl =
    meta == null
      ? null
      : typeof meta === 'string'
        ? h('span.ct-fold__meta', {}, meta)
        : meta;
  metaEl?.classList.add('ct-fold__meta');
  const button = h(
    'button.ct-head.ct-fold__head',
    { type: 'button', onclick: () => setOpen(!isOpen) },
    h('span.ct-fold__title', {}, ...head.childNodes),
    metaEl,
    caret,
  );
  head.replaceWith(button);
  el.classList.add('ct-fold');
  function setOpen(next, remember = true) {
    isOpen = Boolean(next);
    body.hidden = !isOpen;
    button.setAttribute('aria-expanded', String(isOpen));
    caret.textContent = isOpen ? '[-]' : '[+]';
    el.classList.toggle('is-open', isOpen);
    if (id && remember) writeOpen(id, isOpen);
  }
  setOpen(isOpen, false);
  el.setOpen = setOpen;
  return el;
}

/** A folded section from scratch: disclosure('MORE', { id }, ...children). */
export function disclosure(title, opts, ...children) {
  return collapsible(section(title, ...children), opts);
}

/**
 * A segmented single choice. onSelect may return (or resolve to) the id that
 * actually took effect, so a choice that falls back (photoreal without a key)
 * shows the truth instead of what was pressed.
 * @param {{ options: { id: string, label: string, title?: string }[], current?: string,
 *   onSelect: (id: string) => any, label?: string, caption?: string,
 *   columns?: number }} opts  columns: an even grid of this many columns
 */
export function createChoice({ options, current, onSelect, label, caption, columns }) {
  const seg = h('div.ct-seg', { role: 'group', 'aria-label': label || caption || '' });
  if (columns) {
    seg.classList.add('ct-seg--grid');
    seg.style.setProperty('--cols', String(columns));
  }
  // caption: a visible label above the buttons, for rows that need naming.
  const el = caption
    ? h('div.ct-field', {}, h('div.ct-field__label', {}, caption), seg)
    : seg;
  const buttons = new Map();
  for (const o of options) {
    const b = h(
      'button.ct-btn',
      {
        type: 'button',
        title: o.title || o.label,
        'aria-pressed': String(o.id === current),
        onclick: () => choose(o.id),
      },
      o.label,
    );
    buttons.set(o.id, b);
    seg.appendChild(b);
  }
  const paint = (id) => {
    for (const [k, b] of buttons) b.setAttribute('aria-pressed', String(k === id));
  };
  async function choose(id) {
    paint(id);
    const applied = await onSelect(id);
    if (typeof applied === 'string' && applied !== id) paint(applied);
  }
  return { el, set: choose, paint };
}

/**
 * A switch row: LABEL .......... [■] ON
 * @param {{ label: string, on?: boolean, onToggle: (on: boolean) => any, title?: string }} opts
 */
export function createSwitch({ label, on = false, onToggle, title }) {
  const state = h('span.ct-switch__state');
  const el = h(
    'button.ct-switch',
    { type: 'button', title: title || '', onclick: () => set(!value, true) },
    h('span.ct-switch__label', {}, label),
    h('span.ct-switch__box'),
    state,
  );
  let value = on;
  function paint() {
    el.setAttribute('aria-pressed', String(value));
    state.textContent = value ? 'ON' : 'OFF';
  }
  async function set(next, fromUser = false) {
    value = Boolean(next);
    paint();
    if (fromUser) {
      const applied = await onToggle(value);
      if (typeof applied === 'boolean' && applied !== value) {
        value = applied;
        paint();
      }
    }
  }
  paint();
  return { el, set: (v) => set(v, false), get: () => value };
}

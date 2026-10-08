import { h } from './dom.js';

// Small ctOS controls the menus are built from: a titled section, a segmented
// single choice, and a switch row. Core builds them; main.js composes menus.

/** A section: a ct-head title followed by its content. */
export function section(title, ...children) {
  return h(
    'section.ct-section',
    {},
    h('div.ct-head', {}, title),
    h('div.ct-section__body', {}, ...children),
  );
}

/**
 * A segmented single choice. onSelect may return (or resolve to) the id that
 * actually took effect, so a choice that falls back (photoreal without a key)
 * shows the truth instead of what was pressed.
 * @param {{ options: { id: string, label: string, title?: string }[], current?: string,
 *   onSelect: (id: string) => any, label?: string }} opts
 */
export function createChoice({ options, current, onSelect, label }) {
  const el = h('div.ct-seg', { role: 'group', 'aria-label': label || '' });
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
    el.appendChild(b);
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

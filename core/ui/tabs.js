import { h } from './dom.js';

// Kitty-style tabs (design/ctos Terminal tabs): the active tab is the light
// term-tab-active with dark bold text, the rest term-selection with
// textSecondary. Each tab owns a pane; only the active pane is shown.

/**
 * @param {{ tabs: { id: string, label: string, pane: HTMLElement }[],
 *   current?: string, onChange?: (id: string) => void }} opts
 */
export function createTabs({ tabs, current, onChange }) {
  const bar = h('div.ct-tabs', { role: 'tablist' });
  const panes = h('div.ct-tabpanes');
  const byId = new Map();
  for (const t of tabs) {
    const b = h(
      'button',
      {
        type: 'button',
        role: 'tab',
        'aria-selected': 'false',
        onclick: () => select(t.id, true),
      },
      t.label,
    );
    const pane = h('div.ct-tabpane', { role: 'tabpanel', hidden: true }, t.pane);
    byId.set(t.id, { b, pane });
    bar.appendChild(b);
    panes.appendChild(pane);
  }
  let active = null;
  function select(id, fromUser = false) {
    if (!byId.has(id)) return;
    active = id;
    for (const [k, { b, pane }] of byId) {
      b.setAttribute('aria-selected', String(k === id));
      pane.hidden = k !== id;
    }
    if (fromUser) onChange?.(id);
  }
  select(current ?? tabs[0]?.id);
  return {
    bar,
    panes,
    select,
    get current() {
      return active;
    },
    setLabel(id, label) {
      const t = byId.get(id);
      if (t) t.b.textContent = label;
    },
  };
}

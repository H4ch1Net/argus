import './layerMenu.css';
import { h } from './dom.js';
import { layerTile } from './layerGlyphs.js';

// The layer menu: a launcher-style list (design/ctos Launcher) of every data
// layer, grouped, filterable, each row a toggle. A row shows the layer's own
// marker in a tile, its name, and its live state on the right: the contact
// count, LOAD while it fetches, ERR (red) when the feed failed, STALE when the
// proxy could only give its last good answer, OFF. The
// selected style (raised, ctosGray left rule) means "on". Presets sit on top.
// An enabled layer whose data is kept (static infrastructure fetched once per
// tile, slow polls) gets a small RELOAD square beside its row: fetch it again
// now instead of waiting for the cache to expire.

const fmtCount = (n) => (n >= 10000 ? `${(n / 1000).toFixed(0)}K` : String(n));

// A square loop with an arrowhead: ctOS has no round corners, so neither does
// its reload mark.
const RELOAD_SVG =
  '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M11.5 6.5V11.5H2.5V2.5H9" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7.5 0.5 10.5 2.5 7.5 4.5Z" fill="currentColor"/></svg>';

/**
 * @param {{ manager: object, presets?: object[], onPreset?: (p: object) => void,
 *   onManualToggle?: () => void }} opts
 */
export function createLayerMenu({ manager, presets = [], onPreset, onManualToggle }) {
  const filter = h('input', {
    type: 'text',
    placeholder: 'FILTER',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Filter layers',
  });
  const presetRow = h('div.ct-seg.ct-layers__presets');
  const presetButtons = new Map();
  for (const p of presets) {
    const b = h(
      'button.ct-btn',
      {
        type: 'button',
        'aria-pressed': 'false',
        title: p.label,
        onclick: () => onPreset?.(p),
      },
      p.label,
    );
    presetButtons.set(p.id, b);
    presetRow.appendChild(b);
  }
  const listEl = h('div.ct-layers__list');
  const countEl = h('span.ct-head__val');
  const clearBtn = h(
    'button.ct-btn.ct-layers__clear',
    {
      type: 'button',
      title: 'Turn every layer off',
      onclick: () => {
        for (const { key, enabled } of manager.list()) if (enabled) manager.disable(key);
        onManualToggle?.();
      },
    },
    'ALL OFF',
  );
  const el = h(
    'div.ct-layers',
    {},
    h('label.ct-prompt', {}, h('span.ct-prompt__tag', {}, 'LYR'), filter),
    presets.length ? h('div.ct-head', {}, 'PRESETS') : null,
    presets.length ? presetRow : null,
    h('div.ct-head', {}, 'DATA LAYERS', countEl),
    listEl,
    h('div.ct-layers__foot', {}, clearBtn),
  );

  const rows = new Map(); // key -> { row, meta }

  function metaFor(key, enabled, demo) {
    const s = manager.statusOf(key);
    if (s?.state === 'unavailable') return { text: 'N/A', cls: '', title: s.message };
    if (!enabled && s?.state !== 'loading') {
      return { text: 'OFF', cls: '', title: '' };
    }
    if (s?.state === 'loading') return { text: 'LOAD', cls: 'is-load', title: 'Loading' };
    if (s?.state === 'error')
      return { text: 'ERR', cls: 'is-err', title: s.message || 'Feed error' };
    const count = s?.count ?? 0;
    // The feed failed but the proxy still had its last good answer.
    if (s?.stale != null)
      return { text: `STALE ${fmtCount(count)}`, cls: 'is-stale', title: s.note || '' };
    return {
      text: demo ? `DEMO ${fmtCount(count)}` : fmtCount(count),
      cls: demo ? 'is-demo' : '',
      title: s?.note || (demo ? 'Demo data: no verified real feed' : ''),
    };
  }

  function build() {
    listEl.innerHTML = '';
    rows.clear();
    let lastGroup = null;
    for (const { key, label, enabled, demo, group } of manager.list()) {
      if (group && group !== lastGroup) {
        listEl.appendChild(h('div.ct-layers__group', { dataset: { group } }, group));
        lastGroup = group;
      }
      const meta = h('span.ct-row__meta');
      const row = h(
        'button.ct-row.ct-layers__row',
        {
          type: 'button',
          'aria-pressed': String(enabled),
          dataset: { layer: key, group: group || '' },
          onclick: async () => {
            await manager.toggle(key);
            onManualToggle?.();
          },
        },
        h('span.ct-tile', {}, layerTile(key)),
        h('span.ct-row__label', {}, label),
        meta,
      );
      const reload = h('button.ct-layers__reload', {
        type: 'button',
        hidden: true,
        title: `Reload ${label}: fetch it again now`,
        'aria-label': `Reload ${label}`,
        html: RELOAD_SVG,
        onclick: () => reloadLayer(key),
      });
      const item = h('div.ct-layers__item', {}, row, reload);
      rows.set(key, { row, meta, demo, item, reload, busy: null });
      listEl.appendChild(item);
    }
    refresh();
  }

  function reloadLayer(key) {
    const r = rows.get(key);
    if (!r || r.busy) return;
    if (!manager.getLayer?.(key)?.reload?.()) return;
    r.reload.classList.add('is-busy');
    // Cleared by the layer's next settled status, or after 30 s regardless.
    r.busy = setTimeout(() => settle(key), 30_000);
  }

  function settle(key) {
    const r = rows.get(key);
    if (!r?.busy) return;
    clearTimeout(r.busy);
    r.busy = null;
    r.reload.classList.remove('is-busy');
  }

  function refresh() {
    let on = 0;
    for (const { key, enabled } of manager.list()) {
      const r = rows.get(key);
      if (!r) continue;
      if (enabled) on += 1;
      r.row.setAttribute('aria-pressed', String(enabled));
      const m = metaFor(key, enabled, r.demo);
      r.meta.textContent = m.text;
      r.meta.className = `ct-row__meta ${m.cls}`;
      r.row.title = m.title;
      const reloadable = enabled && Boolean(manager.getLayer?.(key)?.reloadable);
      if (r.reload.hidden === reloadable) r.reload.hidden = !reloadable;
      if (!reloadable) settle(key);
    }
    countEl.textContent = `${String(on).padStart(2, '0')}/${String(rows.size).padStart(2, '0')}`;
  }

  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    const groupsShown = new Set();
    for (const [, r] of rows) {
      const match =
        !q ||
        r.row.textContent.toLowerCase().includes(q) ||
        r.row.dataset.group.toLowerCase().includes(q);
      r.item.hidden = !match;
      if (match) groupsShown.add(r.row.dataset.group);
    }
    for (const g of listEl.querySelectorAll('.ct-layers__group'))
      g.hidden = !groupsShown.has(g.dataset.group);
  });

  build();
  manager.subscribe(refresh);
  manager.subscribeStatus((key, s) => {
    // A reload is done once the layer settles (no tiles left to fetch).
    if (s && s.state !== 'loading' && !s.pending) settle(key);
    refresh();
  });

  return {
    el,
    rebuild: build,
    setActivePreset(id) {
      for (const [pid, b] of presetButtons)
        b.setAttribute('aria-pressed', String(pid === id));
    },
  };
}

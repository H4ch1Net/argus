import './layerMenu.css';
import { h } from './dom.js';
import { layerTile } from './layerGlyphs.js';

// The layer menu: a launcher-style list (design/ctos Launcher) of every data
// layer, grouped and filterable, each row a toggle. A row shows the layer's
// own marker in a tile and its name; the raised style (ctosGray left rule)
// means on, and only then does the right side say anything: the contact
// count, LOAD while it fetches, ERR (red) when the feed failed, STALE when
// the proxy could only give its last good answer. Presets sit on top (the
// phone; the desktop has them in the bar).
//
// An enabled layer gets small squares beside its row when it has more to
// offer: RELOAD for data kept a while (fetch it again now), and OPTIONS for
// the layer's own settings (webcam categories, how much surveillance to
// draw...), which open under the row. Options belong to their layer, so they
// show only while it is on.

const fmtCount = (n) => (n >= 10000 ? `${(n / 1000).toFixed(0)}K` : String(n));

// A square loop with an arrowhead: ctOS has no round corners, so neither does
// its reload mark.
const RELOAD_SVG =
  '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M11.5 6.5V11.5H2.5V2.5H9" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7.5 0.5 10.5 2.5 7.5 4.5Z" fill="currentColor"/></svg>';
// Two sliders: the layer's options.
const OPTIONS_SVG =
  '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1 4H13M1 10H13" stroke="currentColor" stroke-width="1.5"/><path d="M8 2H11V6H8ZM3 8H6V12H3Z" fill="currentColor"/></svg>';

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
  const presetRow = h('div.ct-seg.ct-seg--grid.ct-layers__presets', {
    style: { '--cols': '3' },
  });
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
  const countEl = h('span.ct-layers__count');
  const clearBtn = h(
    'button.ct-layers__clear',
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
    h('div.ct-head.ct-layers__head', {}, 'LAYERS', countEl, clearBtn),
    listEl,
  );

  const rows = new Map(); // key -> { row, meta, item, reload, opts, panel, ... }
  const options = new Map(); // key -> the layer's options element
  const openOpts = new Set(); // keys whose options are open

  function metaFor(key, enabled, demo) {
    const s = manager.statusOf(key);
    if (s?.state === 'unavailable') return { text: 'N/A', cls: '', title: s.message };
    if (!enabled && s?.state !== 'loading') return { text: '', cls: '', title: '' };
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

  const square = (cls, label, svg, onclick, extra = {}) =>
    h(`button.ct-layers__sq.${cls}`, {
      type: 'button',
      hidden: true,
      title: label,
      'aria-label': label,
      html: svg,
      onclick,
      ...extra,
    });

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
      const reload = square('ct-layers__reload', `Reload ${label}`, RELOAD_SVG, () =>
        reloadLayer(key),
      );
      const opts = square(
        'ct-layers__optbtn',
        `${label} options`,
        OPTIONS_SVG,
        () => toggleOptions(key),
        { 'aria-expanded': 'false' },
      );
      const panel = h('div.ct-layers__opts', { hidden: true });
      const item = h('div.ct-layers__item', {}, row, opts, reload);
      rows.set(key, { row, meta, demo, item, reload, opts, panel, busy: null });
      listEl.append(item, panel);
    }
    refresh();
  }

  function toggleOptions(key, open = !openOpts.has(key)) {
    const r = rows.get(key);
    const content = options.get(key);
    if (!r || !content) return;
    if (open) {
      openOpts.add(key);
      // One element may serve several layers (the weather history): it
      // moves to whichever is opened.
      if (content.parentElement !== r.panel) r.panel.replaceChildren(content);
    } else {
      openOpts.delete(key);
    }
    r.panel.hidden = !open || !content.isConnected || content.parentElement !== r.panel;
    r.opts.setAttribute('aria-expanded', String(!r.panel.hidden));
    r.opts.classList.toggle('is-on', !r.panel.hidden);
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
      const hasOpts = enabled && options.has(key);
      if (r.opts.hidden === hasOpts) r.opts.hidden = !hasOpts;
      if (!hasOpts && !r.panel.hidden) {
        r.panel.hidden = true;
        r.opts.setAttribute('aria-expanded', 'false');
        r.opts.classList.remove('is-on');
      } else if (hasOpts && openOpts.has(key) && r.panel.hidden) {
        toggleOptions(key, true);
      }
    }
    countEl.textContent = on ? `${String(on).padStart(2, '0')} ON` : '';
    clearBtn.hidden = on === 0;
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
      if (!match) r.panel.hidden = true;
      if (match) groupsShown.add(r.row.dataset.group);
    }
    for (const g of listEl.querySelectorAll('.ct-layers__group'))
      g.hidden = !groupsShown.has(g.dataset.group);
    if (!q) refresh();
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
    /**
     * A layer's own options (an element, or null to remove them), opened
     * from the square beside its row while the layer is on. The same element
     * may be given to several layers.
     */
    setOptions(key, content) {
      if (content) options.set(key, content);
      else options.delete(key);
      refresh();
    },
  };
}

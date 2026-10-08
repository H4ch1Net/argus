import './launcher.css';
import { h } from '../dom.js';
import { glyph } from '../glyphs.js';

// The search launcher (design/ctos Launcher, rofi): a centred panel on the
// translucent ground with a 1px ctosGray border; a prompt "ARGUS" in success,
// the placeholder SEARCH; one-column rows with a 22px icon tile; the selected
// row raised with a ctosGray left border. Opens with "/" or Ctrl+K (or the bar
// segment), arrows move, Enter picks, Escape closes. Results come from the
// global search (contacts in active layers, places, network assets).

const KIND_GLYPH = {
  entity: 'node',
  place: 'frame',
  asset: 'diamond',
  correlate: 'diamond',
  command: 'cross',
};
const KIND_LABEL = {
  entity: 'CONTACT',
  place: 'PLACE',
  asset: 'ASSET',
  correlate: 'CORRELATE',
  command: 'CMD',
};

function tile(kind) {
  const g = glyph(KIND_GLYPH[kind] ?? 'node');
  const c = document.createElement('canvas');
  c.width = g.image.width;
  c.height = g.image.height;
  c.getContext('2d').drawImage(g.image, 0, 0);
  return h('span.ct-tile', {}, c);
}

/**
 * @param {{ onQuery: (q: string) => Promise<object[]>, onSelect: (r: object) => void,
 *   placeholder?: string }} opts
 */
export function createLauncher({ onQuery, onSelect, placeholder = 'SEARCH' }) {
  const input = h('input', {
    type: 'text',
    placeholder,
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Search contacts, places, IPs, domains, ASNs',
  });
  const list = h('div.ct-launcher__list.ct-scroll', { role: 'listbox' });
  const hint = h(
    'div.ct-launcher__hint',
    {},
    'CALLSIGN / SHIP / SATELLITE / PLACE / IP / DOMAIN / AS123   ',
    h('span.ct-muted', {}, '↑↓ ENTER ESC'),
  );
  const panel = h(
    'div.ct-launcher__panel.ct-panel',
    { role: 'dialog', 'aria-label': 'Search' },
    h('label.ct-prompt', {}, h('span.ct-prompt__tag', {}, 'ARGUS'), input),
    list,
    hint,
  );
  const el = h(
    'div.ct-launcher',
    { hidden: true, onpointerdown: (e) => e.target === el && close() },
    panel,
  );

  let results = [];
  let sel = 0;
  let timer = null;
  let seq = 0;

  function render() {
    list.innerHTML = '';
    results.forEach((r, i) => {
      const row = h(
        'button.ct-row',
        {
          type: 'button',
          role: 'option',
          'aria-selected': String(i === sel),
          class: i === sel ? 'is-sel' : '',
          onclick: () => pick(i),
          onpointermove: () => i !== sel && move(i - sel),
        },
        tile(r.kind),
        h('span.ct-row__label', {}, r.label ?? ''),
        h('span.ct-row__meta', {}, r.sub ? String(r.sub) : (KIND_LABEL[r.kind] ?? '')),
      );
      list.appendChild(row);
    });
    list.hidden = results.length === 0;
  }

  function move(d) {
    if (!results.length) return;
    sel = (sel + d + results.length) % results.length;
    render();
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  }

  function pick(i) {
    const r = results[i];
    if (!r) return;
    close();
    onSelect(r);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value;
    if (!q.trim()) {
      results = [];
      render();
      return;
    }
    timer = setTimeout(async () => {
      const mine = ++seq;
      const r = await onQuery(q);
      if (mine !== seq) return; // a newer query is in flight
      results = r || [];
      sel = 0;
      render();
    }, 180);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Enter') pick(sel);
    else if (e.key === 'Escape') {
      close();
      // Closing the launcher is all Escape does here: it must not also
      // release the target or disarm a tool further up.
      e.stopPropagation();
    } else return;
    e.preventDefault();
  });

  function open(prefill = '') {
    el.hidden = false;
    input.value = prefill;
    results = [];
    render();
    requestAnimationFrame(() => input.focus());
  }
  function close() {
    el.hidden = true;
    input.blur();
  }

  // Global shortcuts: "/" and Ctrl/Cmd+K, ignored while typing elsewhere.
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
      e.preventDefault();
      if (el.hidden) open();
      else close();
    }
  });

  return {
    el,
    open,
    close,
    toggle: () => (el.hidden ? open() : close()),
    get isOpen() {
      return !el.hidden;
    },
  };
}

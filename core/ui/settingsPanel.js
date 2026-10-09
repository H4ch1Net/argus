import './settings.css';
import { h } from './dom.js';
import { createChoice, createSwitch } from './controls.js';
import { createSelfIconPicker } from './selfIcons.js';

// SETTINGS: a ctOS dialog over the globe with four pages (PERFORMANCE,
// INTERFACE, DATA, ABOUT), each control writing straight to the settings
// store (core/settings/store.js), which remembers it on this device. What can
// apply live applies live; a quality-tier change offers a reload, since the
// tier shapes how the globe is built. Opens from the bar's SET cell, from
// SETUP, or with the comma key.

const PAGES = [
  { id: 'perf', label: 'PERF' },
  { id: 'ui', label: 'INTERFACE' },
  { id: 'data', label: 'DATA' },
  { id: 'about', label: 'ABOUT' },
];

const opt = (id, label = String(id).toUpperCase()) => ({ id, label });

/**
 * @param {{ settings: object, tier: string, notify?: Function }} deps
 */
export function createSettingsPanel({ settings, tier, notify }) {
  const choice = (key, label, options) =>
    createChoice({
      caption: label,
      options,
      current: settings.get(key),
      onSelect: (id) => settings.set(key, id),
    });
  const toggle = (key, label, title) =>
    createSwitch({
      label,
      title,
      on: settings.get(key),
      onToggle: (on) => settings.set(key, on),
    });
  const note = (text) => h('div.ct-section__note', {}, text);
  const controls = []; // [key, control] for repainting after import/reset

  const keep = (key, control) => {
    controls.push([key, control]);
    return control.el;
  };

  const pages = {
    perf: h(
      'div.ct-settings__page',
      {},
      keep(
        'tier',
        choice('tier', 'Quality', [
          opt('auto', 'Auto'),
          opt('minimal', 'Min'),
          opt('balanced', 'Bal'),
          opt('full', 'Full'),
        ]),
      ),
      note(`Detected tier: ${String(tier).toUpperCase()}. A change reloads the globe.`),
      keep(
        'fps',
        choice('fps', 'Frame rate', [opt('auto', 'Auto'), opt(20), opt(30), opt(60)]),
      ),
      keep(
        'resolution',
        choice('resolution', 'Resolution', [
          opt('auto', 'Auto'),
          opt(1, '1x'),
          opt(1.5, '1.5x'),
          opt(2, '2x'),
          opt(2.5, '2.5x'),
          opt('native', 'Max'),
        ]),
      ),
      keep(
        'detail',
        choice('detail', 'Globe detail', [
          opt('low', 'Low'),
          opt('standard', 'Std'),
          opt('high', 'High'),
        ]),
      ),
      keep(
        'dataSaver',
        toggle(
          'dataSaver',
          'Data saver',
          'Fewer tiles and slower refreshes; heavy layers pause on a metered link',
        ),
      ),
      note(
        "Resolution is rendered pixels per screen point (Max: the panel's own). Lower frame rate and resolution keep a phone cool; detail trades tiles for sharpness.",
      ),
    ),
    ui: h(
      'div.ct-settings__page',
      {},
      keep(
        'units',
        choice('units', 'Units', [
          opt('metric', 'Metric'),
          opt('imperial', 'Imperial'),
          opt('nautical', 'Nautical'),
        ]),
      ),
      keep('clock', choice('clock', 'Clock', [opt('utc', 'UTC'), opt('local', 'Local')])),
      keep(
        'coords',
        choice('coords', 'Coordinates', [
          opt('dec', 'Decimal'),
          opt('dms', 'DMS'),
          opt('mgrs', 'MGRS'),
        ]),
      ),
      keep(
        'uiScale',
        choice('uiScale', 'Interface size', [
          opt(90, '90%'),
          opt(100, '100%'),
          opt(115, '115%'),
          opt(130, '130%'),
        ]),
      ),
      keep(
        'reducedMotion',
        toggle('reducedMotion', 'Reduce motion', 'Stop decorative animation'),
      ),
      keep(
        'startView',
        choice('startView', 'Start in', [
          opt('default', 'Default'),
          opt('last', 'Last view'),
          opt('aroundme', 'Around me'),
        ]),
      ),
      keep(
        'selfIcon',
        createSelfIconPicker({
          current: settings.get('selfIcon'),
          onSelect: (id) => settings.set('selfIcon', id),
        }),
      ),
      note(
        'Your own marker on the map and in the car. GEO centres on you, again to follow.',
      ),
    ),
    data: h(
      'div.ct-settings__page',
      {},
      note(
        'Settings, saved places and scenes live in this browser only. Nothing is uploaded.',
      ),
      h(
        'div.ct-seg',
        {},
        h('button.ct-btn', { type: 'button', onclick: () => exportSettings() }, 'EXPORT'),
        h(
          'button.ct-btn',
          { type: 'button', onclick: () => fileInput.click() },
          'IMPORT',
        ),
        h('button.ct-btn', { type: 'button', onclick: () => reset() }, 'RESET'),
      ),
      h(
        'button.ct-btn',
        {
          type: 'button',
          title: 'Forget settings, saved places and scenes on this device',
          onclick: () => forget(),
        },
        'FORGET THIS DEVICE',
      ),
    ),
    about: h(
      'div.ct-settings__page',
      {},
      h('div.ct-settings__about', {}, 'ARGUS'),
      note(
        'A live globe of public data: flights, ships, satellites, weather, cameras and internet telemetry. Read-only: it maps what is already public and never acts on a target.',
      ),
      note('Data credits: TOOLS > DATA CREDITS. Keys and feed status: SETUP.'),
      note('Based on gods-eye-view (MIT, code only); data keeps its own terms.'),
    ),
  };

  const fileInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    hidden: true,
    onchange: async () => {
      const f = fileInput.files?.[0];
      fileInput.value = '';
      if (!f) return;
      const ok = f.size < 64 * 1024 && settings.import(await f.text());
      notify?.({
        title: ok ? 'SETTINGS IMPORTED' : 'NOT A SETTINGS FILE',
        level: 'low',
      });
      repaint();
    },
  });

  function exportSettings() {
    const blob = new Blob([settings.export()], { type: 'application/json' });
    const a = h('a', {
      href: URL.createObjectURL(blob),
      download: 'argus-settings.json',
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function reset() {
    settings.reset();
    repaint();
    notify?.({ title: 'SETTINGS RESET', level: 'low' });
  }
  function forget() {
    try {
      for (const k of Object.keys(localStorage))
        if (k.startsWith('argus.')) localStorage.removeItem(k);
    } catch {
      // storage blocked: nothing stored either
    }
    settings.reset();
    repaint();
    notify?.({
      title: 'THIS DEVICE FORGOT ARGUS',
      body: 'Settings, places and scenes removed.',
      level: 'low',
    });
  }
  function repaint() {
    for (const [key, c] of controls) (c.paint ?? c.set)?.(settings.get(key));
  }

  // Tabs inside the dialog, the kitty idiom.
  let page = 'perf';
  const tabs = h(
    'div.ct-settings__tabs',
    { role: 'tablist' },
    ...PAGES.map((p) =>
      h(
        'button.ct-settings__tab',
        {
          type: 'button',
          role: 'tab',
          dataset: { page: p.id },
          onclick: () => show(p.id),
        },
        p.label,
      ),
    ),
  );
  const body = h('div.ct-settings__body.ct-scroll', {}, ...Object.values(pages));
  function show(id) {
    page = id;
    for (const b of tabs.children)
      b.setAttribute('aria-selected', String(b.dataset.page === id));
    for (const [k, el] of Object.entries(pages)) el.hidden = k !== id;
  }
  show(page);

  const closeBtn = h('button.ct-btn', { type: 'button', onclick: () => close() }, 'ESC');
  const panel = h(
    'div.ct-settings.ct-panel',
    { role: 'dialog', 'aria-label': 'Settings' },
    h('div.ct-settings__head', {}, h('span.ct-sq'), 'SETTINGS', closeBtn),
    tabs,
    body,
    fileInput,
  );
  const el = h(
    'div.ct-settings__backdrop',
    { hidden: true, onclick: (e) => e.target === el && close() },
    panel,
  );
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  function open(which) {
    if (which && pages[which]) show(which);
    repaint();
    el.hidden = false;
    document.addEventListener('keydown', onKey, true);
    closeBtn.focus();
  }
  function close() {
    el.hidden = true;
    document.removeEventListener('keydown', onKey, true);
  }
  return { el, open, close, toggle: () => (el.hidden ? open() : close()) };
}

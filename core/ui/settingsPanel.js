import './settings.css';
import { h } from './dom.js';
import { createChoice, createSwitch } from './controls.js';
import { createSelfIconPicker } from './selfIcons.js';
import { createIconSettings } from './iconSettings.js';

// SETTINGS: a ctOS dialog over the globe with four pages (GENERAL, QUALITY,
// ICONS, DATA with ABOUT), each control writing straight to the settings
// store (core/settings/store.js), which remembers it on this device. What can
// apply live applies live; a quality-tier change offers a reload, since the
// tier shapes how the globe is built. Opens from the bar's SET cell, from
// SETUP, or with the comma key. Labels only: a control's details are in its
// tooltip, never a paragraph under it.

const PAGES = [
  { id: 'general', label: 'GENERAL' },
  { id: 'quality', label: 'QUALITY' },
  { id: 'icons', label: 'ICONS' },
  { id: 'data', label: 'DATA' },
];
// Earlier page names, for callers that still open them.
const PAGE_ALIAS = { perf: 'quality', ui: 'general', about: 'data' };

const opt = (id, label = String(id).toUpperCase()) => ({ id, label });

/**
 * @param {{ settings: object, tier: string, notify?: Function,
 *   layers?: () => { key: string, label: string, group?: string }[] }} deps
 *   layers: the registered map layers (names and order for ICONS).
 */
export function createSettingsPanel({ settings, tier, notify, layers }) {
  const choice = (key, label, options, columns = options.length) =>
    createChoice({
      caption: label,
      options,
      columns,
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
  // ICONS: size with zoom, one size for all, and per layer (core/ui/iconSettings.js).
  const icons = createIconSettings({ settings, layers });

  const pages = {
    general: h(
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
        'startView',
        choice('startView', 'Start in', [
          opt('last', 'Last view'),
          { id: 'default', label: 'Default', title: 'The default view and layers' },
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
    ),
    quality: h(
      'div.ct-settings__page',
      {},
      keep(
        'tier',
        createChoice({
          caption: `Quality (auto: ${String(tier).toUpperCase()})`,
          label: 'Quality',
          columns: 4,
          options: [
            opt('auto', 'Auto'),
            opt('minimal', 'Min'),
            opt('balanced', 'Bal'),
            opt('full', 'Full'),
          ].map((o) => ({ ...o, title: `${o.label}: a change reloads the globe` })),
          current: settings.get('tier'),
          onSelect: (id) => settings.set('tier', id),
        }),
      ),
      keep(
        'fps',
        choice('fps', 'Frame rate', [opt('auto', 'Auto'), opt(20), opt(30), opt(60)]),
      ),
      keep(
        'resolution',
        choice(
          'resolution',
          'Resolution',
          [
            opt('auto', 'Auto'),
            opt(1, '1x'),
            opt(1.5, '1.5x'),
            opt(2, '2x'),
            opt(2.5, '2.5x'),
            opt('native', 'Max'),
          ].map((o) => ({
            ...o,
            title: 'Rendered pixels per screen point; lower keeps a phone cool',
          })),
          3,
        ),
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
    ),
    icons: h('div.ct-settings__page', {}, icons.el),
    data: h(
      'div.ct-settings__page',
      {},
      note('Settings, places and scenes are saved on this device only.'),
      h(
        'div.ct-seg.ct-seg--grid',
        { style: { '--cols': '3' } },
        h(
          'button.ct-btn',
          {
            type: 'button',
            title: 'Save the settings as a file',
            onclick: () => exportSettings(),
          },
          'EXPORT',
        ),
        h(
          'button.ct-btn',
          {
            type: 'button',
            title: 'Load settings from a file',
            onclick: () => fileInput.click(),
          },
          'IMPORT',
        ),
        h(
          'button.ct-btn',
          {
            type: 'button',
            title: 'Every setting back to its default',
            onclick: () => reset(),
          },
          'RESET',
        ),
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
      h('div.ct-field__label.ct-settings__sub', {}, 'ABOUT'),
      h('div.ct-settings__about', {}, 'ARGUS'),
      note('Public data on a live globe. Read-only: it never acts on a target.'),
      note('Based on gods-eye-view (MIT, code only). Data credits: SETUP.'),
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
    icons.repaint();
  }

  // Tabs inside the dialog, the kitty idiom.
  let page = 'general';
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
    const id = PAGE_ALIAS[which] ?? which;
    if (id && pages[id]) show(id);
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

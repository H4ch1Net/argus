import { h } from './dom.js';
import { createChoice, createSwitch } from './controls.js';
import { glyph } from './glyphs.js';
import { layerTile } from './layerGlyphs.js';
import { inkFor } from './palette.js';
import {
  ICON_LAYERS,
  ICON_SETTINGS_SCHEMA,
  LAYER_SIZES,
  iconLayer,
  isIconKey,
  sizeKey,
  stepSize,
  variantGlyph,
  variantKey,
  variantOf,
  ZOOM,
} from './iconPrefs.js';

// SETTINGS > ICONS (core/ui/settingsPanel.js): how map icons size with zoom,
// one size for all of them, and, under ADVANCED, each layer's own size and
// icon variant with live previews drawn from the same glyphs the map uses
// (core/ui/glyphs.js), tinted with the layer's ink. Every control writes the
// settings store; the scene's icon policy (core/ui/iconPrefs.js) restyles the
// map from there, live.

const PREVIEW_BOX = 44; // CSS px: the row preview's frame
const TILE_PX = 24; // CSS px: a variant tile's art

/** A canvas of a glyph at cssPx, tinted with color unless it is untinted. */
function glyphCanvas(name, color, cssPx) {
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  // The glyph canvas is 16 x density px: enough pixels for this preview.
  const g = glyph(name, Math.max(2, Math.min(4, Math.ceil((cssPx * dpr) / 16))));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(cssPx * dpr));
  c.height = c.width;
  c.style.width = `${cssPx}px`;
  c.style.height = `${cssPx}px`;
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(g.image, 0, 0, c.width, c.height);
  if (!g.untinted) {
    x.globalCompositeOperation = 'multiply';
    x.fillStyle = color;
    x.fillRect(0, 0, c.width, c.height);
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(g.image, 0, 0, c.width, c.height);
  }
  return c;
}

/** What a layer draws now, at cssPx: its variant glyph, or its menu tile. */
function layerPreview(key, variantId, cssPx) {
  const entry = iconLayer(key);
  if (entry?.variants) {
    const name = variantGlyph(variantOf(key, variantId), entry.glyph);
    return glyphCanvas(name, inkFor(key), cssPx);
  }
  if (entry && !['flights', 'military', 'localadsb'].includes(key)) {
    return glyphCanvas(entry.glyph, inkFor(key), cssPx);
  }
  const tile = layerTile(key); // aircraft: the class silhouette, as the menu draws it
  tile.style.width = `${cssPx}px`;
  tile.style.height = `${cssPx}px`;
  return tile;
}

/**
 * @param {{ settings: object, layers?: () => { key: string, label: string, group?: string }[] }} deps
 *   layers: the registered layers (the layer manager's list), for names and order.
 * @returns {{ el: HTMLElement, repaint: () => void }}
 */
export function createIconSettings({ settings, layers }) {
  const scaling = createChoice({
    caption: 'Icon size',
    options: [
      {
        id: 'zoom',
        label: 'Scale with zoom',
        title: 'Icons grow as you zoom in to the street',
      },
      {
        id: 'fixed',
        label: 'Fixed',
        title: 'Icons keep one screen size at every height',
      },
    ],
    current: settings.get('iconScaling'),
    onSelect: (id) => settings.set('iconScaling', id),
  });
  const global = createChoice({
    caption: 'All icons',
    options: ICON_SETTINGS_SCHEMA.iconSize.values.map((v) => ({ id: v, label: `${v}%` })),
    current: settings.get('iconSize'),
    onSelect: (id) => settings.set('iconSize', id),
  });

  // ADVANCED: one row per icon layer the app registered, in menu order.
  const list = h('div.ct-icons__list', { hidden: true });
  const rows = new Map(); // key -> { paint }
  let built = false;
  function build() {
    built = true;
    const known = (layers?.() ?? ICON_LAYERS.map((l) => ({ key: l.key, label: l.key })))
      .filter((l) => iconLayer(l.key))
      .filter((l, i, all) => all.findIndex((o) => o.key === l.key) === i);
    let group = null;
    for (const l of known) {
      if (l.group && l.group !== group) {
        group = l.group;
        list.append(h('div.ct-icons__group', {}, group.toUpperCase()));
      }
      const row = createRow(l.key, l.label || l.key);
      rows.set(l.key, row);
      list.append(row.el);
    }
  }

  function createRow(key, label) {
    const entry = iconLayer(key);
    const preview = h('span.ct-icons__preview', {
      title: 'How this layer draws at its usual map size',
    });
    const value = h('span.ct-icons__value');
    const step = (dir) =>
      settings.set(sizeKey(key), stepSize(settings.get(sizeKey(key)), dir));
    const minus = h(
      'button.ct-btn.ct-icons__step',
      { type: 'button', 'aria-label': `${label}: smaller`, onclick: () => step(-1) },
      '\u2212',
    );
    const plus = h(
      'button.ct-btn.ct-icons__step',
      { type: 'button', 'aria-label': `${label}: larger`, onclick: () => step(1) },
      '+',
    );
    const tiles = new Map();
    const variants = entry.variants
      ? h(
          'div.ct-icons__variants',
          { role: 'radiogroup', 'aria-label': `${label} icon` },
          ...entry.variants.map((v) => {
            const tile = h(
              'button.ct-iconvar',
              {
                type: 'button',
                role: 'radio',
                title: `${label}: ${v.label}`,
                onclick: () => settings.set(variantKey(key), v.id),
              },
              h(
                'span.ct-iconvar__art',
                {},
                glyphCanvas(variantGlyph(v, entry.glyph), inkFor(key), TILE_PX),
              ),
              v.label,
            );
            tiles.set(v.id, tile);
            return tile;
          }),
        )
      : null;
    const el = h(
      'div.ct-icons__row',
      { dataset: { layer: key } },
      preview,
      h('span.ct-icons__name', {}, label),
      h('span.ct-icons__size', {}, minus, value, plus),
      variants,
    );
    let shown = '';
    function paint() {
      const size = settings.get(sizeKey(key));
      const variant = entry.variants ? settings.get(variantKey(key)) : null;
      const total = (settings.get('iconSize') / 100) * (size / 100);
      const px = Math.max(5, Math.min(PREVIEW_BOX, Math.round(entry.px * total)));
      value.textContent = `${size}%`;
      minus.disabled = size <= LAYER_SIZES[0];
      plus.disabled = size >= LAYER_SIZES[LAYER_SIZES.length - 1];
      const sig = `${variant}|${px}`;
      if (sig !== shown) {
        shown = sig;
        preview.replaceChildren(layerPreview(key, variant, px));
      }
      for (const [id, t] of tiles) t.setAttribute('aria-checked', String(id === variant));
    }
    paint();
    return { el, paint };
  }

  const advanced = createSwitch({
    label: 'Per-layer icons',
    title: 'Size and icon style for each layer',
    on: false,
    onToggle: (on) => {
      if (on && !built) build();
      list.hidden = !on;
    },
  });
  const resetBtn = h(
    'button.ct-btn',
    {
      type: 'button',
      title: 'Every icon setting back to its default',
      onclick: () => {
        for (const [k, spec] of Object.entries(ICON_SETTINGS_SCHEMA))
          settings.set(k, spec.def);
      },
    },
    'RESET ICONS',
  );

  function repaint() {
    scaling.paint(settings.get('iconScaling'));
    global.paint(settings.get('iconSize'));
    for (const r of rows.values()) r.paint();
  }
  settings.subscribe?.((key) => {
    if (!isIconKey(key)) return;
    if (key === 'iconScaling') scaling.paint(settings.get(key));
    else if (key === 'iconSize') {
      global.paint(settings.get(key));
      for (const r of rows.values()) r.paint();
    } else {
      const layer = key.slice(key.indexOf('.') + 1);
      rows.get(layer)?.paint();
    }
  });

  const near = Math.round(ZOOM.max * 10) / 10;
  const el = h(
    'div.ct-icons',
    {},
    scaling.el,
    h(
      'div.ct-section__note',
      {},
      `Scale with zoom: icons grow as you come down to the street (up to ${near}x at 100 m) and stay as they were from far away. Fixed: one screen size at every height.`,
    ),
    global.el,
    h('div.ct-icons__bar', {}, advanced.el, resetBtn),
    list,
  );
  return { el, repaint };
}

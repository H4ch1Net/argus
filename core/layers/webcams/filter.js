// Category filter chips in the ctOS style: ALL / NONE, then one toggle chip per
// category (its map glyph and a short label). The chips drive a shared set
// filter (./categories.js); the layer draws only the chosen categories from
// data it already has, so a tap never costs a request. Browser only (DOM and
// canvas); the terminal shell never imports it.
//
// main.js mounts it, e.g. in VIEW:
//   const wf = createWebcamFilter({
//     onChange: () => manager.getLayer('webcams')?.refresh?.(),
//   });
//   view.push(section('WEBCAMS', wf.el));

import { h } from '../../ui/dom.js';
import { glyphTile } from '../../ui/layerGlyphs.js';
import { inkFor } from '../../ui/palette.js';
import { WEBCAM_CATEGORIES, webcamFilter } from './categories.js';
import { CAMERA_KINDS, trafficCamKindFilter } from '../trafficcams/kinds.js';

/**
 * Generic chip filter over a set filter.
 * @param {{ options: ReadonlyArray<{ id: string, label: string, short?: string,
 *   glyph?: string }>, filter: { has: Function, toggle: Function, all: Function,
 *   none: Function, subscribe: Function }, onChange?: (selected: Set<string>) => void,
 *   label?: string, ink?: string }} opts
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function createChipFilter({ options, filter, onChange, label = '', ink }) {
  const chips = new Map();
  const bar = h(
    'div.ct-seg',
    { role: 'group', 'aria-label': label ? `${label}: all or none` : 'All or none' },
    h(
      'button.ct-btn',
      { type: 'button', title: 'Show all', onclick: () => filter.all() },
      'ALL',
    ),
    h(
      'button.ct-btn',
      { type: 'button', title: 'Hide all', onclick: () => filter.none() },
      'NONE',
    ),
  );
  const grid = h('div.ct-seg', { role: 'group', 'aria-label': label });
  for (const o of options) {
    const tile = o.glyph ? glyphTile(o.glyph, ink) : null;
    if (tile) Object.assign(tile.style, { width: '16px', height: '16px', flex: 'none' });
    const chip = h(
      'button.ct-btn',
      {
        type: 'button',
        title: o.label,
        'aria-pressed': String(filter.has(o.id)),
        onclick: () => filter.toggle(o.id),
      },
      tile,
      o.short ?? o.label,
    );
    chips.set(o.id, chip);
    grid.appendChild(chip);
  }
  const paint = () => {
    for (const [id, chip] of chips)
      chip.setAttribute('aria-pressed', String(filter.has(id)));
  };
  const off = filter.subscribe((selected) => {
    paint();
    onChange?.(selected);
  });
  const el = h(
    'div.ct-chipfilter',
    { style: { display: 'grid', gap: '6px' } },
    bar,
    grid,
  );
  return {
    el,
    destroy() {
      off();
      el.remove();
    },
  };
}

/**
 * The webcam category chips, over the filter the layer reads.
 * @param {{ onChange?: (selected: Set<string>) => void, filter?: object, ink?: string }} [opts]
 *   onChange runs after every change (main.js refreshes the layer there)
 */
export function createWebcamFilter({
  onChange,
  filter = webcamFilter,
  ink = inkFor('webcams'),
} = {}) {
  return createChipFilter({
    options: WEBCAM_CATEGORIES,
    filter,
    onChange,
    label: 'Webcam categories',
    ink,
  });
}

/**
 * The traffic camera kind chips (ramp, bridge, tunnel, pass, border, road),
 * over the filter the traffic camera layer reads.
 * @param {{ onChange?: (selected: Set<string>) => void, filter?: object }} [opts]
 */
export function createCameraKindFilter({ onChange, filter = trafficCamKindFilter } = {}) {
  return createChipFilter({
    options: CAMERA_KINDS,
    filter,
    onChange,
    label: 'Traffic camera kinds',
  });
}

import { h } from '../core/ui/dom.js';
import { maneuverSvg } from './maneuvers.js';
import { formatClock, formatDuration, formatStepDistance } from './nav.js';

// The car's two ctOS readouts. Both write the DOM only when what they show has
// changed (a car display repaints the WebGL map under them), and nothing on
// them animates while they rest.
//
// VEHICLE: one small strip under the status strip, parked only: the fuel (or
// an electric car's battery) with a thin meter, and the range. A tap opens the
// rest for a few seconds (the car's name, odometer, average consumption).
// Maneuver banner and ETA strip: the page's own turn-by-turn readout, only
// outside the Android app (in the app, Android Auto draws its routing card).

/** A tapped-open widget folds back after this long. */
export const VEHICLE_OPEN_MS = 6000;

/**
 * The VEHICLE widget. show(chip) / hide() with vehicle.js vehicleChip;
 * toggle() opens or folds it (a tap: hit(x, y) says whether one landed on it).
 */
export function createVehicleWidget() {
  const levelLabel = h('span.car-veh__label', {}, 'FUEL');
  const fill = h('i');
  const meter = h('span.ct-meter.car-veh__meter', {}, fill);
  const levelValue = h('span.car-veh__value', {}, '--');
  const low = h('span.car-veh__low', { hidden: true }, 'LOW');
  const rangeValue = h('span.car-veh__value', {}, '--');
  const title = h('div.car-veh__name', { hidden: true });
  const rows = h('div.car-veh__rows');
  const more = h('div.car-veh__more', { hidden: true }, title, rows);
  const el = h(
    'section.car-veh',
    { hidden: true, 'aria-label': 'Vehicle' },
    h(
      'div.car-veh__main',
      {},
      h('span.car-veh__cell', {}, levelLabel, meter, levelValue, low),
      h('span.car-veh__cell', {}, h('span.car-veh__label', {}, 'RNG'), rangeValue),
    ),
    more,
  );
  let rowsKey = '';
  const cells = new Map(); // detail key -> value node
  let foldTimer = 0;
  let last = null;
  const put = (node, text) => {
    if (node.textContent !== text) node.textContent = text;
  };

  function render(chip) {
    last = chip;
    put(levelLabel, chip.level.label);
    put(levelValue, chip.level.value);
    const w = chip.level.meter === null ? '0%' : `${Math.round(chip.level.meter)}%`;
    if (fill.style.width !== w) fill.style.width = w;
    meter.hidden = chip.level.meter === null;
    low.hidden = !chip.low;
    el.classList.toggle('is-low', chip.low);
    put(rangeValue, chip.range.value);
    put(title, chip.title);
    title.hidden = !chip.title;
    const key = chip.details.map((d) => d.key).join(',');
    if (key !== rowsKey) {
      rowsKey = key;
      cells.clear();
      rows.replaceChildren(
        ...chip.details.map((d) => {
          const value = h('span.car-veh__value', {}, d.value);
          cells.set(d.key, value);
          return h('div.car-veh__row', {}, h('span.car-veh__label', {}, d.label), value);
        }),
      );
    }
    for (const d of chip.details) {
      const node = cells.get(d.key);
      if (node) put(node, d.value);
    }
  }

  function fold() {
    clearTimeout(foldTimer);
    foldTimer = 0;
    more.hidden = true;
    el.classList.remove('is-open');
  }

  const api = {
    el,
    show(chip) {
      render(chip);
      el.hidden = false;
    },
    hide() {
      fold();
      el.hidden = true;
    },
    /** Open (or fold) the details; open folds back by itself. */
    toggle() {
      if (el.hidden) return false;
      if (!more.hidden) {
        fold();
        return true;
      }
      // Nothing more to show than the strip itself.
      if (!last?.title && !last?.details.length) return true;
      more.hidden = false;
      el.classList.add('is-open');
      foldTimer = setTimeout(fold, VEHICLE_OPEN_MS);
      return true;
    },
    /** Whether a tap at (x, y), in CSS pixels, lands on the widget. */
    hit(x, y) {
      if (el.hidden) return false;
      const r = el.getBoundingClientRect();
      const pad = 8; // fingertips at arm's length
      return (
        x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad
      );
    },
    get shown() {
      return !el.hidden;
    },
    get open() {
      return !el.hidden && !more.hidden;
    },
  };
  // In a browser (?shell=car) a real press opens it too.
  el.addEventListener('pointerup', (e) => {
    if (e.isTrusted) api.toggle();
  });
  return api;
}

/**
 * The page's own maneuver banner (browser only): the next maneuver, its
 * distance and road, the one after, and the ETA line under them.
 * update(payload) with nav.js navPayload, or hide().
 */
export function createNavBanner({ units }) {
  const icon = h('div.car-maneuver__icon');
  const dist = h('div.car-maneuver__dist');
  const text = h('div.car-maneuver__text');
  const thenIcon = h('span.car-maneuver__then-icon');
  const thenRow = h(
    'div.car-maneuver__then',
    { hidden: true },
    h('span', {}, 'THEN'),
    thenIcon,
  );
  const eta = h('div.car-maneuver__eta');
  const el = h(
    'section.car-maneuver.ct-panel',
    { hidden: true, role: 'status', 'aria-live': 'polite' },
    icon,
    h('div.car-maneuver__body', {}, dist, text, thenRow),
    eta,
  );
  let iconName = '';
  let thenName = '';
  const put = (node, value) => {
    if (node.textContent !== value) node.textContent = value;
  };

  return {
    el,
    update(p) {
      if (!p || !['navigating', 'rerouting', 'arrived'].includes(p.status)) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      el.classList.toggle('is-rerouting', p.status === 'rerouting');
      const name = p.status === 'arrived' ? 'arrive' : (p.maneuver?.icon ?? 'straight');
      if (name !== iconName) {
        iconName = name;
        icon.innerHTML = maneuverSvg(name, 64);
      }
      if (p.status === 'rerouting') {
        put(dist, 'REROUTING');
        put(text, 'FINDING A NEW ROUTE');
      } else if (p.status === 'arrived') {
        put(dist, 'ARRIVED');
        put(text, String(p.destination?.name ?? '').toUpperCase());
      } else {
        put(dist, formatStepDistance(p.distanceToStepM, units));
        put(text, (p.roadName || p.instruction || '').toUpperCase());
      }
      const next = p.status === 'navigating' ? p.then?.maneuver?.icon : null;
      thenRow.hidden = !next;
      if (next && next !== thenName) {
        thenName = next;
        thenIcon.innerHTML = maneuverSvg(next, 22);
      }
      put(
        eta,
        p.status === 'arrived'
          ? String(p.destination?.detail ?? '').toUpperCase()
          : `ETA ${formatClock(p.eta)}  ${formatStepDistance(p.distanceRemainingM, units)}  ${formatDuration(p.durationRemainingS)}`,
      );
    },
    hide() {
      el.hidden = true;
    },
  };
}

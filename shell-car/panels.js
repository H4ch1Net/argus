import { h } from '../core/ui/dom.js';
import { maneuverSvg } from './maneuvers.js';
import { formatClock, formatDuration, formatStepDistance } from './nav.js';

// The car's two ctOS panels. Both write the DOM only when what they show has
// changed (a car display repaints the WebGL map under them), and both slide
// in and out on a short transform/opacity transition, nothing that animates
// while they rest.
//
// VEHICLE: the car itself (make, model, year, a silhouette for its body,
// fuel, battery, range, odometer, average consumption), shown while parked.
// Maneuver banner and ETA strip: the page's own turn-by-turn readout, only
// outside the Android app (in the app, Android Auto draws its routing card).

// Side views on a 240 x 96 box, facing right: white hairlines, glass in a
// faint fill, wheels with square hubs.
const WHEEL = (x, y, r) =>
  `<circle cx="${x}" cy="${y}" r="${r}"/><rect x="${x - 3}" y="${y - 3}" width="6" height="6" fill="currentColor" stroke="none"/>`;
const BODIES = {
  sedan: {
    body: 'M20,70V58Q21,52 34,50L68,47L92,29Q97,25 106,25H150Q158,25 165,31L186,47L212,51Q221,53 221,61V70H192A14,14 0 0 0 164,70H76A14,14 0 0 0 48,70Z',
    glass: 'M98,31L81,45H124V31ZM130,31V45H176L161,33Q158,31 153,31Z',
    wheels: [
      [62, 70, 11],
      [178, 70, 11],
    ],
  },
  suv: {
    body: 'M20,72V44Q20,38 28,37L60,34L72,20Q75,17 82,17H160Q166,17 170,22L186,36L214,40Q222,42 222,50V72H194A15,15 0 0 0 164,72H78A15,15 0 0 0 48,72Z',
    glass: 'M80,22L70,33H112V22ZM118,22V33H178L168,24Q166,22 162,22Z',
    extra: 'M84,12H156',
    wheels: [
      [63, 72, 12],
      [179, 72, 12],
    ],
  },
  ev: {
    body: 'M20,70V60Q22,52 40,49L76,45L100,27Q106,23 116,23H146Q156,23 164,29L196,48L214,52Q222,55 222,62V70H192A14,14 0 0 0 164,70H76A14,14 0 0 0 48,70Z',
    glass: 'M104,29L87,44H184L161,30Q157,28 150,28Z',
    bolt: 'M125,49L116,60H123L119,68L131,56H124L128,49Z',
    wheels: [
      [62, 70, 11],
      [178, 70, 11],
    ],
  },
};

export function vehicleSvg(variant) {
  const v = BODIES[variant] ?? BODIES.sedan;
  return `<svg viewBox="0 0 240 96" aria-hidden="true">
<path d="M6,84H234" stroke="currentColor" stroke-opacity="0.35" stroke-width="1"/>
<path d="M6,88H40M200,88H234" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="miter">
<path d="${v.glass}" fill="currentColor" fill-opacity="0.12" stroke-width="1.2"/>
<path d="${v.body}"/>${v.extra ? `<path d="${v.extra}" stroke-width="2.4"/>` : ''}
${v.wheels.map(([x, y, r]) => WHEEL(x, y, r)).join('')}
</g>${v.bolt ? `<path d="${v.bolt}" fill="currentColor"/>` : ''}
</svg>`;
}

/** The VEHICLE panel. show(view) / hide(); view from vehicle.js vehicleView. */
export function createVehiclePanel() {
  const art = h('div.car-vehicle__art');
  const title = h('div.car-vehicle__name', {}, 'VEHICLE');
  const low = h('span.ct-tag.car-vehicle__low', { hidden: true }, 'LOW FUEL');
  const grid = h('div.car-vehicle__grid');
  const el = h(
    'section.car-vehicle.ct-frame',
    { hidden: true, 'aria-label': 'Vehicle' },
    h(
      'div.car-vehicle__head',
      {},
      h('span.ct-sq'),
      h('span', {}, 'VEHICLE'),
      low,
      h('span.car-vehicle__state', {}, 'PARKED'),
    ),
    title,
    art,
    grid,
  );
  let variant = '';
  let rowsKey = '';
  let hideTimer = 0;
  const cells = new Map(); // key -> { value, bar }

  function render(view) {
    if (view.variant !== variant) {
      variant = view.variant;
      art.innerHTML = vehicleSvg(variant);
    }
    if (title.textContent !== view.title) title.textContent = view.title;
    low.hidden = !view.lowFuel;
    const key = view.rows.map((r) => r.key).join(',');
    if (key !== rowsKey) {
      rowsKey = key;
      cells.clear();
      grid.replaceChildren(
        ...view.rows.map((r) => {
          const value = h('span.car-stat__value', {}, '--');
          const bar = 'meter' in r ? h('i') : null;
          cells.set(r.key, { value, bar });
          return h(
            `div.car-stat.car-stat--${r.key}`,
            {},
            h('span.car-stat__label', {}, r.label),
            value,
            bar ? h('span.ct-meter.car-stat__meter', {}, bar) : null,
          );
        }),
      );
    }
    for (const r of view.rows) {
      const c = cells.get(r.key);
      if (!c) continue;
      if (c.value.textContent !== r.value) c.value.textContent = r.value;
      if (c.bar) {
        const w = Number.isFinite(r.meter)
          ? `${Math.max(0, Math.min(100, r.meter))}%`
          : '0%';
        if (c.bar.style.width !== w) c.bar.style.width = w;
      }
    }
  }

  return {
    el,
    show(view) {
      render(view);
      clearTimeout(hideTimer);
      if (el.hidden) {
        el.hidden = false;
        // Next frame, so the transition runs from the hidden pose.
        requestAnimationFrame(() => el.classList.add('is-in'));
      }
    },
    update(view) {
      if (!el.hidden) render(view);
    },
    hide() {
      if (el.hidden || !el.classList.contains('is-in')) {
        el.hidden = true;
        return;
      }
      el.classList.remove('is-in');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => (el.hidden = true), 220);
    },
    get shown() {
      return !el.hidden;
    },
  };
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

import { h } from './dom.js';
import { closestApproach, formatTcpa } from '../geo/cpa.js';
import { haversineM } from '../geo/geofence.js';

// COMPARE (master plan 8, "multi-entity compare"): PIN on a target card puts
// it in a tray of up to three, side by side, with live altitude, speed,
// heading and position, the distance between the first pin and each other,
// and their closest approach. Refreshes once a second while anything is
// pinned and the page is visible. Tap a column's name to select it.

const MAX_PINS = 3;

/**
 * @param {{ resolve: (target: object) => ({ normalized: object, metadata: object }|null),
 *   onSelect: (target: object) => void, formatDistance: (m: number) => string,
 *   formatAltitude: (m: number) => string }} deps
 */
export function createCompareTray({ resolve, onSelect, formatDistance, formatAltitude }) {
  const pins = []; // targets
  const grid = h('div.ct-compare__grid');
  const el = h(
    'div.ct-compare.ct-panel',
    { hidden: true, 'aria-label': 'Compare' },
    h(
      'div.ct-compare__head',
      {},
      h('span.ct-sq'),
      'COMPARE',
      h('button.ct-btn', { type: 'button', onclick: () => clear() }, 'CLEAR'),
    ),
    grid,
  );
  let timer = null;

  const fmt = (v, digits = 0, unit = '') =>
    Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : '--';

  function motion(n) {
    const v = n.velocity ?? {};
    const knots = n.type === 'ship';
    return {
      lat: n.position.latitude,
      lon: n.position.longitude,
      alt: n.position.altitude,
      velocity: {
        speed: Number.isFinite(v.speed) ? v.speed * (knots ? 0.514444 : 1) : 0,
        heading: v.heading ?? v.course ?? 0,
      },
    };
  }

  function render() {
    grid.innerHTML = '';
    const recs = pins.map((t) => ({ t, r: resolve(t) })).filter((x) => x.r);
    el.hidden = !recs.length;
    if (!recs.length) return;
    const first = recs[0].r.normalized;
    const rows = [
      ['', () => null],
      ['ALT', (x) => formatAltitude(x.n.position.altitude)],
      [
        'SPD',
        (x) =>
          Number.isFinite(x.n.velocity?.speed)
            ? x.n.type === 'ship'
              ? `${Math.round(x.n.velocity.speed)} KT`
              : `${Math.round(x.n.velocity.speed * 1.943844)} KT`
            : '--',
      ],
      ['HDG', (x) => fmt(x.n.velocity?.heading ?? x.n.velocity?.course, 0, '°')],
      [
        'POS',
        (x) => `${x.n.position.latitude.toFixed(3)} ${x.n.position.longitude.toFixed(3)}`,
      ],
      [
        'RANGE',
        (x, i) =>
          i === 0
            ? 'REF'
            : formatDistance(
                haversineM(
                  first.position.latitude,
                  first.position.longitude,
                  x.n.position.latitude,
                  x.n.position.longitude,
                ),
              ),
      ],
      [
        'CPA',
        (x, i) => {
          if (i === 0) return 'REF';
          const c = closestApproach(motion(first), motion(x.n));
          return c.closing
            ? `${formatDistance(c.cpaM)} ${formatTcpa(c.tcpaS)}`
            : 'OPENING';
        },
      ],
    ];
    grid.style.gridTemplateColumns = `56px repeat(${recs.length}, minmax(0, 1fr))`;
    for (const [label, cell] of rows) {
      grid.appendChild(h('span.ct-compare__k', {}, label));
      recs.forEach(({ t, r }, i) => {
        if (!label) {
          grid.appendChild(
            h(
              'button.ct-compare__name',
              { type: 'button', title: 'Select', onclick: () => onSelect(t) },
              String(r.metadata?.title ?? r.normalized.id).toUpperCase(),
              h(
                'span.ct-compare__x',
                {
                  role: 'button',
                  title: 'Unpin',
                  onclick: (e) => {
                    e.stopPropagation();
                    remove(t);
                  },
                },
                ' ×',
              ),
            ),
          );
        } else
          grid.appendChild(h('span.ct-compare__v', {}, cell({ n: r.normalized }, i)));
      });
    }
  }

  function tick() {
    if (document.hidden) return;
    render();
  }
  function sync() {
    if (pins.length && !timer) timer = setInterval(tick, 1000);
    if (!pins.length && timer) {
      clearInterval(timer);
      timer = null;
    }
    render();
  }
  function add(t) {
    if (pins.includes(t)) return;
    if (pins.length >= MAX_PINS) pins.shift();
    pins.push(t);
    sync();
  }
  function remove(t) {
    const i = pins.indexOf(t);
    if (i >= 0) pins.splice(i, 1);
    sync();
  }
  function clear() {
    pins.length = 0;
    sync();
  }
  return {
    el,
    add,
    remove,
    has: (t) => pins.includes(t),
    toggle: (t) => (pins.includes(t) ? remove(t) : add(t)),
  };
}

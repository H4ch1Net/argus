import { h } from './dom.js';
import { section } from './controls.js';
import { rankLandmarks, landmarkFraming, distanceKm } from '../layers/landmarks/parse.js';
import { categoryLabel, categoryCode } from '../layers/landmarks/format.js';

// LANDMARKS (TOOLS): the landmarks NEARBY the middle of the view, from
// OpenStreetMap (core/layers/landmarks/parse.js), instead of a fixed list of a
// few cities. About a dozen, Wikipedia / Wikidata ones first, each with its
// distance: a row flies there framed for its kind (a tower from below its top,
// a castle from further out), SAVE keeps it in MY PLACES. The list scans when
// the section comes into sight and the view has moved since, or on SCAN; each
// area is fetched once (the tiles are shared with the Landmarks layer).

const LINE = { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' };
const fmtKm = (km) =>
  km < 1 ? `${Math.round(km * 1000)} M` : `${km.toFixed(km < 10 ? 1 : 0)} KM`;

/**
 * @param {{
 *   nearby: (at: { lat: number, lon: number }, radiusKm: number) => Promise<object[]>,
 *   centre: () => ({ lat: number, lon: number })|null,
 *   viewKm?: () => number,
 *   from?: () => ({ lat: number, lon: number })|null,
 *   flyTo: (view: { lon: number, lat: number, height: number, range: number,
 *     pitch: number, heading: number }, n: object) => void,
 *   save: (n: object) => object|null,
 *   notify?: Function,
 *   formatDistance?: (m: number) => string,
 * }} deps
 *   nearby: normalized landmarks around a point (core/layers/landmarks);
 *   centre: the ground point in the middle of the view; viewKm: the view's
 *   width (the scan radius follows it); from: the camera's ground point (the
 *   flight's heading); save: add to MY PLACES, returns the place or null
 */
export function createPoiTool({
  nearby,
  centre,
  viewKm = () => 8,
  from = () => null,
  flyTo,
  save,
  notify = () => {},
  formatDistance,
}) {
  const summary = h('div.ct-tool__summary');
  const list = h('div.ct-tool__steps.ct-scroll', { style: { maxHeight: '300px' } });
  let scanning = false;
  let lastAt = null; // where the list was last scanned
  let lastRadius = 0;
  let flown = null;
  let rows = [];

  const dist = (km) => (formatDistance ? formatDistance(km * 1000) : fmtKm(km));

  function render() {
    list.innerHTML = '';
    for (const { n, km } of rows) {
      const name = n.meta.name;
      const row = h(
        'button.ct-row',
        {
          type: 'button',
          title: `Fly to ${name}`,
          'aria-pressed': String(flown === n.id),
          onclick: () => {
            flown = n.id;
            flyTo(landmarkFraming(n, from()), n);
            render();
          },
        },
        // Two lines: the name (a diamond when it is on Wikipedia), then its
        // kind and distance, so long names keep their room.
        h(
          'span.ct-row__label',
          {},
          h(
            'span',
            { style: LINE },
            `${n.meta.notable ? '◆ ' : ''}${name.toUpperCase()}`,
          ),
          h(
            'span.ct-row__meta',
            { style: LINE },
            `${categoryCode(n.meta.category)} · ${dist(km)}`,
          ),
        ),
      );
      const keep = h(
        'button.ct-btn',
        {
          type: 'button',
          title: `Save ${name} to MY PLACES`,
          onclick: () => {
            const p = save(n);
            notify({
              title: p ? `SAVED ${String(p.name).toUpperCase()}` : 'PLACE LIST FULL',
              level: 'low',
            });
          },
        },
        'SAVE',
      );
      list.appendChild(
        h(
          'div.ct-nearby__row',
          {
            title: categoryLabel(n.meta.category),
            style: {
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto',
              gap: '4px',
            },
          },
          row,
          keep,
        ),
      );
    }
  }

  async function scan() {
    const at = centre();
    if (!at) {
      summary.textContent = 'AIM AT THE GROUND TO SCAN';
      return;
    }
    if (scanning) return;
    scanning = true;
    // Search about half the view across, between 2 and 8 km.
    const radius = Math.max(2, Math.min(8, (viewKm() || 8) / 2));
    summary.textContent = 'SCANNING OSM...';
    try {
      const items = await nearby(at, radius);
      rows = rankLandmarks(items, at, { limit: 12, maxKm: radius * 1.25 });
      lastAt = at;
      lastRadius = radius;
      summary.textContent = rows.length
        ? `NEARBY  ${String(rows.length).padStart(2, '0')} WITHIN ${dist(radius * 1.25)}`
        : 'NO NAMED LANDMARKS NEAR THE VIEW';
      render();
    } catch (err) {
      // No popup for a network failure: the summary line says it.
      console.warn('[argus] nearby landmarks:', err?.message || err);
      summary.textContent = 'OSM UNREACHABLE: TRY SCAN AGAIN';
    } finally {
      scanning = false;
    }
  }

  /** Scan again when the view has moved a fair way since the last list. */
  function maybeScan() {
    const at = centre();
    if (!at) return;
    if (lastAt && distanceKm(at, lastAt) < Math.max(0.5, lastRadius * 0.35)) return;
    scan();
  }

  const scanBtn = h(
    'button.ct-btn',
    {
      type: 'button',
      title: 'List the landmarks around the middle of the view',
      onclick: () => scan(),
    },
    'SCAN VIEW',
  );
  const el = section(
    'LANDMARKS',
    summary,
    h('div.ct-seg', {}, scanBtn),
    list,
    h(
      'div.ct-section__note',
      {},
      'Named landmarks from OpenStreetMap around the middle of the view, Wikipedia-linked first. Each area is fetched once.',
    ),
  );
  // Scan when the section comes into sight (its tab opened, scrolled to).
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) maybeScan();
    }).observe(el);
  }
  summary.textContent = 'OPEN TO SCAN THE VIEW';
  return { el, scan, maybeScan };
}

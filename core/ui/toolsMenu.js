import { h } from './dom.js';
import { section, createChoice } from './controls.js';

// The TOOLS tab: draw and measure, recent imagery, share link, data credits
// (the ROUTE section is the navigation panel's, core/ui/navPanel.js). Tools
// that need a point on the map "arm" the next tap (deps.armTap): while armed,
// a tap on the globe goes to the tool instead of selecting a contact. Pure UI
// plus calls into the pure modules; drawing on the globe goes through
// core/scene/sketch.js.

const note = (text) => h('div.ct-section__note', {}, text);
const btn = (label, onclick, title = label) =>
  h('button.ct-btn', { type: 'button', title, onclick }, label);

/**
 * Draw and measure: an area, a line or a pin by tapping vertices; the live
 * measure shows as you go; DONE keeps the shape, CLEAR removes them all.
 * @param {{ sketch: object, armTap: Function, disarm: Function }} deps
 */
export function createDrawTool({ sketch, armTap, disarm }) {
  let shape = 'line';
  let session = null;
  let geo = null;
  let count = 0;
  const measure = h('div.ct-tool__summary', {}, '');
  const saved = h('div.ct-tool__steps');

  async function start() {
    geo ??= await import('../draw/geometry.js');
    session = geo.createDrawSession(shape);
    measure.textContent = 'TAP TO ADD POINTS';
    armTap(
      (p) => {
        geo.addVertex(session, { lon: p.lon, lat: p.lat });
        redraw();
        if (shape === 'pin') done();
      },
      `TAP THE MAP: ${shape.toUpperCase()} (DONE TO FINISH)`,
      { repeat: shape !== 'pin' },
    );
  }

  function redraw() {
    sketch.clear('draft');
    if (!session) return;
    const coords = session.vertices.map((v) => [v.lon, v.lat]);
    for (const c of coords) sketch.marker('draft', c);
    if (shape === 'area' && coords.length >= 3) sketch.area('draft', coords);
    else if (coords.length >= 2) sketch.line('draft', coords, { dashed: true, width: 2 });
    measure.textContent = geo.formatMeasure(session) || '';
  }

  function done() {
    disarm();
    if (!session) return;
    const result = geo.finishShape(session, { label: '' });
    sketch.clear('draft');
    if (result) {
      count += 1;
      const name = `shape-${count}`;
      const coords = session.vertices.map((v) => [v.lon, v.lat]);
      if (result.shape === 'area') sketch.area(name, coords);
      else if (result.shape === 'line') sketch.line(name, coords, { width: 2 });
      sketch.marker(
        name,
        [result.centroid.lon ?? coords[0][0], result.centroid.lat ?? coords[0][1]],
        result.measure,
      );
      saved.appendChild(
        h(
          'div.ct-tool__step',
          {},
          h('span.ct-muted', {}, String(count).padStart(2, '0')),
          h('span', {}, result.measure),
        ),
      );
    }
    measure.textContent = result ? result.measure : 'NOT ENOUGH POINTS';
    session = null;
  }

  function undo() {
    if (!session) return;
    geo.removeLastVertex(session);
    redraw();
  }

  function clearAll() {
    disarm();
    session = null;
    for (let i = 1; i <= count; i += 1) sketch.clear(`shape-${i}`);
    sketch.clear('draft');
    saved.innerHTML = '';
    measure.textContent = '';
    count = 0;
  }

  const el = section(
    'DRAW + MEASURE',
    createChoice({
      label: 'Shape',
      options: [
        { id: 'line', label: 'Line' },
        { id: 'area', label: 'Area' },
        { id: 'pin', label: 'Pin' },
      ],
      current: shape,
      onSelect: (id) => {
        shape = id;
      },
    }).el,
    h(
      'div.ct-seg',
      {},
      btn('START', start),
      btn('UNDO', undo),
      btn('DONE', done),
      btn('CLEAR', clearAll),
    ),
    measure,
    saved,
  );
  return { el, clear: clearAll };
}

/**
 * Recent imagery: tap a spot, see the last 30 days of NASA HLS / VIIRS
 * passes over a 10 km box, pick a day to show it on the globe.
 * @param {{ catalogue: object|null, armTap: Function, manager: object, notify: Function }} deps
 */
export function createImageryTool({ catalogue, armTap, manager, notify }) {
  const list = h('div.ct-tool__steps.ct-scroll');
  const status = h('div.ct-tool__summary');
  if (!catalogue) {
    return {
      el: section('RECENT IMAGERY', note('Needs the live proxy (NASA CMR / GIBS).')),
    };
  }
  async function pick() {
    armTap(async (p) => {
      const m = await import('../layers/imagery/catalog.js');
      const box = m.boxFromPin(p.lon, p.lat);
      status.textContent = 'SEARCHING...';
      list.innerHTML = '';
      try {
        const r = await catalogue.search(box);
        status.textContent = `${r.candidates.length} PASSES${r.truncated ? ' (NEWEST ONLY)' : ''}`;
        for (const c of r.candidates.slice(0, 40)) {
          list.appendChild(
            h(
              'button.ct-row',
              {
                type: 'button',
                onclick: async () => {
                  catalogue.select(c);
                  if (!manager.isEnabled('imagery')) await manager.enable('imagery');
                  for (const row of list.children)
                    row.classList.toggle(
                      'is-sel',
                      row.dataset.key === `${c.product}:${c.day}`,
                    );
                },
                dataset: { key: `${c.product}:${c.day}` },
              },
              h('span.ct-row__label', {}, m.formatCandidate(c).toUpperCase()),
            ),
          );
        }
      } catch (err) {
        status.textContent = '';
        notify({
          title: 'IMAGERY SEARCH FAILED',
          body: String(err?.message || err),
          level: 'low',
        });
      }
    }, 'TAP THE MAP: IMAGERY AREA');
  }
  const el = section(
    'RECENT IMAGERY',
    note(
      'Last 30 days of Sentinel-2 / Landsat (HLS) and VIIRS over a 10 km box. NASA GIBS.',
    ),
    h(
      'div.ct-seg',
      {},
      btn('PICK AREA', pick),
      btn('CLEAR', () => {
        catalogue.clear();
        list.innerHTML = '';
        status.textContent = '';
      }),
    ),
    status,
    list,
  );
  return { el };
}

/**
 * Share: copy (or share, on a phone) a link that reopens this view: camera,
 * layers, sensor, basemap, labels and the selected target.
 * @param {{ encode: () => string, notify: Function }} deps
 */
export function createShareTool({ encode, notify }) {
  async function share() {
    const hash = encode();
    history.replaceState(null, '', hash);
    const url = location.href;
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ title: 'Argus view', url });
        return;
      }
      await navigator.clipboard.writeText(url);
      notify({
        title: 'LINK COPIED',
        body: 'This view is in the clipboard.',
        level: 'low',
        key: 'share',
      });
    } catch {
      notify({
        title: 'LINK READY',
        body: 'The address bar now holds a link to this view.',
        level: 'low',
        key: 'share',
      });
    }
  }
  return {
    el: section(
      'SHARE',
      note('A link to this exact view. Nothing leaves the device.'),
      btn('COPY LINK', share),
    ),
  };
}

/**
 * Data credits: who supplies each active layer, with terms and links.
 * @param {{ activeKeys: () => string[], manager: object }} deps
 */
export function createCreditsView({ activeKeys, manager }) {
  const body = h('div.ct-credits');
  async function render() {
    const { creditsByLayer } = await import('../credits.js');
    body.innerHTML = '';
    const keys = [
      ...activeKeys(),
      'basemap',
      'labels',
      'terrain',
      'search',
      'directions',
    ];
    for (const g of creditsByLayer(keys)) {
      const label =
        manager.list().find((l) => l.key === g.layer)?.label ?? g.label ?? g.layer;
      body.appendChild(h('div.ct-credits__group', {}, String(label).toUpperCase()));
      for (const c of g.credits) {
        body.appendChild(
          h(
            'div.ct-credits__row',
            {},
            c.url
              ? h(
                  'a',
                  { href: c.url, target: '_blank', rel: 'noopener noreferrer' },
                  c.name,
                )
              : h('span', {}, c.name),
            h('span.ct-muted', {}, ` ${c.terms}`),
          ),
        );
      }
    }
  }
  manager.subscribe(render);
  render();
  return { el: section('DATA CREDITS', body) };
}

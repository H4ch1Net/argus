import { h } from './dom.js';
import { section, createChoice } from './controls.js';
import { CITY_POIS, poiView } from '../search/pois.js';

// LANDMARKS, a TOOLS-menu section: pick a city, then one of its public
// landmarks to fly to its hand-tuned view (core/search/pois.js, adapted from
// gods-eye-view). Pure UI: flying is the caller's flyTo.

// Short city codes for the segmented choice (nine full names would not fit).
const CODE = {
  austin: 'AUS',
  sf: 'SF',
  nyc: 'NYC',
  tokyo: 'TYO',
  london: 'LDN',
  paris: 'PAR',
  dubai: 'DXB',
  dc: 'DC',
  tallinn: 'TLL',
};
const fmtHdg = (d) => `${String(Math.round(d) % 360).padStart(3, '0')}°`;

/**
 * @param {{ flyTo: (view: { lon: number, lat: number, alt: number, heading: number,
 *   pitch: number, targetM: number, groundM: number, name: string }) => void,
 *   city?: string }} deps
 *   flyTo: alt is the viewing RANGE in metres from the landmark (default 1500),
 *   heading and pitch in degrees (pitch default -35, negative looks down),
 *   targetM the landmark's centre above the ground, groundM the city's fallback
 *   ground height; city: the id to open on (default the first)
 */
export function createPoiTool({ flyTo, city: initial } = {}) {
  let city = CITY_POIS.find((c) => c.id === initial) ?? CITY_POIS[0];
  let flown = null; // `${cityId}:${name}` of the landmark last flown to
  const summary = h('div.ct-tool__summary');
  const list = h('div.ct-tool__steps');

  function go(poi) {
    flown = `${city.id}:${poi.name}`;
    flyTo({ ...poiView(poi), groundM: city.groundM, name: poi.name });
    for (const row of list.children)
      row.setAttribute('aria-pressed', String(row.dataset.key === flown));
  }

  function render() {
    summary.textContent = `${city.city.toUpperCase()}  ${String(city.pois.length).padStart(2, '0')} LANDMARKS`;
    list.innerHTML = '';
    for (const poi of city.pois) {
      const key = `${city.id}:${poi.name}`;
      list.appendChild(
        h(
          'button.ct-row',
          {
            type: 'button',
            title: `Fly to ${poi.name}`,
            'aria-pressed': String(key === flown),
            dataset: { key },
            onclick: () => go(poi),
          },
          h('span.ct-row__label', {}, poi.name.toUpperCase()),
          h('span.ct-row__meta', {}, `HDG ${fmtHdg(poi.heading)}`),
        ),
      );
    }
  }

  const choice = createChoice({
    label: 'City',
    options: CITY_POIS.map((c) => ({
      id: c.id,
      label: CODE[c.id] ?? c.id.toUpperCase(),
      title: c.city,
    })),
    current: city.id,
    onSelect: (id) => {
      city = CITY_POIS.find((c) => c.id === id) ?? city;
      render();
      return city.id;
    },
  });
  render();

  const el = section(
    'LANDMARKS',
    choice.el,
    summary,
    list,
    h(
      'div.ct-section__note',
      {},
      'Public landmarks with hand-tuned views, adapted from gods-eye-view (MIT).',
    ),
  );
  return { el };
}

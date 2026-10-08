import './scenesTool.css';
import { h } from './dom.js';
import { section, createChoice } from './controls.js';

// WATCH AREAS (TOOLS): circles on the map that raise a notice when a moving
// contact (aircraft, ship, vehicle) enters or leaves one, the master plan's
// proximity alerts. Place one round the middle of the view or a tapped point,
// at a chosen radius; each row shows how many contacts are inside, flies
// there, or removes it. Checked every five seconds while any area exists and
// the page is visible; areas last for this session.

const RADII = [
  { id: 1000, label: '1 KM' },
  { id: 5000, label: '5 KM' },
  { id: 25000, label: '25 KM' },
  { id: 100000, label: '100 KM' },
];

/**
 * @param {{ fences: object, sketch: object, centre: () => object|null,
 *   pick: (fn: (ll: object) => void) => void, flyTo: (a: object) => void,
 *   notify: Function }} deps
 */
export function createWatchTool({ fences, sketch, centre, pick, flyTo, notify }) {
  let radiusM = 5000;
  const nameInput = h('input.ct-scenes__input', {
    type: 'text',
    maxlength: '40',
    placeholder: 'optional',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Area name',
  });
  const list = h('div.ct-tool__steps');
  const summary = h('div.ct-tool__summary');

  function addAt(ll) {
    if (!ll) {
      notify({ title: 'NO GROUND THERE', level: 'low' });
      return;
    }
    const id = fences.add({
      name: nameInput.value.trim() || `AREA ${fences.size + 1}`,
      lat: ll.lat,
      lon: ll.lon,
      radiusM,
    });
    if (!id) return;
    nameInput.value = '';
    sketch.circle(`watch-${id}`, [ll.lon, ll.lat], radiusM);
    render();
  }

  function render() {
    const areas = fences.list();
    summary.textContent = areas.length
      ? `${String(areas.length).padStart(2, '0')} AREAS WATCHED`
      : 'NO AREAS';
    list.innerHTML = '';
    for (const a of areas) {
      list.appendChild(
        h(
          'div.ct-places__row',
          {},
          h(
            'button.ct-row',
            { type: 'button', title: `Fly to ${a.name}`, onclick: () => flyTo(a) },
            h('span.ct-row__label', {}, a.name.toUpperCase()),
            h(
              'span.ct-row__meta',
              {},
              `${String(a.count).padStart(2, '0')} IN  ${Math.round(a.radiusM / 100) / 10}KM`,
            ),
          ),
          h(
            'button.ct-btn',
            {
              type: 'button',
              title: `Stop watching ${a.name}`,
              onclick: () => {
                fences.remove(a.id);
                sketch.clear(`watch-${a.id}`);
                render();
              },
            },
            'X',
          ),
        ),
      );
    }
  }
  render();

  const el = section(
    'WATCH AREAS',
    h(
      'div.ct-section__note',
      {},
      'A notice when a moving contact enters or leaves a circle. This session only.',
    ),
    createChoice({
      caption: 'Radius',
      options: RADII,
      current: radiusM,
      onSelect: (id) => (radiusM = id),
    }).el,
    h('label.ct-scenes__field', {}, h('span.ct-scenes__label', {}, 'AREA'), nameInput),
    h(
      'div.ct-seg',
      {},
      h(
        'button.ct-btn',
        { type: 'button', onclick: () => addAt(centre()) },
        'WATCH VIEW CENTRE',
      ),
      h(
        'button.ct-btn',
        { type: 'button', onclick: () => pick((ll) => addAt(ll)) },
        'PICK ON MAP',
      ),
    ),
    summary,
    list,
  );
  return { el, render };
}

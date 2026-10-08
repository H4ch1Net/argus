import './scenesTool.css';
import { h } from './dom.js';
import { section, createChoice } from './controls.js';

// MY PLACES (TOOLS): the user's own locations and landmarks. SAVE VIEW keeps
// the place in the middle of the view with the camera that framed it; PICK ON
// MAP keeps a point you tap. Each row flies there, renames or deletes; the
// list exports and imports as JSON. Kept on this device only.

const KINDS = [
  { id: 'place', label: 'Place' },
  { id: 'landmark', label: 'Landmark' },
  { id: 'home', label: 'Home' },
  { id: 'work', label: 'Work' },
  { id: 'watch', label: 'Watch' },
];

/**
 * @param {{ store: object, centre: () => ({ lat: number, lon: number }|null),
 *   view: () => object, flyTo: (place: object) => void,
 *   pick: (onPoint: (ll: { lat: number, lon: number }) => void) => void,
 *   notify: Function, onChange?: () => void }} deps
 */
export function createPlacesTool({ store, centre, view, flyTo, pick, notify, onChange }) {
  let kind = 'place';
  const nameInput = h('input.ct-scenes__input', {
    type: 'text',
    maxlength: '60',
    placeholder: 'optional',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Place name',
  });
  const list = h('div.ct-tool__steps.ct-scroll');
  const summary = h('div.ct-tool__summary');
  const file = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    hidden: true,
    onchange: async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      const n = f.size < 512 * 1024 ? store.import(await f.text()) : 0;
      notify({
        title: n ? `${n} PLACES IMPORTED` : 'NO NEW PLACES IN THAT FILE',
        level: 'low',
      });
    },
  });

  const nameOr = (fallback) => nameInput.value.trim() || fallback;
  function save(ll, withView) {
    if (!ll) {
      notify({
        title: 'NO GROUND THERE',
        body: 'Aim at the globe, not the sky.',
        level: 'low',
      });
      return;
    }
    const p = store.add({
      name: nameOr(`${kind.toUpperCase()} ${ll.lat.toFixed(3)} ${ll.lon.toFixed(3)}`),
      lat: ll.lat,
      lon: ll.lon,
      kind,
      view: withView ? view() : undefined,
    });
    nameInput.value = '';
    notify({
      title: p ? `SAVED ${p.name.toUpperCase()}` : 'PLACE LIST FULL',
      level: 'low',
    });
  }

  function render() {
    const places = store.list();
    summary.textContent = `${String(places.length).padStart(2, '0')} SAVED ON THIS DEVICE`;
    list.innerHTML = '';
    for (const p of places) {
      const del = h(
        'button.ct-btn',
        { type: 'button', title: `Delete ${p.name}`, onclick: () => store.remove(p.id) },
        'X',
      );
      const ren = h(
        'button.ct-btn',
        {
          type: 'button',
          title: 'Rename',
          onclick: () => {
            const next = window.prompt('Name', p.name);
            if (next != null) store.update(p.id, { name: next });
          },
        },
        'REN',
      );
      list.appendChild(
        h(
          'div.ct-places__row',
          {},
          h(
            'button.ct-row',
            { type: 'button', title: `Fly to ${p.name}`, onclick: () => flyTo(p) },
            h('span.ct-row__label', {}, p.name.toUpperCase()),
            h('span.ct-row__meta', {}, p.kind.toUpperCase()),
          ),
          ren,
          del,
        ),
      );
    }
    if (!places.length)
      list.appendChild(h('div.ct-section__note', {}, 'Nothing saved yet.'));
  }

  store.subscribe(() => {
    render();
    onChange?.();
  });
  render();

  const el = section(
    'MY PLACES',
    h(
      'div.ct-section__note',
      {},
      'Your own places and landmarks, on this device only. They show on the map with the My places layer and in search.',
    ),
    createChoice({
      caption: 'Kind',
      options: KINDS,
      current: kind,
      onSelect: (id) => (kind = id),
    }).el,
    h('label.ct-scenes__field', {}, h('span.ct-scenes__label', {}, 'NAME'), nameInput),
    h(
      'div.ct-seg',
      {},
      h(
        'button.ct-btn',
        {
          type: 'button',
          title: 'Save the place in the middle of the view',
          onclick: () => save(centre(), true),
        },
        'SAVE VIEW',
      ),
      h(
        'button.ct-btn',
        {
          type: 'button',
          title: 'Tap a point on the globe to save it',
          onclick: () => pick((ll) => save(ll, false)),
        },
        'PICK ON MAP',
      ),
    ),
    summary,
    list,
    h(
      'div.ct-seg',
      {},
      h(
        'button.ct-btn',
        {
          type: 'button',
          onclick: () => {
            const blob = new Blob([store.export()], { type: 'application/json' });
            const a = h('a', {
              href: URL.createObjectURL(blob),
              download: 'argus-places.json',
            });
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          },
        },
        'EXPORT',
      ),
      h('button.ct-btn', { type: 'button', onclick: () => file.click() }, 'IMPORT'),
    ),
    file,
  );
  return { el };
}

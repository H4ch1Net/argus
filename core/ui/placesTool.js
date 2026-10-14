import './scenesTool.css';
import './navPanel.css';
import { h } from './dom.js';
import { section } from './controls.js';

// MY PLACES (TOOLS): the user's saved places, the same list as WHERE TO's
// HOME / WORK / SAVED and WHAT'S HERE > SAVE (core/places/saved.js). SAVE
// VIEW keeps the place in the middle of the view with the camera that framed
// it; PICK ON MAP keeps a point you tap. Each row flies there; HOME / WORK,
// rename (in place) and delete beside it; the list exports and imports as
// JSON. Kept on this device only.

/**
 * @param {{ store: object, centre: () => ({ lat: number, lon: number }|null),
 *   view: () => object, flyTo: (place: object) => void,
 *   pick: (onPoint: (ll: { lat: number, lon: number }) => void) => void,
 *   notify: Function, onChange?: () => void }} deps
 */
export function createPlacesTool({ store, centre, view, flyTo, pick, notify, onChange }) {
  const nameInput = h('input.ct-scenes__input', {
    type: 'text',
    maxlength: '60',
    placeholder: 'NAME (OPTIONAL)',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Place name',
  });
  const list = h('div.ct-tool__steps.ct-scroll');
  const summary = h('div.ct-tool__summary');
  let renaming = null;
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

  function save(ll, withView) {
    if (!ll) {
      notify({ title: 'NO GROUND THERE', level: 'low' });
      return;
    }
    const p = store.add({
      name: nameInput.value.trim() || `PLACE ${ll.lat.toFixed(4)} ${ll.lon.toFixed(4)}`,
      lat: ll.lat,
      lon: ll.lon,
      kind: 'place',
      view: withView ? view() : undefined,
    });
    nameInput.value = '';
    notify({
      title: p ? `SAVED ${p.name.toUpperCase()}` : 'PLACE LIST FULL',
      level: 'low',
    });
  }

  const small = (label, title, onclick, pressed = null) =>
    h(
      'button.ct-btn.ct-nav__ed',
      {
        type: 'button',
        title,
        'aria-pressed': pressed === null ? null : String(pressed),
        onclick,
      },
      label,
    );

  function renameField(p) {
    const field = h('input.ct-nav__rename', {
      type: 'text',
      value: p.name,
      maxlength: '60',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': 'Name',
    });
    let done = false;
    const commit = (keep) => {
      if (done) return;
      done = true;
      const v = field.value.trim();
      renaming = null;
      if (keep && v && v !== p.name) store.update(p.id, { name: v });
      else render();
    };
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commit(true);
      else if (e.key === 'Escape') commit(false);
    });
    field.addEventListener('blur', () => commit(true));
    setTimeout(() => {
      field.focus();
      field.select?.();
    }, 0);
    return h('div.ct-places__row.ct-nav__item--edit', {}, field);
  }

  function render() {
    const places = store.list();
    summary.textContent = `${String(places.length).padStart(2, '0')} SAVED ON THIS DEVICE`;
    list.innerHTML = '';
    // HOME and WORK first, then the rest as saved (newest first).
    const order = [
      ...places.filter((p) => p.kind === 'home'),
      ...places.filter((p) => p.kind === 'work'),
      ...places.filter((p) => p.kind !== 'home' && p.kind !== 'work'),
    ];
    for (const p of order) {
      if (renaming === p.id) {
        list.appendChild(renameField(p));
        continue;
      }
      const role = (kind, label) =>
        small(
          label,
          `Set as ${label}`,
          () => store.setRole(p.id, p.kind === kind ? null : kind),
          p.kind === kind,
        );
      list.appendChild(
        h(
          'div.ct-places__row.ct-places__row--roles',
          {},
          h(
            'button.ct-row',
            { type: 'button', title: `Fly to ${p.name}`, onclick: () => flyTo(p) },
            h('span.ct-row__label', {}, p.name.toUpperCase()),
          ),
          role('home', 'HOME'),
          role('work', 'WORK'),
          small('REN', 'Rename', () => {
            renaming = p.id;
            render();
          }),
          small('×', `Delete ${p.name}`, () => store.remove(p.id)),
        ),
      );
    }
    if (!places.length)
      list.appendChild(
        h(
          'div.ct-section__note',
          {},
          'Nothing saved yet. Long press the map, or ◇ in WHERE TO.',
        ),
      );
  }

  store.subscribe(() => {
    render();
    onChange?.();
  });
  render();

  const el = section(
    'MY PLACES',
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
          title: 'Save the list as a file (to move it to another device)',
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
      h(
        'button.ct-btn',
        {
          type: 'button',
          title: 'Add places from an exported file',
          onclick: () => file.click(),
        },
        'IMPORT',
      ),
    ),
    file,
  );
  return { el };
}

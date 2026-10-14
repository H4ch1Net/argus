import './navPanel.css';
import { h } from './dom.js';
import { glyph } from './glyphs.js';
import { section, createChoice, createSwitch } from './controls.js';
import { maneuverCanvas } from './navGlyphs.js';
import { maneuverLabel } from '../nav/maneuvers.js';
import {
  formatNavDistance,
  formatNavDuration,
  formatClock,
  formatDelay,
  routeFacts,
} from '../nav/format.js';
import { createDriveSim } from '../nav/simulate.js';
import { haversineM } from '../nav/geo.js';
import { savedShortlist } from '../nav/search.js';
import { greatCircleM, initialBearingDeg } from '../draw/geometry.js';

// Navigation UI for the desktop and phone shells, ctOS style (the car has its
// own, shell-car). Everything drives one navigator (core/nav/navigator.js):
//
//   WHERE TO   a search bar always at hand (desktop: top centre; phone: under
//              the bar). Before typing: HOME, WORK, SAVED (EDIT renames, sets
//              HOME / WORK, deletes), RECENT, then pick on the map. Typing:
//              results as launcher rows, each with a one-tap save (◇, ◆ when
//              saved). A result, WHAT'S HERE > ROUTE HERE, or ROUTE HERE on
//              any target card sets the destination.
//   WHAT'S HERE a long press or right click on the map: the point's name and
//              coordinates; SAVE, ROUTE HERE, FROM HERE, COPY, SHARE, MEASURE.
//   PREVIEW    the destination (◇ saves it), DRIVE / WALK / BIKE, AVOID
//              HIGHWAYS, TRAFFIC (only with the
//              TomTom key), up to 3 routes with ETA, time, distance, traffic
//              delay and SIGNALS; GO, SIM (a simulated drive, for a desk with
//              no GPS), FLY (fly along), and where the trip starts (my
//              location, a point picked on the map, the selected target).
//   DRIVING    the turn banner (maneuver glyph, distance, road, then-step),
//              the strip (ETA, distance and time left, signals ahead,
//              RECENTER, END), reroute and arrival come from the navigator.
//   TOOLS      the ROUTE section: the same trip from the menu (from / to /
//              mode), folded from the old A/B route tool.
//
// DOM is built once; a fix updates text in place (at most once a second).

const MODES = [
  { id: 'drive', label: 'DRIVE' },
  { id: 'walk', label: 'WALK' },
  { id: 'bike', label: 'BIKE' },
];
const LONG_PRESS_MS = 550;
const SEARCH_DEBOUNCE_MS = 350;

const fmtLL = (p) =>
  p
    ? `${Math.abs(p.lat).toFixed(4)}${p.lat >= 0 ? 'N' : 'S'} ${Math.abs(p.lon).toFixed(4)}${p.lon >= 0 ? 'E' : 'W'}`
    : '--';

function tile(name) {
  const g = glyph(name);
  const c = document.createElement('canvas');
  c.width = g.image.width;
  c.height = g.image.height;
  c.getContext('2d')?.drawImage(g.image, 0, 0);
  return h('span.ct-tile', {}, c);
}

const btn = (label, onclick, title = label, cls = '') =>
  h(`button.ct-btn${cls}`, { type: 'button', title, onclick }, label);

/** Text to the clipboard (the async API, else a hidden field); false when refused. */
async function copyText(s) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch {
    // refused (no permission, not a secure context): the old way below
  }
  try {
    const ta = h('textarea', {
      readonly: true,
      style: { position: 'fixed', opacity: '0' },
    });
    ta.value = s;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   nav: object, view: object|null, fixes: object, shell: 'desktop'|'mobile',
 *   settings?: object|null, near: () => ({lat:number, lon:number}|null),
 *   armTap: (fn: Function, label: string) => void,
 *   targetPoint: () => ({lat:number, lon:number, name?:string}|null),
 *   flyAlong?: (coords: number[][]) => void, notify?: Function,
 *   canvas?: HTMLCanvasElement|null, pick?: (pos: {x:number,y:number}) => ({lat:number, lon:number}|null),
 *   demo?: boolean, onActive?: (kind: 'preview'|'drive') => void, now?: () => number,
 *   places?: object|null, recents?: object|null, sketch?: object|null,
 *   shareLink?: (p: {lat:number, lon:number}) => (string|null),
 *   onSaved?: (place: object) => void,
 * }} deps
 *   places: the saved places (core/places/saved.js); recents: the recent
 *   destinations (core/places/recents.js); sketch: the globe's sketch layer
 *   (core/scene/sketch.js: the pressed point and MEASURE); shareLink: a link
 *   to a point (null: an OpenStreetMap link); onSaved: a place was saved.
 */
export function createNavPanel({
  nav,
  view = null,
  fixes,
  shell = 'desktop',
  settings = null,
  near,
  armTap,
  targetPoint,
  flyAlong,
  notify,
  canvas = null,
  pick = null,
  demo = false,
  onActive,
  now = () => Date.now(),
  places = null,
  recents = null,
  sketch = null,
  shareLink = null,
  onSaved = null,
}) {
  const near0 = () => near?.() ?? null;
  const units = () => settings?.get?.('units') ?? 'metric';
  const opts = {
    mode: settings?.get?.('navMode') ?? 'drive',
    avoidHighways: Boolean(settings?.get?.('navAvoidHighways')),
    traffic: settings?.get?.('navTraffic') !== false,
  };
  let origin = { kind: 'me' }; // or { kind: 'point', lat, lon, name }
  let dest = null; // Place
  let stopWatch = null;
  let stopSim = null;
  let simulating = false;
  const listeners = new Set(); // TOOLS section repaint
  const changed = () => listeners.forEach((fn) => fn());

  // ------------------------------------------------------------- WHERE TO
  const input = h('input', {
    type: 'search',
    placeholder: 'WHERE TO',
    autocomplete: 'off',
    spellcheck: 'false',
    enterKeyHint: 'search',
    'aria-label': 'Where to: search a destination',
  });
  const clearBtn = h(
    'button.ct-nav__x',
    { type: 'button', title: 'Clear', 'aria-label': 'Clear', hidden: true },
    '×',
  );
  const results = h('div.ct-nav__results.ct-scroll', { role: 'listbox', hidden: true });
  const status = h('div.ct-nav__status', { hidden: true });
  const bar = h(
    'div.ct-nav__bar.ct-panel',
    {},
    h('label.ct-prompt', {}, h('span.ct-prompt__tag', {}, 'NAV'), input, clearBtn),
  );

  let searchSeq = 0;
  let searchTimer = null;
  let searchAbort = null;
  let rows = [];
  let sel = -1;
  let editing = false; // the SAVED list's edit mode (rename, HOME / WORK, delete)
  let renaming = null; // the saved place id being renamed inline
  let showAllSaved = false;
  let lastList = null; // what renderRows last drew, to draw it again after a change
  let shownSearch = false; // the list shows search results (not the saved list)

  function origin2() {
    if (origin.kind === 'point') return origin;
    return fixes.get() ?? null;
  }

  // ----- saved places: one store (core/places/saved.js), shared with MY PLACES
  const savedAt = (p) =>
    p && Number.isFinite(p.lat) && Number.isFinite(p.lon)
      ? (places?.near?.(p.lat, p.lon, 30) ?? null)
      : null;
  /** Save a place (one tap) or, when it is saved already, forget it. */
  function toggleSaved(p) {
    if (!places || !p) return null;
    const had = p.savedId ? places.get(p.savedId) : savedAt(p);
    if (had) {
      places.remove(had.id);
      return null;
    }
    const role = p.kind === 'home' || p.kind === 'work' ? p.kind : 'place';
    const name =
      role !== 'place' ? p.detail || p.name : String(p.name ?? '').trim() || fmtLL(p);
    const saved = places.add({
      name,
      lat: p.lat,
      lon: p.lon,
      kind: role,
      note: role === 'place' ? (p.detail ?? '') : '',
    });
    if (saved) onSaved?.(saved);
    else notify?.({ title: 'PLACE LIST FULL', level: 'low', key: 'places-full' });
    return saved;
  }

  /** The ◇ / ◆ button: one tap saves, saved ones show filled. */
  function saveToggle(place, after) {
    const on = Boolean(place.savedId ? places?.get?.(place.savedId) : savedAt(place));
    return h(
      'button.ct-nav__save',
      {
        type: 'button',
        title: on ? 'Saved: tap to forget' : 'Save this place',
        'aria-label': on ? 'Saved. Forget it' : 'Save this place',
        'aria-pressed': String(on),
        onpointerdown: (e) => e.preventDefault(), // keep the input's focus
        onclick: (e) => {
          e.stopPropagation();
          toggleSaved(place);
          after?.();
        },
      },
      h('span.ct-nav__savemark'),
    );
  }

  const ROLE_LETTER = { home: 'H', work: 'W' };
  const glyphFor = (p) =>
    p.kind === 'city'
      ? 'frame'
      : p.kind === 'saved'
        ? 'diamond'
        : p.kind === 'intersection'
          ? 'cross'
          : p.kind === 'recent'
            ? 'dot'
            : 'node';

  /** A Place as a row (a search result, a saved place, a recent one). */
  function placeRow(p) {
    return {
      label: String(p.name).toUpperCase(),
      detail: String(p.detail ?? '').toUpperCase(),
      glyph: glyphFor(p),
      letter: ROLE_LETTER[p.kind] ?? null,
      place: p,
      save: Boolean(places),
      run: () => routeHere(p),
    };
  }

  /** WHERE TO before anything is typed: HOME, WORK, SAVED, RECENT, then the map. */
  function homeRows() {
    const near = origin2() ?? near0();
    const list = nav.search
      ? savedList({ near, savedMax: showAllSaved ? 500 : 6 })
      : { saved: [], recent: [], more: 0 };
    const out = [];
    if (list.saved.length) {
      out.push({
        head: 'SAVED',
        action: {
          label: editing ? 'DONE' : 'EDIT',
          title: editing ? 'Done editing' : 'Rename, set HOME / WORK, delete',
          run: () => {
            editing = !editing;
            renaming = null;
            renderRows(homeRows());
          },
        },
      });
      for (const p of list.saved) out.push({ ...placeRow(p), edit: editing });
      if (list.more > 0 && !showAllSaved)
        out.push({
          label: `ALL SAVED (${list.more + list.saved.filter((p) => p.kind === 'saved').length})`,
          meta: '',
          glyph: 'frame',
          run: () => {
            showAllSaved = true;
            renderRows(homeRows());
            input.focus();
          },
          keep: true,
        });
    }
    if (list.recent.length && !editing) {
      out.push({
        head: 'RECENT',
        action: {
          label: 'CLEAR',
          title: 'Forget the recent destinations',
          run: () => {
            recents?.clear?.();
            renderRows(homeRows());
          },
        },
      });
      for (const p of list.recent) out.push(placeRow(p));
    }
    if (!editing) out.push(...quickRows());
    return out;
  }

  /** The saved places (HOME, WORK first) and recent ones, as Places. */
  function savedList({ near, savedMax }) {
    places?.refresh?.();
    const all = places?.list?.() ?? [];
    const short = savedShortlist({ places, recents, near, savedMax, recentMax: 5 });
    const saved = short.filter((p) => p.kind !== 'recent');
    const others = all.filter((p) => p.kind !== 'home' && p.kind !== 'work').length;
    return {
      saved,
      recent: short.filter((p) => p.kind === 'recent'),
      more: Math.max(0, others - saved.filter((p) => p.kind === 'saved').length),
    };
  }

  function quickRows() {
    const out = [
      {
        label: 'PICK ON THE MAP',
        meta: 'TAP',
        glyph: 'cross',
        run: () => pickDestination(),
      },
    ];
    const t = targetPoint?.();
    if (t)
      out.push({
        label: `TARGET  ${String(t.name ?? '').toUpperCase()}`.trim(),
        meta: 'TGT',
        glyph: 'diamond',
        run: () => routeHere({ ...t, name: t.name ?? 'TARGET', kind: 'target' }),
      });
    return out;
  }

  const rowTile = (r) =>
    r.letter ? h('span.ct-tile.ct-nav__letter', {}, r.letter) : tile(r.glyph ?? 'frame');

  // Edit mode: the saved place's own controls instead of the save toggle.
  function editControls(p) {
    const id = p.savedId;
    const rec = places?.get?.(id);
    if (!rec) return null;
    const ctl = (label, title, fn, pressed = null) =>
      h(
        'button.ct-btn.ct-nav__ed',
        {
          type: 'button',
          title,
          'aria-pressed': pressed === null ? null : String(pressed),
          onpointerdown: (e) => e.preventDefault(),
          onclick: (e) => {
            e.stopPropagation();
            fn();
            renderRows(homeRows());
          },
        },
        label,
      );
    return h(
      'span.ct-nav__edits',
      {},
      ctl(
        'HOME',
        'Set as HOME',
        () => places.setRole(id, rec.kind === 'home' ? null : 'home'),
        rec.kind === 'home',
      ),
      ctl(
        'WORK',
        'Set as WORK',
        () => places.setRole(id, rec.kind === 'work' ? null : 'work'),
        rec.kind === 'work',
      ),
      ctl('REN', 'Rename', () => (renaming = id)),
      ctl('×', `Delete ${rec.name}`, () => places.remove(id)),
    );
  }

  // Inline rename: the row becomes a field (Enter or leaving it keeps the name).
  function renameRow(p) {
    const rec = places?.get?.(p.savedId);
    const field = h('input.ct-nav__rename', {
      type: 'text',
      value: rec?.name ?? p.name,
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
      if (keep && v && rec) places.update(rec.id, { name: v });
      renaming = null;
      renderRows(homeRows());
      input.focus();
    };
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commit(true);
      else if (e.key === 'Escape') commit(false);
    });
    field.addEventListener('blur', () => setTimeout(() => commit(true), 0));
    setTimeout(() => {
      field.focus();
      field.select?.();
    }, 0);
    return h('div.ct-nav__item.ct-nav__item--edit', {}, rowTile(placeRow(p)), field);
  }

  function renderRows(list, note = '') {
    lastList = list;
    rows = list.filter((r) => !r.head);
    sel = -1;
    results.innerHTML = '';
    const from = origin2();
    let i = 0;
    for (const r of list) {
      if (r.head) {
        results.appendChild(
          h(
            'div.ct-nav__head',
            {},
            h('span', {}, r.head),
            r.action
              ? h(
                  'button.ct-nav__headbtn',
                  {
                    type: 'button',
                    title: r.action.title,
                    onpointerdown: (e) => e.preventDefault(),
                    onclick: (e) => {
                      e.stopPropagation();
                      r.action.run();
                    },
                  },
                  r.action.label,
                )
              : null,
          ),
        );
        continue;
      }
      const at = i;
      i += 1;
      if (r.edit && renaming && r.place?.savedId === renaming) {
        results.appendChild(renameRow(r.place));
        continue;
      }
      const meta =
        r.meta ??
        (from && Number.isFinite(r.place?.lat)
          ? formatNavDistance(
              haversineM(from.lat, from.lon, r.place.lat, r.place.lon),
              units(),
            )
          : '');
      const main = h(
        'button.ct-row.ct-nav__row',
        {
          type: 'button',
          role: 'option',
          onpointerdown: (e) => e.preventDefault(), // keep the input's focus
          onclick: () => choose(at),
        },
        rowTile(r),
        h(
          'span.ct-row__label',
          {},
          h('span.ct-nav__name', {}, r.label),
          r.detail ? h('span.ct-nav__detail', {}, r.detail) : null,
        ),
        r.edit ? null : h('span.ct-row__meta', {}, meta),
      );
      const side = r.edit
        ? editControls(r.place)
        : r.save && r.place
          ? saveToggle(r.place, () => renderRows(lastList ?? []))
          : null;
      results.appendChild(h('div.ct-nav__item', {}, main, side));
    }
    if (note) results.appendChild(h('div.ct-nav__note', {}, note));
    results.hidden = !list.length && !note;
  }

  function choose(i) {
    const r = rows[i];
    if (!r) return;
    if (r.keep) return r.run();
    results.hidden = true;
    editing = false;
    renaming = null;
    input.blur();
    r.run();
  }

  function paintSel() {
    [...results.querySelectorAll('.ct-nav__row')].forEach((el, i) =>
      el.classList.toggle('is-sel', i === sel),
    );
  }

  async function runSearch(q) {
    const seq = (searchSeq += 1);
    searchAbort?.abort();
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    searchAbort = ac;
    // The last answer stays while the next is on its way; the saved list does not.
    renderRows(shownSearch ? rows.filter((r) => r.place) : [], 'SEARCHING');
    try {
      const bias = origin2() ?? near0();
      const found = await nav.search(q, { near: bias, limit: 8, signal: ac?.signal });
      if (seq !== searchSeq) return;
      renderRows(found.map(placeRow), found.length ? '' : 'NO MATCH');
      shownSearch = true;
    } catch (err) {
      if (seq !== searchSeq || err?.name === 'AbortError') return;
      console.warn('[argus] nav search failed', err?.message ?? err);
      renderRows([], 'SEARCH UNAVAILABLE');
    }
  }

  function showHome() {
    searchSeq += 1;
    shownSearch = false;
    renderRows(homeRows());
  }

  input.addEventListener('input', () => {
    clearBtn.hidden = !input.value;
    clearTimeout(searchTimer);
    const q = input.value.trim();
    editing = false;
    renaming = null;
    if (q.length < 2) {
      showHome();
      return;
    }
    searchTimer = setTimeout(() => runSearch(q), SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener('focus', () => {
    if (!input.value.trim()) showHome();
    else if (rows.length) results.hidden = false;
    // Find the user now, while they type: results then show how far each is,
    // the search leans towards them, and the plan needs no wait.
    if (origin.kind === 'me' && !fixes.get()) fixes.locate({ timeoutMs: 8000 });
  });
  const inside = (el) => el === input || results.contains(el);
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (!inside(document.activeElement)) closeResults();
    }, 150);
  });
  function closeResults() {
    results.hidden = true;
    editing = false;
    renaming = null;
    showAllSaved = false;
  }
  // A tap anywhere else closes the list (a rename field may hold the focus).
  const onOutside = (e) => {
    if (results.hidden) return;
    if (bar.contains(e.target) || results.contains(e.target)) return;
    closeResults();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows.length;
      if (!n) return;
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      paintSel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (sel >= 0) choose(sel);
      else if (rows[0]?.place && input.value.trim()) choose(0);
      else if (input.value.trim().length >= 2) {
        clearTimeout(searchTimer);
        runSearch(input.value.trim());
      }
    } else if (e.key === 'Escape') {
      closeResults();
      input.blur();
    }
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.hidden = true;
    if (nav.state.status === 'previewing' || nav.state.status === 'planning' || dest)
      end();
    showHome();
    input.focus();
  });
  // The list follows the store (a save from the map menu, MY PLACES, the car).
  const unsubPlaces = places?.subscribe?.(() => {
    if (!results.hidden && !input.value.trim() && !renaming) renderRows(homeRows());
    paintCardSave();
  });

  // ------------------------------------------------------------- PREVIEW card
  const card = h('div.ct-nav__card.ct-panel', {
    hidden: true,
    role: 'region',
    'aria-label': 'Route preview',
  });
  const destName = h('div.ct-nav__dest');
  const destDetail = h('div.ct-nav__destdetail');
  const fromVal = h('span.ct-nav__fromval', {}, 'MY LOCATION');
  const routeList = h('div.ct-nav__routes', { role: 'listbox' });
  const warn = h('div.ct-nav__warn', { hidden: true });
  const credit = h('div.ct-nav__credit');
  const goBtn = btn(
    'GO',
    () => go(false),
    'Start turn-by-turn from your location',
    '.ct-btn--ok.ct-nav__go',
  );
  const simBtn = btn('SIM', () => go(true), 'Simulate the drive along this route');
  const flyBtn = btn(
    'FLY',
    () => {
      const r = nav.state.route;
      if (r && flyAlong) flyAlong(r.geometry);
    },
    'Fly along the route',
  );

  const modeChoice = createChoice({
    label: 'Travel mode',
    options: MODES,
    current: opts.mode,
    onSelect: (id) => setOpt('mode', id),
  });
  const avoidSwitch = createSwitch({
    label: 'Avoid highways',
    on: opts.avoidHighways,
    title: 'Plan around motorways and freeways (driving)',
    onToggle: (on) => setOpt('avoidHighways', on),
  });
  const trafficSwitch = createSwitch({
    label: 'Traffic',
    on: opts.traffic,
    title: 'Live traffic (TomTom) in the travel times',
    onToggle: (on) => setOpt('traffic', on),
  });
  const optsRow = h(
    'div.ct-nav__opts',
    {},
    modeChoice.el,
    avoidSwitch.el,
    trafficSwitch.el,
  );

  const cardSave = h('span.ct-nav__cardsave');
  /** The destination's save toggle (◇ / ◆), repainted when the list changes. */
  function paintCardSave() {
    cardSave.innerHTML = '';
    if (places && dest) cardSave.append(saveToggle(dest, () => paintCardSave()));
  }
  card.append(
    h(
      'div.ct-nav__cardhead',
      {},
      h('div.ct-nav__destwrap', {}, destName, destDetail),
      demo ? h('span.ct-tag', {}, 'DEMO') : null,
      cardSave,
      h(
        'button.ct-nav__x',
        { type: 'button', title: 'Close', 'aria-label': 'Close', onclick: () => end() },
        '×',
      ),
    ),
    h(
      'div.ct-nav__from',
      {},
      h('span.ct-muted', {}, 'FROM'),
      fromVal,
      btn('ME', () => setOrigin({ kind: 'me' }), 'From my location'),
      btn('MAP', () => pickOrigin(), 'Pick the start on the map'),
      btn('TGT', () => originFromTarget(), 'From the selected target'),
    ),
    optsRow,
    status,
    routeList,
    warn,
    h('div.ct-seg.ct-nav__actions', {}, goBtn, simBtn, flyBtn),
    credit,
  );

  function setOpt(k, v) {
    opts[k] = v;
    const key = {
      mode: 'navMode',
      avoidHighways: 'navAvoidHighways',
      traffic: 'navTraffic',
    }[k];
    settings?.set?.(key, v);
    avoidSwitch.el.hidden = opts.mode !== 'drive';
    changed();
    if (dest) plan();
    return v;
  }

  function setStatus(text, kind = '') {
    status.hidden = !text;
    status.className = `ct-nav__status${kind ? ` ct-nav__status--${kind}` : ''}`;
    status.innerHTML = '';
    if (kind === 'busy')
      status.append(h('span.ct-spin', {}, ...Array.from({ length: 9 }, () => h('i'))));
    if (text) status.append(h('span', {}, text));
  }

  function routeRow(r, i, selected) {
    const f = routeFacts(r, { now: now(), units: units() });
    const letter = String.fromCharCode(65 + i);
    return h(
      'button.ct-row.ct-nav__route',
      {
        type: 'button',
        role: 'option',
        'aria-pressed': String(selected),
        title: `Route ${letter}`,
        onclick: () => nav.select?.(r),
      },
      h('span.ct-tile.ct-nav__letter', {}, letter),
      h(
        'span.ct-nav__routemain',
        {},
        h(
          'span.ct-nav__routetop',
          {},
          h('b', {}, f.duration),
          h('span.ct-muted', {}, ` ${f.distance}`),
          f.delay ? h('span.ct-nav__delay', {}, ` ${f.delay} TRAFFIC`) : null,
        ),
        h('span.ct-nav__via', {}, f.via ? `VIA ${f.via}` : ''),
      ),
      h(
        'span.ct-nav__routeside',
        {},
        h('span', {}, `ETA ${f.eta}`),
        h('span.ct-muted', {}, f.signals ? `SIG ${f.signals}` : 'SIG --'),
      ),
    );
  }

  function creditFor(r) {
    const fix = h(
      'a',
      {
        href: 'https://www.openstreetmap.org/fixthemap',
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      'FIX THE MAP',
    );
    const who =
      r?.provider === 'tomtom'
        ? 'ROUTES © TOMTOM. MAP DATA © OSM CONTRIBUTORS. '
        : r?.provider === 'valhalla'
          ? 'ROUTES: VALHALLA (FOSSGIS). MAP DATA © OSM CONTRIBUTORS. '
          : 'ROUTES: OSRM (FOSSGIS). MAP DATA © OSM CONTRIBUTORS. ';
    credit.innerHTML = '';
    credit.append(who, 'SIGNALS: OSM. ', fix);
  }

  function renderCard(s) {
    const show = Boolean(dest) && ['planning', 'previewing', 'idle'].includes(s.status);
    card.hidden = !show;
    if (!show) return;
    destName.textContent = String(dest.name ?? 'DESTINATION').toUpperCase();
    destDetail.textContent = String(dest.detail || fmtLL(dest)).toUpperCase();
    paintCardSave();
    fromVal.textContent =
      origin.kind === 'me'
        ? 'MY LOCATION'
        : String(origin.name ?? fmtLL(origin)).toUpperCase();
    trafficSwitch.el.hidden = !(nav.traffic && opts.mode === 'drive');
    avoidSwitch.el.hidden = opts.mode !== 'drive';
    routeList.innerHTML = '';
    const routes = s.status === 'previewing' ? (s.routes ?? []) : [];
    routes.forEach((r, i) => routeList.appendChild(routeRow(r, i, r === s.route)));
    if (s.status === 'planning') setStatus('ROUTING', 'busy');
    else if (s.status === 'idle' && s.error) setStatus(s.error, 'err');
    else setStatus('');
    const w = s.route?.warnings ?? [];
    warn.hidden = !w.length || s.status !== 'previewing';
    warn.textContent = w.join('  /  ');
    const ready = s.status === 'previewing' && Boolean(s.route);
    goBtn.disabled = !ready || origin.kind !== 'me';
    goBtn.title =
      origin.kind === 'me'
        ? 'Start turn-by-turn from your location'
        : 'GO follows your own position: set FROM to ME (or use SIM)';
    simBtn.disabled = !ready;
    flyBtn.disabled = !ready || !flyAlong;
    creditFor(s.route);
  }

  // ------------------------------------------------------------- planning
  /** Show the routes on the globe in the part of the screen the panels leave free. */
  function frame() {
    const H = globalThis.innerHeight || 1;
    const t = top.getBoundingClientRect();
    const b = bottom.getBoundingClientRect();
    view?.frameRoutes?.({
      top: (t.height ? t.bottom : 0) / H + 0.04,
      bottom: (b.height ? H - b.top : 0) / H + 0.06,
    });
  }

  async function plan() {
    if (!dest) return;
    let from = origin.kind === 'point' ? origin : fixes.get();
    if (!from) {
      setStatus('LOCATING', 'busy');
      card.hidden = false;
      from = await fixes.locate({ timeoutMs: 8000 });
      if (!dest) return;
    }
    if (!from) {
      setStatus('NO LOCATION: PICK A START WITH MAP', 'err');
      return;
    }
    try {
      await nav.plan(from, dest, { ...opts });
      if (nav.state.status === 'previewing') frame();
    } catch (err) {
      console.warn('[argus] nav plan failed', err?.message ?? err);
    }
  }

  /** Set the destination and plan. Place = { lat, lon, name?, detail?, id?, kind? }. */
  function routeHere(place) {
    if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return;
    if (isDriving()) end();
    dest = {
      id: place.id ?? `pin:${place.lat.toFixed(5)},${place.lon.toFixed(5)}`,
      name: place.name ?? 'DROPPED PIN',
      detail: place.detail ?? '',
      lat: place.lat,
      lon: place.lon,
      kind: place.kind ?? 'pin',
    };
    input.value = dest.name;
    clearBtn.hidden = false;
    results.hidden = true;
    changed();
    renderCard(nav.state);
    onActive?.('preview');
    plan();
    // A dropped pin gets a street name when Nominatim knows one.
    if (!place.name && nav.reverse) {
      const d = dest;
      nav.reverse(place.lat, place.lon).then((r) => {
        if (!r || dest !== d) return;
        d.name = r.name;
        d.detail = r.detail;
        input.value = r.name;
        renderCard(nav.state);
        changed();
        nav.remember?.(d);
      });
    }
  }

  function setOrigin(o) {
    origin = o;
    changed();
    renderCard(nav.state);
    if (dest) plan();
  }
  function pickOrigin() {
    armTap(
      (p) => setOrigin({ kind: 'point', lat: p.lat, lon: p.lon }),
      'TAP THE MAP: ROUTE START',
    );
  }
  function originFromTarget() {
    const t = targetPoint?.();
    if (t) setOrigin({ kind: 'point', lat: t.lat, lon: t.lon, name: t.name });
    else
      notify?.({
        title: 'NO TARGET',
        body: 'Select a contact first.',
        level: 'low',
        key: 'nav-tgt',
      });
  }
  function pickDestination() {
    armTap((p) => routeHere({ lat: p.lat, lon: p.lon }), 'TAP THE MAP: DESTINATION');
  }

  // ------------------------------------------------------------- driving
  const isDriving = () =>
    ['navigating', 'rerouting', 'arrived'].includes(nav.state.status);
  const banner = h('div.ct-nav__banner.ct-panel.ct-frame', {
    hidden: true,
    role: 'status',
    'aria-live': 'polite',
  });
  const glyphNow = maneuverCanvas(shell === 'mobile' ? 52 : 60);
  const glyphThen = maneuverCanvas(20);
  const bDist = h('div.ct-nav__bdist');
  const bLabel = h('div.ct-nav__blabel');
  const bRoad = h('div.ct-nav__broad');
  const bThenLabel = h('span');
  const bThen = h(
    'div.ct-nav__bthen',
    { hidden: true },
    h('span.ct-muted', {}, 'THEN'),
    glyphThen.el,
    bThenLabel,
  );
  banner.append(
    h('div.ct-nav__bglyph', {}, glyphNow.el),
    h('div.ct-nav__btext', {}, bDist, bLabel, bRoad, bThen),
  );

  const strip = h('div.ct-nav__strip.ct-panel', { hidden: true });
  const sEtaLabel = h('span.ct-muted', {}, 'ETA');
  const sEta = h('b');
  const sLeft = h('span');
  const sTime = h('span');
  const sSig = h('span.ct-muted');
  const sTraffic = h('span.ct-nav__delay');
  const sSim = h('span.ct-tag', { hidden: true }, 'SIM');
  const recenterBtn = btn(
    'RECENTER',
    () => view?.recenter?.(),
    'Follow the vehicle again',
    '.ct-nav__recenter',
  );
  recenterBtn.hidden = true;
  const endBtn = btn('END', () => end(), 'End navigation');
  strip.append(
    h('div.ct-nav__facts', {}, sEtaLabel, sEta, sLeft, sTime, sSig, sTraffic, sSim),
    h('div.ct-nav__stripbtns', {}, recenterBtn, endBtn),
  );

  let shownStep = null;
  let shownThen = null;
  function renderDriving(s) {
    const driving = ['navigating', 'rerouting', 'arrived'].includes(s.status);
    banner.hidden = !driving;
    strip.hidden = !driving;
    bar.hidden = driving;
    if (driving) results.hidden = true;
    if (!driving) {
      shownStep = shownThen = null;
      return;
    }
    const p = s.progress;
    const u = units();
    if (s.status === 'arrived') {
      glyphNow.draw({ type: 'arrive' });
      shownStep = null;
      bDist.textContent = 'ARRIVED';
      // The panel's name: a dropped pin may have been named since planning.
      bLabel.textContent = String(dest?.name ?? s.destination?.name ?? '').toUpperCase();
      bRoad.textContent = '';
      bThen.hidden = true;
    } else if (s.status === 'rerouting' || p?.offRoute) {
      if (shownStep !== 'reroute') glyphNow.draw({ type: 'reroute' });
      shownStep = 'reroute';
      bDist.textContent = 'REROUTING';
      bLabel.textContent = 'OFF ROUTE';
      bRoad.textContent = '';
      bThen.hidden = true;
    } else if (p?.step) {
      if (p.step !== shownStep) {
        glyphNow.draw(p.step.maneuver);
        shownStep = p.step;
      }
      bDist.textContent = formatNavDistance(p.distanceToStepM, u);
      bLabel.textContent = maneuverLabel(p.step.maneuver);
      bRoad.textContent = String(p.step.name ?? '').toUpperCase();
      // THEN: the next maneuver when it comes soon after this one.
      const t = p.then;
      const soon =
        t && (p.step.distanceM ?? Infinity) < 400 && p.step.maneuver.type !== 'arrive';
      bThen.hidden = !soon;
      if (soon && t !== shownThen) {
        glyphThen.draw(t.maneuver);
        bThenLabel.textContent = maneuverLabel(t.maneuver);
        shownThen = t;
      }
    }
    banner.classList.toggle('is-alert', Boolean(p?.offRoute) || s.status === 'rerouting');
    const arrived = s.status === 'arrived';
    sEtaLabel.textContent = arrived ? 'ARRIVED' : 'ETA';
    if (p) {
      sEta.textContent = formatClock(p.eta);
      sLeft.textContent = arrived ? '' : formatNavDistance(p.distanceRemainingM, u);
      sTime.textContent = arrived ? '' : formatNavDuration(p.durationRemainingS);
      sSig.textContent =
        !arrived && Number.isFinite(p.signalsAhead) ? `SIG ${p.signalsAhead}` : '';
      sTraffic.textContent = arrived ? '' : formatDelay(s.route?.trafficDelayS);
    }
    sSim.hidden = !simulating;
  }

  function go(sim) {
    const r = nav.state.route;
    if (!r) return;
    stopDriving();
    simulating = sim;
    nav.start(r);
    onActive?.('drive');
    if (sim) {
      const simulator = createDriveSim(r, { timeScale: 3 });
      const t0 = now();
      const tick = () => nav.update(simulator.fixAt((now() - t0) / 1000, now()));
      tick();
      const id = setInterval(() => {
        if (nav.state.status === 'arrived' || nav.state.status === 'idle')
          return clearInterval(id);
        tick();
      }, 1000);
      stopSim = () => clearInterval(id);
    } else {
      stopWatch = fixes.watch((f) => nav.update(f));
    }
  }

  function stopDriving() {
    stopWatch?.();
    stopWatch = null;
    stopSim?.();
    stopSim = null;
    simulating = false;
  }

  function end() {
    stopDriving();
    nav.stop();
    dest = null;
    input.value = '';
    clearBtn.hidden = true;
    card.hidden = true;
    changed();
  }

  // A preview left open keeps its arrival times current (twice a minute,
  // nothing while the page is hidden; no request, just the clock).
  let etaTimer = null;
  const unsubscribe = nav.subscribe((s) => {
    renderCard(s);
    renderDriving(s);
    changed();
    if (s.status === 'previewing' && !etaTimer)
      etaTimer = setInterval(() => {
        if (!document.hidden && nav.state.status === 'previewing') renderCard(nav.state);
      }, 30_000);
    else if (s.status !== 'previewing' && etaTimer) {
      clearInterval(etaTimer);
      etaTimer = null;
    }
  });

  // ------------------------------------------------------------- map press
  // Long press (touch, pen) or right click: WHAT'S HERE. The point's
  // coordinates at once, its name when Photon's reverse geocoder answers;
  // SAVE (one tap, then rename and HOME / WORK right there), ROUTE HERE,
  // FROM HERE, COPY (the coordinates), SHARE (a link to the point), MEASURE
  // (the distance to the next tap).
  const ctx = h('div.ct-nav__ctx.ct-panel', {
    hidden: true,
    role: 'dialog',
    'aria-label': "What's here",
    'data-shell': shell,
  });
  let swallowUntil = 0;
  let here = null; // { lat, lon, name, detail, named, savedId, seq }
  let hereSeq = 0;

  const fmtDeg = (p) => `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;

  function ctxAction(label, title, fn, { pressed = null, cls = '' } = {}) {
    return h(
      `button.ct-btn.ct-nav__act${cls}`,
      {
        type: 'button',
        title,
        'aria-pressed': pressed === null ? null : String(pressed),
        onclick: (e) => {
          e.stopPropagation();
          fn();
        },
      },
      label,
    );
  }

  function renderCtx() {
    if (!here) return;
    const p = here;
    const rec = p.savedId ? places?.get?.(p.savedId) : null;
    if (p.savedId && !rec) p.savedId = null;
    ctx.innerHTML = '';
    const title = p.name || (p.named ? 'DROPPED PIN' : 'WHAT’S HERE');
    ctx.append(
      h(
        'div.ct-nav__ctxhead',
        {},
        h(
          'div.ct-nav__ctxwrap',
          {},
          // Saved: the name is the title, edited in place.
          rec ? nameField(rec) : h('div.ct-nav__ctxtitle', {}, title.toUpperCase()),
          h(
            'div.ct-nav__ctxsub',
            {},
            p.named ? String(p.detail ?? '').toUpperCase() : 'LOOKING UP',
          ),
          h('div.ct-nav__ctxll', {}, fmtLL(p)),
        ),
        h(
          'button.ct-nav__x',
          {
            type: 'button',
            title: 'Close',
            'aria-label': 'Close',
            onclick: () => closeCtx(),
          },
          '×',
        ),
      ),
    );
    const role = (kind, label) =>
      ctxAction(
        label,
        `Set as ${label}`,
        () => {
          places.setRole(rec.id, rec.kind === kind ? null : kind);
          renderCtx();
        },
        { pressed: rec.kind === kind },
      );
    ctx.append(
      h(
        'div.ct-nav__ctxgrid',
        {},
        places
          ? ctxAction(
              rec ? 'SAVED' : 'SAVE',
              rec ? 'Saved: tap to forget' : 'Save this place',
              () => {
                if (rec) {
                  places.remove(rec.id);
                  p.savedId = null;
                } else {
                  const saved = toggleSaved({
                    lat: p.lat,
                    lon: p.lon,
                    name: p.name || `PIN ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`,
                    detail: p.detail ?? '',
                  });
                  p.savedId = saved?.id ?? null;
                  p.autoName = !p.named; // named when the answer comes
                }
                renderCtx();
              },
              { pressed: Boolean(rec), cls: '.ct-nav__act--save' },
            )
          : null,
        // Saved: HOME / WORK right beside it; else the routes first.
        rec ? role('home', 'HOME') : null,
        rec ? role('work', 'WORK') : null,
        ctxAction('ROUTE HERE', 'Plan a route to this point', () => {
          closeCtx();
          routeHere(placeOfHere());
        }),
        ctxAction('FROM HERE', 'Start the route from this point', () => {
          closeCtx();
          setOrigin({ kind: 'point', lat: p.lat, lon: p.lon, name: here?.name || null });
        }),
        ctxAction('COPY', 'Copy the coordinates', () => {
          copyText(fmtDeg(p)).then((ok) =>
            notify?.({
              title: ok ? 'COORDINATES COPIED' : fmtDeg(p),
              level: 'low',
              key: 'copy',
            }),
          );
          closeCtx();
        }),
        ctxAction('SHARE', 'Share a link to this point', () => {
          sharePoint(p);
          closeCtx();
        }),
        sketch && armTap
          ? ctxAction('MEASURE', 'Distance from here to the next tap', () => {
              closeCtx();
              measureFrom(p);
            })
          : null,
      ),
    );
  }

  // A saved place's name as the sheet's title, edited in place (Enter, or
  // leaving the field, keeps it).
  function nameField(rec) {
    const field = h('input.ct-nav__rename.ct-nav__ctxname', {
      type: 'text',
      value: rec.name,
      maxlength: '60',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': 'Name of this saved place',
      title: 'Rename',
    });
    const keep = () => {
      const v = field.value.trim();
      if (v && v !== rec.name) {
        places.update(rec.id, { name: v });
        if (here) {
          here.autoName = false;
          here.name = v;
        }
      }
    };
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        keep();
        field.blur();
      }
    });
    field.addEventListener('change', keep);
    field.addEventListener('blur', keep);
    return field;
  }

  function placeOfHere() {
    const rec = here?.savedId ? places?.get?.(here.savedId) : null;
    return {
      lat: here.lat,
      lon: here.lon,
      name: rec?.name ?? (here.named ? here.name || undefined : undefined),
      detail: here.detail ?? '',
    };
  }

  function openCtx(pos, ll) {
    const seq = (hereSeq += 1);
    const saved = savedAt(ll);
    here = {
      lat: ll.lat,
      lon: ll.lon,
      name: saved?.name ?? '',
      detail: saved?.note ?? '',
      named: Boolean(saved),
      savedId: saved?.id ?? null,
      autoName: false,
    };
    sketch?.clear?.('measure');
    sketch?.clear?.('here');
    sketch?.marker?.('here', [ll.lon, ll.lat]);
    renderCtx();
    ctx.hidden = false;
    placeCtx(pos);
    // The name, when the reverse geocoder knows one.
    // Photon first; when it has nothing (or is down), Nominatim's reverse.
    const ask = nav.reversePlace ?? null;
    if (!ask || saved) return;
    Promise.resolve(ask(ll.lat, ll.lon))
      .then((r) => r ?? (seq === hereSeq ? nav.reverse?.(ll.lat, ll.lon) : null))
      .catch(() => null)
      .then((r) => {
        if (seq !== hereSeq || !here) return;
        here.named = true;
        if (r) {
          here.name = r.name;
          here.detail = r.detail;
          // Saved before the name came: the saved place takes it.
          if (here.savedId && here.autoName && places?.get?.(here.savedId))
            places.update(here.savedId, { name: r.name, note: r.detail });
        }
        here.autoName = false;
        renderCtx();
      });
  }

  function placeCtx(pos) {
    const r = canvas?.getBoundingClientRect?.() ?? {
      left: 0,
      top: 0,
      width: innerWidth,
      height: innerHeight,
    };
    const w = ctx.offsetWidth || 260;
    const hgt = ctx.offsetHeight || 220;
    const vw = globalThis.innerWidth || r.width;
    const vh = globalThis.innerHeight || r.height;
    // Beside the point, inside the screen (above the finger when low down).
    let x = r.left + pos.x + 12;
    let y = r.top + pos.y + 12;
    if (x + w > vw - 8) x = Math.max(8, r.left + pos.x - w - 12);
    if (x + w > vw - 8) x = Math.max(8, vw - w - 8);
    if (y + hgt > vh - 8) y = Math.max(8, r.top + pos.y - hgt - 12);
    ctx.style.left = `${Math.max(8, x)}px`;
    ctx.style.top = `${Math.max(8, y)}px`;
  }

  function closeCtx() {
    if (ctx.hidden) return;
    ctx.hidden = true;
    here = null;
    hereSeq += 1;
    sketch?.clear?.('here');
  }

  // MEASURE: a dashed line from the pressed point to the next tap, with the
  // distance and bearing; the next long press clears it.
  function measureFrom(a) {
    armTap((b) => {
      const m = greatCircleM(a, b);
      const brg = Math.round(initialBearingDeg(a, b));
      const label = `${formatNavDistance(m, units())}  ${String(brg).padStart(3, '0')}°`;
      sketch.clear('measure');
      sketch.line(
        'measure',
        [
          [a.lon, a.lat],
          [b.lon, b.lat],
        ],
        { dashed: true, width: 2 },
      );
      sketch.marker('measure', [a.lon, a.lat]);
      sketch.marker('measure', [b.lon, b.lat], label);
      notify?.({ title: `DISTANCE ${label}`, level: 'low', key: 'measure' });
    }, 'TAP THE MAP: MEASURE TO');
  }

  async function sharePoint(p) {
    const name = String(here?.name || '').trim();
    const url =
      shareLink?.(p) ??
      `https://www.openstreetmap.org/?mlat=${p.lat.toFixed(5)}&mlon=${p.lon.toFixed(5)}#map=17/${p.lat.toFixed(5)}/${p.lon.toFixed(5)}`;
    const text = [name, fmtDeg(p)].filter(Boolean).join('  ');
    try {
      if (navigator.share && matchMedia?.('(pointer: coarse)').matches) {
        await navigator.share({ title: name || 'Argus point', text, url });
        return;
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
    const ok = await copyText(url);
    notify?.({
      title: ok ? 'LINK COPIED' : 'LINK',
      body: ok ? '' : url,
      level: 'low',
      key: 'share',
    });
  }

  const onDocDown = (e) => {
    if (!ctx.hidden && !ctx.contains(e.target)) closeCtx();
    onOutside(e);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      closeCtx();
      sketch?.clear?.('measure');
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(
      document.activeElement?.tagName ?? '',
    );
    if (
      !typing &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      (e.key === 'g' || e.key === 'G') &&
      !bar.hidden
    ) {
      e.preventDefault();
      input.focus();
    }
  };
  document.addEventListener('pointerdown', onDocDown, true);
  document.addEventListener('keydown', onKey);
  let press = null;
  const toPos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const fire = (e) => {
    const pos = toPos(e);
    const ll = pick?.(pos);
    if (ll) {
      swallowUntil = performance.now() + 800;
      openCtx(pos, ll);
    }
  };
  const onDown = (e) => {
    clearTimeout(press?.timer);
    press = {
      x: e.clientX,
      y: e.clientY,
      t: performance.now(),
      button: e.button,
      timer: null,
    };
    // A right press is never a pick: the picker's tap handler runs before
    // ours on release, so it is told now.
    if (e.button === 2) swallowUntil = performance.now() + 1000;
    if (e.pointerType !== 'mouse' && e.isPrimary) {
      const ev = { clientX: e.clientX, clientY: e.clientY };
      press.timer = setTimeout(() => press && fire(ev), LONG_PRESS_MS);
    }
  };
  const onMove = (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) {
      clearTimeout(press.timer);
      press = null;
    }
  };
  const onUp = (e) => {
    if (!press) return;
    clearTimeout(press.timer);
    const tap =
      Math.hypot(e.clientX - press.x, e.clientY - press.y) <= 6 &&
      performance.now() - press.t < 700;
    if (press.button === 2 && e.button === 2 && tap) fire(e);
    press = null;
  };
  const onCancel = () => {
    clearTimeout(press?.timer);
    press = null;
  };
  const noMenu = (e) => e.preventDefault();
  if (canvas && pick) {
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('contextmenu', noMenu);
  }

  // ------------------------------------------------------------- TOOLS > ROUTE
  function createMenuSection() {
    const fromText = h('span.ct-tool__val');
    const toText = h('span.ct-tool__val');
    const mode = createChoice({
      label: 'Route mode',
      options: MODES,
      current: opts.mode,
      onSelect: (id) => {
        modeChoice.paint(id);
        return setOpt('mode', id);
      },
    });
    const avoid = createSwitch({
      label: 'Avoid highways',
      on: opts.avoidHighways,
      onToggle: (on) => {
        avoidSwitch.set(on);
        return setOpt('avoidHighways', on);
      },
    });
    const paint = () => {
      fromText.textContent =
        origin.kind === 'me'
          ? 'MY LOCATION'
          : String(origin.name ?? fmtLL(origin)).toUpperCase();
      toText.textContent = dest ? String(dest.name).toUpperCase() : '--';
      mode.paint(opts.mode);
      avoid.set(opts.avoidHighways);
      avoid.el.hidden = opts.mode !== 'drive';
    };
    listeners.add(paint);
    paint();
    return section(
      'ROUTE',
      h(
        'div.ct-tool__pt.ct-nav__pt',
        {},
        h('span.ct-muted', {}, 'FROM'),
        fromText,
        btn('ME', () => setOrigin({ kind: 'me' }), 'From my location'),
        btn('MAP', () => pickOrigin(), 'Pick the start on the map'),
        btn('TGT', () => originFromTarget(), 'From the selected target'),
      ),
      h(
        'div.ct-tool__pt.ct-nav__pt',
        {},
        h('span.ct-muted', {}, 'TO'),
        toText,
        btn('FIND', () => openSearch(), 'Search a destination (G)'),
        btn('MAP', () => pickDestination(), 'Pick the destination on the map'),
        btn(
          'TGT',
          () => {
            const t = targetPoint?.();
            if (t) routeHere({ ...t, kind: 'target' });
            else
              notify?.({
                title: 'NO TARGET',
                body: 'Select a contact first.',
                level: 'low',
                key: 'nav-tgt',
              });
          },
          'To the selected target',
        ),
      ),
      mode.el,
      avoid.el,
      h(
        'div.ct-seg',
        {},
        btn('ROUTE', () => (dest ? plan() : openSearch()), 'Plan the route'),
        btn(
          'FLY ALONG',
          () => nav.state.route && flyAlong?.(nav.state.route.geometry),
          'Fly along the route',
        ),
        btn('CLEAR', () => end(), 'Clear the route'),
      ),
      h(
        'div.ct-section__note',
        {},
        'Routes: OSRM / Valhalla (FOSSGIS), TomTom with a key. ',
        h(
          'a',
          {
            href: 'https://www.openstreetmap.org/fixthemap',
            target: '_blank',
            rel: 'noopener noreferrer',
          },
          'FIX THE MAP',
        ),
      ),
    );
  }

  function openSearch() {
    if (bar.hidden) return;
    input.focus();
    input.select?.();
  }

  // Desktop: one column at the top (bar, results, preview, banner) and the
  // strip at the bottom. Phone: the bar, results and banner at the top, the
  // preview card and the strip at the bottom in thumb reach.
  const top = h('div.ct-nav', { 'data-shell': shell }, bar, results, banner);
  const bottom = h('div.ct-nav.ct-nav--bottom', { 'data-shell': shell }, strip);
  if (shell === 'mobile') bottom.prepend(card);
  else top.insertBefore(card, banner);

  renderCard(nav.state);
  renderDriving(nav.state);
  avoidSwitch.el.hidden = opts.mode !== 'drive';

  return {
    top,
    bottom,
    ctx,
    routeHere,
    routeFrom: (p) => setOrigin({ kind: 'point', lat: p.lat, lon: p.lon, name: p.name }),
    openSearch,
    menuSection: createMenuSection,
    /**
     * True just after a right press or a long press on the map: the tap the
     * picker sees as it ends is not a pick (it would drop the target).
     */
    swallowTap: () => performance.now() < swallowUntil,
    /** The view stopped (or resumed) following the vehicle: RECENTER shows while it is off. */
    setFollowing(on) {
      recenterBtn.hidden = Boolean(on);
    },
    get driving() {
      return isDriving();
    },
    /** A simulated drive (SIM) is running. */
    get simulating() {
      return simulating;
    },
    destroy() {
      end();
      unsubscribe();
      clearInterval(etaTimer);
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('keydown', onKey);
      unsubPlaces?.();
      closeCtx();
      if (canvas) {
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onCancel);
        canvas.removeEventListener('contextmenu', noMenu);
      }
    },
  };
}

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

// Navigation UI for the desktop and phone shells, ctOS style (the car has its
// own, shell-car). Everything drives one navigator (core/nav/navigator.js):
//
//   WHERE TO   a search bar always at hand (desktop: top centre; phone: under
//              the bar); results as launcher rows. A result, a long press or
//              right click on the map (ROUTE HERE), or ROUTE HERE on any
//              target card sets the destination.
//   PREVIEW    DRIVE / WALK / BIKE, AVOID HIGHWAYS, TRAFFIC (only with the
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

/**
 * @param {{
 *   nav: object, view: object|null, fixes: object, shell: 'desktop'|'mobile',
 *   settings?: object|null, near: () => ({lat:number, lon:number}|null),
 *   armTap: (fn: Function, label: string) => void,
 *   targetPoint: () => ({lat:number, lon:number, name?:string}|null),
 *   flyAlong?: (coords: number[][]) => void, notify?: Function,
 *   canvas?: HTMLCanvasElement|null, pick?: (pos: {x:number,y:number}) => ({lat:number, lon:number}|null),
 *   demo?: boolean, onActive?: (kind: 'preview'|'drive') => void, now?: () => number,
 * }} deps
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
}) {
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

  function origin2() {
    if (origin.kind === 'point') return origin;
    return fixes.get() ?? null;
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

  function renderRows(list, note = '') {
    rows = list;
    sel = -1;
    results.innerHTML = '';
    const from = origin2();
    for (const [i, r] of list.entries()) {
      const meta =
        r.meta ??
        (from && Number.isFinite(r.place?.lat)
          ? formatNavDistance(
              haversineM(from.lat, from.lon, r.place.lat, r.place.lon),
              units(),
            )
          : '');
      results.appendChild(
        h(
          'button.ct-row.ct-nav__row',
          {
            type: 'button',
            role: 'option',
            onpointerdown: (e) => e.preventDefault(), // keep the input's focus
            onclick: () => choose(i),
          },
          tile(r.glyph ?? 'frame'),
          h(
            'span.ct-row__label',
            {},
            h('span.ct-nav__name', {}, r.label),
            r.detail ? h('span.ct-nav__detail', {}, r.detail) : null,
          ),
          h('span.ct-row__meta', {}, meta),
        ),
      );
    }
    if (note) results.appendChild(h('div.ct-nav__note', {}, note));
    results.hidden = !list.length && !note;
  }

  function choose(i) {
    const r = rows[i];
    if (!r) return;
    results.hidden = true;
    input.blur();
    r.run();
  }

  function paintSel() {
    [...results.querySelectorAll('.ct-row')].forEach((el, i) =>
      el.classList.toggle('is-sel', i === sel),
    );
  }

  async function runSearch(q) {
    const seq = (searchSeq += 1);
    searchAbort?.abort();
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    searchAbort = ac;
    renderRows(
      rows.filter((r) => r.place),
      'SEARCHING',
    );
    try {
      const bias = origin2() ?? near?.() ?? null;
      const places = await nav.search(q, { near: bias, limit: 8, signal: ac?.signal });
      if (seq !== searchSeq) return;
      renderRows(
        places.map((p) => ({
          label: String(p.name).toUpperCase(),
          detail: String(p.detail ?? '').toUpperCase(),
          glyph: p.kind === 'city' ? 'frame' : 'node',
          place: p,
          run: () => routeHere(p),
        })),
        places.length ? '' : 'NO MATCH',
      );
    } catch (err) {
      if (seq !== searchSeq || err?.name === 'AbortError') return;
      console.warn('[argus] nav search failed', err?.message ?? err);
      renderRows([], 'SEARCH UNAVAILABLE');
    }
  }

  input.addEventListener('input', () => {
    clearBtn.hidden = !input.value;
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 2) {
      searchSeq += 1;
      renderRows(quickRows());
      return;
    }
    searchTimer = setTimeout(() => runSearch(q), SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener('focus', () => {
    if (!input.value.trim()) renderRows(quickRows());
    else if (rows.length) results.hidden = false;
    // Find the user now, while they type: results then show how far each is,
    // the search leans towards them, and the plan needs no wait.
    if (origin.kind === 'me' && !fixes.get()) fixes.locate({ timeoutMs: 8000 });
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement !== input) results.hidden = true;
    }, 150);
  });
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
      else if (rows[0]?.place) choose(0);
      else if (input.value.trim().length >= 2) {
        clearTimeout(searchTimer);
        runSearch(input.value.trim());
      }
    } else if (e.key === 'Escape') {
      results.hidden = true;
      input.blur();
    }
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.hidden = true;
    if (nav.state.status === 'previewing' || nav.state.status === 'planning' || dest)
      end();
    renderRows(quickRows());
    input.focus();
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

  card.append(
    h(
      'div.ct-nav__cardhead',
      {},
      h('div.ct-nav__destwrap', {}, destName, destDetail),
      demo ? h('span.ct-tag', {}, 'DEMO') : null,
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

  const unsubscribe = nav.subscribe((s) => {
    renderCard(s);
    renderDriving(s);
    changed();
  });

  // ------------------------------------------------------------- map press
  // Long press (touch, pen) or right click: ROUTE HERE / ROUTE FROM HERE.
  const ctx = h('div.ct-nav__ctx.ct-panel', { hidden: true, role: 'menu' });
  let swallowUntil = 0;
  function openCtx(pos, ll) {
    ctx.innerHTML = '';
    ctx.append(
      h('div.ct-nav__ctxhead', {}, fmtLL(ll)),
      h(
        'button.ct-row',
        {
          type: 'button',
          role: 'menuitem',
          onclick: () => (closeCtx(), routeHere({ lat: ll.lat, lon: ll.lon })),
        },
        tile('cross'),
        h('span.ct-row__label', {}, 'ROUTE HERE'),
      ),
      h(
        'button.ct-row',
        {
          type: 'button',
          role: 'menuitem',
          onclick: () => (
            closeCtx(),
            setOrigin({ kind: 'point', lat: ll.lat, lon: ll.lon })
          ),
        },
        tile('square'),
        h('span.ct-row__label', {}, 'ROUTE FROM HERE'),
      ),
    );
    ctx.hidden = false;
    const r = canvas?.getBoundingClientRect?.() ?? {
      left: 0,
      top: 0,
      width: innerWidth,
      height: innerHeight,
    };
    const w = 190;
    const x = Math.min(r.left + pos.x + 8, r.left + r.width - w - 8);
    const y = Math.min(r.top + pos.y + 8, r.top + r.height - 130);
    ctx.style.left = `${Math.max(8, x)}px`;
    ctx.style.top = `${Math.max(8, y)}px`;
  }
  function closeCtx() {
    ctx.hidden = true;
  }
  const onDocDown = (e) => {
    if (!ctx.hidden && !ctx.contains(e.target)) closeCtx();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') closeCtx();
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
        'div.ct-tool__pt',
        {},
        h('span.ct-muted', {}, 'FROM'),
        fromText,
        btn('ME', () => setOrigin({ kind: 'me' }), 'From my location'),
        btn('MAP', () => pickOrigin(), 'Pick the start on the map'),
        btn('TGT', () => originFromTarget(), 'From the selected target'),
      ),
      h(
        'div.ct-tool__pt',
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
        'Long press or right click the map: ROUTE HERE. Routes: OSRM / Valhalla (FOSSGIS), TomTom with a key. ',
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
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('keydown', onKey);
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

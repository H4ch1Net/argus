// The terminal shell's controller: state, input, commands, and the frame loop.
// I/O is injected (write, size, timers, clock), so the whole app runs headless in
// tests; index.js binds it to a real TTY.
//
// GUARDRAIL: the command set is the shared one from core (commands the app, runs
// passive public-index lookups) plus view/housekeeping commands. Nothing here
// opens a connection to a target; every read goes through the proxy allowlist.

import fs from 'node:fs';
import { createCommands } from '../core/osint/terminal/commands.js';
import { classifyAsset } from '../core/osint/asset.js';
import { PRESETS, DEFAULT_LAYERS } from '../core/presets.js';
import { shortestLonDelta } from '../core/layers/sdk/interpolate.js';
import { createTerminalLayer } from './engine.js';
import { buildLayers, makeCtSource, GLYPHS } from './layers.js';
import { createViewerAdapter } from './viewerAdapter.js';
import { builtinBasemap, loadNaturalEarth } from './basemap.js';
import {
  makeView,
  metrics,
  viewBBox,
  viewRectangleRadians,
  worldDegPerDot,
  zoomView,
  panView,
  degPerDotForAltitude,
  cellToLonLat,
  project,
  latSpan,
  DOTS_X,
  DOTS_Y,
} from './projection.js';
import { composeFrame, layout } from './ui.js';
import { createStyler, seq } from './ansi.js';

const LOG_CAP = 300;
const CT_CAP = 200;
const OSINT_CAP = 24;
const ZOOM_STEP = 1.6;

/**
 * @param {object} opts
 * @param {object} opts.backend          from backend.js
 * @param {(s: string) => void} opts.write
 * @param {() => { cols: number, rows: number }} opts.size
 * @param {boolean} [opts.unicode=true]
 * @param {'truecolor'|'256'|'none'} [opts.colorMode='256']
 * @param {{ lat: number, lon: number, span?: number }|null} [opts.at]   initial centre (and "Around Me" home)
 * @param {string[]|null} [opts.layers]    layer keys to start with (default: core's DEFAULT_LAYERS)
 * @param {() => void} [opts.onQuit]
 * @param {() => number} [opts.now]
 * @param {object} [opts.timers]
 * @param {string} [opts.satGroup]
 */
export function createTuiApp(opts) {
  const {
    backend,
    write,
    size,
    unicode = true,
    colorMode = '256',
    at = null,
    onQuit = () => {},
    now = () => Date.now(),
    timers = globalThis,
    satGroup = 'stations',
  } = opts;

  const glyphs = unicode ? GLYPHS.unicode : GLYPHS.ascii;
  const style = createStyler(colorMode);

  const state = {
    cols: 80,
    rows: 24,
    view: null,
    unicode,
    glyphs,
    backend,
    live: true,
    frozenAt: null,
    sidePanel: true,
    showGrid: unicode, // in ASCII the grid dots crowd the coastline characters
    showCities: true,
    mode: 'map', // map | command | help
    input: '',
    cursor: 0,
    history: [],
    historyIdx: -1,
    log: [],
    selected: null, // { layer, id }
    tracking: false,
    card: null,
    osint: [],
    ct: { on: false, certs: [], rate: null, stop: null },
    basemap: builtinBasemap(),
    basemapSource: 'built-in outline (fetching Natural Earth)',
    presetIdx: -1,
    mapNotice: '',
    entities: [],
    tracks: [],
    layers: [],
    now: now(),
  };

  // --- view helpers ---------------------------------------------------------

  function mapBox() {
    return layout(state.cols, state.rows, { sidePanel: state.sidePanel }).map;
  }
  function mapMetrics() {
    const b = mapBox();
    return metrics(state.view, b.w, b.h);
  }
  function worldView() {
    const b = mapBox();
    return makeView({ lon: 0, lat: 10, degPerDot: worldDegPerDot(b.w, b.h) });
  }
  const sceneNow = () => (state.live ? now() : state.frozenAt);

  const viewer = createViewerAdapter(() =>
    viewRectangleRadians(state.view, mapMetrics()),
  );
  const getQuery = () => ({ bbox: viewBBox(state.view, mapMetrics()) });

  // --- logging ---------------------------------------------------------------

  function log(text, level = 'info') {
    for (const line of String(text).split('\n')) {
      state.log.push({ at: now(), text: line, level });
    }
    if (state.log.length > LOG_CAP) state.log.splice(0, state.log.length - LOG_CAP);
    dirty = true;
  }

  // --- layers ---------------------------------------------------------------

  let dirty = true;
  const markDirty = () => {
    dirty = true;
  };
  const defs = buildLayers({
    client: backend.client,
    wsBase: backend.wsBase,
    health: backend.health,
    demo: backend.mode === 'demo',
    viewer,
    glyphs,
    satGroup,
  });
  const layers = defs.map((def) => {
    const rt = createTerminalLayer(def, { getQuery, onChange: markDirty, now, timers });
    rt.unavailable = def.unavailable;
    return rt;
  });
  const layerByKey = (key) => layers.find((l) => l.key === key) ?? null;

  async function enableLayer(rt) {
    if (rt.running) return;
    if (rt.unavailable) log(`${rt.def.label}: ${rt.unavailable}`, 'warn');
    await rt.start();
  }
  function disableLayer(rt) {
    if (!rt.running) return;
    rt.stop();
    if (state.selected?.layer === rt.key) clearSelection();
  }
  function setLayer(key, action) {
    const rt = layerByKey(key);
    if (!rt) return false;
    const on = action === 'on' || (action === 'toggle' && !rt.running);
    if (on) enableLayer(rt);
    else disableLayer(rt);
    state.presetIdx = -1;
    return true;
  }

  function applyPresetById(id) {
    const p = PRESETS.find(
      (x) => x.id === id || x.label.toLowerCase() === String(id).toLowerCase(),
    );
    if (!p) return false;
    const wanted = new Set(p.layers);
    for (const rt of layers) {
      if (wanted.has(rt.key)) enableLayer(rt);
      else disableLayer(rt);
    }
    state.presetIdx = PRESETS.indexOf(p);
    const missing = p.layers.filter((k) => !layerByKey(k));
    log(
      `preset ${p.label}${missing.length ? ` (globe-only layers skipped: ${missing.join(', ')})` : ''}`,
      'ok',
    );
    if (p.geolocate) aroundMe();
    return true;
  }

  // "Around Me" in a terminal: there is no GPS here, and asking a third-party
  // IP-geolocation service would locate the user, which this project does not
  // do. Use a home position the user chose (--at or ARGUS_HOME), else say so.
  function aroundMe() {
    if (at) {
      setView({ lon: at.lon, lat: at.lat, altitude: 120_000 });
      log(`around ${at.lat.toFixed(2)}, ${at.lon.toFixed(2)} (home)`, 'ok');
    } else {
      log(
        'Around Me needs a home position: start with --at LAT,LON or set ARGUS_HOME=LAT,LON',
        'warn',
      );
    }
  }

  // --- view changes ---------------------------------------------------------

  let settleTimer = null;
  let settledView = null; // the view the feeds were last fetched for
  function viewChanged() {
    dirty = true;
    if (settleTimer) timers.clearTimeout(settleTimer);
    settleTimer = timers.setTimeout(() => {
      settleTimer = null;
      settledView = state.view;
      for (const rt of layers) rt.viewChanged();
      viewer.fireMoveEnd();
      maybeUpgradeBasemap();
    }, 250);
  }

  function setView({ lon, lat, altitude, degPerDot }) {
    const b = mapBox();
    state.view = makeView({
      lon,
      lat,
      degPerDot:
        degPerDot ??
        (altitude ? degPerDotForAltitude(altitude, b.h) : state.view.degPerDot),
    });
    viewChanged();
  }

  function zoom(factor, anchor = null) {
    const b = mapBox();
    const before = state.view;
    let next = zoomView(before, factor, b.w, b.h);
    if (anchor && next.degPerDot !== before.degPerDot) {
      // Keep the point under the cursor where it is while zooming.
      const k = next.degPerDot / before.degPerDot;
      next = makeView({
        lon: anchor.lon + shortestLonDelta(anchor.lon, before.lon) * k,
        lat: anchor.lat + (before.lat - anchor.lat) * k,
        degPerDot: next.degPerDot,
      });
    }
    state.view = next;
    if (state.tracking && factor !== 1) followSelection();
    viewChanged();
  }

  function pan(fx, fy) {
    state.tracking = false;
    state.view = panView(state.view, mapMetrics(), fx, fy);
    viewChanged();
  }

  // Basemap: fetch Natural Earth 110m in the background, 50m when zoomed in.
  let basemapLoading = false;
  let have50m = false;
  let ne110 = null;
  async function loadBasemap(detail) {
    if (basemapLoading) return;
    basemapLoading = true;
    try {
      const bm = await loadNaturalEarth({ client: backend.client, detail });
      if (bm) {
        if (detail === '110m') ne110 = bm;
        else have50m = true;
        state.basemap = bm;
        state.basemapSource = bm.source;
        dirty = true;
      } else if (detail === '110m') {
        state.basemapSource = 'built-in outline (Natural Earth unavailable offline)';
      }
    } finally {
      basemapLoading = false;
    }
  }
  function maybeUpgradeBasemap() {
    const span = latSpan(state.view, mapMetrics());
    if (span < 25 && !have50m && ne110) loadBasemap('50m');
    else if (span >= 25 && have50m && ne110 && state.basemap !== ne110) {
      state.basemap = ne110; // the 110m outline reads better at wide zoom
      state.basemapSource = ne110.source;
      have50m = false;
    }
  }

  // --- selection + tracking -------------------------------------------------

  function entityPosition(sel) {
    if (!sel) return null;
    if (sel.layer === 'osint') {
      const o = state.osint.find((x) => x.id === sel.id);
      return o?.position ?? null;
    }
    const rt = layerByKey(sel.layer);
    return rt?.entities(sceneNow()).find((e) => e.id === sel.id)?.position ?? null;
  }

  function refreshCard() {
    const sel = state.selected;
    if (!sel) {
      state.card = null;
      return;
    }
    if (sel.layer === 'osint') {
      state.card = state.osint.find((x) => x.id === sel.id)?.card ?? null;
    } else {
      state.card = layerByKey(sel.layer)?.describe(sel.id, sceneNow()) ?? null;
    }
    if (!state.card && sel.layer !== 'osint') {
      log('selection is gone (left the feed)', 'warn');
      clearSelection();
    }
  }

  function select(sel, { track = false } = {}) {
    state.selected = sel;
    state.tracking = track;
    refreshCard();
    if (track) followSelection();
    dirty = true;
  }
  function clearSelection() {
    state.selected = null;
    state.tracking = false;
    state.card = null;
    state.tracks = [];
    dirty = true;
  }
  function followSelection() {
    const p = entityPosition(state.selected);
    if (!p) return;
    state.view = makeView({
      lon: p.longitude,
      lat: p.latitude,
      degPerDot: state.view.degPerDot,
    });
    // Refetch viewport feeds (and re-scope the AIS subscription) once the view
    // has moved a fifth of its size away from where the feeds last settled.
    const base = settledView ?? state.view;
    const m = mapMetrics();
    const lonDrift = Math.abs(shortestLonDelta(base.lon, state.view.lon));
    const latDrift = Math.abs(base.lat - state.view.lat);
    if (lonDrift > m.dLon * m.dotsW * 0.2 || latDrift > m.dLat * m.dotsH * 0.2) {
      settledView = state.view;
      viewChanged();
    }
  }

  /** Visible entities ordered by distance from the map centre. */
  function visibleByDistance() {
    const m = mapMetrics();
    const cx = m.dotsW / 2;
    const cy = m.dotsH / 2;
    return state.entities
      .map((e) => {
        const p = project(state.view, m, e.position.longitude, e.position.latitude);
        return { e, d: (p.x - cx) ** 2 + (p.y - cy) ** 2, p };
      })
      .filter(({ p }) => p.x >= 0 && p.y >= 0 && p.x < m.dotsW && p.y < m.dotsH)
      .sort((a, b) => a.d - b.d);
  }

  function cycleSelection(dir) {
    const list = visibleByDistance();
    if (!list.length) {
      log('nothing selectable in view', 'warn');
      return;
    }
    const idx = list.findIndex(
      ({ e }) =>
        state.selected && e.layer === state.selected.layer && e.id === state.selected.id,
    );
    const next = list[(idx + dir + list.length) % list.length].e;
    select({ layer: next.layer, id: next.id }, { track: false });
  }

  function selectNearCell(col, row) {
    const m = mapMetrics();
    let best = null;
    for (const e of state.entities) {
      const p = project(state.view, m, e.position.longitude, e.position.latitude);
      const dc = p.x / DOTS_X - (col + 0.5);
      const dr = p.y / DOTS_Y - (row + 0.5);
      const d = dc * dc + (dr * 2) ** 2; // a cell is about twice as tall as wide
      if (d <= 9 && (!best || d < best.d)) best = { e, d };
    }
    for (const o of state.osint) {
      if (!o.position) continue;
      const p = project(state.view, m, o.position.longitude, o.position.latitude);
      const dc = p.x / DOTS_X - (col + 0.5);
      const dr = p.y / DOTS_Y - (row + 0.5);
      const d = dc * dc + (dr * 2) ** 2;
      if (d <= 9 && (!best || d < best.d)) best = { e: { layer: 'osint', id: o.id }, d };
    }
    if (best) select({ layer: best.e.layer, id: best.e.id });
    else clearSelection();
  }

  // --- OSINT (passive) -------------------------------------------------------

  function plot(result) {
    state.osint = state.osint.filter((o) => o.id !== result.id);
    state.osint.push(result);
    if (state.osint.length > OSINT_CAP) state.osint.shift();
    select({ layer: 'osint', id: result.id });
    if (result.position) {
      setView({
        lon: result.position.longitude,
        lat: result.position.latitude,
        degPerDot: Math.min(
          state.view.degPerDot,
          degPerDotForAltitude(2_000_000, mapBox().h),
        ),
      });
    }
  }

  async function passive(kind, str) {
    const asset = classifyAsset(str);
    if (!asset) return { error: 'not a valid asset (expected ip/domain/asn)' };
    const fn = kind === 'correlate' ? backend.correlate : backend.lookup;
    if (!fn) return { error: 'lookups unavailable' };
    log(`${kind} ${asset.kind} ${asset.value}: reading public indexes...`, 'info');
    const r = await fn(asset);
    if (!r) return { error: `${kind} found nothing for ${asset.value}` };
    plot(r);
    const rows = [
      ...(r.card.rows || []),
      ...(r.card.sections || []).flatMap((s) => s.rows),
    ];
    for (const [k, v] of rows.slice(0, 8)) log(`  ${k}: ${v}`, 'info');
    return r.position
      ? { kind: asset.kind, value: asset.value }
      : { error: 'no location for that asset' };
  }

  // --- commands --------------------------------------------------------------

  const extra = [
    {
      name: 'zoom',
      usage: 'zoom <in|out|n>',
      help: 'zoom the map (n: 0 = world)',
      run: (args) => {
        const a = args[0];
        if (a === 'in') zoom(ZOOM_STEP);
        else if (a === 'out') zoom(1 / ZOOM_STEP);
        else if (/^\d+$/.test(a ?? '')) {
          state.view = { ...worldView(), lon: state.view.lon, lat: state.view.lat };
          zoom(ZOOM_STEP ** Number(a));
        } else return ['usage: zoom <in|out|n>'];
        return [`zoom ${a}`];
      },
    },
    {
      name: 'world',
      usage: 'world',
      help: 'reset to the world view',
      run: () => {
        state.tracking = false;
        state.view = worldView();
        viewChanged();
        return ['world view'];
      },
    },
    {
      name: 'find',
      usage: 'find <text>',
      help: 'search the active layers',
      run: (args) => {
        const q = args.join(' ');
        if (!q) return ['usage: find <text>'];
        const hits = layers.filter((l) => l.running).flatMap((l) => l.search(q, 5));
        if (!hits.length) return [`no match for "${q}" in the active layers`];
        return hits.slice(0, 12).map((h) => `  [${h.layer}] ${h.label}  (track ${h.id})`);
      },
    },
    {
      name: 'export',
      usage: 'export <file.json>',
      help: 'save what is in view (public data) as JSON',
      run: (args) => {
        const file = args[0];
        if (!file) return ['usage: export <file.json>'];
        collectEntities();
        const data = {
          exportedAt: new Date(now()).toISOString(),
          source: backend.label,
          bbox: getQuery().bbox,
          entities: visibleByDistance().map(({ e }) => ({
            layer: e.layer,
            id: e.id,
            position: e.position,
            card: layerByKey(e.layer)?.describe(e.id, sceneNow()) ?? null,
          })),
          osint: state.osint.map((o) => ({
            id: o.id,
            value: o.value,
            position: o.position,
            card: o.card,
          })),
        };
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        return [`wrote ${data.entities.length} entities to ${file}`];
      },
    },
    {
      name: 'status',
      usage: 'status',
      help: 'proxy, feeds and keys',
      run: () => {
        const out = [`backend: ${backend.label}`];
        if (backend.envFiles?.length) out.push(`env: ${backend.envFiles.join(', ')}`);
        for (const f of backend.health?.feeds ?? []) {
          out.push(`  feed ${f.id.padEnd(12)} ${f.configured ? 'ready' : 'needs key'}`);
        }
        for (const [k, s] of Object.entries(backend.health?.streams ?? {})) {
          out.push(
            `  ws   ${k.padEnd(12)} ${!s.available ? 'unavailable' : s.configured ? 'ready' : 'needs key'}`,
          );
        }
        out.push(`map: ${state.basemapSource}`);
        return out;
      },
    },
    {
      name: 'clear',
      usage: 'clear',
      help: 'clear the log',
      run: () => {
        state.log = [];
        return [];
      },
    },
    {
      name: 'quit',
      usage: 'quit',
      help: 'leave',
      run: () => {
        quit();
        return [];
      },
    },
  ];

  const commands = createCommands(
    {
      listLayers: () => layers.map((l) => ({ key: l.key, on: l.running })),
      setLayer,
      track: (q) => {
        for (const rt of layers.filter((l) => l.running)) {
          const hit = rt.search(q, 1)[0];
          if (hit) {
            select({ layer: rt.key, id: hit.id }, { track: true });
            return hit.label;
          }
        }
        // Exact id from `find` output.
        for (const rt of layers.filter((l) => l.running)) {
          if (rt.get(q)) {
            select({ layer: rt.key, id: q }, { track: true });
            return state.card?.title ?? q;
          }
        }
        return null;
      },
      goto: ({ latitude, longitude, altitude }) => {
        state.tracking = false;
        setView({ lon: longitude, lat: latitude, altitude: altitude ?? 1_000_000 });
      },
      geocode: backend.geocode,
      query: (s) => passive('query', s),
      correlate: (s) => passive('correlate', s),
      listPresets: () => PRESETS.map((p) => ({ id: p.id, label: p.label })),
      applyPreset: applyPresetById,
    },
    { extra },
  );

  async function runCommand(line) {
    log(`: ${line}`, 'cmd');
    const out = await commands.run(line);
    for (const l of out)
      log(l, /^(unknown|usage|error|no |query: |correlate: )/.test(l) ? 'warn' : 'info');
    dirty = true;
  }

  // --- CT ticker --------------------------------------------------------------

  let ctConnecting = false;
  async function toggleCt() {
    if (ctConnecting) return; // a toggle is already connecting
    if (state.ct.on) {
      state.ct.stop?.();
      state.ct = { on: false, certs: [], rate: null, stop: null };
      log('CT ticker off', 'info');
      return;
    }
    ctConnecting = true;
    let source;
    try {
      source = await makeCtSource({
        demo: backend.mode === 'demo',
        wsBase: backend.wsBase,
        health: backend.health,
      });
    } finally {
      ctConnecting = false;
    }
    if (!running) return;
    if (!source) {
      log('CT stream unavailable (proxy websockets are off)', 'warn');
      return;
    }
    const arrivals = [];
    state.ct.on = true;
    state.ct.stop = source((certs) => {
      const t = now();
      for (const c of certs) {
        state.ct.certs.push({ ...c, at: t });
        arrivals.push(t);
      }
      if (state.ct.certs.length > CT_CAP)
        state.ct.certs.splice(0, state.ct.certs.length - CT_CAP);
      while (arrivals.length && arrivals[0] < t - 10_000) arrivals.shift();
      state.ct.rate = arrivals.length / 10;
      dirty = true;
    });
    log(
      backend.mode === 'demo'
        ? 'CT ticker on (simulated certificates)'
        : 'CT ticker on (public CertStream is often silent; set CT_STREAM_URL for a working aggregator)',
      'info',
    );
  }

  // --- input -----------------------------------------------------------------

  function handleCommandKey(k) {
    if (k.name === 'escape') {
      state.mode = 'map';
      state.input = '';
      state.cursor = 0;
    } else if (k.name === 'enter') {
      const line = state.input.trim();
      state.mode = 'map';
      state.input = '';
      state.cursor = 0;
      state.historyIdx = -1;
      if (line) {
        state.history.push(line);
        if (state.history.length > 100) state.history.shift();
        runCommand(line);
      }
    } else if (k.name === 'backspace') {
      if (state.cursor > 0) {
        state.input =
          state.input.slice(0, state.cursor - 1) + state.input.slice(state.cursor);
        state.cursor -= 1;
      } else if (!state.input) state.mode = 'map';
    } else if (k.name === 'delete') {
      state.input =
        state.input.slice(0, state.cursor) + state.input.slice(state.cursor + 1);
    } else if (k.name === 'left') state.cursor = Math.max(0, state.cursor - 1);
    else if (k.name === 'right')
      state.cursor = Math.min(state.input.length, state.cursor + 1);
    else if (k.name === 'home' || (k.ctrl && k.name === 'a')) state.cursor = 0;
    else if (k.name === 'end' || (k.ctrl && k.name === 'e'))
      state.cursor = state.input.length;
    else if (k.ctrl && k.name === 'u') {
      state.input = state.input.slice(state.cursor);
      state.cursor = 0;
    } else if (k.name === 'up' || k.name === 'down') {
      if (!state.history.length) return;
      if (k.name === 'up') {
        state.historyIdx =
          state.historyIdx < 0
            ? state.history.length - 1
            : Math.max(0, state.historyIdx - 1);
      } else {
        state.historyIdx = state.historyIdx < 0 ? -1 : state.historyIdx + 1;
        if (state.historyIdx >= state.history.length) state.historyIdx = -1;
      }
      state.input = state.historyIdx < 0 ? '' : state.history[state.historyIdx];
      state.cursor = state.input.length;
    } else if (k.name === 'tab') {
      // Complete the command name.
      const names = Object.keys(commands.commands);
      const hits = names.filter((n) => n.startsWith(state.input.trim()));
      if (hits.length === 1) {
        state.input = `${hits[0]} `;
        state.cursor = state.input.length;
      } else if (hits.length > 1) log(hits.join('  '), 'info');
    } else if (k.ch && !k.ctrl && !k.alt) {
      state.input =
        state.input.slice(0, state.cursor) + k.ch + state.input.slice(state.cursor);
      state.cursor += k.ch.length;
    }
  }

  let dragFrom = null;
  function handleMouse(k) {
    const lay = layout(state.cols, state.rows, { sidePanel: state.sidePanel });
    const b = lay.map;
    const inMap = k.x >= b.x && k.x < b.x + b.w && k.y >= b.y && k.y < b.y + b.h;
    if (k.name === 'wheelup' || k.name === 'wheeldown') {
      if (!inMap) return;
      const p = cellToLonLat(state.view, mapMetrics(), k.x - b.x, k.y - b.y);
      zoom(k.name === 'wheelup' ? ZOOM_STEP : 1 / ZOOM_STEP, { lon: p.lon, lat: p.lat });
      return;
    }
    if (k.name === 'drag' && dragFrom) {
      const dc = k.x - dragFrom.x;
      const dr = k.y - dragFrom.y;
      if (dc || dr) {
        pan(-dc / b.w, -dr / b.h);
        dragFrom = { x: k.x, y: k.y, moved: true };
      }
      return;
    }
    if (k.name === 'mouse' && !k.release && k.button === 0) {
      dragFrom = inMap ? { x: k.x, y: k.y, moved: false } : null;
      return;
    }
    if (k.name === 'mouse' && k.release) {
      if (dragFrom && !dragFrom.moved && inMap) selectNearCell(k.x - b.x, k.y - b.y);
      else if (!dragFrom && k.button === 0 && lay.side && k.x >= lay.side.x) {
        // A click / tap on a layer row in the side panel toggles that layer.
        const hit = state.sideHits?.find((h) => h.y === k.y);
        if (hit && setLayer(hit.key, 'toggle')) {
          const rt = layerByKey(hit.key);
          log(`${rt.def.label} ${rt.running ? 'on' : 'off'}`, 'info');
        }
      }
      dragFrom = null;
    }
  }

  function handleMapKey(k) {
    const n = k.name;
    if (n === 'q' || (k.ctrl && n === 'c')) return quit();
    if (n === ':' || n === '/') {
      state.mode = 'command';
      state.input = n === '/' ? 'find ' : '';
      state.cursor = state.input.length;
    } else if (n === '?') state.mode = 'help';
    else if (n === 'up' || n === 'k') pan(0, k.shift ? -0.5 : -0.15);
    else if (n === 'down' || n === 'j') pan(0, k.shift ? 0.5 : 0.15);
    else if (n === 'left' || n === 'h') pan(k.shift ? -0.5 : -0.15, 0);
    else if (n === 'right' || n === 'l') pan(k.shift ? 0.5 : 0.15, 0);
    else if (n === 'K') pan(0, -0.5);
    else if (n === 'J') pan(0, 0.5);
    else if (n === 'H') pan(-0.5, 0);
    else if (n === 'L') pan(0.5, 0);
    else if (n === '+' || n === '=') zoom(ZOOM_STEP);
    else if (n === '-' || n === '_') zoom(1 / ZOOM_STEP);
    else if (n === 'pageup') zoom(ZOOM_STEP * ZOOM_STEP);
    else if (n === 'pagedown') zoom(1 / (ZOOM_STEP * ZOOM_STEP));
    else if (n === 'w' || n === '0' || n === 'home') {
      state.tracking = false;
      state.view = worldView();
      viewChanged();
    } else if (/^[1-9]$/.test(n)) {
      const rt = layers[Number(n) - 1];
      if (rt) {
        setLayer(rt.key, 'toggle');
        log(`${rt.def.label} ${rt.running ? 'on' : 'off'}`, 'info');
      }
    } else if (n === 'tab') cycleSelection(1);
    else if (n === 'backtab') cycleSelection(-1);
    else if (n === 'enter') {
      if (state.selected) {
        state.tracking = !state.tracking;
        if (state.tracking) followSelection();
      } else cycleSelection(1);
    } else if (n === 'escape') {
      if (state.tracking) state.tracking = false;
      else clearSelection();
    } else if (n === 'g') state.showGrid = !state.showGrid;
    else if (n === 'n') state.showCities = !state.showCities;
    else if (n === 'i') state.sidePanel = !state.sidePanel;
    else if (n === 'c') toggleCt();
    else if (n === 'p') {
      const next = (state.presetIdx + 1) % PRESETS.length;
      applyPresetById(PRESETS[next].id);
    } else if (n === ' ') {
      state.live = !state.live;
      state.frozenAt = state.live ? null : now();
      log(state.live ? 'live' : 'paused (data still arrives; motion frozen)', 'info');
    } else if (n === 'a') aroundMe();
  }

  function handleKeys(events) {
    for (const k of events) {
      if (
        k.name === 'mouse' ||
        k.name === 'wheelup' ||
        k.name === 'wheeldown' ||
        k.name === 'drag'
      ) {
        if (state.mode !== 'help') handleMouse(k);
      } else if (state.mode === 'command') handleCommandKey(k);
      else if (state.mode === 'help') state.mode = 'map';
      else handleMapKey(k);
    }
    dirty = true;
    render();
  }

  // --- frame loop --------------------------------------------------------------

  let prevLines = [];
  let rawSize = { cols: 0, rows: 0 };
  let fullRedraw = true;
  let running = false;
  let tickTimer = null;

  function collectEntities() {
    const t = sceneNow();
    const list = [];
    for (const rt of layers) {
      if (!rt.running) continue;
      const base = layers.indexOf(rt);
      for (const e of rt.entities(t)) {
        list.push({
          ...e,
          glyph: rt.def.glyph(e.n),
          priority: (rt.def.priority?.(e.n) ?? 0) + base * 0.01,
        });
      }
    }
    state.entities = list;

    // Trail (movers) or orbit (satellites) for the selection.
    state.tracks = [];
    const sel = state.selected;
    if (sel && sel.layer !== 'osint') {
      const rt = layerByKey(sel.layer);
      const n = rt?.get(sel.id);
      if (n && rt.def.track) {
        const pts = rt.def.track(n, t).map((p) => [p.longitude, p.latitude]);
        if (pts.length > 1) state.tracks.push(pts);
      } else if (n) {
        const hist = rt.history(sel.id).map((f) => [f.longitude, f.latitude]);
        if (hist.length > 1) state.tracks.push(hist);
      }
    }
  }

  function render() {
    if (!running) return;
    const { cols, rows } = size();
    // Compare the raw size: the stored one is clamped for layout, so comparing
    // against it would treat every frame on a tiny terminal as a resize.
    if (cols !== rawSize.cols || rows !== rawSize.rows) {
      rawSize = { cols, rows };
      const wasWorld =
        !state.view ||
        state.view.degPerDot >= worldDegPerDot(mapBox().w, mapBox().h) * 0.999;
      state.cols = Math.max(40, cols);
      state.rows = Math.max(12, rows);
      if (!state.view || wasWorld)
        state.view = state.view ? { ...worldView(), lon: state.view.lon } : worldView();
      fullRedraw = true;
      viewChanged();
    }
    state.now = sceneNow();
    state.layers = layers.map((rt) => ({
      key: rt.key,
      label: rt.def.label,
      hotkey: rt.def.hotkey,
      running: rt.running,
      status: rt.status,
      unavailable: rt.unavailable,
      legend: rt.def.legend,
    }));
    if (state.tracking) followSelection();
    if (state.selected) refreshCard();
    collectEntities();

    const notices = layers
      .filter((l) => l.running && l.status.message && /zoom in/.test(l.status.message))
      .map((l) => `${l.def.label}: ${l.status.message}`);
    state.mapNotice = notices[0] ?? '';

    const { screen } = composeFrame(state);
    const lines = screen.toLines(style);
    let out = fullRedraw ? seq.clear : '';
    for (let r = 0; r < lines.length; r += 1) {
      if (fullRedraw || lines[r] !== prevLines[r]) out += seq.moveTo(r, 0) + lines[r];
    }
    if (out) write(out);
    prevLines = lines;
    fullRedraw = false;
    dirty = false;
  }

  function tick() {
    const moving =
      state.live &&
      layers.some((l) => l.running && (l.def.interpolate || l.def.positionAt));
    if (dirty || moving || state.tracking || state.ct.on) render();
    else {
      // The clock in the header still advances once a second.
      const sec = Math.floor(now() / 1000);
      if (sec !== Math.floor(state.now / 1000)) render();
    }
  }

  function quit() {
    stop();
    onQuit();
  }

  async function start({ layers: initial = null } = {}) {
    running = true;
    const { cols, rows } = size();
    rawSize = { cols, rows };
    state.cols = Math.max(40, cols);
    state.rows = Math.max(12, rows);
    state.view = at
      ? makeView({
          lon: at.lon,
          lat: at.lat,
          degPerDot: at.span
            ? Math.max(0.0004, at.span / (mapBox().h * DOTS_Y))
            : degPerDotForAltitude(1_500_000, mapBox().h),
        })
      : worldView();
    if (backend.mode === 'demo')
      log(
        'DEMO DATA: every layer is simulated (no network). Drop --demo for live feeds.',
        'warn',
      );
    else log(`connected: ${backend.label}`, 'ok');
    if (
      backend.mode !== 'demo' &&
      !backend.envFiles?.length &&
      backend.mode === 'embedded'
    ) {
      log(
        'no .env found: keyless feeds only (flights via adsb.lol, quakes, satellites, OSM, BGP)',
        'info',
      );
    }
    log('press ? for keys, : for commands', 'info');
    for (const key of initial ?? DEFAULT_LAYERS) {
      const rt = layerByKey(key);
      if (rt) enableLayer(rt);
      else log(`unknown layer "${key}"`, 'warn');
    }
    if (backend.client) loadBasemap('110m');
    else state.basemapSource = 'built-in outline';
    render();
    tickTimer = timers.setInterval(tick, 250);
  }

  function stop() {
    if (!running) return;
    running = false;
    if (tickTimer) timers.clearInterval(tickTimer);
    if (settleTimer) timers.clearTimeout(settleTimer);
    for (const rt of layers) rt.stop();
    state.ct.stop?.();
  }

  return {
    state,
    layers,
    start,
    stop,
    render,
    handleKeys,
    runCommand,
    log,
    forceRedraw: () => {
      fullRedraw = true;
      render();
    },
  };
}

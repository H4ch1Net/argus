// Compose one terminal frame from the shell's state. Pure: state in, a screen
// out. The app (app.js) owns timers, input, and data; this only draws.

import { createScreen } from './screen.js';
import { createCanvas } from './canvas.js';
import { fit } from './ansi.js';
import { metrics, project, latSpan, widthKm, DOTS_X, DOTS_Y } from './projection.js';
import { drawBasemap, drawGraticule, drawPolyline } from './mapRender.js';
import { graticuleStep } from './basemap.js';
import { CITIES } from './data/cities.js';

export const THEME = {
  brand: '#57e39a',
  accent: '#57b6e3',
  text: '#d7e3ee',
  dim: '#6f8294',
  faint: '#3a4a5a',
  coast: '#4f9fbf',
  grid: '#22323f',
  track: '#e3d357',
  ok: '#57e39a',
  warn: '#e3b457',
  error: '#ff6b5b',
  demo: '#ffb454',
  cmd: '#7fd4ff',
  city: '#8193a6',
};

/** Panel geometry for a terminal size. Shared with the app for mouse mapping. */
export function layout(cols, rows, { sidePanel = true } = {}) {
  const sideW = !sidePanel
    ? 0
    : cols >= 130
      ? 44
      : cols >= 100
        ? 38
        : cols >= 80
          ? 30
          : 0;
  const logH = rows >= 44 ? 8 : rows >= 32 ? 6 : rows >= 24 ? 4 : 2;
  const mainTop = 1;
  const footerRow = rows - 1;
  const logTop = footerRow - logH; // separator row is logTop - 1
  const mainH = Math.max(3, logTop - 1 - mainTop);
  const mapW = Math.max(10, cols - (sideW ? sideW + 1 : 0));
  return {
    cols,
    rows,
    map: { x: 0, y: mainTop, w: mapW, h: mainH },
    side: sideW ? { x: mapW + 1, y: mainTop, w: sideW - 1, h: mainH } : null,
    log: { x: 0, y: logTop, w: cols, h: logH },
    sepRow: logTop - 1,
    footerRow,
  };
}

const clockText = (t) => new Date(t).toISOString().slice(11, 19);

function fmtLat(lat) {
  return `${Math.abs(lat).toFixed(2)}${lat >= 0 ? 'N' : 'S'}`;
}
function fmtLon(lon) {
  return `${Math.abs(lon).toFixed(2)}${lon >= 0 ? 'E' : 'W'}`;
}
function fmtKm(km) {
  if (km >= 1000) return `${Math.round(km).toLocaleString('en-US')} km`;
  if (km >= 10) return `${Math.round(km)} km`;
  if (km >= 1) return `${km.toFixed(1)} km`;
  return `${Math.round(km * 1000)} m`;
}
function gridLabel(v, step, pos, neg) {
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  const a = Math.abs(v).toFixed(digits);
  return v === 0 ? '0' : `${a}${v > 0 ? pos : neg}`;
}

function drawHeader(scr, state) {
  const { cols } = scr;
  scr.fill(0, 0, cols, 1, ' ', { bg: '#0b1620' });
  const g = state.unicode ? '◉' : '*';
  let x = 1;
  x += scr.text(x, 0, `${g} ARGUS`, { fg: THEME.brand, bold: true, bg: '#0b1620' });
  x += scr.text(x, 0, '  GLOBAL SIGNALS TERMINAL', { fg: THEME.dim, bg: '#0b1620' });
  const parts = [
    state.backend.mode === 'demo'
      ? { t: 'DEMO DATA', fg: THEME.demo, bold: true }
      : {
          t: state.live ? 'LIVE' : 'PAUSED',
          fg: state.live ? THEME.ok : THEME.warn,
          bold: true,
        },
    { t: state.backend.label, fg: THEME.dim },
    { t: `${fmtLat(state.view.lat)} ${fmtLon(state.view.lon)}`, fg: THEME.text },
    { t: `${fmtKm(state.scaleKm)} across`, fg: THEME.dim },
    { t: `${clockText(state.now)}Z`, fg: THEME.accent },
  ];
  const sep = '  ';
  const total =
    parts.reduce((n, p) => n + p.t.length, 0) + sep.length * (parts.length - 1);
  let rx = cols - total - 1;
  if (rx < x + 2) parts.splice(1, 2); // narrow: drop the middle items
  const total2 =
    parts.reduce((n, p) => n + p.t.length, 0) + sep.length * (parts.length - 1);
  rx = Math.max(x + 2, cols - total2 - 1);
  parts.forEach((p, i) => {
    rx += scr.text(rx, 0, p.t, { fg: p.fg, bold: p.bold, bg: '#0b1620' });
    if (i < parts.length - 1) rx += scr.text(rx, 0, sep, { bg: '#0b1620' });
  });
}

function drawMap(scr, box, state) {
  const view = state.view;
  const m = metrics(view, box.w, box.h);
  const canvas = createCanvas(box.w, box.h);
  const gridInk = canvas.ink('grid', THEME.grid, 0);
  const coastInk = canvas.ink('coast', THEME.coast, 1);
  const trackInk = canvas.ink('track', THEME.track, 2);

  const step = state.showGrid
    ? drawGraticule(canvas, gridInk, view, m)
    : graticuleStep(latSpan(view, m));
  if (state.basemap) drawBasemap(canvas, coastInk, view, m, state.basemap);
  for (const track of state.tracks || []) drawPolyline(canvas, trackInk, view, m, track);

  const cellOf = (lon, lat) => {
    const p = project(view, m, lon, lat);
    if (p.x < 0 || p.y < 0 || p.x >= m.dotsW || p.y >= m.dotsH) return null;
    return { col: Math.floor(p.x / DOTS_X), row: Math.floor(p.y / DOTS_Y) };
  };

  // Entities: highest priority wins a contested cell; the selection always wins.
  const visible = [];
  for (const e of state.entities) {
    const c = cellOf(e.position.longitude, e.position.latitude);
    if (!c) continue;
    const selected =
      state.selected && e.layer === state.selected.layer && e.id === state.selected.id;
    const priority = selected ? 1e6 : (e.priority ?? 0);
    if (
      canvas.glyph(c.col, c.row, e.glyph.ch, e.glyph.color, {
        priority,
        bold: e.glyph.bold || selected,
      })
    ) {
      visible.push({ ...e, ...c, selected });
    }
  }

  // OSINT query results: always on top, labelled with the asset.
  for (const o of state.osint || []) {
    if (!o.position) continue;
    const c = cellOf(o.position.longitude, o.position.latitude);
    if (!c) continue;
    const color = o.variant === 'correlated' ? '#ff7ad9' : THEME.brand;
    canvas.glyph(c.col, c.row, state.glyphs.osint, color, { priority: 2e6, bold: true });
    canvas.text(c.col + 2, c.row, o.value, color, { priority: 1.5e6, bold: true });
  }

  // Place names for orientation: more of them as you zoom in, placed greedily by
  // rank so labels never overlap each other or any entity.
  if (state.showCities) {
    const span = latSpan(view, m);
    const maxRank = span > 90 ? 1 : span > 25 ? 2 : 3;
    for (const [name, lat, lon, rank] of CITIES) {
      if (rank > maxRank) continue;
      const c = cellOf(lon, lat);
      if (!c) continue;
      // Strict ASCII mode also drops accents (São Paulo -> Sao Paulo).
      const shown = state.unicode
        ? name
        : name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const label = `${state.unicode ? '∙' : '.'}${shown}`;
      if (!canvas.free(c.col, c.row, label.length)) continue;
      canvas.text(c.col, c.row, label, THEME.city, { priority: -0.5 });
    }
  }

  // Graticule labels along the left and top edges, under every entity glyph.
  if (state.showGrid) {
    const halfLat = (m.dotsH / 2) * m.dLat;
    const lat0 = Math.max(-90, Math.ceil((view.lat - halfLat) / step) * step);
    const lat1 = Math.min(90, view.lat + halfLat);
    for (let lat = lat0; lat <= lat1; lat += step) {
      const c = cellOf(view.lon, lat);
      if (c)
        canvas.text(0, c.row, gridLabel(+lat.toFixed(6), step, 'N', 'S'), THEME.faint, {
          priority: -1,
        });
    }
    const halfLon = (m.dotsW / 2) * m.dLon;
    if (halfLon < 180) {
      for (
        let lon = Math.ceil((view.lon - halfLon) / step) * step;
        lon <= view.lon + halfLon;
        lon += step
      ) {
        const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
        const c = cellOf(wrapped, view.lat);
        if (!c || c.col < 4 || c.col > box.w - 6) continue;
        canvas.text(
          c.col,
          0,
          gridLabel(+wrapped.toFixed(6), step, 'E', 'W'),
          THEME.faint,
          { priority: -1 },
        );
      }
    }
  }

  const cells = canvas.toCells({ ascii: !state.unicode });
  for (let r = 0; r < box.h; r += 1) {
    for (let c = 0; c < box.w; c += 1) {
      const cell = cells[r * box.w + c];
      scr.put(box.x + c, box.y + r, cell.ch, { fg: cell.fg, bold: cell.bold });
    }
  }

  // Selection: invert the glyph and label it.
  const sel = visible.find((v) => v.selected);
  if (sel) {
    // Inverse video works in every colour mode, including none.
    scr.put(box.x + sel.col, box.y + sel.row, sel.glyph.ch, {
      fg: sel.glyph.color,
      inverse: true,
      bold: true,
    });
    if (state.card?.title) {
      const label = ` ${state.card.title} `;
      const lx =
        sel.col + 2 + label.length < box.w ? sel.col + 2 : sel.col - label.length - 1;
      scr.text(box.x + Math.max(0, lx), box.y + sel.row, label, {
        fg: THEME.track,
        inverse: true,
        bold: true,
      });
    }
  }

  // Map notices (centered top), e.g. "zoom in to load surveillance".
  if (state.mapNotice) {
    const t = ` ${state.mapNotice} `;
    scr.text(box.x + Math.max(0, Math.floor((box.w - t.length) / 2)), box.y + 1, t, {
      fg: THEME.warn,
      inverse: true,
    });
  }
  return visible.length;
}

function stateDot(layer, unicode) {
  const on = unicode ? '●' : '*';
  const off = unicode ? '○' : 'o';
  if (!layer.running) return { ch: off, fg: THEME.faint };
  const s = layer.status.state;
  if (s === 'error') return { ch: '!', fg: THEME.error };
  if (s === 'loading' || s === 'waiting') return { ch: on, fg: THEME.warn };
  return { ch: on, fg: THEME.ok };
}

function drawSide(scr, box, state) {
  let y = box.y;
  const w = box.w;
  const head = (title) => {
    if (y >= box.y + box.h) return;
    scr.text(box.x, y, fit(` ${title}`, w), {
      fg: THEME.accent,
      bold: true,
      bg: '#0e1b26',
    });
    y += 1;
  };
  const line = (text, style = {}) => {
    if (y >= box.y + box.h) return;
    scr.text(box.x, y, fit(text, w, state.unicode ? '…' : '~'), style);
    y += 1;
  };

  head('LAYERS');
  // With many layers and a short terminal, list the running ones first and
  // fold the rest into a "+N more" line, so the selection card stays visible.
  // Each drawn row is recorded for click / tap toggling (state.sideHits).
  const budget = Math.max(5, box.h - 10);
  let rows = state.layers;
  let hidden = 0;
  if (rows.length > budget) {
    const ordered = [...rows.filter((l) => l.running), ...rows.filter((l) => !l.running)];
    rows = ordered.slice(0, budget - 1);
    hidden = ordered.length - rows.length;
  }
  state.sideHits = [];
  for (const l of rows) {
    if (y >= box.y + box.h) break;
    state.sideHits.push({ y, key: l.key });
    const d = stateDot(l, state.unicode);
    scr.text(box.x + 1, y, l.hotkey, { fg: THEME.dim });
    scr.text(box.x + 3, y, d.ch, { fg: d.fg, bold: true });
    scr.text(box.x + 5, y, fit(l.label, 13), { fg: l.running ? THEME.text : THEME.dim });
    let note = '';
    let noteFg = THEME.dim;
    if (l.running) {
      if (l.status.state === 'error') {
        note = l.status.message;
        noteFg = THEME.error;
      } else if (l.status.state === 'loading') note = 'loading';
      else if (l.status.state === 'waiting') note = 'waiting';
      else note = l.status.message || String(l.status.count);
    } else if (l.unavailable) {
      note = l.unavailable;
      noteFg = THEME.faint;
    }
    scr.text(box.x + 19, y, fit(note, Math.max(0, w - 19), '~'), { fg: noteFg });
    y += 1;
  }
  if (hidden) line(` +${hidden} more (:layer NAME, or :layers)`, { fg: THEME.faint });
  y += 1;

  const card = state.card;
  if (card) {
    head(state.tracking ? 'TRACKING' : 'SELECTED');
    line(` ${card.title}`, { fg: THEME.text, bold: true });
    if (card.subtitle) line(` ${card.subtitle}`, { fg: THEME.dim });
    const kv = (k, v) => {
      if (y >= box.y + box.h) return;
      const kw = Math.min(16, Math.floor(w * 0.45));
      scr.text(box.x + 1, y, fit(k, kw), { fg: THEME.dim });
      scr.text(box.x + 2 + kw, y, fit(String(v), Math.max(0, w - kw - 2), '~'), {
        fg: THEME.text,
      });
      y += 1;
    };
    for (const [k, v] of card.rows || []) kv(k, v);
    for (const sec of card.sections || []) {
      line(` ${sec.title}`, { fg: THEME.accent });
      for (const [k, v] of sec.rows) kv(k, v);
    }
    for (const l of card.links || []) kv(l.label, l.url);
    y += 1;
  }

  if (y < box.y + box.h - 2) {
    head('LEGEND');
    for (const l of state.layers) {
      if (!l.running || !l.legend) continue;
      line(` ${l.legend()}`, { fg: THEME.dim });
    }
    line(` ${state.glyphs.osint} OSINT query result`, { fg: THEME.dim });
  }

  if (state.basemapSource && y < box.y + box.h) {
    scr.text(box.x, box.y + box.h - 1, fit(` map: ${state.basemapSource}`, w), {
      fg: THEME.faint,
    });
  }
}

function drawLog(scr, box, sepRow, state) {
  const title = state.ct?.on
    ? ` CT ISSUANCE ${state.ct.rate != null ? `${state.ct.rate.toFixed(1)}/s` : ''} `
    : ' LOG ';
  scr.hline(0, sepRow, scr.cols, state.unicode ? '─' : '-', { fg: THEME.faint });
  scr.text(2, sepRow, title, { fg: THEME.accent, bold: true });
  if (state.ct?.on) {
    const certs = state.ct.certs.slice(-box.h);
    certs.forEach((c, i) => {
      const y = box.y + i;
      scr.text(1, y, clockText(c.at), { fg: THEME.dim });
      scr.text(11, y, fit(c.domain, Math.max(10, box.w - 50)), { fg: THEME.text });
      scr.text(Math.max(22, box.w - 38), y, fit(`+${c.domains}`, 6), { fg: THEME.dim });
      scr.text(Math.max(29, box.w - 31), y, fit(c.ca, 30), { fg: THEME.accent });
    });
    return;
  }
  const colors = {
    info: THEME.text,
    ok: THEME.ok,
    warn: THEME.warn,
    error: THEME.error,
    cmd: THEME.cmd,
  };
  const lines = state.log.slice(-box.h);
  lines.forEach((l, i) => {
    const y = box.y + i;
    scr.text(1, y, clockText(l.at), { fg: THEME.faint });
    scr.text(11, y, fit(l.text, box.w - 12, '~'), { fg: colors[l.level] || THEME.text });
  });
}

function drawFooter(scr, row, state) {
  scr.fill(0, row, scr.cols, 1, ' ', { bg: '#0b1620' });
  if (state.mode === 'command') {
    scr.text(0, row, ':', { fg: THEME.cmd, bold: true, bg: '#0b1620' });
    const before = state.input.slice(0, state.cursor);
    const at = state.input[state.cursor] ?? ' ';
    const after = state.input.slice(state.cursor + 1);
    const w = scr.cols - 2;
    // Keep the cursor visible on long input.
    const start = Math.max(0, before.length - w + 2);
    let x = 1;
    x += scr.text(x, row, before.slice(start), { fg: THEME.text, bg: '#0b1620' });
    scr.put(x, row, at, { fg: THEME.cmd, inverse: true });
    scr.text(x + 1, row, after, { fg: THEME.text, bg: '#0b1620' }, scr.cols - x - 1);
    return;
  }
  const hints = [
    ['?', 'help'],
    [':', 'command'],
    ['1-9', 'layers'],
    [state.unicode ? '←↑→↓' : 'arrows', 'pan'],
    ['+/-', 'zoom'],
    ['tab', 'next'],
    ['enter', 'track'],
    ['c', 'CT'],
    ['q', 'quit'],
  ];
  let x = 1;
  for (const [k, v] of hints) {
    if (x + k.length + v.length + 3 > scr.cols) break;
    x += scr.text(x, row, k, { fg: THEME.cmd, bold: true, bg: '#0b1620' });
    x += scr.text(x, row, ` ${v}  `, { fg: THEME.dim, bg: '#0b1620' });
  }
}

export const HELP_LINES = [
  'KEYS',
  '  arrows / h j k l   pan            + - (or wheel)   zoom in / out',
  '  w                  world view     g / n            graticule / place names',
  '  1-9                toggle layer   p                cycle presets',
  '  tab / shift-tab    select next / previous entity in view',
  '  enter              track the selection (map follows it)',
  '  esc                stop tracking / clear selection',
  '  click              select the nearest entity (mouse)',
  '  c                  CT issuance ticker    i   side panel',
  '  a                  Around Me (home from --at or ARGUS_HOME)',
  '  space              pause / resume map motion    q   quit',
  '',
  'COMMANDS (press : then type)',
  '  goto <lat,lon> | <place>      track <callsign|name|id>',
  '  query <ip|domain|asn>         correlate <ip|domain|asn>',
  '  layer <id> [on|off]           layers   presets   preset <name>',
  '  zoom <in|out|n>   world   find <text>   export <file.json>',
  '  status   clear   help   quit',
  '',
  'Passive only: lookups read public indexes (RIPEstat, Shodan host data);',
  'nothing is ever sent at a target. Inputs are assets, never people.',
];

function drawHelp(scr, box, state) {
  const w = Math.min(box.w - 4, 78);
  const h = Math.min(box.h - 2, HELP_LINES.length + 2);
  const x0 = box.x + Math.floor((box.w - w) / 2);
  const y0 = box.y + Math.max(0, Math.floor((box.h - h) / 2));
  scr.fill(x0, y0, w, h, ' ', { bg: '#0e1b26' });
  HELP_LINES.slice(0, h - 2).forEach((l, i) => {
    const heading = l && !l.startsWith(' ');
    scr.text(x0 + 2, y0 + 1 + i, fit(l, w - 4, state.unicode ? '…' : '~'), {
      fg: heading ? THEME.accent : THEME.text,
      bold: heading,
      bg: '#0e1b26',
    });
  });
}

/**
 * @param {object} state  see app.js for the shape
 * @returns {{ screen: object, lay: object, visibleCount: number }}
 */
export function composeFrame(state) {
  const lay = layout(state.cols, state.rows, { sidePanel: state.sidePanel });
  const scr = createScreen(state.cols, state.rows);
  const m = metrics(state.view, lay.map.w, lay.map.h);
  state.scaleKm = widthKm(state.view, m);

  drawHeader(scr, state);
  const visibleCount = drawMap(scr, lay.map, state);
  if (lay.side) {
    scr.vline(lay.side.x - 1, lay.side.y, lay.side.h, state.unicode ? '│' : '|', {
      fg: THEME.faint,
    });
    drawSide(scr, lay.side, state);
  }
  drawLog(scr, lay.log, lay.sepRow, state);
  drawFooter(scr, lay.footerRow, state);
  if (state.mode === 'help') drawHelp(scr, lay.map, state);
  return { screen: scr, lay, visibleCount };
}

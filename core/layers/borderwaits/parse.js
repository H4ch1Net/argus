// Pure parsers for land border wait times, and the join that places them on
// the bundled ports table (./data/ports.js). Shared by every shell.
//
// - US Customs and Border Protection, Border Wait Times: GET
//   https://bwt.cbp.gov/api/bwtnew, one JSON record per crossing (time to enter
//   the US). Per CBP's public site and its documented JSON, not live-tested here.
// - Canada Border Services Agency, Border Wait Times open data: GET
//   https://www.cbsa-asfc.gc.ca/bwt-taf/bwt-eng.csv (time to enter Canada).
//   Per the open-data listing as remembered, not live-tested here; the parser
//   finds its columns by their headings, so a column order change is harmless.
//
// GUARDRAIL: published queue times at public crossings. Nothing here concerns
// any person or vehicle.

import { PORTS } from './data/ports.js';

const list = (v) => (Array.isArray(v) ? v : []);
const text = (v, max = 120) =>
  typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : null;
const int = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isInteger(n) && n >= 0 && n < 100_000 ? n : null;
};

/** Lower-case words only: "B&M Bridge" -> "b and m bridge". */
export const normName = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * One CBP lane group (e.g. passenger_vehicle_lanes.standard_lanes) -> { delay
 * (minutes, 0 for "no delay", null when unknown), open (lanes open), closed,
 * status, updated }, or null when the lane does not exist at this crossing.
 */
export function cbpLane(l) {
  if (!l || typeof l !== 'object') return null;
  const status = normName(l.operational_status);
  if (!status || status === 'n a' || status === 'na') return null;
  const closed = /closed/.test(status);
  const delay = closed ? null : /no delay/.test(status) ? 0 : int(l.delay_minutes);
  return {
    delay,
    open: int(l.lanes_open),
    closed,
    pending: /pending/.test(status),
    updated: text(l.update_time, 40),
  };
}

const LANES = {
  passenger: [
    ['passenger_vehicle_lanes', 'standard_lanes', 'Passenger'],
    ['passenger_vehicle_lanes', 'NEXUS_SENTRI_lanes', 'SENTRI / NEXUS'],
    ['passenger_vehicle_lanes', 'ready_lanes', 'Ready Lane'],
  ],
  commercial: [
    ['commercial_vehicle_lanes', 'standard_lanes', 'Commercial'],
    ['commercial_vehicle_lanes', 'FAST_lanes', 'Commercial FAST'],
  ],
  pedestrian: [
    ['pedestrian_lanes', 'standard_lanes', 'Pedestrian'],
    ['pedestrian_lanes', 'ready_lanes', 'Pedestrian Ready Lane'],
  ],
};

/**
 * CBP Border Wait Times: [{ port_number, border, port_name, crossing_name,
 * hours, date, time, port_status, passenger_vehicle_lanes: { standard_lanes:
 * { operational_status, delay_minutes, lanes_open, update_time }, ... },
 * commercial_vehicle_lanes, pedestrian_lanes, construction_notice }]. The
 * whole list may also come wrapped ({ port: [...] }).
 */
export function parseCbp(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : list(payload?.port ?? payload?.ports ?? payload?.data);
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const port = text(r?.port_name, 80);
    if (!port) continue;
    const crossing = text(r?.crossing_name, 80) ?? '';
    const number = String(r?.port_number ?? '').trim();
    const key = /^\d{4,8}$/.test(number) ? number : `${port}|${crossing}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lanes = [];
    for (const group of Object.values(LANES))
      for (const [g, k, label] of group) {
        const lane = cbpLane(r?.[g]?.[k]);
        if (lane) lanes.push({ label, kind: g, ...lane });
      }
    const borderText = normName(r?.border);
    out.push({
      key,
      port,
      crossing,
      border: /canad/.test(borderText) ? 'ca' : /mexic/.test(borderText) ? 'mx' : null,
      status: text(r?.port_status, 40),
      hours: text(r?.hours, 60),
      updated: [text(r?.date, 20), text(r?.time, 20)].filter(Boolean).join(' ') || null,
      notice: text(r?.construction_notice, 240),
      lanes,
    });
  }
  return out;
}

// --- CBSA (CSV) ---------------------------------------------------------------

const MAX_CSV_CHARS = 2 * 1024 * 1024;

/** RFC 4180-style CSV -> rows of fields (quotes, doubled quotes, CRLF). */
export function parseCsv(textIn) {
  const s = typeof textIn === 'string' && textIn.length <= MAX_CSV_CHARS ? textIn : '';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

/**
 * A CBSA delay phrase -> { delay (minutes, 0 for no delay, null otherwise),
 * text }: "No delay", "10 minutes", "1 hour 15 minutes", "Not applicable",
 * "Closed", or their French forms.
 */
export function cbsaDelay(raw) {
  const t = text(String(raw ?? '').replace(/\uFEFF/g, ''), 60);
  if (!t) return null;
  const n = normName(t);
  if (/not applicable|sans objet|^n a$/.test(n)) return null;
  if (/no delay|aucun d/.test(n)) return { delay: 0, text: t, closed: false };
  if (/closed|ferm/.test(n)) return { delay: null, text: t, closed: true };
  const h = /(\d{1,2})\s*(?:h|hr|hrs|hour|hours|heure|heures)\b/.exec(n);
  const m = /(\d{1,3})\s*(?:min|mins|minute|minutes)\b/.exec(n);
  if (!h && !m) return { delay: null, text: t, closed: false };
  return {
    delay: (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0),
    text: t,
    closed: false,
  };
}

/**
 * CBSA border wait times CSV -> [{ office, location, updated, travellers,
 * commercial }], columns found by heading (office / location / updated /
 * travellers / commercial, English or French).
 */
export function parseCbsa(csv) {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => normName(h.replace(/\uFEFF/g, '')));
  const col = (re) => head.findIndex((h) => re.test(h));
  const iOffice = col(/office|bureau/);
  const iLocation = col(/location|lieu|emplacement/);
  const iUpdated = col(/updated|mise a jour|mis a jour|last/);
  const iTravel = col(/travel|voyageur|passenger/);
  const iCommercial = col(/commercial/);
  if (iOffice < 0 || (iTravel < 0 && iCommercial < 0)) return [];
  const out = [];
  for (const r of rows.slice(1)) {
    const office = text(r[iOffice], 100);
    if (!office) continue;
    out.push({
      office,
      location: iLocation >= 0 ? text(r[iLocation], 100) : null,
      updated: iUpdated >= 0 ? text(r[iUpdated], 40) : null,
      travellers: iTravel >= 0 ? cbsaDelay(r[iTravel]) : null,
      commercial: iCommercial >= 0 ? cbsaDelay(r[iCommercial]) : null,
    });
  }
  return out;
}

// --- The join -------------------------------------------------------------------

const matches = (m, port, crossing) =>
  m.port.test(port) &&
  (!m.crossing || m.crossing.test(crossing)) &&
  (!m.skip || !m.skip.test(crossing));

/** The bundled port a CBP record belongs to, or null. */
export function portForCbp(row, ports = PORTS) {
  const port = normName(row.port);
  const crossing = normName(row.crossing);
  return ports.find((p) => p.cbp.some((m) => matches(m, port, crossing))) ?? null;
}

/** The bundled port a CBSA record belongs to, or null. */
export function portForCbsa(row, ports = PORTS) {
  const t = normName(`${row.office} ${row.location ?? ''}`);
  return ports.find((p) => p.cbsa && p.cbsa.test(t)) ?? null;
}

/**
 * Place both feeds on the bundled ports: [{ ...port, cbp: [records], cbsa:
 * record|null }] for every port with data, plus the CBP records with no
 * bundled position (kept out of the map, counted in the layer's note).
 */
export function joinPorts(cbpRows = [], cbsaRows = [], ports = PORTS) {
  const byId = new Map();
  const entry = (p) => {
    let e = byId.get(p.id);
    if (!e) {
      e = {
        id: p.id,
        name: p.name,
        border: p.border,
        state: p.state,
        lat: p.lat,
        lon: p.lon,
        confidence: p.confidence,
        cbp: [],
        cbsa: null,
      };
      byId.set(p.id, e);
    }
    return e;
  };
  const unplaced = [];
  for (const r of cbpRows) {
    const p = portForCbp(r, ports);
    if (p) entry(p).cbp.push(r);
    else unplaced.push(r);
  }
  for (const r of cbsaRows) {
    const p = portForCbsa(r, ports);
    if (p && !byId.get(p.id)?.cbsa) entry(p).cbsa = r;
  }
  // Table order (west to east along each border).
  const order = new Map(ports.map((p, i) => [p.id, i]));
  return {
    ports: [...byId.values()].sort((a, b) => order.get(a.id) - order.get(b.id)),
    unplaced,
  };
}

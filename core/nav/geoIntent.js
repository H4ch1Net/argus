// Places and navigation actions handed to Argus by Gemini or Google Assistant
// (and by any app that opens a geo: link): "navigate to the airport" arrives
// as geo:0,0?q=the+airport. The assistant does the listening and turns the
// speech into this text; Argus never records or hears anything itself. The
// formats are Google's navigation app intents
// (developer.android.com/develop/devices/assistant/intents-assistant-nav-app):
//
//   navigate (androidx.car.app.action.NAVIGATE, android.intent.action.NAVIGATE)
//     geo:0,0?q=Googleplex                      a place to search for
//     geo:1.1,2.2?q=Starbucks+on+Main+Street    the same, near 1.1, 2.2
//     geo:47.6,-122.2                           a point
//     geo:0,0?q=47.6,-122.2(Pier+57)            a point with its name
//     ...&intent=navigation|directions|add_a_stop  &avoid=htf  &mode=d
//   search (android.intent.action.VIEW)
//     geo:0,0?q=restaurants+nearby              a list to pick from
//   action (android.intent.action.VIEW, scheme geo.action)
//     geo.action:?act=exit_navigation           exit, eta, show_traffic, ...
//
// Pure: the car page (shell-car) and the phone (main.js) share it; the
// destinations are places, never people.

import { formatClock, formatNavDistance, formatNavDuration } from './format.js';

/** A request's text is cut at this length (a destination, never a document). */
export const GEO_QUERY_MAX = 200;
/** A voice "navigate to" starts at once when the best match is this close. */
export const AUTO_START_M = 80_000;

const COORDS =
  /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*(?:\(([\s\S]*)\))?\s*$/;
const INTENTS = new Set(['navigation', 'directions', 'add_a_stop']);

function decode(s) {
  const plus = String(s ?? '').replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plus);
  } catch {
    return plus;
  }
}

function point(lat, lon) {
  const a = Number(lat);
  const b = Number(lon);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  // 0,0 is the formats' "no point here".
  if (a === 0 && b === 0) return null;
  return { lat: a, lon: b };
}

const clean = (s, max = GEO_QUERY_MAX) =>
  String(s ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/**
 * Read a geo: or geo.action: URI. `kind` is what the intent's action asked
 * for: 'navigate' (the NAVIGATE actions) or 'search' (VIEW); a geo.action URI
 * is always an 'action'. Null for anything else.
 *
 * @returns {null | {
 *   kind: 'navigate'|'search'|'action',
 *   query: string,
 *   dest: {lat:number, lon:number, name:string}|null,
 *   near: {lat:number, lon:number}|null,
 *   intent: 'navigation'|'directions'|'add_a_stop',
 *   avoid: {highways:boolean, tolls:boolean, ferries:boolean},
 *   mode: string|null,
 *   act: string|null,
 *   params: Record<string, string>,
 * }}
 */
export function parseGeoIntent(uri, kind = 'navigate') {
  const raw = String(uri ?? '')
    .trim()
    .slice(0, 2000);
  const m = /^(geo(?:\.action)?)(?:\.offline)?:([\s\S]*)$/i.exec(raw);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const rest = m[2];
  const qAt = rest.indexOf('?');
  const path = qAt < 0 ? rest : rest.slice(0, qAt);
  const params = {};
  if (qAt >= 0) {
    for (const pair of rest.slice(qAt + 1).split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const key = decode(eq < 0 ? pair : pair.slice(0, eq))
        .trim()
        .toLowerCase();
      if (!key || key in params) continue;
      params[key] = clean(decode(eq < 0 ? '' : pair.slice(eq + 1)), 400);
    }
  }
  const avoidCodes = String(params.avoid ?? '').toLowerCase();
  const base = {
    query: '',
    dest: null,
    near: null,
    intent: INTENTS.has(params.intent) ? params.intent : 'navigation',
    avoid: {
      highways: avoidCodes.includes('h'),
      tolls: avoidCodes.includes('t'),
      ferries: avoidCodes.includes('f'),
    },
    mode: /^[bdxlrw]$/.test(params.mode ?? '') ? params.mode : null,
    act: null,
    params,
  };
  if (scheme === 'geo.action') {
    const act = String(params.act ?? '')
      .toLowerCase()
      .replace(/[^a-z_]/g, '')
      .slice(0, 40);
    return act ? { ...base, kind: 'action', act } : null;
  }
  // The point: "lat,lon", RFC 5870 extras (";u=35") dropped.
  const [latS, lonS] = decode(path).split(';')[0].split(',');
  const at = point(latS, lonS);
  const q = params.q ?? '';
  const coords = COORDS.exec(q);
  const out = { ...base, kind: kind === 'search' ? 'search' : 'navigate' };
  if (coords) {
    const p = point(coords[1], coords[2]);
    if (p) return { ...out, dest: { ...p, name: clean(coords[3] ?? '', 120) } };
  }
  const text = clean(q);
  if (text) return { ...out, query: text, near: at };
  if (at) return { ...out, dest: { ...at, name: '' } };
  return null;
}

/** "33.7215, -116.1940": a point with no name. */
export const pointName = (p) =>
  `${Number(p.lat).toFixed(4)}, ${Number(p.lon).toFixed(4)}`;

/** A name as said: lower case, letters and digits, no leading "the". */
const sameName = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the /, '');

/**
 * What to do with a navigate or search request once its search (if any) has
 * answered. `results` are search payload places ({ name, lat, lon,
 * distanceM?, ... }, best first).
 *
 *   { kind: 'route', place, autoStart, note? }   a route preview (autoStart: drive it)
 *   { kind: 'list', query, results }             the driver picks one
 *   { kind: 'message', message }                 nothing to go to
 *
 * A voice "navigate to" starts at once when there is one match, or the best
 * one is within AUTO_START_M, or one with exactly the name asked for is
 * (Google's "navigation starts"); otherwise the matches are listed
 * (Google's "the user is asked to choose"). "Directions
 * to" and "add a stop" show the route without starting it (Argus has no
 * stops: the route goes to the stop alone, and the preview says so).
 */
export function planGeoIntent(req, results = []) {
  if (!req || req.kind === 'action')
    return { kind: 'message', message: 'NOT A DESTINATION' };
  const note =
    req.intent === 'add_a_stop' ? 'NO STOPS IN ARGUS: ROUTE TO IT ALONE' : null;
  const drive = req.kind === 'navigate' && req.intent === 'navigation';
  if (req.dest) {
    const place = {
      id: `pin:${req.dest.lat.toFixed(5)},${req.dest.lon.toFixed(5)}`,
      name: req.dest.name || pointName(req.dest),
      detail: req.dest.name ? pointName(req.dest) : '',
      kind: 'pin',
      lat: req.dest.lat,
      lon: req.dest.lon,
    };
    return { kind: 'route', place, autoStart: drive, ...(note ? { note } : {}) };
  }
  const found = (results || []).filter(
    (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon),
  );
  if (!found.length)
    return {
      kind: 'message',
      message: `NO PLACES FOUND: ${req.query.toUpperCase()}`.slice(0, 120),
    };
  if (req.kind === 'search') return { kind: 'list', query: req.query, results: found };
  const top = found[0];
  const isClose = (p) => !Number.isFinite(p.distanceM) || p.distanceM <= AUTO_START_M;
  if (drive && (found.length === 1 || isClose(top)))
    return { kind: 'route', place: top, autoStart: true };
  // The best match far away, but one with exactly the name asked for close
  // by ("Home Depot": The Home Depot 3 km away, not a Home Depot Power Center
  // 100 km off): that one.
  const said = sameName(req.query);
  const named = found.find((p) => isClose(p) && sameName(p.name) === said);
  if (drive && named) return { kind: 'route', place: named, autoStart: true };
  if (drive) return { kind: 'list', query: req.query, results: found };
  return { kind: 'route', place: top, autoStart: false, ...(note ? { note } : {}) };
}

/**
 * The answer to a geo.action request ("what's my ETA", "exit navigation",
 * "show traffic"). `nav` is the car's navigation payload (shell-car/nav.js
 * navPayload), or null when not navigating; `trafficAvailable` says whether
 * the traffic flow layer can show (it needs the TomTom key). The reply's
 * message is shown on the car screen; act-specific fields tell the caller
 * what to change:
 *
 *   { act, message, stop?, follow?, overview?, layer?, on?, avoidHighways? }
 *
 * Every act Google lists gets an answer: those Argus cannot do say so.
 */
export function answerGeoAction(
  act,
  { nav = null, trafficAvailable = false, units = 'metric', clock = formatClock } = {},
) {
  const driving = ['navigating', 'rerouting', 'arrived'].includes(nav?.status);
  const reply = (message, extra = {}) => ({ act, message, ...extra });
  const notDriving = () => reply('NOT NAVIGATING');
  const dist = (m) => formatNavDistance(m, units);
  switch (act) {
    case 'exit_navigation':
      return driving ? reply('NAVIGATION ENDED', { stop: true }) : notDriving();
    case 'follow_mode':
      return reply('FOLLOWING YOU', { follow: true });
    case 'route_overview':
      return driving ? reply('ROUTE OVERVIEW', { overview: true }) : notDriving();
    case 'show_traffic':
    case 'hide_traffic': {
      const on = act === 'show_traffic';
      if (!trafficAvailable)
        return reply('TRAFFIC FLOW NEEDS A TOMTOM KEY: PHONE APP, SETUP');
      return reply(on ? 'TRAFFIC FLOW ON' : 'TRAFFIC FLOW OFF', {
        layer: 'trafficflow',
        on,
      });
    }
    case 'avoid_highways':
      return reply('AVOIDING HIGHWAYS', { avoidHighways: true });
    case 'allow_highways':
      return reply('HIGHWAYS ALLOWED', { avoidHighways: false });
    case 'avoid_tolls':
    case 'allow_tolls':
    case 'avoid_ferries':
    case 'allow_ferries':
      return reply('ARGUS CAN ONLY AVOID HIGHWAYS');
    case 'eta':
    case 'time_to_destination': {
      if (!driving) return notDriving();
      const left = formatNavDuration(nav.durationRemainingS);
      return reply(
        Number.isFinite(nav.eta) ? `ARRIVE ${clock(nav.eta)} · ${left}` : `${left} TO GO`,
      );
    }
    case 'distance_to_destination':
      return driving ? reply(`${dist(nav.distanceRemainingM)} TO GO`) : notDriving();
    case 'distance_to_next_turn':
    case 'time_to_next_turn':
    case 'query_next_turn': {
      if (!driving) return notDriving();
      const what = nav.instruction || nav.roadName || 'NEXT TURN';
      const when =
        act === 'time_to_next_turn' && Number.isFinite(nav.timeToStepS)
          ? formatNavDuration(nav.timeToStepS)
          : dist(nav.distanceToStepM);
      return reply(`${what} IN ${when}`.toUpperCase());
    }
    case 'query_destination':
      return driving
        ? reply(`TO ${String(nav.destination?.name || 'DESTINATION').toUpperCase()}`)
        : notDriving();
    case 'query_current_road':
      return driving && nav.currentRoad
        ? reply(`ON ${String(nav.currentRoad).toUpperCase()}`)
        : reply('ROAD NOT KNOWN');
    case 'mute':
    case 'unmute':
      return reply('ARGUS HAS NO VOICE GUIDANCE');
    case 'show_satellite':
    case 'hide_satellite':
      return reply('THE CAR MAP HAS ONE LOOK');
    default:
      if (act?.startsWith('report_')) return reply('REPORTS ARE NOT IN ARGUS');
      return reply('NOT IN ARGUS');
  }
}

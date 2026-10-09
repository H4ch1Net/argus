// Directions: OSRM on the FOSSGIS servers (routing.openstreetmap.de), reached
// through the proxy feed 'osrm'. Pure (no Cesium, no DOM): request path and
// query, leg checks, response parsing, plain-English turn instructions, and the
// fly-along helpers. Every shell shares it, the terminal included.
//
// Adapted from gods-eye-view server/providers/places/routes.js,
// src/data/routeSteps.js and src/layers/directions/index.js (MIT).
//
// Terms (per the reference implementation, not live-tested here): the FOSSGIS
// routing service is keyless with a usage policy of at most one request per
// second, a valid User-Agent (the proxy sets it), no heavy use, and an
// attribution that carries a "fix the map" link. Ask only on an explicit A/B
// set, never per frame or per drag.

export const OSRM_FEED = 'osrm';

/** Travel modes: the FOSSGIS service and OSRM profile behind each, plus a chip label. */
export const ROUTE_MODES = Object.freeze({
  car: Object.freeze({ service: 'routed-car', profile: 'driving', label: 'DRIVE' }),
  foot: Object.freeze({ service: 'routed-foot', profile: 'foot', label: 'WALK' }),
  bike: Object.freeze({ service: 'routed-bike', profile: 'bike', label: 'BIKE' }),
});
export const DEFAULT_ROUTE_MODE = 'car';

export const ROUTE_MIN_POINTS = 2;
export const ROUTE_MAX_POINTS = 12;
/** Straight-line limits (km): a real drive, walk or ride is local; past these it is a bug or abuse. */
export const ROUTE_MAX_LEG_KM = 600;
export const ROUTE_MAX_TOTAL_KM = 2500;
/** Cap on steps returned for one route; a 2,500 km drive rarely needs more. */
export const ROUTE_STEPS_MAX = 200;

export const ROUTE_ATTRIBUTION =
  'Routing: OSRM on the FOSSGIS servers (routing.openstreetmap.de), map data © OpenStreetMap contributors';
export const ROUTE_ABOUT_URL = 'https://routing.openstreetmap.de/about.html';
/** The service asks that its credit carry this link, so a wrong turn can be fixed at the source. */
export const FIX_THE_MAP_URL = 'https://www.openstreetmap.org/fixthemap';

const EARTH_R_M = 6371008.8;
const RAD = Math.PI / 180;

/** 'drive' | 'driving' | 'car' -> 'car'; 'walk' -> 'foot'; 'cycling' -> 'bike'; else null. */
export function normalizeMode(raw) {
  const m = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (['car', 'drive', 'driving'].includes(m)) return 'car';
  if (['foot', 'walk', 'walking'].includes(m)) return 'foot';
  if (['bike', 'bicycle', 'cycle', 'cycling'].includes(m)) return 'bike';
  return null;
}

/** {lat, lon} or {latitude, longitude} -> {lat, lon}, or null when not a coordinate on the globe. */
export function toLatLon(p) {
  const lat = Number(p?.lat ?? p?.latitude);
  const lon = Number(p?.lon ?? p?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** Great-circle distance in metres between two {lat, lon} points. */
export function haversineM(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Check a stop list before asking anyone: 2 to 12 points on the globe, each
 * straight-line leg at most 600 km and the total at most 2,500 km.
 * @param {Array<{lat:number, lon:number}>} points
 * @returns {{ ok: true, points: Array<{lat:number, lon:number}>, legsKm: number[], totalKm: number }
 *   | { ok: false, error: string }}
 */
export function checkRoutePoints(points) {
  if (!Array.isArray(points)) return { ok: false, error: 'need 2 to 12 points' };
  if (points.length < ROUTE_MIN_POINTS || points.length > ROUTE_MAX_POINTS)
    return { ok: false, error: 'need 2 to 12 points' };
  const clean = points.map(toLatLon);
  if (clean.some((p) => !p)) return { ok: false, error: 'invalid coordinate' };
  const legsKm = [];
  for (let i = 1; i < clean.length; i += 1) {
    const km = haversineM(clean[i - 1], clean[i]) / 1000;
    if (km > ROUTE_MAX_LEG_KM)
      return { ok: false, error: `route leg too long (over ${ROUTE_MAX_LEG_KM} km)` };
    legsKm.push(km);
  }
  const totalKm = legsKm.reduce((s, k) => s + k, 0);
  if (totalKm > ROUTE_MAX_TOTAL_KM)
    return { ok: false, error: `route too long (over ${ROUTE_MAX_TOTAL_KM} km)` };
  return { ok: true, points: clean, legsKm, totalKm };
}

const coord = (n) => String(Number(n.toFixed(6)));

/**
 * Feed sub-path for a route, e.g. '/routed-car/route/v1/driving/-0.1,51.5;2.35,48.86'.
 * Throws when the mode is unknown or the points fail checkRoutePoints.
 */
export function routePath(mode, points) {
  const m = ROUTE_MODES[normalizeMode(mode)];
  if (!m) throw new Error(`unknown travel mode: ${mode}`);
  const check = checkRoutePoints(points);
  if (!check.ok) throw new Error(check.error);
  const coords = check.points.map((p) => `${coord(p.lon)},${coord(p.lat)}`).join(';');
  return `/${m.service}/route/v1/${m.profile}/${coords}`;
}

/**
 * Query for a route: full GeoJSON geometry, maneuvers only when asked, and
 * OSRM's own alternatives (up to two more, computed in the same request) only
 * when asked: the navigator's preview asks, a terminal route does not.
 */
export function routeQuery({ steps = true, alternatives = false } = {}) {
  return {
    overview: 'full',
    geometries: 'geojson',
    alternatives: alternatives ? 'true' : 'false',
    steps: steps ? 'true' : 'false',
  };
}

/**
 * Everything a shell needs to ask the proxy for a route:
 *   const r = routeRequest('car', [a, b]);
 *   const json = await proxyClient.getJson(r.feed, r.path, { params: r.params });
 *   const route = parseRoute(json);
 * Throws (with a readable message) on a bad mode or point list.
 */
export function routeRequest(mode, points, { steps = true, alternatives = false } = {}) {
  return {
    feed: OSRM_FEED,
    path: routePath(mode, points),
    params: routeQuery({ steps, alternatives }),
  };
}

const OSRM_ERRORS = {
  NoRoute: 'no route found between those points',
  NoSegment: 'a point is too far from any road or path',
  TooBig: 'route request too large',
  InvalidQuery: 'invalid route request',
  InvalidValue: 'invalid route request',
};

/** A readable reason for an OSRM answer that carries no route. */
export function routeErrorMessage(json) {
  return OSRM_ERRORS[json?.code] || 'no route found';
}

function cleanText(v, max = 120) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** Road label for a step: "Name (Ref)", "Name", "Ref", or "". */
export function roadLabel(step) {
  const name = cleanText(step?.name);
  const ref = cleanText(step?.ref);
  if (name && ref && !name.includes(ref)) return `${name} (${ref})`;
  return name || ref;
}

const DIRECTION_WORDS = {
  left: 'left',
  right: 'right',
  'slight left': 'slightly left',
  'slight right': 'slightly right',
  'sharp left': 'sharply left',
  'sharp right': 'sharply right',
  straight: 'straight',
  uturn: 'around',
};

function ordinal(n) {
  if (!Number.isInteger(n) || n < 1 || n > 99) return null;
  const suffix =
    n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
  return `${n}${suffix}`;
}

/**
 * One plain-English instruction for an OSRM maneuver. No arrows, emoji or
 * symbols, so it reads the same uppercased (the HUD) or in a terminal.
 * @param {{type?: string, modifier?: string, exit?: number, name?: string, ref?: string}} step
 */
export function instructionFor(step) {
  const type = cleanText(step?.type).toLowerCase();
  const modifier = cleanText(step?.modifier).toLowerCase();
  const dir = DIRECTION_WORDS[modifier] || '';
  const road = roadLabel(step);
  const onto = road ? ` onto ${road}` : '';
  switch (type) {
    case 'depart':
      return road ? `Head out on ${road}` : 'Head out';
    case 'arrive':
      if (modifier === 'left' || modifier === 'right')
        return `Arrive at the destination, on the ${modifier}`;
      return 'Arrive at the destination';
    case 'turn':
      if (modifier === 'uturn') return `Make a U-turn${onto}`;
      if (modifier === 'straight') return `Continue straight${onto}`;
      return dir ? `Turn ${dir}${onto}` : `Turn${onto}`;
    case 'new name':
      return `Continue${onto}`;
    case 'continue':
      if (modifier === 'uturn') return `Make a U-turn${onto}`;
      return dir && dir !== 'straight'
        ? `Continue ${dir}${onto}`
        : `Continue straight${onto}`;
    case 'end of road':
      return dir
        ? `At the end of the road, turn ${dir}${onto}`
        : `At the end of the road, continue${onto}`;
    case 'fork':
      return dir ? `Keep ${dir} at the fork${onto}` : `Continue at the fork${onto}`;
    case 'merge':
      return dir ? `Merge ${dir}${onto}` : `Merge${onto}`;
    case 'on ramp':
      return dir ? `Take the ramp on the ${dir}${onto}` : `Take the ramp${onto}`;
    case 'off ramp':
      return dir ? `Take the exit on the ${dir}${onto}` : `Take the exit${onto}`;
    case 'roundabout':
    case 'rotary': {
      const exit = ordinal(step?.exit);
      return exit
        ? `At the roundabout, take the ${exit} exit${onto}`
        : `Enter the roundabout${onto}`;
    }
    case 'roundabout turn':
      return dir
        ? `At the roundabout, turn ${dir}${onto}`
        : `At the roundabout, continue${onto}`;
    case 'exit roundabout':
    case 'exit rotary':
      return `Exit the roundabout${onto}`;
    case 'use lane':
      return dir ? `Use the ${dir} lane${onto}` : `Continue${onto}`;
    default:
      return `Continue${onto}`;
  }
}

/**
 * Flatten an OSRM route's legs into one step list. An "exit roundabout" step
 * is folded into the roundabout before it (one instruction per decision). Past
 * ROUTE_STEPS_MAX the list is cut and reported as cut, because the last step of
 * a route is its arrival and a silently short list reads as complete.
 * @returns {{ steps: Array<{index:number, type:string, modifier:string|null, exit:number|null,
 *   name:string, ref:string|null, distanceM:number, durationS:number, lon:number, lat:number,
 *   instruction:string}>, truncated: boolean }}
 */
export function normalizeSteps(route) {
  const out = [];
  for (const leg of Array.isArray(route?.legs) ? route.legs : []) {
    for (const raw of Array.isArray(leg?.steps) ? leg.steps : []) {
      const loc = raw?.maneuver?.location;
      const lon = Number(loc?.[0]);
      const lat = Number(loc?.[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      const type = cleanText(raw.maneuver?.type, 40).toLowerCase() || 'continue';
      const step = {
        index: out.length,
        type,
        modifier: cleanText(raw.maneuver?.modifier, 40).toLowerCase() || null,
        exit: Number.isInteger(raw.maneuver?.exit) ? raw.maneuver.exit : null,
        name: cleanText(raw.name),
        ref: cleanText(raw.ref, 40) || null,
        distanceM: Math.max(0, Math.round(Number(raw.distance) || 0)),
        durationS: Math.max(0, Math.round(Number(raw.duration) || 0)),
        lon: Number(lon.toFixed(6)),
        lat: Number(lat.toFixed(6)),
        instruction: '',
      };
      const prev = out[out.length - 1];
      if (
        (type === 'exit roundabout' || type === 'exit rotary') &&
        prev &&
        ['roundabout', 'rotary', 'roundabout turn'].includes(prev.type)
      ) {
        prev.distanceM += step.distanceM;
        prev.durationS += step.durationS;
        if (!roadLabel(prev) && roadLabel(step)) {
          prev.name = step.name;
          prev.ref = step.ref;
          prev.instruction = instructionFor(prev);
        }
        continue;
      }
      step.instruction = instructionFor(step);
      out.push(step);
      if (out.length >= ROUTE_STEPS_MAX) return { steps: out, truncated: true };
    }
  }
  return { steps: out, truncated: false };
}

/**
 * Parse an OSRM /route answer (routes[0]). Null when there is no usable route;
 * routeErrorMessage(json) then says why. There is never a straight-line stand-in.
 * @returns {null | { distanceM: number, durationS: number,
 *   coordinates: Array<[number, number]>, steps: object[], stepsTruncated: boolean }}
 */
export function parseRoute(json) {
  if (json?.code !== 'Ok') return null;
  const route = Array.isArray(json.routes) ? json.routes[0] : null;
  const raw = route?.geometry?.coordinates;
  if (!Array.isArray(raw)) return null;
  const coordinates = [];
  for (const c of raw) {
    const lon = Number(c?.[0]);
    const lat = Number(c?.[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    coordinates.push([lon, lat]);
  }
  if (coordinates.length < 2) return null;
  const { steps, truncated } = normalizeSteps(route);
  return {
    distanceM: Math.max(0, Math.round(Number(route.distance) || 0)),
    durationS: Math.max(0, Math.round(Number(route.duration) || 0)),
    coordinates,
    steps,
    stepsTruncated: truncated,
  };
}

/**
 * Which step is in force after travelling `traveledM` along the route. Each
 * step carries the length of the stretch that follows it, so it is the last
 * step whose cumulative start is at or behind that distance. Null for no steps.
 */
export function stepIndexAtDistance(steps, traveledM) {
  if (!Array.isArray(steps) || !steps.length) return null;
  if (!Number.isFinite(traveledM) || traveledM < 0) return 0;
  let start = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const end = start + Math.max(0, Number(steps[i]?.distanceM) || 0);
    if (traveledM < end) return i;
    start = end;
  }
  return steps.length - 1;
}

/**
 * Walk a route geometry by distance, for a simple fly-along (no banking):
 *   const path = alongRoute(route.coordinates);
 *   const { lon, lat, headingDeg } = path.at(metres);
 * @param {Array<[number, number]>} coordinates [lon, lat] pairs
 */
export function alongRoute(coordinates) {
  const pts = (Array.isArray(coordinates) ? coordinates : [])
    .map(([lon, lat]) => ({ lon: Number(lon), lat: Number(lat) }))
    .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1)
    cum.push(cum[i - 1] + haversineM(pts[i - 1], pts[i]));
  const totalM = cum[cum.length - 1] || 0;
  return {
    totalM,
    at(m) {
      if (!pts.length) return null;
      if (pts.length === 1) return { ...pts[0], headingDeg: 0 };
      const s = Math.min(totalM, Math.max(0, Number(m) || 0));
      let lo = 0;
      let hi = cum.length - 2;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cum[mid] <= s) lo = mid;
        else hi = mid - 1;
      }
      const a = pts[lo];
      const b = pts[lo + 1];
      const seg = cum[lo + 1] - cum[lo];
      const t = seg > 1e-6 ? (s - cum[lo]) / seg : 0;
      let dLon = b.lon - a.lon;
      if (dLon > 180) dLon -= 360;
      if (dLon < -180) dLon += 360;
      let lon = a.lon + dLon * t;
      if (lon > 180) lon -= 360;
      if (lon < -180) lon += 360;
      return { lon, lat: a.lat + (b.lat - a.lat) * t, headingDeg: bearingDeg(a, b) };
    },
  };
}

/** Initial great-circle bearing from a to b, degrees clockwise from north in [0, 360). */
export function bearingDeg(a, b) {
  const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
  const x =
    Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) -
    Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** "850 m", "1.2 km", "21 km". */
export function formatRouteDistance(meters) {
  if (!Number.isFinite(meters) || meters < 0) return '';
  if (meters < 100) return `${Math.round(meters)} m`;
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** "40 s", "12 min", "1 h 5 min". */
export function formatRouteDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

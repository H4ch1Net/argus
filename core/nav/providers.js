// Routers for navigation, each as a pure pair: a proxy request (feed, path,
// params) and a parser from its answer to the Route shape of the navigation
// contract (core/nav/navigator.js). No Cesium, no DOM, no fetch: the
// navigator does the asking, so every shell (the terminal, the car) shares it.
//
//   OSRM on the FOSSGIS servers (feed 'osrm'): drive, walk, bike. It cannot
//     avoid motorways (exclude=motorway answers 400 there).
//   Valhalla on the FOSSGIS servers (feed 'valhalla'): drive, walk, bike, and
//     avoid-highways (costing_options.auto.use_highways = 0). Live-tested Oct
//     2026 (the parser tests use real answers, test/fixtures).
//   TomTom Routing (feed 'tomtom-routing', the proxy's TOMTOM_API_KEY):
//     traffic-aware travel times (computeTravelTimeFor=all gives the traffic
//     delay), avoid=motorways, traffic sections. Per the provider's
//     documentation, not live-tested here (no key in this environment).
//
// Every Route: { id, provider, mode, avoidHighways, distanceM, durationS,
// trafficDelayS?, signals?, signalDelayS?, summary, geometry: [lon, lat][],
// steps, warnings? }; every Step: { maneuver: { type, modifier?, exit? },
// instruction, name, distanceM, durationS, location: [lon, lat],
// geometryIndex }, maneuvers in OSRM's vocabulary (core/nav/maneuvers.js).

import {
  routeRequest,
  roadLabel,
  normalizeMode,
  checkRoutePoints,
} from '../route/osrm.js';
import { cleanLine, cumulative, decodePolyline, haversineM } from './geo.js';
import { fromOsrm, fromValhalla, fromTomTom, instructionText } from './maneuvers.js';

export const NAV_MODES = Object.freeze(['drive', 'walk', 'bike']);
/** Steps kept per route: generous, and the arrival is always kept. */
export const NAV_STEPS_MAX = 400;

/** 'car' | 'driving' -> 'drive', 'foot' -> 'walk', 'cycling' -> 'bike'; else null. */
export function navMode(raw) {
  const m = normalizeMode(raw);
  return m === 'car' ? 'drive' : m === 'foot' ? 'walk' : m === 'bike' ? 'bike' : null;
}

const OSRM_MODE = { drive: 'car', walk: 'foot', bike: 'bike' };
const VALHALLA_COSTING = { drive: 'auto', walk: 'pedestrian', bike: 'bicycle' };
const TOMTOM_MODE = { drive: 'car', walk: 'pedestrian', bike: 'bicycle' };

const r6 = (n) => Number(Number(n).toFixed(6));
const r5 = (n) => Number(Number(n).toFixed(5));
const text = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Throw a readable error unless from/to are two stops a router may be asked for. */
function checkStops(from, to) {
  const check = checkRoutePoints([from, to]);
  if (!check.ok) throw Object.assign(new Error(check.error), { code: 'bad-stops' });
  return check.points;
}

/**
 * Where each step's maneuver sits on the route line, for routers that do not
 * say (OSRM): the nearest vertex to the maneuver point within 400 m of where
 * the steps' own distances put it, never behind the previous step.
 */
export function locateSteps(line, steps) {
  const cum = cumulative(line);
  let prev = 0;
  let expected = 0;
  for (const s of steps) {
    const [lon, lat] = s.location;
    let best = prev;
    let bestD = Infinity;
    for (let i = prev; i < line.length; i += 1) {
      if (cum[i] > expected + 400) break;
      if (cum[i] < expected - 400) continue;
      const d = haversineM(lat, lon, line[i][1], line[i][0]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    s.geometryIndex = best;
    prev = best;
    expected = cum[best] + s.distanceM;
  }
  return steps;
}

/** Cap a step list, keeping the arrival as the last step. */
function capSteps(steps) {
  if (steps.length <= NAV_STEPS_MAX) return steps;
  return [...steps.slice(0, NAV_STEPS_MAX - 1), steps[steps.length - 1]];
}

/** "A, B": the two longest named stretches, in route order. */
export function summaryFromSteps(steps) {
  const named = steps
    .map((s, i) => ({ name: s.name, d: s.distanceM, i }))
    .filter((s) => s.name);
  const top = named.sort((a, b) => b.d - a.d).slice(0, 2);
  const seen = new Set();
  return top
    .sort((a, b) => a.i - b.i)
    .map((s) => s.name)
    .filter((n) => !seen.has(n) && seen.add(n))
    .join(', ');
}

function makeStep(maneuver, name, distanceM, durationS, location, geometryIndex) {
  return {
    maneuver,
    instruction: instructionText(maneuver, name),
    name,
    distanceM: Math.max(0, Math.round(Number(distanceM) || 0)),
    durationS: Math.max(0, Math.round(Number(durationS) || 0)),
    location: [r6(location[0]), r6(location[1])],
    geometryIndex,
  };
}

// --- OSRM ------------------------------------------------------------------------

export const osrm = {
  id: 'osrm',
  feed: 'osrm',
  modes: NAV_MODES,
  avoidsHighways: false,
  /** @returns {{ feed: string, path: string, params: object }} */
  request(from, to, { mode = 'drive' } = {}) {
    const [a, b] = checkStops(from, to);
    return routeRequest(OSRM_MODE[mode] ?? 'car', [a, b], { alternatives: true });
  },
  /** OSRM /route answer -> Route[] (best first, as OSRM orders them). */
  parse(json, { mode = 'drive', avoidHighways = false } = {}) {
    if (json?.code !== 'Ok' || !Array.isArray(json.routes)) return [];
    const out = [];
    for (const r of json.routes.slice(0, 3)) {
      const geometry = cleanLine(r?.geometry?.coordinates);
      if (geometry.length < 2) continue;
      const steps = [];
      const legs = Array.isArray(r.legs) ? r.legs : [];
      for (let li = 0; li < legs.length; li += 1) {
        for (const raw of Array.isArray(legs[li]?.steps) ? legs[li].steps : []) {
          const loc = raw?.maneuver?.location;
          if (!Number.isFinite(loc?.[0]) || !Number.isFinite(loc?.[1])) continue;
          const type = text(raw.maneuver?.type, 40).toLowerCase();
          // A via point is not the end of the trip, nor a new start.
          if (type === 'arrive' && li < legs.length - 1) continue;
          if (type === 'depart' && li > 0) continue;
          const prev = steps[steps.length - 1];
          // One instruction per decision: a roundabout's exit folds into its entry.
          if ((type === 'exit roundabout' || type === 'exit rotary') && prev) {
            prev.distanceM += Math.round(Number(raw.distance) || 0);
            prev.durationS += Math.round(Number(raw.duration) || 0);
            if (!prev.name && roadLabel(raw)) {
              prev.name = roadLabel(raw);
              prev.instruction = instructionText(prev.maneuver, prev.name);
            }
            continue;
          }
          steps.push(
            makeStep(
              fromOsrm(raw.maneuver),
              roadLabel(raw),
              raw.distance,
              raw.duration,
              loc,
              0,
            ),
          );
        }
      }
      if (!steps.length) continue;
      locateSteps(geometry, steps);
      const legSummary = legs
        .map((l) => text(l?.summary))
        .filter(Boolean)
        .join(', ');
      const route = {
        id: '',
        provider: 'osrm',
        mode,
        avoidHighways: false,
        distanceM: Math.max(0, Math.round(Number(r.distance) || 0)),
        durationS: Math.max(0, Math.round(Number(r.duration) || 0)),
        summary: legSummary || summaryFromSteps(steps),
        geometry,
        steps: capSteps(steps),
      };
      // Asked to avoid highways, but this router cannot: say so on the route.
      if (avoidHighways && mode === 'drive') route.warnings = ['HIGHWAYS NOT AVOIDED'];
      out.push(route);
    }
    return out;
  },
};

// --- Valhalla --------------------------------------------------------------------

export const valhalla = {
  id: 'valhalla',
  feed: 'valhalla',
  modes: NAV_MODES,
  avoidsHighways: true,
  /**
   * GET /route?json={...}: two stops (the first with the vehicle's heading
   * when it is moving, so a reroute does not start by turning round), the
   * costing for the mode, use_highways 0 to avoid highways, two alternates.
   */
  request(from, to, { mode = 'drive', avoidHighways = false, heading = null } = {}) {
    const [a, b] = checkStops(from, to);
    const start = { lat: r6(a.lat), lon: r6(a.lon) };
    if (Number.isFinite(heading)) {
      start.heading = Math.round(((heading % 360) + 360) % 360) % 360;
      start.heading_tolerance = 45;
    }
    const costing = VALHALLA_COSTING[mode] ?? 'auto';
    const body = {
      locations: [start, { lat: r6(b.lat), lon: r6(b.lon) }],
      costing,
      directions_options: { units: 'kilometers', language: 'en-US' },
      alternates: 2,
    };
    if (avoidHighways && costing === 'auto')
      body.costing_options = { auto: { use_highways: 0 } };
    return { feed: 'valhalla', path: '/route', params: { json: JSON.stringify(body) } };
  },
  /** Valhalla /route answer (trip + alternates) -> Route[]. */
  parse(json, { mode = 'drive', avoidHighways = false } = {}) {
    const trips = [json?.trip, ...(json?.alternates ?? []).map((a) => a?.trip)];
    const out = [];
    for (const trip of trips) {
      if (!trip || trip.status !== 0 || !Array.isArray(trip.legs)) continue;
      const unit = trip.units === 'miles' ? 1609.344 : 1000;
      const geometry = [];
      const steps = [];
      for (let li = 0; li < trip.legs.length; li += 1) {
        const leg = trip.legs[li];
        const base = geometry.length ? geometry.length - 1 : 0;
        const shape = decodePolyline(leg?.shape, 6);
        geometry.push(...(geometry.length ? shape.slice(1) : shape));
        const ms = Array.isArray(leg?.maneuvers) ? leg.maneuvers : [];
        for (let i = 0; i < ms.length; i += 1) {
          const m = ms[i];
          const t = Number(m?.type);
          // A via point is not the end of the trip, nor a new start.
          if (t >= 4 && t <= 6 && li < trip.legs.length - 1) continue;
          if (t >= 1 && t <= 3 && li > 0) continue;
          if (t === 27) continue; // folded into its roundabout below
          let name = (m.street_names ?? m.begin_street_names ?? [])
            .map(String)
            .join(' / ');
          let length = Number(m.length) || 0;
          let time = Number(m.time) || 0;
          let exitBearing;
          if (t === 26) {
            const exit = ms.slice(i + 1).find((x) => Number(x?.type) === 27);
            if (exit) {
              name = (exit.street_names ?? []).map(String).join(' / ') || name;
              length += Number(exit.length) || 0;
              time += Number(exit.time) || 0;
              exitBearing = Number(exit.bearing_after);
            }
          }
          const idx = Math.min(
            geometry.length - 1,
            base + Math.max(0, Math.round(Number(m.begin_shape_index) || 0)),
          );
          if (!geometry[idx]) continue;
          steps.push(
            makeStep(
              fromValhalla(m, { exitBearing }),
              text(name),
              length * unit,
              time,
              geometry[idx],
              idx,
            ),
          );
        }
      }
      const line = cleanLineKeepingIndex(geometry, steps);
      if (line.length < 2 || !steps.length) continue;
      out.push({
        id: '',
        provider: 'valhalla',
        mode,
        avoidHighways: Boolean(avoidHighways && mode === 'drive'),
        distanceM: Math.round((Number(trip.summary?.length) || 0) * unit),
        durationS: Math.round(Number(trip.summary?.time) || 0),
        summary: summaryFromSteps(steps),
        geometry: line,
        steps: capSteps(steps),
      });
    }
    return out;
  },
  /** A readable reason from Valhalla's error body ({ error_code, error }). */
  errorMessage(json) {
    const code = Number(json?.error_code);
    if (code === 442 || code === 443) return 'no route found between those points';
    if (code === 171 || code === 170) return 'a point is too far from any road or path';
    return text(json?.error) || 'no route found';
  },
};

/**
 * Drop repeated or invalid vertices from a decoded line while keeping each
 * step's geometryIndex pointing at the same vertex.
 */
function cleanLineKeepingIndex(line, steps) {
  const map = new Int32Array(line.length);
  const out = [];
  for (let i = 0; i < line.length; i += 1) {
    const [lon, lat] = line[i];
    const ok =
      Number.isFinite(lon) &&
      Number.isFinite(lat) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180;
    const prev = out[out.length - 1];
    if (ok && !(prev && prev[0] === lon && prev[1] === lat)) out.push([lon, lat]);
    map[i] = Math.max(0, out.length - 1);
  }
  for (const s of steps) s.geometryIndex = map[s.geometryIndex] ?? 0;
  return out;
}

// --- TomTom Routing --------------------------------------------------------------

const TRAFFIC_KIND = {
  JAM: 'JAM',
  ROAD_WORK: 'ROADWORKS',
  ROAD_CLOSURE: 'CLOSURE',
  OTHER: 'TRAFFIC',
};

export const tomtom = {
  id: 'tomtom',
  feed: 'tomtom-routing',
  modes: NAV_MODES,
  avoidsHighways: true,
  /**
   * GET routing/1/calculateRoute/{lat,lon:lat,lon}/json with live traffic,
   * travel times for all traffic models (the traffic delay), two
   * alternatives, text guidance and the traffic sections. The key is added
   * by the proxy, never here.
   */
  request(
    from,
    to,
    { mode = 'drive', avoidHighways = false, traffic = true, heading = null } = {},
  ) {
    const [a, b] = checkStops(from, to);
    const travelMode = TOMTOM_MODE[mode] ?? 'car';
    const params = {
      travelMode,
      traffic: traffic ? 'true' : 'false',
      computeTravelTimeFor: 'all',
      maxAlternatives: '2',
      instructionsType: 'text',
      language: 'en-GB',
      routeType: 'fastest',
      sectionType: 'traffic',
    };
    if (avoidHighways && travelMode === 'car') params.avoid = 'motorways';
    if (Number.isFinite(heading) && travelMode === 'car')
      params.vehicleHeading = Math.round(((heading % 360) + 360) % 360) % 360;
    return {
      feed: 'tomtom-routing',
      path: `/calculateRoute/${r5(a.lat)},${r5(a.lon)}:${r5(b.lat)},${r5(b.lon)}/json`,
      params,
    };
  },
  /** TomTom calculateRoute answer -> Route[]. */
  parse(json, { mode = 'drive', avoidHighways = false, traffic = true } = {}) {
    const out = [];
    for (const r of Array.isArray(json?.routes) ? json.routes.slice(0, 3) : []) {
      const raw = [];
      for (const leg of Array.isArray(r?.legs) ? r.legs : []) {
        const pts = (Array.isArray(leg?.points) ? leg.points : []).map((p) => [
          Number(p?.longitude),
          Number(p?.latitude),
        ]);
        raw.push(...(raw.length ? pts.slice(1) : pts));
      }
      const ins = Array.isArray(r?.guidance?.instructions) ? r.guidance.instructions : [];
      const steps = [];
      for (let i = 0; i < ins.length; i += 1) {
        const a = ins[i];
        const b = ins[i + 1];
        const lon = Number(a?.point?.longitude);
        const lat = Number(a?.point?.latitude);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        const name =
          text(a.street) ||
          (Array.isArray(a.roadNumbers) ? a.roadNumbers.map(String).join(' / ') : '');
        const dist = b
          ? Number(b.routeOffsetInMeters) - Number(a.routeOffsetInMeters)
          : 0;
        const time = b
          ? Number(b.travelTimeInSeconds) - Number(a.travelTimeInSeconds)
          : 0;
        const idx = Math.max(
          0,
          Math.min(raw.length - 1, Math.round(Number(a.pointIndex) || 0)),
        );
        steps.push(makeStep(fromTomTom(a), text(name), dist, time, [lon, lat], idx));
      }
      const geometry = cleanLineKeepingIndex(raw, steps);
      if (geometry.length < 2 || !steps.length) continue;
      const sum = r.summary ?? {};
      const route = {
        id: '',
        provider: 'tomtom',
        mode,
        avoidHighways: Boolean(avoidHighways && mode === 'drive'),
        distanceM: Math.round(Number(sum.lengthInMeters) || 0),
        durationS: Math.round(Number(sum.travelTimeInSeconds) || 0),
        summary: summaryFromSteps(steps),
        geometry,
        steps: capSteps(steps),
      };
      if (traffic) {
        route.trafficDelayS = Math.max(
          0,
          Math.round(Number(sum.trafficDelayInSeconds) || 0),
        );
        const sections = (Array.isArray(r.sections) ? r.sections : [])
          .filter((s) => String(s?.sectionType).toUpperCase() === 'TRAFFIC')
          .map((s) => ({
            from: Math.max(0, Math.round(Number(s.startPointIndex) || 0)),
            to: Math.max(0, Math.round(Number(s.endPointIndex) || 0)),
            delayS: Math.max(0, Math.round(Number(s.delayInSeconds) || 0)),
            kind: TRAFFIC_KIND[String(s.simpleCategory).toUpperCase()] ?? 'TRAFFIC',
          }))
          .filter((s) => s.to > s.from);
        if (sections.length) route.traffic = sections;
        const warnings = [];
        if (sections.some((s) => s.kind === 'CLOSURE')) warnings.push('CLOSURE ON ROUTE');
        const jam = sections.reduce((t, s) => t + s.delayS, 0);
        if (jam >= 60) warnings.push(`TRAFFIC +${Math.round(jam / 60)} MIN`);
        if (warnings.length) route.warnings = warnings;
      }
      out.push(route);
    }
    return out;
  },
};

export const PROVIDERS = Object.freeze({ osrm, valhalla, tomtom });

/**
 * The routers to try for a plan, in order. Driving with traffic on and the
 * TomTom key at the proxy: TomTom first (live traffic, avoids motorways too).
 * Avoiding highways otherwise: Valhalla, then OSRM (which cannot avoid them
 * and says so on the route). Anything else: OSRM, then Valhalla.
 */
export function providerChain({
  mode = 'drive',
  avoidHighways = false,
  traffic = true,
  tomtom: tt = false,
} = {}) {
  const chain = [];
  if (mode === 'drive' && traffic && tt) chain.push('tomtom');
  if (mode === 'drive' && avoidHighways) chain.push('valhalla', 'osrm');
  else chain.push('osrm', 'valhalla');
  return chain;
}

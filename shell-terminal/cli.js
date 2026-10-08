// Non-interactive commands: the passive console for scripts and pipes. Each
// prints a readable table by default or JSON with --json, and exits non-zero on
// failure, so it composes with jq, grep, and shell loops on Kali.
//
// GUARDRAIL: these are the same passive reads the app makes. `query` and
// `correlate` accept only network assets (classifyAsset), never people; nothing
// here sends traffic at a target, it reads public indexes through the proxy.

import { connectBackend } from './backend.js';
import { parseLatLon } from './index.js';
import { classifyAsset } from '../core/osint/asset.js';
import { parseQuakes } from '../core/layers/earthquakes/parse.js';
import { parseFlights, adsbPointPath } from '../core/layers/flights/parse.js';
import {
  formatAltitude,
  formatSpeed,
  formatHeading,
} from '../core/layers/flights/format.js';
import { parseFires } from '../core/layers/fires/parse.js';
import { ADSB_MILITARY_PATH } from '../core/layers/flights/parse.js';
import { parseMilitary } from '../core/layers/military/parse.js';
import { parseCyclones } from '../core/layers/cyclones/parse.js';
import { saffirSimpson } from '../core/layers/cyclones/format.js';
import { parseLaunches, launchQuery } from '../core/layers/launches/parse.js';
import { relativeTime } from '../core/layers/launches/format.js';
import { feedConfigured } from '../core/net/discoverProxy.js';
import { findPlace, searchPlaces } from '../core/search/places.js';
import {
  routeRequest,
  parseRoute,
  routeErrorMessage,
  normalizeMode,
  checkRoutePoints,
  formatRouteDistance,
  formatRouteDuration,
  ROUTE_MODES,
  ROUTE_ATTRIBUTION,
  FIX_THE_MAP_URL,
} from '../core/route/osrm.js';
import { greatCircleM, initialBearingDeg } from '../core/draw/geometry.js';

export const CLI_COMMANDS = [
  'query',
  'correlate',
  'quakes',
  'flights',
  'military',
  'storms',
  'launches',
  'sats',
  'fires',
  'geocode',
  'route',
  'measure',
  'bgp',
  'ct',
  'health',
];

const QUAKE_FEEDS = [
  'all_hour',
  'all_day',
  'all_week',
  '2.5_day',
  '4.5_week',
  'significant_week',
];

function opt(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
/** Positional arguments: everything that is not a flag or a flag's value. */
export function positionals(argv, valueFlags = []) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      if (valueFlags.includes(argv[i])) i += 1;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

/** Great-circle distance in km. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** A bbox around a point with a radius in km. */
export function bboxAround(lat, lon, radiusKm) {
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return {
    lamin: Math.max(-90, lat - dLat),
    lamax: Math.min(90, lat + dLat),
    lomin: Math.max(-180, lon - dLon),
    lomax: Math.min(180, lon + dLon),
  };
}

/**
 * Make control characters visible (`\u001b`) instead of letting them act on the
 * terminal. Newlines and tabs are kept. Inside JSON strings the result is still
 * valid JSON with the same value.
 */
export function escapeControls(s) {
  let out = '';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    const control =
      (cp < 0x20 && ch !== '\n' && ch !== '\t') || (cp >= 0x7f && cp <= 0x9f);
    out += control ? `\\u${cp.toString(16).padStart(4, '0')}` : ch;
  }
  return out;
}

/** Render rows as an aligned text table. */
export function table(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  const line = (cells) =>
    cells
      .map((c, i) => String(c ?? '').padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join(
    '\n',
  );
}

function printCard(card) {
  const lines = [`${card.title}${card.subtitle ? `  ·  ${card.subtitle}` : ''}`];
  const kw = Math.max(
    8,
    ...(card.rows || []).map(([k]) => k.length),
    ...(card.sections || []).flatMap((s) => s.rows.map(([k]) => k.length)),
  );
  for (const [k, v] of card.rows || []) lines.push(`  ${k.padEnd(kw)}  ${v}`);
  for (const s of card.sections || []) {
    lines.push(`  ${s.title}`);
    for (const [k, v] of s.rows) lines.push(`    ${k.padEnd(kw - 2)}  ${v}`);
  }
  for (const l of card.links || []) lines.push(`  ${l.label.padEnd(kw)}  ${l.url}`);
  return lines.join('\n');
}

const asPlace = (p) => ({ lat: p.latitude, lon: p.longitude, name: p.name });

/** Coordinates or an exact bundled place name, with no network; else null. */
export function resolveOffline(text) {
  const ll = parseLatLon(text);
  if (ll) return { ...ll, name: `${ll.lat}, ${ll.lon}` };
  const p = findPlace(text);
  return p ? asPlace(p) : null;
}

/**
 * Coordinates, then the bundled offline places, then the proxy geocoder (Photon,
 * then Nominatim). If the geocoder is unreachable or finds nothing, the closest
 * bundled name still beats no answer.
 */
async function resolvePlace(backend, text) {
  const offline = resolveOffline(text);
  if (offline) return offline;
  let places = null;
  let failure = null;
  try {
    places = await backend?.geocode?.(text);
  } catch (e) {
    failure = e;
  }
  if (places?.length) return asPlace(places[0]);
  const [guess] = searchPlaces(text, { limit: 1 });
  if (guess) return asPlace(guess);
  if (failure) throw failure;
  throw new Error(`no place found for "${text}"`);
}

/** Two places from positionals: "A B" (quote multi-word names) or "A to B". */
export function twoPlaces(args) {
  const i = args.findIndex((a) => a.toLowerCase() === 'to');
  if (i > 0 && i < args.length - 1)
    return [args.slice(0, i).join(' '), args.slice(i + 1).join(' ')];
  return args.length === 2 ? [...args] : null;
}

function streamLines(url, type, key, count, json, print) {
  return new Promise((resolve, reject) => {
    let seen = 0;
    const ws = new WebSocket(url);
    const done = () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolve(seen);
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type !== type) return;
      for (const ev of m[key] || []) {
        print(json ? JSON.stringify(ev) : ev);
        seen += 1;
        if (count && seen >= count) return done();
      }
    };
    ws.onerror = () => reject(new Error(`could not open ${url}`));
    ws.onclose = () => resolve(seen);
    process.once('SIGINT', done);
  });
}

/**
 * @param {string} cmd
 * @param {string[]} argv
 * @param {{ out?: (s: string) => void, err?: (s: string) => void, backend?: object }} [io]
 * @returns {Promise<number>} exit code
 */
export async function runCli(cmd, argv, io = {}) {
  const rawOut = io.out ?? ((s) => process.stdout.write(`${s}\n`));
  const rawErr = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  // Upstream text (station names, storm names, card values) must never reach the
  // terminal as escape sequences.
  const out = (s) => rawOut(escapeControls(s));
  const err = (s) => rawErr(escapeControls(s));
  const json = argv.includes('--json');
  const verbose = argv.includes('--verbose');
  const warnings = [];
  const valueFlags = [
    '--proxy',
    '--min',
    '--limit',
    '--feed',
    '--near',
    '--radius',
    '--group',
    '--count',
    '--mode',
  ];
  const args = positionals(argv, valueFlags);

  // Great-circle distance and initial bearing between two resolved places.
  const printMeasure = (a, b) => {
    const m = greatCircleM(a, b);
    const bearing = initialBearingDeg(a, b);
    if (json)
      out(
        JSON.stringify(
          {
            from: a,
            to: b,
            distanceM: Math.round(m),
            distanceKm: Number((m / 1000).toFixed(3)),
            distanceNm: Number((m / 1852).toFixed(3)),
            bearingDeg: Number(bearing.toFixed(1)),
          },
          null,
          2,
        ),
      );
    else {
      out(`${a.name} -> ${b.name}`);
      out(
        `  distance  ${(m / 1000).toFixed(1)} km  (${(m / 1852).toFixed(1)} nm, ${(m / 1609.344).toFixed(1)} mi), great circle`,
      );
      out(`  bearing   ${bearing.toFixed(1)} deg true (initial)`);
    }
    return 0;
  };

  // Validate before starting any proxy, so usage errors are instant.
  if ((cmd === 'query' || cmd === 'correlate') && !classifyAsset(args.join(' '))) {
    err(`argus ${cmd}: expected an IP, domain, or ASN (assets only, never people)`);
    return 2;
  }
  if ((cmd === 'flights' || cmd === 'fires') && !opt(argv, '--near')) {
    err(`argus ${cmd}: --near <LAT,LON|place> is required (feeds are viewport-bounded)`);
    return 2;
  }
  if (cmd === 'geocode' && !args.length) {
    err('argus geocode: give a place name');
    return 2;
  }
  if ((cmd === 'route' || cmd === 'measure') && !twoPlaces(args)) {
    err(
      `argus ${cmd}: give two places, e.g. argus ${cmd} London Paris (quote multi-word names, or write "A to B")`,
    );
    return 2;
  }
  if (
    cmd === 'route' &&
    opt(argv, '--mode') !== undefined &&
    !normalizeMode(opt(argv, '--mode'))
  ) {
    err('argus route: --mode must be car, foot or bike');
    return 2;
  }
  // Two coordinates or two bundled names need no network at all.
  if (cmd === 'measure') {
    const [a, b] = twoPlaces(args).map(resolveOffline);
    if (a && b) return printMeasure(a, b);
  }

  const backend =
    io.backend ??
    (await connectBackend({
      proxyUrl: opt(argv, '--proxy') ?? null,
      demo: argv.includes('--demo'),
      warn: (m) => warnings.push(m),
    }));
  if (verbose) for (const w of warnings) err(`[argus] ${w}`);
  const c = backend.client;

  try {
    if (cmd === 'health') {
      const h = backend.health;
      if (json)
        out(
          JSON.stringify(
            { backend: backend.label, envFiles: backend.envFiles, ...h },
            null,
            2,
          ),
        );
      else {
        out(`backend: ${backend.label}`);
        out(
          `env files: ${backend.envFiles?.length ? backend.envFiles.join(', ') : 'none'}`,
        );
        if (h) {
          out(
            table(
              ['feed', 'status'],
              h.feeds.map((f) => [f.id, f.configured ? 'ready' : 'needs key']),
            ),
          );
          for (const [k, s] of Object.entries(h.streams ?? {})) {
            out(
              `ws ${k}: ${!s.available ? 'unavailable' : s.configured ? 'ready' : 'needs key'}`,
            );
          }
        }
      }
      return h || backend.mode === 'demo' ? 0 : 1;
    }

    if (cmd === 'query' || cmd === 'correlate') {
      const asset = classifyAsset(args.join(' '));
      const fn = cmd === 'query' ? backend.lookup : backend.correlate;
      const r = await fn(asset);
      if (!r) {
        err(`${cmd}: nothing found for ${asset.value}`);
        return 1;
      }
      out(json ? JSON.stringify(r, null, 2) : printCard(r.card));
      return 0;
    }

    if (cmd === 'geocode') {
      const places = await backend.geocode(args.join(' '));
      if (json) out(JSON.stringify(places, null, 2));
      else
        out(
          table(
            ['lat', 'lon', 'name'],
            places.map((p) => [p.latitude.toFixed(4), p.longitude.toFixed(4), p.name]),
          ),
        );
      return places.length ? 0 : 1;
    }

    if (cmd === 'measure') {
      const [ta, tb] = twoPlaces(args);
      return printMeasure(
        await resolvePlace(backend, ta),
        await resolvePlace(backend, tb),
      );
    }

    if (cmd === 'route') {
      if (!c) {
        err(
          'route: routing is online only (OSRM through the proxy); --demo has no network',
        );
        return 1;
      }
      const mode = normalizeMode(opt(argv, '--mode') ?? 'car');
      const [ta, tb] = twoPlaces(args);
      const a = await resolvePlace(backend, ta);
      const b = await resolvePlace(backend, tb);
      const check = checkRoutePoints([a, b]);
      if (!check.ok) {
        err(`route: ${check.error}`);
        return 1;
      }
      const req = routeRequest(mode, [a, b]);
      let raw;
      try {
        raw = await c.getJson(req.feed, req.path, { params: req.params });
      } catch (e) {
        // OSRM answers NoRoute / NoSegment with a 400.
        if (e?.status === 400) {
          err('route: no route found (a stop may be too far from any road or path)');
          return 1;
        }
        throw e;
      }
      const route = parseRoute(raw);
      if (!route) {
        err(`route: ${routeErrorMessage(raw)}`);
        return 1;
      }
      if (json) {
        out(
          JSON.stringify(
            {
              mode,
              from: a,
              to: b,
              distanceM: route.distanceM,
              durationS: route.durationS,
              steps: route.steps,
              stepsTruncated: route.stepsTruncated,
              geometry: route.coordinates,
              attribution: ROUTE_ATTRIBUTION,
              fixTheMap: FIX_THE_MAP_URL,
            },
            null,
            2,
          ),
        );
        return 0;
      }
      out(
        `${ROUTE_MODES[mode].label} ${a.name} -> ${b.name}: ${formatRouteDistance(route.distanceM)}, ${formatRouteDuration(route.durationS)}`,
      );
      let at = 0;
      const rows = route.steps.map((s, i) => {
        const row = [String(i + 1), formatRouteDistance(at), s.instruction];
        at += s.distanceM;
        return row;
      });
      out(table(['#', 'at', 'instruction'], rows));
      if (route.stepsTruncated) out(`(first ${route.steps.length} steps only)`);
      out(`${ROUTE_ATTRIBUTION}. Fix the map: ${FIX_THE_MAP_URL}`);
      return 0;
    }

    if (cmd === 'quakes') {
      const feed = opt(argv, '--feed') ?? 'all_day';
      if (!QUAKE_FEEDS.includes(feed)) {
        err(`quakes: --feed must be one of ${QUAKE_FEEDS.join(', ')}`);
        return 2;
      }
      const min = Number(opt(argv, '--min') ?? 0);
      const limit = Number(opt(argv, '--limit') ?? 25);
      const raw = await c.getJson('usgs-quakes', `/${feed}.geojson`);
      const list = parseQuakes(raw)
        .filter((q) => (q.meta.mag ?? 0) >= min)
        .sort((a, b) => (b.meta.time ?? 0) - (a.meta.time ?? 0))
        .slice(0, limit);
      if (json) out(JSON.stringify(list, null, 2));
      else {
        out(
          table(
            ['time (UTC)', 'mag', 'depth', 'lat', 'lon', 'place'],
            list.map((q) => [
              q.meta.time
                ? new Date(q.meta.time).toISOString().slice(0, 16).replace('T', ' ')
                : '',
              q.meta.mag?.toFixed(1) ?? '',
              q.meta.depthKm != null ? `${Math.round(q.meta.depthKm)} km` : '',
              q.position.latitude.toFixed(2),
              q.position.longitude.toFixed(2),
              q.meta.place,
            ]),
          ),
        );
      }
      return 0;
    }

    if (cmd === 'flights') {
      const place = await resolvePlace(backend, opt(argv, '--near'));
      const radiusNm = Math.min(250, Number(opt(argv, '--radius') ?? 60));
      const limit = Number(opt(argv, '--limit') ?? 30);
      const bbox = bboxAround(place.lat, place.lon, radiusNm * 1.852);
      const useOpenSky = !backend.health || feedConfigured(backend.health, 'opensky');
      const raw = useOpenSky
        ? await c.getJson('opensky', '/states/all', { params: bbox })
        : await c.getJson('adsblol', adsbPointPath(bbox));
      const list = parseFlights(raw)
        .aircraft.map((a) => ({
          ...a,
          distanceKm: haversineKm(place.lat, place.lon, a.latitude, a.longitude),
        }))
        .filter((a) => a.distanceKm <= radiusNm * 1.852)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, limit);
      if (json)
        out(
          JSON.stringify(
            { near: place, source: useOpenSky ? 'OpenSky' : 'adsb.lol', aircraft: list },
            null,
            2,
          ),
        );
      else {
        out(
          `${list.length} aircraft within ${radiusNm} nm of ${place.name} (${useOpenSky ? 'OpenSky' : 'adsb.lol'})`,
        );
        out(
          table(
            ['callsign', 'icao24', 'type', 'altitude', 'speed', 'heading', 'dist'],
            list.map((a) => [
              a.callsign || '-',
              a.id,
              a.typeCode ?? '',
              a.onGround ? 'ground' : formatAltitude(a.geoAltitude ?? a.baroAltitude),
              formatSpeed(a.velocity),
              formatHeading(a.trueTrack),
              `${a.distanceKm.toFixed(0)} km`,
            ]),
          ),
        );
      }
      return 0;
    }

    if (cmd === 'military') {
      // adsb.lol's global military list; optionally only those near a place.
      const near = opt(argv, '--near');
      const place = near ? await resolvePlace(backend, near) : null;
      const radiusKm = Number(opt(argv, '--radius') ?? 500);
      const limit = Number(opt(argv, '--limit') ?? 40);
      const list = parseMilitary(await c.getJson('adsblol', ADSB_MILITARY_PATH))
        .map((n) => ({
          ...n.meta,
          distanceKm: place
            ? haversineKm(place.lat, place.lon, n.meta.latitude, n.meta.longitude)
            : null,
        }))
        .filter((a) => !place || a.distanceKm <= radiusKm)
        .sort((a, b) =>
          place
            ? a.distanceKm - b.distanceKm
            : String(a.callsign).localeCompare(b.callsign),
        )
        .slice(0, limit);
      if (json) out(JSON.stringify({ near: place, aircraft: list }, null, 2));
      else {
        out(
          `${list.length} military aircraft${place ? ` within ${radiusKm} km of ${place.name}` : ''} (adsb.lol)`,
        );
        out(
          table(
            [
              'callsign',
              'icao24',
              'type',
              'operator',
              'altitude',
              'speed',
              place ? 'dist' : 'lat,lon',
            ],
            list.map((a) => [
              a.callsign || '-',
              a.id,
              a.typeCode ?? '',
              a.operator ?? '',
              a.onGround ? 'ground' : formatAltitude(a.geoAltitude ?? a.baroAltitude),
              formatSpeed(a.velocity),
              place
                ? `${a.distanceKm.toFixed(0)} km`
                : `${a.latitude.toFixed(2)},${a.longitude.toFixed(2)}`,
            ]),
          ),
        );
      }
      return 0;
    }

    if (cmd === 'storms') {
      const list = parseCyclones(await c.getJson('nhc', '/CurrentStorms.json'));
      if (json) out(JSON.stringify(list, null, 2));
      else if (!list.length)
        out('no active tropical cyclones (NOAA NHC: Atlantic, E/C Pacific)');
      else
        out(
          table(
            ['storm', 'id', 'class', 'wind', 'pressure', 'lat', 'lon', 'moving'],
            list.map(({ meta: m, position: p }) => [
              m.name,
              m.stormId.toUpperCase(),
              saffirSimpson(m.windKt)
                ? `${m.classification} cat ${saffirSimpson(m.windKt)}`
                : (m.classification ?? ''),
              m.windKt != null ? `${m.windKt} kt` : '',
              m.pressureHpa != null ? `${m.pressureHpa} hPa` : '',
              p.latitude.toFixed(1),
              p.longitude.toFixed(1),
              m.movementDir != null ? `${m.movementDir}° ${m.movementKt ?? '?'} kt` : '',
            ]),
          ),
        );
      return 0;
    }

    if (cmd === 'launches') {
      // Upcoming by default; --past lists the last week instead.
      const past = argv.includes('--past');
      const limit = Number(opt(argv, '--limit') ?? 20);
      const now = Date.now();
      const pads = parseLaunches(
        await c.getJson('ll2', '/launches/', { params: launchQuery(now) }),
      );
      const list = pads
        .flatMap((p) =>
          p.meta.launches.map((l) => ({
            ...l,
            pad: p.meta.pad,
            location: p.meta.location,
          })),
        )
        .filter((l) =>
          past ? l.net != null && l.net < now : l.net == null || l.net >= now,
        )
        .sort((a, b) =>
          past ? (b.net ?? 0) - (a.net ?? 0) : (a.net ?? Infinity) - (b.net ?? Infinity),
        )
        .slice(0, limit);
      if (json) out(JSON.stringify(list, null, 2));
      else
        out(
          table(
            ['NET (UTC)', 'when', 'launch', 'provider', 'pad', 'status'],
            list.map((l) => [
              l.net
                ? new Date(l.net).toISOString().slice(0, 16).replace('T', ' ')
                : 'TBD',
              relativeTime(l.net, now),
              l.name,
              l.provider ?? '',
              l.pad,
              l.abbrev ?? l.status ?? '',
            ]),
          ),
        );
      return 0;
    }

    if (cmd === 'fires') {
      if (backend.health && !feedConfigured(backend.health, 'firms')) {
        err(
          'fires: needs FIRMS_MAP_KEY in .env (free at firms.modaps.eosdis.nasa.gov/api/map_key)',
        );
        return 1;
      }
      const place = await resolvePlace(backend, opt(argv, '--near'));
      const radiusKm = Math.min(1000, Number(opt(argv, '--radius') ?? 150));
      const b = bboxAround(place.lat, place.lon, radiusKm);
      const csv = await c.getText(
        'firms',
        `/VIIRS_SNPP_NRT/${b.lomin},${b.lamin},${b.lomax},${b.lamax}/1`,
      );
      const list = parseFires(csv).sort((x, y) => (y.meta.frp ?? 0) - (x.meta.frp ?? 0));
      if (json) out(JSON.stringify(list, null, 2));
      else {
        out(
          `${list.length} VIIRS detections within ${radiusKm} km of ${place.name} (last 24 h)`,
        );
        out(
          table(
            ['lat', 'lon', 'FRP (MW)', 'confidence', 'acquired'],
            list
              .slice(0, 40)
              .map((f) => [
                f.position.latitude.toFixed(3),
                f.position.longitude.toFixed(3),
                f.meta.frp?.toFixed(1) ?? '',
                f.meta.confidence ?? '',
                `${f.meta.acqDate ?? ''} ${f.meta.acqTime ?? ''}`,
              ]),
          ),
        );
      }
      return 0;
    }

    if (cmd === 'sats') {
      let sat;
      try {
        sat = await import('../core/layers/satellites/format.js');
      } catch {
        err('sats: satellite.js is not installed (run npm install)');
        return 1;
      }
      const group = opt(argv, '--group') ?? 'stations';
      const limit = Number(opt(argv, '--limit') ?? 40);
      const tle = await c.getText('celestrak', '/gp.php', {
        params: { GROUP: group, FORMAT: 'tle' },
      });
      const nowDate = new Date();
      const list = sat
        .tleToNormalized(tle, nowDate)
        .slice(0, limit)
        .map((n) => ({ id: n.id, name: n.meta.name, ...n.position }));
      if (json)
        out(
          JSON.stringify({ group, at: nowDate.toISOString(), satellites: list }, null, 2),
        );
      else {
        out(
          `${list.length} objects in CelesTrak group "${group}" at ${nowDate.toISOString()}`,
        );
        out(
          table(
            ['norad', 'name', 'lat', 'lon', 'alt'],
            list.map((s) => [
              s.id,
              s.name,
              s.latitude.toFixed(2),
              s.longitude.toFixed(2),
              `${Math.round(s.altitude / 1000)} km`,
            ]),
          ),
        );
      }
      return 0;
    }

    if (cmd === 'bgp' || cmd === 'ct') {
      if (!backend.wsBase || backend.health?.streams?.[cmd]?.available === false) {
        err(
          `${cmd}: proxy websockets are unavailable (run npm install so the proxy has the ws package)`,
        );
        return 1;
      }
      const count = Number(opt(argv, '--count') ?? 0);
      const url = `${backend.wsBase}/ws/${cmd}`;
      if (!json)
        err(
          `streaming ${cmd === 'bgp' ? 'RIPE RIS Live BGP updates (sampled)' : 'Certificate Transparency issuance'}; Ctrl-C to stop`,
        );
      const fmt =
        cmd === 'bgp'
          ? (ev) =>
              `${new Date().toISOString().slice(11, 19)}  ${ev.kind === 'A' ? 'announce ' : 'withdraw '} ${ev.rrc}  AS${ev.asn ?? '?'}`
          : (ev) =>
              `${new Date().toISOString().slice(11, 19)}  ${ev.domain}  +${ev.domains}  ${ev.ca}`;
      await streamLines(url, cmd, cmd === 'bgp' ? 'events' : 'certs', count, json, (ev) =>
        out(typeof ev === 'string' ? ev : fmt(ev)),
      );
      return 0;
    }

    err(`argus: unknown command ${cmd}`);
    return 2;
  } catch (e) {
    err(`argus ${cmd}: ${e?.message || e}`);
    for (const w of warnings) err(`[argus] ${w}`);
    return 1;
  } finally {
    if (!io.backend) await backend.close().catch(() => {});
  }
}

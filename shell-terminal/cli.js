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
import { feedConfigured } from '../core/net/discoverProxy.js';

export const CLI_COMMANDS = [
  'query',
  'correlate',
  'quakes',
  'flights',
  'sats',
  'fires',
  'geocode',
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
  return lines.join('\n');
}

async function resolvePlace(backend, text) {
  const ll = parseLatLon(text);
  if (ll) return { ...ll, name: `${ll.lat}, ${ll.lon}` };
  const places = await backend.geocode?.(text);
  if (!places?.length) throw new Error(`no place found for "${text}"`);
  return { lat: places[0].latitude, lon: places[0].longitude, name: places[0].name };
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
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
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
  ];
  const args = positionals(argv, valueFlags);

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

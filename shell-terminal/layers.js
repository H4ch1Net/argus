// The terminal shell's layer catalog. Each entry is config against the engine in
// engine.js, built from core's own pieces: the same parsers, normalizers, card
// formatters, push clients, Overpass client, and dev mocks the globe uses. What
// is terminal-specific is only how an entity is drawn (a glyph and a colour).
//
// GUARDRAIL (as everywhere): every source is a read of an already-public feed
// through the proxy allowlist. Surveillance maps camera LOCATIONS only.

import { parseFlights, adsbPointPath } from '../core/layers/flights/parse.js';
import {
  formatAircraft,
  aircraftToNormalized,
  aircraftSearchText,
} from '../core/layers/flights/format.js';
import { parseQuakes } from '../core/layers/earthquakes/parse.js';
import { describeQuake, magnitudeColorHex } from '../core/layers/earthquakes/format.js';
import { parseFires } from '../core/layers/fires/parse.js';
import { describeFire, fireColorHex } from '../core/layers/fires/format.js';
import {
  describeShip,
  shipHeading,
  shipToNormalized,
  shipSearchText,
} from '../core/layers/ships/format.js';
import { parseOverpass } from '../core/layers/overpass/parse.js';
import { createOverpassSource, areaTooLarge } from '../core/layers/overpass/client.js';
import {
  describeSurveillance,
  surveillanceKind,
} from '../core/layers/surveillance/format.js';
import { describeLandmark } from '../core/layers/landmarks/format.js';
import { parseShodanFacets } from '../core/layers/shodan/parse.js';
import { describeShodan, shodanColorHex } from '../core/layers/shodan/format.js';
import {
  bgpEventToNormalized,
  describeBgp,
  bgpSearchText,
} from '../core/layers/bgp/format.js';
import { parseMilitary, militarySearchText } from '../core/layers/military/parse.js';
import { ADSB_MILITARY_PATH } from '../core/layers/flights/parse.js';
import { createTransitSource } from '../core/layers/transit/source.js';
import { parseTransit, transitNote } from '../core/layers/transit/parse.js';
import {
  describeTransit,
  transitColorHex,
  transitSearchText,
} from '../core/layers/transit/format.js';
import { parseCyclones } from '../core/layers/cyclones/parse.js';
import {
  describeCyclone,
  cycloneColorHex,
  cycloneSearchText,
} from '../core/layers/cyclones/format.js';
import {
  parseLaunches,
  launchQuery,
  primaryLaunch,
} from '../core/layers/launches/parse.js';
import {
  describeLaunchPad,
  launchColorHex,
  launchSearchText,
} from '../core/layers/launches/format.js';
import { parseRadio, radioQuery } from '../core/layers/radio/parse.js';
import {
  describeRadio,
  radioColorHex,
  radioSearchText,
} from '../core/layers/radio/format.js';
import {
  DATACENTER_FILTERS,
  DATACENTER_MAX_DEG,
  INSTALLATION_FILTERS,
  INSTALLATION_MAX_DEG,
  describeDatacenter,
  describeInstallation,
  installationColorHex,
  infraSearchText,
} from '../core/layers/infrastructure/format.js';
import { parseLandingPoints } from '../core/layers/cables/parse.js';
import { describeLanding } from '../core/layers/cables/format.js';
import {
  createConstellationSource,
  groupInfo,
  mergeGroups,
} from '../core/layers/constellations/groups.js';
import { feedConfigured } from '../core/net/discoverProxy.js';

export const GLYPHS = {
  unicode: {
    arrows: ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'],
    quake: ['·', 'o', 'O', '@'],
    fire: '▲',
    sat: '✦',
    camera: '◉',
    alpr: '◈',
    landmark: '◆',
    shodan: '■',
    bgp: '•',
    osint: '◎',
    trail: '·',
    transit: '▪',
    cyclone: '✺',
    launch: '↟',
    radio: '♪',
    datacenter: '▣',
    installation: '⊞',
    landing: '◇',
    navsat: '✧',
  },
  ascii: {
    arrows: ['^', '/', '>', '\\', 'v', '/', '<', '\\'],
    quake: ['.', 'o', 'O', '@'],
    fire: '^',
    sat: '*',
    camera: 'c',
    alpr: 'A',
    landmark: 'L',
    shodan: '#',
    bgp: '+',
    osint: '@',
    trail: '.',
    transit: 'b',
    cyclone: '%',
    launch: '!',
    radio: 'r',
    datacenter: 'D',
    installation: 'M',
    landing: '=',
    navsat: ':',
  },
};

export const arrowFor = (deg, set) =>
  set.arrows[Math.round((((Number(deg) || 0) % 360) + 360) / 45) % 8];

function hslToHex(h, s, l) {
  const k = (n) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)]
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** Same ramp as the globe's flights layer: green low, gold high. */
export function altitudeColorHex(metres) {
  const t = Math.max(0, Math.min(1, (metres || 0) / 12000));
  return hslToHex(0.34 - 0.17 * t, 0.85, 0.6);
}

const OVERPASS_MAX_DEG = 3;
const SURVEILLANCE_FILTERS = [
  'node["man_made"="surveillance"]',
  'way["man_made"="surveillance"]',
];
const LANDMARK_FILTERS = ['node["tourism"]', 'node["historic"]'];

/**
 * @param {{ client: object|null, wsBase: string|null, health: object|null, demo: boolean,
 *   viewer: object, glyphs: object, satGroup?: string }} ctx
 * @returns {object[]} layer definitions, in hotkey order
 */
export function buildLayers({
  client,
  wsBase,
  health,
  demo,
  viewer,
  glyphs,
  satGroup = 'stations',
}) {
  const g = glyphs;
  const needs = (feed, secret) =>
    !demo && health && !feedConfigured(health, feed)
      ? `needs ${secret} in .env (proxy side)`
      : null;
  const streamIssue = (name, secret) => {
    const s = health?.streams?.[name];
    if (demo || !health || !s) return null;
    if (!s.available)
      return 'proxy websockets unavailable (npm install for the ws package)';
    return s.configured ? null : `needs ${secret} in .env (proxy side)`;
  };

  // Satellites need satellite.js (SGP4). Loaded lazily so the rest of the shell
  // runs even before `npm install` has fetched it.
  let sat = null;
  const loadSat = async () => {
    if (sat) return sat;
    try {
      const [fmt, prop] = await Promise.all([
        import('../core/layers/satellites/format.js'),
        import('../core/layers/satellites/propagate.js'),
      ]);
      sat = { ...fmt, ...prop };
      return sat;
    } catch {
      throw new Error('satellite.js is not installed (run npm install)');
    }
  };

  const layers = [
    {
      key: 'flights',
      label: 'Flights',
      mode: 'poll',
      intervalMs: 15_000,
      viewportBounded: true,
      interpolate: true,
      makeSource: async () => {
        if (demo) {
          const m = await import('../core/layers/flights/mockSource.js');
          return m.createMockSource();
        }
        // OpenSky when its client is configured, else keyless adsb.lol (as on the globe).
        if (!health || feedConfigured(health, 'opensky')) {
          return (q, signal) =>
            client.getJson('opensky', '/states/all', { params: q.bbox, signal });
        }
        return (q, signal) =>
          client.getJson('adsblol', adsbPointPath(q.bbox), { signal });
      },
      normalize: (raw) => parseFlights(raw).aircraft.map(aircraftToNormalized),
      describe: (n) => formatAircraft(n.meta),
      searchText: aircraftSearchText,
      glyph: (n) => ({
        ch: arrowFor(n.meta.trueTrack, g),
        color: altitudeColorHex(n.position.altitude),
      }),
      legend: () => `${g.arrows[2]} aircraft (colour = altitude)`,
    },
    {
      key: 'quakes',
      label: 'Earthquakes',
      mode: 'poll',
      intervalMs: 2 * 60_000,
      makeSource: async () =>
        demo
          ? (
              await import('../core/layers/earthquakes/mockSource.js')
            ).createQuakeMockSource({ viewer })
          : (_q, signal) => client.getJson('usgs-quakes', '/all_day.geojson', { signal }),
      normalize: (raw) => parseQuakes(raw),
      describe: describeQuake,
      searchText: (n) => `${n.meta.place} M${n.meta.mag ?? ''}`,
      glyph: (n) => {
        const mag = n.meta.mag ?? 0;
        const i = mag < 2.5 ? 0 : mag < 4.5 ? 1 : mag < 6 ? 2 : 3;
        return { ch: g.quake[i], color: magnitudeColorHex(n.meta.mag), bold: mag >= 4.5 };
      },
      priority: (n) => (n.meta.mag ?? 0) * 2,
      legend: () => `${g.quake.join(' ')} quakes by magnitude`,
    },
    {
      key: 'satellites',
      label: 'Satellites',
      mode: 'poll',
      intervalMs: 6 * 60 * 60_000, // CelesTrak asks for at most one download per update cycle
      makeSource: async () => {
        await loadSat();
        if (demo) {
          const m = await import('../core/layers/satellites/mockSource.js');
          return m.createSatMockSource();
        }
        return (_q, signal) =>
          client.getText('celestrak', '/gp.php', {
            params: { GROUP: satGroup, FORMAT: 'tle' },
            signal,
          });
      },
      normalize: (tle) => (sat ? sat.tleToNormalized(tle) : []),
      positionAt: (n, t) => (sat ? sat.satPositionAt(n.meta.satrec, new Date(t)) : null),
      describe: (n, t) => (sat ? sat.describeSatellite(n, new Date(t)) : null),
      searchText: (n) => `${n.meta.name} ${n.id}`,
      glyph: () => ({ ch: g.sat, color: '#ffd95f' }),
      track: (n, t) => (sat ? sat.orbitTrack(n.meta.satrec, new Date(t), 120) : []),
      legend: () => `${g.sat} satellites (SGP4)`,
    },
    {
      key: 'fires',
      label: 'Fires',
      mode: 'poll',
      intervalMs: 5 * 60_000,
      viewportBounded: true,
      unavailable: needs('firms', 'FIRMS_MAP_KEY'),
      makeSource: async () => {
        if (demo)
          return (
            await import('../core/layers/fires/mockSource.js')
          ).createFireMockSource();
        if (needs('firms', 'FIRMS_MAP_KEY')) return null;
        return (q, signal) =>
          client.getText(
            'firms',
            `/VIIRS_SNPP_NRT/${q.bbox.lomin},${q.bbox.lamin},${q.bbox.lomax},${q.bbox.lamax}/1`,
            { signal },
          );
      },
      normalize: (csv) => parseFires(csv),
      describe: describeFire,
      glyph: (n) => ({ ch: g.fire, color: fireColorHex(n.meta.frp) }),
      legend: () => `${g.fire} fire detections (VIIRS)`,
    },
    {
      key: 'ships',
      label: 'Ships',
      mode: 'push',
      interpolate: true,
      interpolateLagMs: 5000,
      staleMs: 180_000,
      maxEntities: 3000,
      unavailable: streamIssue('ais', 'AISSTREAM_API_KEY'),
      makeSource: async () => {
        if (demo) {
          const m = await import('../core/layers/ships/mockSource.js');
          return m.createShipMockSource({ viewer });
        }
        if (!wsBase || streamIssue('ais', 'AISSTREAM_API_KEY')) return null;
        const { createAisSource } = await import('../core/layers/ships/aisSource.js');
        return createAisSource({ wsUrl: `${wsBase}/ws/ais`, viewer });
      },
      normalize: (ships) => ships.map(shipToNormalized),
      describe: describeShip,
      searchText: shipSearchText,
      glyph: (n) => ({ ch: arrowFor(shipHeading(n), g), color: '#7fd4ff' }),
      legend: () => `${g.arrows[0]} vessels (AIS)`,
    },
    {
      key: 'transit',
      label: 'Transit',
      mode: 'poll',
      intervalMs: 15_000,
      viewportBounded: true,
      interpolate: true,
      maxEntities: 6000,
      makeSource: async () => {
        if (demo) {
          const m = await import('../core/layers/transit/mockSource.js');
          return m.createTransitMockSource();
        }
        return createTransitSource({ proxyClient: client });
      },
      normalize: (raw) => parseTransit(raw),
      describe: (n) => describeTransit(n),
      searchText: transitSearchText,
      glyph: (n) => ({ ch: g.transit, color: transitColorHex(n.meta.routeId) }),
      statusNote: (_q, raw) => transitNote(raw),
      legend: () => `${g.transit} transit vehicles (GTFS-RT, colour = route)`,
    },
    {
      key: 'surveillance',
      label: 'Surveillance',
      mode: 'viewport',
      makeSource: async () =>
        demo
          ? (
              await import('../core/layers/surveillance/mockSource.js')
            ).createSurveillanceMockSource({ viewer })
          : createOverpassSource({
              proxyClient: client,
              filters: SURVEILLANCE_FILTERS,
              maxAreaDeg: OVERPASS_MAX_DEG,
            }),
      normalize: (json) => parseOverpass(json),
      describe: describeSurveillance,
      searchText: (n) =>
        `${n.meta.tags.operator || ''} ${n.meta.tags['surveillance:type'] || ''}`,
      glyph: (n) =>
        surveillanceKind(n.meta.tags) === 'ALPR'
          ? { ch: g.alpr, color: '#ff4d4d', bold: true }
          : { ch: g.camera, color: '#ffb454' },
      statusNote: (q) =>
        !demo && q.bbox && areaTooLarge(q.bbox, OVERPASS_MAX_DEG)
          ? 'zoom in to a city to load'
          : '',
      legend: () => `${g.camera} camera  ${g.alpr} ALPR reader (locations only)`,
    },
    {
      key: 'military',
      label: 'Military air',
      mode: 'poll',
      intervalMs: 15_000,
      interpolate: true,
      maxEntities: 1500,
      makeSource: async () => {
        if (demo) {
          const m = await import('../core/layers/military/mockSource.js');
          return m.createMilitaryMockSource();
        }
        return (_q, signal) => client.getJson('adsblol', ADSB_MILITARY_PATH, { signal });
      },
      normalize: (raw) => parseMilitary(raw),
      describe: (n) => formatAircraft(n.meta),
      searchText: militarySearchText,
      glyph: (n) => ({ ch: arrowFor(n.meta.trueTrack, g), color: '#ff7a59', bold: true }),
      legend: () => `${g.arrows[2]} military aircraft (adsb.lol)`,
    },
    {
      key: 'bgp',
      label: 'BGP',
      mode: 'push',
      unavailable: streamIssue('bgp'),
      staleMs: 2500,
      maxEntities: 400,
      makeSource: async () => {
        if (demo)
          return (await import('../core/layers/bgp/mockSource.js')).createBgpMockSource();
        if (!wsBase || streamIssue('bgp')) return null;
        const { createRisSource } = await import('../core/layers/bgp/risSource.js');
        return createRisSource({ wsUrl: `${wsBase}/ws/bgp` });
      },
      normalize: (events) => events.map(bgpEventToNormalized).filter(Boolean),
      describe: describeBgp,
      searchText: bgpSearchText,
      glyph: (n) => ({
        ch: g.bgp,
        color: n.meta.kind === 'A' ? '#5fe3ff' : '#ffb454',
        bold: true,
      }),
      legend: () =>
        `${g.bgp} BGP updates at RIS collectors (cyan announce, amber withdraw)`,
    },
    {
      key: 'landmarks',
      label: 'Landmarks',
      mode: 'viewport',
      makeSource: async () =>
        demo
          ? (
              await import('../core/layers/landmarks/mockSource.js')
            ).createLandmarkMockSource({ viewer })
          : createOverpassSource({
              proxyClient: client,
              filters: LANDMARK_FILTERS,
              maxAreaDeg: OVERPASS_MAX_DEG,
            }),
      normalize: (json) => parseOverpass(json),
      describe: describeLandmark,
      searchText: (n) =>
        `${n.meta.tags.name || ''} ${n.meta.tags.tourism || n.meta.tags.historic || ''}`,
      glyph: () => ({ ch: g.landmark, color: '#c9a6ff' }),
      statusNote: (q) =>
        !demo && q.bbox && areaTooLarge(q.bbox, OVERPASS_MAX_DEG)
          ? 'zoom in to a city to load'
          : '',
      legend: () => `${g.landmark} landmarks (OSM)`,
    },
    {
      key: 'shodan',
      label: 'Shodan',
      mode: 'once',
      unavailable: needs('shodan', 'SHODAN_API_KEY'),
      makeSource: async () => {
        if (demo)
          return (
            await import('../core/layers/shodan/mockSource.js')
          ).createShodanMockSource();
        if (needs('shodan', 'SHODAN_API_KEY')) return null;
        // Credit-free count facets only: awareness, never search-on-pan.
        return (_q, signal) =>
          client.getJson('shodan', '/shodan/host/count', {
            params: { query: 'product:Apache httpd', facets: 'country:200' },
            signal,
          });
      },
      normalize: (json) => parseShodanFacets(json, 'country'),
      describe: describeShodan,
      searchText: (n) => n.meta.country,
      glyph: (n) => ({ ch: g.shodan, color: shodanColorHex(n.meta.count) }),
      priority: (n) => Math.log10(Math.max(1, n.meta.count)),
      legend: () => `${g.shodan} exposed-host density by country`,
    },
    {
      key: 'cyclones',
      label: 'Cyclones',
      mode: 'poll',
      intervalMs: 5 * 60_000,
      makeSource: async () =>
        demo
          ? (
              await import('../core/layers/cyclones/mockSource.js')
            ).createCycloneMockSource()
          : (_q, signal) => client.getJson('nhc', '/CurrentStorms.json', { signal }),
      normalize: (raw) => parseCyclones(raw),
      describe: describeCyclone,
      searchText: cycloneSearchText,
      glyph: (n) => ({
        ch: g.cyclone,
        color: cycloneColorHex(n.meta.windKt),
        bold: true,
      }),
      priority: (n) => (n.meta.windKt ?? 0) / 10,
      statusNote: (_q, raw) =>
        raw && !raw.activeStorms?.length ? 'no active storms' : '',
      legend: () => `${g.cyclone} tropical cyclones (NOAA NHC)`,
    },
    {
      key: 'launches',
      label: 'Launches',
      mode: 'poll',
      intervalMs: 15 * 60_000,
      makeSource: async () =>
        demo
          ? (
              await import('../core/layers/launches/mockSource.js')
            ).createLaunchMockSource()
          : (_q, signal) =>
              client.getJson('ll2', '/launches/', { params: launchQuery(), signal }),
      normalize: (raw) => parseLaunches(raw),
      describe: (n) => describeLaunchPad(n),
      searchText: launchSearchText,
      glyph: (n) => ({
        ch: g.launch,
        color: launchColorHex(primaryLaunch(n.meta.launches)),
      }),
      legend: () => `${g.launch} launch pads (green ahead, amber < 24 h)`,
    },
    {
      key: 'radio',
      label: 'Radio',
      mode: 'poll',
      intervalMs: 45 * 60_000,
      maxEntities: 1500,
      makeSource: async () =>
        demo
          ? (await import('../core/layers/radio/mockSource.js')).createRadioMockSource()
          : (_q, signal) =>
              client.getJson('radiobrowser', '/json/stations/search', {
                params: radioQuery(),
                signal,
              }),
      normalize: (raw) => parseRadio(raw),
      describe: describeRadio,
      searchText: radioSearchText,
      glyph: (n) => ({ ch: g.radio, color: radioColorHex(n) }),
      priority: (n) => Math.log10(Math.max(1, n.meta.clicks ?? 1)) / 4,
      legend: () => `${g.radio} radio stations (amber = news/scanner)`,
    },
    {
      key: 'datacenters',
      label: 'Data centres',
      mode: 'viewport',
      maxEntities: 3000,
      makeSource: async () =>
        demo
          ? (
              await import('../core/layers/infrastructure/mockSource.js')
            ).createInfraMockSource({ viewer, kind: 'datacenters' })
          : createOverpassSource({
              proxyClient: client,
              filters: DATACENTER_FILTERS,
              maxAreaDeg: DATACENTER_MAX_DEG,
            }),
      normalize: (json) => parseOverpass(json),
      describe: describeDatacenter,
      searchText: infraSearchText,
      glyph: () => ({ ch: g.datacenter, color: '#80deea' }),
      statusNote: (q) =>
        !demo && q.bbox && areaTooLarge(q.bbox, DATACENTER_MAX_DEG)
          ? 'zoom in to load'
          : '',
      legend: () => `${g.datacenter} data centres (OSM)`,
    },
    {
      key: 'installations',
      label: 'Installations',
      mode: 'viewport',
      maxEntities: 3000,
      makeSource: async () =>
        demo
          ? (
              await import('../core/layers/infrastructure/mockSource.js')
            ).createInfraMockSource({ viewer, kind: 'installations' })
          : createOverpassSource({
              proxyClient: client,
              filters: INSTALLATION_FILTERS,
              maxAreaDeg: INSTALLATION_MAX_DEG,
            }),
      normalize: (json) => parseOverpass(json),
      describe: describeInstallation,
      searchText: infraSearchText,
      glyph: (n) => ({ ch: g.installation, color: installationColorHex(n.meta.tags) }),
      statusNote: (q) =>
        !demo && q.bbox && areaTooLarge(q.bbox, INSTALLATION_MAX_DEG)
          ? 'zoom in to load'
          : '',
      legend: () => `${g.installation} mapped military installations (OSM)`,
    },
    {
      key: 'landings',
      label: 'Cable landings',
      mode: 'poll',
      intervalMs: 24 * 60 * 60_000,
      maxEntities: 3000,
      // The globe draws the cables themselves; a braille map shows where they land.
      makeSource: async () =>
        demo
          ? async () => ({
              features: [
                {
                  properties: { id: 'demo-a', name: 'Demo landing A (simulated)' },
                  geometry: { type: 'Point', coordinates: [-4.5, 50.8] },
                },
                {
                  properties: { id: 'demo-b', name: 'Demo landing B (simulated)' },
                  geometry: { type: 'Point', coordinates: [-74, 40.5] },
                },
              ],
            })
          : (_q, signal) =>
              client.getJson('cables', '/landing-point/landing-point-geo.json', {
                signal,
              }),
      normalize: (raw) => parseLandingPoints(raw),
      describe: describeLanding,
      searchText: (n) => `${n.meta.name} cable landing`,
      glyph: () => ({ ch: g.landing, color: '#4fc3f7' }),
      legend: () => `${g.landing} submarine cable landing points (TeleGeography)`,
    },
    {
      key: 'constellations',
      label: 'Nav & GEO sats',
      mode: 'poll',
      intervalMs: 6 * 60 * 60_000,
      maxEntities: 1200,
      makeSource: async () => {
        await loadSat();
        if (demo) {
          const m = await import('../core/layers/satellites/mockSource.js');
          const tle = m.createSatMockSource({ count: 12 });
          return async () => [{ group: 'gps-ops', text: await tle() }];
        }
        return createConstellationSource({ proxyClient: client });
      },
      normalize: (results) => (sat ? mergeGroups(results, sat.tleToNormalized) : []),
      positionAt: (n, t) => (sat ? sat.satPositionAt(n.meta.satrec, new Date(t)) : null),
      describe: (n, t) => {
        const card = sat ? sat.describeSatellite(n, new Date(t)) : null;
        return (
          card && { ...card, rows: [['Constellation', n.meta.groupLabel], ...card.rows] }
        );
      },
      searchText: (n) => `${n.meta.name} ${n.id} ${n.meta.groupLabel}`,
      glyph: (n) => ({ ch: g.navsat, color: groupInfo(n.meta.group).color }),
      legend: () => `${g.navsat} GPS / Galileo / GLONASS / GEO satellites`,
    },
  ];

  // Digits toggle the first nine; the rest via `:layer <name>` or a click / tap on
  // their row in the side panel.
  return layers.map((l, i) => ({ ...l, hotkey: i < 9 ? String(i + 1) : ' ' }));
}

/** CT firehose source (a panel, not a map layer: certificates have no geography). */
export async function makeCtSource({ demo, wsBase, health }) {
  if (demo) {
    const m = await import('../core/osint/ct/mockCtSource.js');
    return m.createCtMockSource();
  }
  if (!wsBase || health?.streams?.ct?.available === false) return null;
  const { createCtSource } = await import('../core/osint/ct/ctSource.js');
  return createCtSource({ wsUrl: `${wsBase}/ws/ct` });
}

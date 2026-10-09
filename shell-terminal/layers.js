// The terminal shell's layer catalog. Each entry is config against the engine in
// engine.js, built from core's own pieces: the same parsers, normalizers, card
// formatters, push clients, Overpass client, and dev mocks the globe uses. What
// is terminal-specific is only how an entity is drawn (a glyph and a colour).
//
// GUARDRAIL (as everywhere): every source is a read of an already-public feed
// through the proxy allowlist. Surveillance maps camera LOCATIONS only.

import {
  parseFlights,
  adsbPointPath,
  openSkyParams,
} from '../core/layers/flights/parse.js';
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
  shipVelocity,
} from '../core/layers/ships/format.js';
import { parseOverpass } from '../core/layers/overpass/parse.js';
import { createOverpassSource, areaTooLarge } from '../core/layers/overpass/client.js';
import {
  describeSurveillance,
  surveillanceKind,
  surveillanceHeading,
  surveillanceColorHex,
  surveillanceSearchText,
} from '../core/layers/surveillance/format.js';
import { normalizeSurveillance } from '../core/layers/surveillance/parse.js';
import { createSurveillanceSource } from '../core/layers/surveillance/source.js';
import { describeLandmark, landmarkSearchText } from '../core/layers/landmarks/format.js';
import {
  normalizeLandmarks,
  createLandmarksLoader,
  createLandmarksSource,
} from '../core/layers/landmarks/parse.js';
import { normalizeSignals, createSignalsSource } from '../core/layers/signals/parse.js';
import { describeSignal, signalSearchText } from '../core/layers/signals/format.js';
import { tiledNote } from '../core/layers/overpass/tiles.js';
import { describeShodan, shodanColorHex } from '../core/layers/shodan/format.js';
import {
  bgpEventToNormalized,
  describeBgp,
  bgpSearchText,
} from '../core/layers/bgp/format.js';
import { parseMilitary, militarySearchText } from '../core/layers/military/parse.js';
import { parseLocalAdsb } from '../core/layers/localadsb/parse.js';
import { parsePerimeters } from '../core/layers/perimeters/parse.js';
import {
  describePerimeter,
  perimeterSearchText,
} from '../core/layers/perimeters/format.js';
import {
  DAM_FILTERS,
  DAM_MAX_DEG,
  describeDam,
  damSearchText,
} from '../core/layers/dams/format.js';
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
import { createBikeshareSource } from '../core/layers/bikeshare/systems.js';
import {
  parseBikeshare,
  bikeshareNote,
  describeBikeStation,
  bikeColorHex,
  bikeshareSearchText,
} from '../core/layers/bikeshare/format.js';
import { createTrafficCamSource } from '../core/layers/trafficcams/sources.js';
import {
  parseTrafficCams,
  trafficCamNote,
  describeTrafficCam,
  trafficCamSearchText,
} from '../core/layers/trafficcams/format.js';
import { createWebcamSource } from '../core/layers/webcams/sources.js';
import {
  parseWebcams,
  webcamNote,
  describeWebcam,
  webcamSearchText,
  webcamColorHex,
} from '../core/layers/webcams/format.js';
import { createBorderWaitSource } from '../core/layers/borderwaits/source.js';
import {
  parseBorderWaits,
  borderWaitNote,
  describeBorderWait,
  borderWaitSearchText,
  borderWaitColorHex,
} from '../core/layers/borderwaits/format.js';
import { parseLandingPoints } from '../core/layers/cables/parse.js';
import { describeLanding } from '../core/layers/cables/format.js';
import {
  createConstellationSource,
  groupInfo,
  mergeGroups,
} from '../core/layers/constellations/groups.js';
import { feedConfigured } from '../core/net/discoverProxy.js';
import { parseTomTomIncidents } from '../core/layers/incidents/parse.js';
import { parseWaze } from '../core/layers/waze/parse.js';
import {
  describeWaze,
  wazeColorHex,
  wazeSearchText,
} from '../core/layers/waze/format.js';
import { createWazeSource, createWazeMockSource } from '../core/layers/waze/source.js';
import {
  describeIncident,
  incidentColorHex,
  incidentSearchText,
} from '../core/layers/incidents/format.js';
import {
  createIncidentSource,
  createIncidentMockSource,
} from '../core/layers/incidents/source.js';
import { parseChpXml } from '../core/layers/chp/parse.js';
import { describeChp, chpSearchText } from '../core/layers/chp/format.js';
import { parseOnionoo, onionooQuery, ONIONOO_PATH } from '../core/layers/tor/parse.js';
import {
  describeTor,
  torColorHex,
  torNote,
  torSearchText,
} from '../core/layers/tor/format.js';
import { parseGdeltEvents, gdeltStatusNote } from '../core/layers/gdelt/parse.js';
import {
  describeGdelt,
  gdeltColorHex,
  gdeltSearchText,
} from '../core/layers/gdelt/format.js';
import { createGdeltSource, createGdeltMockSource } from '../core/layers/gdelt/source.js';
import { shodanToNormalized } from '../core/layers/shodan/parse.js';
import { shodanSearchText } from '../core/layers/shodan/format.js';
import { createShodanSource } from '../core/layers/shodan/source.js';
import { createSimTrafficSource } from '../core/layers/simtraffic/source.js';
import { createSimTrafficMockSource } from '../core/layers/simtraffic/mockSource.js';
import {
  createSimDriver,
  describeSimVehicle,
  viewOfBbox,
} from '../core/layers/simtraffic/driver.js';
import { CONGESTION_COLORS } from '../core/layers/simtraffic/format.js';
import { streetPhotoToNormalized } from '../core/layers/streetphotos/parse.js';
import {
  describeStreetPhoto,
  streetPhotoSearchText,
} from '../core/layers/streetphotos/format.js';
import { createStreetPhotoSource } from '../core/layers/streetphotos/source.js';
import { createStreetPhotoMockSource } from '../core/layers/streetphotos/mockSource.js';

export const GLYPHS = {
  unicode: {
    arrows: ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'],
    quake: ['·', 'o', 'O', '@'],
    fire: '▲',
    sat: '✦',
    camera: '◉',
    alpr: '◈',
    ptz: '⊙',
    speedcam: '⊕',
    redlight: '⊗',
    acoustic: '∴',
    guardpost: '⌂',
    signal: '⋮',
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
    trafficcam: '◘',
    webcam: '◫',
    border: '⊟',
    bike: '¤',
    perimeter: '▲',
    dam: '▬',
    incident: {
      accident: '✕',
      jam: '≡',
      roadworks: '▥',
      closure: '⊘',
      hazard: '!',
      weather: '≈',
      police: '⊽',
    },
    relay: { exit: '»', guard: '◙', middle: '∙' },
    news: '¶',
    simcar: '▫',
    photo: '⊡',
    host: '◦',
  },
  ascii: {
    arrows: ['^', '/', '>', '\\', 'v', '/', '<', '\\'],
    quake: ['.', 'o', 'O', '@'],
    fire: '^',
    sat: '*',
    camera: 'c',
    alpr: 'A',
    ptz: 'p',
    speedcam: 'S',
    redlight: 'R',
    acoustic: 'G',
    guardpost: 'H',
    signal: 's',
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
    trafficcam: 'T',
    webcam: 'W',
    border: 'B',
    bike: '$',
    perimeter: 'P',
    dam: '=',
    incident: {
      accident: 'x',
      jam: '=',
      roadworks: 'w',
      closure: '0',
      hazard: '!',
      weather: '~',
      police: 'P',
    },
    relay: { exit: '>', guard: 'g', middle: 'o' },
    news: 'n',
    simcar: 'v',
    photo: 'p',
    host: 'o',
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

// The terminal glyph for each surveillance kind (core/layers/surveillance/kinds.js).
const SURVEILLANCE_CHAR = {
  alpr: 'alpr',
  acoustic: 'acoustic',
  redlight: 'redlight',
  speed: 'speedcam',
  average: 'speedcam',
  guard: 'guardpost',
  ptz: 'ptz',
};

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
  // Keyed networks (511 states, WSDOT, Windy, NPS) are offered only when the
  // proxy reports their feed configured.
  const keyed = (feed) => !demo && Boolean(health && feedConfigured(health, feed));
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

  // Road incidents (TomTom, CHP): glyph by kind, colour and rank by severity.
  const incidentGlyph = (n) => ({
    ch: g.incident[n.meta.kind] ?? g.incident.hazard,
    color: incidentColorHex(n.meta.severity),
    bold: n.meta.severity === 'critical',
  });
  const incidentPriority = (n) =>
    n.meta.severity === 'critical' ? 2 : n.meta.severity === 'notable' ? 1 : 0;
  let torStatus = '';
  // The simulated traffic's model driver (positions by time) and its note.
  const simDriver = createSimDriver({ cap: 150 });
  let simNote = '';

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
            client.getJson('opensky', '/states/all', {
              params: openSkyParams(q.bbox),
              signal,
            });
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
      interpolateLagMs: 8000,
      extrapolateMs: 60_000,
      velocityOf: shipVelocity,
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
      // OSM cameras, ALPR readers (DeFlock's mapping), acoustic sensors, guard
      // posts, speed and red-light cameras; each 0.1 degree tile fetched once.
      makeSource: async () =>
        demo
          ? (
              await import('../core/layers/surveillance/mockSource.js')
            ).createSurveillanceMockSource({ viewer })
          : createSurveillanceSource({ proxyClient: client }),
      normalize: (raw) => normalizeSurveillance(raw),
      describe: describeSurveillance,
      searchText: surveillanceSearchText,
      // A device mapped with a facing draws as an arrow that way (the
      // terminal's direction tick); one without keeps its kind's glyph.
      glyph: (n) => {
        const kind = surveillanceKind(n);
        const facing = surveillanceHeading(n);
        const color = surveillanceColorHex(kind);
        const strong = kind === 'alpr' || kind === 'acoustic';
        if (facing != null) return { ch: arrowFor(facing, g), color, bold: strong };
        return { ch: g[SURVEILLANCE_CHAR[kind]] ?? g.camera, color, bold: strong };
      },
      priority: (n) => (surveillanceKind(n) === 'alpr' ? 1 : 0),
      statusNote: (_q, raw) => (demo ? '' : tiledNote(raw)),
      legend: () =>
        `${g.camera} camera ${g.alpr} ALPR ${g.acoustic} acoustic ${g.speedcam} speed ${g.redlight} red-light ${g.guardpost} guard ${g.arrows[1]} facing (OSM, DeFlock; locations only)`,
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
      key: 'localadsb',
      label: 'My receiver',
      mode: 'poll',
      intervalMs: 2000,
      interpolate: true,
      maxEntities: 1000,
      // 1090 MHz (LOCAL_ADSB_URL) and/or 978 MHz UAT (LOCAL_UAT_URL).
      unavailable:
        needs('local-adsb', 'LOCAL_ADSB_URL') && needs('local-uat', 'LOCAL_UAT_URL')
          ? 'needs LOCAL_ADSB_URL or LOCAL_UAT_URL in .env (proxy side)'
          : null,
      makeSource: async () => {
        if (demo) {
          const m = await import('../core/layers/localadsb/mockSource.js');
          return m.createLocalAdsbMockSource({ viewer });
        }
        const { createLocalReceiverSource, LOCAL_RECEIVER_FEEDS } =
          await import('../core/layers/localadsb/source.js');
        const feeds = LOCAL_RECEIVER_FEEDS.filter(
          (f) => !health || feedConfigured(health, f.feed),
        );
        if (!feeds.length) return null;
        return createLocalReceiverSource({ proxyClient: client, feeds });
      },
      normalize: (raw) => parseLocalAdsb(raw),
      describe: (n) => formatAircraft(n.meta),
      searchText: aircraftSearchText,
      glyph: (n) => ({ ch: arrowFor(n.meta.trueTrack, g), color: '#b388ff', bold: true }),
      legend: () => `${g.arrows[2]} aircraft heard by your receiver (1090 / 978 MHz)`,
    },
    {
      key: 'landmarks',
      label: 'Landmarks',
      mode: 'viewport',
      // Named OSM attractions, museums, monuments, castles, towers (Wikipedia
      // linked ones first in the glyph priority); each tile fetched once.
      makeSource: async () =>
        demo
          ? (
              await import('../core/layers/landmarks/mockSource.js')
            ).createLandmarkMockSource({ viewer })
          : createLandmarksSource(createLandmarksLoader({ proxyClient: client })),
      normalize: (raw) => normalizeLandmarks(raw),
      describe: describeLandmark,
      searchText: landmarkSearchText,
      glyph: (n) => ({ ch: g.landmark, color: '#c9a6ff', bold: n.meta.notable }),
      priority: (n) => (n.meta.notable ? 1 : 0),
      statusNote: (_q, raw) =>
        demo ? '' : tiledNote(raw, { tooWide: 'zoom in to a city to load' }),
      legend: () => `${g.landmark} landmarks (OSM, bold: on Wikipedia)`,
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
        // A curated snapshot through the credit-free count endpoint (the
        // proxy pins the query): awareness, never search-on-pan. The snapshot
        // is ARGUS_SHODAN_SNAPSHOT (core/layers/shodan/snapshots.js ids).
        return createShodanSource({
          proxyClient: client,
          getSnapshot: () => process.env.ARGUS_SHODAN_SNAPSHOT,
        });
      },
      normalize: (raw) => shodanToNormalized(raw),
      describe: describeShodan,
      searchText: shodanSearchText,
      glyph: (n) =>
        n.type === 'shodan-host'
          ? { ch: g.host, color: '#ffffff' }
          : { ch: g.shodan, color: shodanColorHex(n.meta.count) },
      priority: (n) => Math.log10(Math.max(1, n.meta.count ?? 1)),
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
      key: 'trafficcams',
      label: 'Traffic cams',
      mode: 'poll',
      intervalMs: 15 * 60_000,
      viewportBounded: true,
      maxEntities: 4000,
      makeSource: async () =>
        demo
          ? (
              await import('../core/layers/trafficcams/mockSource.js')
            ).createTrafficCamMockSource({ viewer })
          : createTrafficCamSource({ proxyClient: client, isConfigured: keyed }),
      normalize: (raw) => parseTrafficCams(raw),
      // The card carries the still's proxy URL as a link (a terminal shows no images).
      describe: describeTrafficCam,
      searchText: trafficCamSearchText,
      glyph: () => ({ ch: g.trafficcam, color: '#5fe3ff' }),
      statusNote: (_q, raw) => trafficCamNote(raw),
      legend: () => `${g.trafficcam} public traffic cameras (stills on request)`,
    },
    {
      key: 'webcams',
      label: 'Public webcams',
      mode: 'poll',
      intervalMs: 5 * 60_000,
      viewportBounded: true,
      maxEntities: 1500,
      // Windy (WINDY_WEBCAMS_KEY) and NPS (NPS_API_KEY) only when the proxy has
      // their keys; NASA EPIC and the observatory stills are keyless.
      makeSource: async () => {
        if (!demo)
          return createWebcamSource({ proxyClient: client, isConfigured: keyed });
        const m = await import('../core/layers/webcams/mockSource.js');
        return m.createWebcamMockSource({ viewer });
      },
      normalize: (raw) => parseWebcams(raw),
      // The card carries the still's proxy URL as a link (a terminal shows no images).
      describe: describeWebcam,
      searchText: webcamSearchText,
      glyph: (n) => ({ ch: g.webcam, color: webcamColorHex(n.meta.category) }),
      statusNote: (_q, raw) => webcamNote(raw),
      legend: () =>
        `${g.webcam} public webcams (Windy, NPS, NASA EPIC; stills on request)`,
    },
    {
      key: 'borderwaits',
      label: 'Border waits',
      mode: 'poll',
      intervalMs: 5 * 60_000,
      viewportBounded: true,
      maxEntities: 200,
      makeSource: async () =>
        demo
          ? (
              await import('../core/layers/borderwaits/mockSource.js')
            ).createBorderWaitMockSource()
          : createBorderWaitSource({
              proxyClient: client,
              cameraSource: createTrafficCamSource({
                proxyClient: client,
                isConfigured: keyed,
              }),
            }),
      normalize: (raw) => parseBorderWaits(raw),
      describe: describeBorderWait,
      searchText: borderWaitSearchText,
      glyph: (n) => ({
        ch: g.border,
        color: borderWaitColorHex(n.meta),
        bold: !n.meta.closed,
      }),
      priority: (n) => (n.meta.maxDelay ?? 0) / 60,
      statusNote: (_q, raw) => borderWaitNote(raw),
      legend: () => `${g.border} land border waits (CBP, CBSA; brighter = longer)`,
    },
    {
      key: 'bikeshare',
      label: 'Bikeshare',
      mode: 'poll',
      intervalMs: 60_000,
      viewportBounded: true,
      maxEntities: 6000,
      makeSource: async () =>
        demo
          ? (
              await import('../core/layers/bikeshare/mockSource.js')
            ).createBikeshareMockSource({ viewer })
          : createBikeshareSource({ proxyClient: client }),
      normalize: (raw) => parseBikeshare(raw),
      describe: (n) => describeBikeStation(n),
      searchText: bikeshareSearchText,
      glyph: (n) => ({ ch: g.bike, color: bikeColorHex(n.meta) }),
      statusNote: (_q, raw) => bikeshareNote(raw),
      legend: () => `${g.bike} bikeshare stations (green ok, amber low, red empty)`,
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
      label: 'Nav, GEO & visual sats',
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
      legend: () => `${g.navsat} GPS / Galileo / GLONASS / GEO / brightest satellites`,
    },
    {
      key: 'perimeters',
      label: 'Fire perimeters',
      mode: 'poll',
      intervalMs: 5 * 60_000,
      maxEntities: 2000,
      makeSource: async () => {
        if (demo) {
          const m = await import('../core/layers/perimeters/mockSource.js');
          return m.createPerimeterMockSource();
        }
        const { createPerimeterSource } =
          await import('../core/layers/perimeters/source.js');
        return createPerimeterSource({ proxyClient: client });
      },
      normalize: (raw) => parsePerimeters(raw),
      describe: (n) => describePerimeter(n),
      searchText: perimeterSearchText,
      glyph: (n) => ({
        ch: g.perimeter,
        color: (n.meta.containedPct ?? 0) >= 100 ? '#7a7a7a' : '#fc3e38',
        bold: true,
      }),
      legend: () => `${g.perimeter} wildfire perimeters, US (NIFC WFIGS)`,
    },
    {
      key: 'dams',
      label: 'Dams',
      mode: 'viewport',
      maxEntities: 3000,
      makeSource: async () =>
        demo
          ? (await import('../core/layers/dams/mockSource.js')).createDamMockSource({
              viewer,
            })
          : createOverpassSource({
              proxyClient: client,
              filters: DAM_FILTERS,
              maxAreaDeg: DAM_MAX_DEG,
            }),
      normalize: (json) => parseOverpass(json),
      describe: describeDam,
      searchText: damSearchText,
      glyph: () => ({ ch: g.dam, color: '#66b2b2' }),
      statusNote: (q) =>
        !demo && q.bbox && areaTooLarge(q.bbox, DAM_MAX_DEG) ? 'zoom in to load' : '',
      legend: () => `${g.dam} dams (OSM)`,
    },
    {
      key: 'simtraffic',
      label: 'Traffic (simulated)',
      mode: 'poll',
      intervalMs: 10_000,
      viewportBounded: true,
      maxEntities: 150,
      // SIMULATED vehicles on OSM roads (core/layers/simtraffic), the same model
      // as the globe: active once the map is zoomed in below about 8 km.
      makeSource: async () => {
        let view = null;
        const getView = () => view;
        const src = demo
          ? createSimTrafficMockSource({ getView, tier: 'minimal' })
          : createSimTrafficSource({
              proxyClient: client,
              getView,
              flow: keyed('tomtom-flowseg'),
              tier: 'minimal',
            });
        return async (q) => {
          view = viewOfBbox(q?.bbox);
          return src();
        };
      },
      normalize: (model) => {
        simDriver.sync(model);
        simNote = model?.note?.() ?? '';
        return simDriver.vehicles(Date.now());
      },
      positionAt: (n, t) => simDriver.positionAt(n.meta.slot, t),
      statusNote: () => simNote,
      describe: (n) => describeSimVehicle(n, simDriver.speedKmh(n.meta.slot)),
      glyph: (n) => ({
        ch: g.simcar,
        color: n.meta.flow
          ? (CONGESTION_COLORS[
              n.meta.flow.ratio < 0.45
                ? 'jam'
                : n.meta.flow.ratio < 0.75
                  ? 'slow'
                  : 'free'
            ] ?? '#d9d9d9')
          : '#d9d9d9',
      }),
      priority: () => -1,
      legend: () => `${g.simcar} SIMULATED vehicles (zoom in below 8 km)`,
    },
    {
      key: 'streetphotos',
      label: 'Street photos',
      mode: 'viewport',
      maxEntities: 600,
      unavailable: needs('mapillary', 'MAPILLARY_TOKEN'),
      makeSource: async () => {
        // The closest terminal zoom is about 8 km across: load the tiles
        // around the middle of it.
        if (demo) return createStreetPhotoMockSource({ maxViewDeg: 0.12 });
        if (needs('mapillary', 'MAPILLARY_TOKEN')) return null;
        return createStreetPhotoSource({ proxyClient: client, maxViewDeg: 0.12 });
      },
      normalize: (raw) => (raw?.images ?? []).map(streetPhotoToNormalized),
      statusNote: (_q, raw) => (raw?.tooWide ? 'zoom in to load' : ''),
      describe: (n) => describeStreetPhoto(n),
      searchText: streetPhotoSearchText,
      glyph: () => ({ ch: g.photo, color: '#deeeed' }),
      legend: () => `${g.photo} street photos (Mapillary, CC BY-SA)`,
    },
    {
      key: 'incidents',
      label: 'Traffic incidents',
      mode: 'poll',
      intervalMs: 5 * 60_000,
      viewportBounded: true,
      maxEntities: 2000,
      unavailable: needs('tomtom-incidents', 'TOMTOM_API_KEY'),
      makeSource: async () => {
        if (demo) return createIncidentMockSource();
        if (needs('tomtom-incidents', 'TOMTOM_API_KEY')) return null;
        return createIncidentSource({ proxyClient: client });
      },
      normalize: (raw) => parseTomTomIncidents(raw?.json ?? raw),
      describe: describeIncident,
      searchText: incidentSearchText,
      glyph: incidentGlyph,
      priority: incidentPriority,
      statusNote: (_q, raw) => (raw?.clipped ? 'nearest 80 km' : ''),
      legend: () =>
        `${g.incident.accident} accident ${g.incident.jam} jam ${g.incident.roadworks} works ${g.incident.closure} closed (TomTom; red = critical)`,
    },
    {
      key: 'chp',
      label: 'CHP incidents',
      mode: 'poll',
      intervalMs: 2 * 60_000,
      maxEntities: 2000,
      makeSource: async () =>
        demo
          ? (await import('../core/layers/chp/mockSource.js')).createChpMockSource()
          : (_q, signal) => client.getText('chp-cad', '/sa.xml', { signal }),
      normalize: (xml) => parseChpXml(xml),
      describe: (n) => describeChp(n),
      searchText: chpSearchText,
      glyph: incidentGlyph,
      priority: incidentPriority,
      legend: () =>
        `${g.incident.accident} CHP dispatch incidents, California (red = critical)`,
    },
    {
      // Waze's live map, unofficial (personal use); your own waze-server when
      // the proxy has LOCAL_WAZE_URL. The alerts and jams Waze shows drivers:
      // never users or reporter names (core/layers/waze/parse.js).
      key: 'waze',
      label: 'Waze alerts (unofficial)',
      mode: 'poll',
      intervalMs: 2 * 60_000,
      viewportBounded: true,
      maxEntities: 1500,
      makeSource: async () =>
        demo
          ? createWazeMockSource()
          : createWazeSource({ proxyClient: client, local: keyed('waze-local') }),
      normalize: (raw) => parseWaze(raw?.json ?? raw),
      describe: (n) => describeWaze(n),
      searchText: wazeSearchText,
      glyph: (n) => ({
        ch: g.incident[n.meta.kind] ?? g.incident.hazard,
        color: wazeColorHex(n.meta.severity),
        bold: n.meta.severity === 'critical',
      }),
      priority: incidentPriority,
      statusNote: (_q, raw) =>
        [
          raw?.via === 'local' ? 'your waze-server' : '',
          raw?.clipped ? 'nearest 100 km' : '',
        ]
          .filter(Boolean)
          .join(' · '),
      legend: () =>
        `${g.incident.accident} accident ${g.incident.jam} jam ${g.incident.hazard} hazard ${g.incident.closure} closed ${g.incident.police} police (Waze, unofficial; red = critical)`,
    },
    {
      key: 'tor',
      label: 'Tor relays',
      mode: 'poll',
      intervalMs: 60 * 60_000,
      maxEntities: 9000,
      makeSource: async () =>
        demo
          ? (await import('../core/layers/tor/mockSource.js')).createTorMockSource()
          : (_q, signal) =>
              client.getJson('onionoo', ONIONOO_PATH, { params: onionooQuery(), signal }),
      normalize: (raw) => {
        const list = parseOnionoo(raw);
        torStatus = torNote(list);
        return list;
      },
      statusNote: () => torStatus,
      describe: describeTor,
      searchText: torSearchText,
      glyph: (n) => ({
        ch: g.relay[n.meta.role] ?? g.relay.middle,
        color: torColorHex(n),
        bold: n.meta.role === 'exit',
      }),
      priority: (n) => (n.meta.role === 'exit' ? 1 : n.meta.role === 'guard' ? 0.5 : 0),
      legend: () =>
        `${g.relay.exit} exit ${g.relay.guard} guard ${g.relay.middle} middle Tor relays (Onionoo)`,
    },
    {
      key: 'gdelt',
      label: 'News events',
      mode: 'poll',
      intervalMs: 15 * 60_000,
      maxEntities: 3000,
      makeSource: async () =>
        demo ? createGdeltMockSource() : createGdeltSource({ proxyClient: client }),
      normalize: (raw) => parseGdeltEvents(raw),
      statusNote: (_q, raw) => gdeltStatusNote(raw),
      describe: (n) => describeGdelt(n),
      searchText: gdeltSearchText,
      glyph: (n) => ({ ch: g.news, color: gdeltColorHex(n) }),
      priority: (n) => Math.log10(Math.max(1, n.meta.count)),
      legend: () =>
        `${g.news} GDELT events, last hour (red conflict, white humanitarian aid, gray protest)`,
    },
    {
      key: 'signals',
      label: 'Traffic lights',
      mode: 'viewport',
      maxEntities: 2500,
      // OSM traffic signals, only in views about 20 km across or less.
      makeSource: async () =>
        demo
          ? (
              await import('../core/layers/signals/mockSource.js')
            ).createSignalsMockSource({ viewer })
          : createSignalsSource({ proxyClient: client }),
      normalize: (raw) => normalizeSignals(raw),
      describe: describeSignal,
      searchText: signalSearchText,
      glyph: (n) => ({
        ch: g.signal,
        color: n.meta.kind === 'crossing' ? '#8fa8a6' : '#deeeed',
        bold: n.meta.kind !== 'crossing',
      }),
      priority: (n) => (n.meta.kind === 'crossing' ? 0 : 1),
      statusNote: (_q, raw) => tiledNote(raw),
      legend: () => `${g.signal} traffic lights (OSM; zoom in to about 20 km)`,
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

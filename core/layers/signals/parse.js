// Traffic lights mapped in OpenStreetMap: the Overpass query, the parser and
// the data source. Pure (no Cesium): the terminal shell uses the same code.
//
// Tagging (OSM wiki): a junction's signals are nodes tagged
// highway=traffic_signals (traffic_signals=signal|blinker|emergency|...,
// traffic_signals:direction=forward|backward|both); a pedestrian crossing with
// lights is highway=crossing + crossing=traffic_signals (or crossing:signals=yes),
// with traffic_signals:sound / :vibration and button_operated. Both are
// fetched; crossings are drawn only when zoomed in further (./definition.js).
//
// Dense: about 3,600 junction signals in one 0.1 degree tile of central Paris,
// so the layer loads only when the view is about 20 km across or less, and each
// tile once (core/layers/overpass/tiles.js).

import {
  bboxText,
  createTileLoader,
  createTiledSource,
  overpassFetcher,
} from '../overpass/tiles.js';

export const SIGNALS_TILE_DEG = 0.1;
export const SIGNALS_TTL_MS = 24 * 60 * 60 * 1000;
export const SIGNALS_MAX_TILES = 24;
/** Tiles one view loads, nearest the middle first (a 20 km view needs up to 12). */
export const SIGNALS_VIEW_TILES = 12;
/** The view (square root of its area, km) above which nothing loads. */
export const SIGNALS_MAX_VIEW_KM = 22;
/** Pedestrian crossing signals are drawn only in views this small (km). */
export const CROSSINGS_MAX_VIEW_KM = 6;
const TILE_CAP = 8000;

/** Overpass QL for one tile. */
export function signalsQuery(bbox) {
  const b = bboxText(bbox);
  return (
    `[out:json][timeout:25];` +
    `(node["highway"="traffic_signals"](${b});node["crossing"="traffic_signals"](${b}););` +
    `out ${TILE_CAP};`
  );
}

/** 'junction' (highway=traffic_signals) or 'crossing' (a signalled crossing). */
export function signalKind(tags = {}) {
  return tags.highway === 'traffic_signals' ? 'junction' : 'crossing';
}

/**
 * Overpass JSON -> normalized records:
 * { id, type: 'signal', position, meta: { tags, kind, osmType, osmId } }.
 */
export function parseSignals(json) {
  const elements = Array.isArray(json?.elements) ? json.elements : [];
  const out = [];
  const seen = new Set();
  for (const e of elements) {
    if (e?.type !== 'node' || !Number.isFinite(e.lat) || !Number.isFinite(e.lon))
      continue;
    const id = `node/${e.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const tags = e.tags || {};
    out.push({
      id,
      type: 'signal',
      position: { longitude: e.lon, latitude: e.lat, altitude: 0 },
      meta: { tags, kind: signalKind(tags), osmType: 'node', osmId: e.id },
    });
  }
  return out;
}

/** A tiled pass ({ items }) or raw Overpass JSON (the dev mock) -> records. */
export function normalizeSignals(raw) {
  return Array.isArray(raw?.items) ? raw.items : parseSignals(raw);
}

/**
 * The layer's source: through the proxy's Overpass feed, per tile, once.
 * @param {{ proxyClient: object, anchor?: Function, onUpdate?: Function,
 *   fetchTile?: (bbox: object) => Promise<object> }} opts
 */
export function createSignalsSource({ proxyClient, anchor, onUpdate, fetchTile }) {
  const loader = createTileLoader({
    fetchTile: fetchTile ?? overpassFetcher(proxyClient, signalsQuery),
    parse: parseSignals,
    tileDeg: SIGNALS_TILE_DEG,
    ttlMs: SIGNALS_TTL_MS,
    maxTiles: SIGNALS_MAX_TILES,
  });
  return createTiledSource(loader, {
    maxViewKm: SIGNALS_MAX_VIEW_KM,
    maxViewTiles: SIGNALS_VIEW_TILES,
    anchor,
    onUpdate,
  });
}

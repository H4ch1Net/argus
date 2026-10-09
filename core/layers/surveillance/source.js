// The surveillance layer's data source: OSM through the proxy's Overpass feed,
// one query per 0.1 degree tile, each tile fetched once and kept for hours
// (core/layers/overpass/tiles.js). Pure (no Cesium): the terminal uses it too.

import {
  createTileLoader,
  createTiledSource,
  overpassFetcher,
} from '../overpass/tiles.js';
import {
  surveillanceQuery,
  parseSurveillance,
  SURVEILLANCE_TILE_DEG,
  SURVEILLANCE_TTL_MS,
} from './parse.js';

/** Tiles kept at once (about 3,000 records each in a dense city). */
export const SURVEILLANCE_MAX_TILES = 36;
/** Tiles one view loads (nearest the anchor first): 3 x 3 around it. */
export const SURVEILLANCE_VIEW_TILES = 9;
/**
 * Tiles the NEAREST 60 needs: the 2 x 2 block around the anchor, at least half
 * a tile (4 to 5 km at mid latitudes) on every side of it, so fewer Overpass
 * requests than all in view.
 */
export const SURVEILLANCE_NEAREST_TILES = 4;
/** Wider views load nothing (the nearest-n default still works up to this). */
export const SURVEILLANCE_MAX_VIEW_KM = 160;

/**
 * @param {{ proxyClient: object, anchor?: () => ({ lat: number, lon: number })|null,
 *   onUpdate?: () => void, fetchTile?: (bbox: object) => Promise<object>,
 *   viewTiles?: number|(() => number) }} opts
 *   anchor: where "nearest" is measured from (tiles load nearest it first);
 *   onUpdate: a background tile landed (the globe refreshes the layer);
 *   viewTiles: tiles one view loads (fewer serve the nearest 60: NEAREST_TILES)
 */
export function createSurveillanceSource({
  proxyClient,
  anchor,
  onUpdate,
  fetchTile,
  viewTiles = SURVEILLANCE_VIEW_TILES,
}) {
  const loader = createTileLoader({
    fetchTile: fetchTile ?? overpassFetcher(proxyClient, surveillanceQuery),
    parse: parseSurveillance,
    tileDeg: SURVEILLANCE_TILE_DEG,
    ttlMs: SURVEILLANCE_TTL_MS,
    maxTiles: SURVEILLANCE_MAX_TILES,
  });
  return createTiledSource(loader, {
    maxViewKm: SURVEILLANCE_MAX_VIEW_KM,
    maxViewTiles: viewTiles,
    anchor,
    onUpdate,
  });
}

// The basemap's tile engine, shared by the worker and the main-thread
// fallback: fetches each zoom-14 (or shallower) source tile once, keeps the
// decoded tiles and the label placements in small LRU caches, and renders
// output tiles of any kind and zoom onto a canvas it is handed. No Cesium, no
// DOM beyond the canvas factory it is given.

import { decodeTile } from './mvt.js';
import { WANT, sourceFor, drawBase, placeLabels, drawLabels } from './render.js';

/** A tiny LRU map. */
function lru(max) {
  const m = new Map();
  return {
    get(k) {
      if (!m.has(k)) return undefined;
      const v = m.get(k);
      m.delete(k);
      m.set(k, v);
      return v;
    },
    set(k, v) {
      m.delete(k);
      m.set(k, v);
      while (m.size > max) m.delete(m.keys().next().value);
    },
    get size() {
      return m.size;
    },
  };
}

/**
 * @param {{ template: string, makeCanvas: (w: number, h: number) => any,
 *   fetchImpl?: typeof fetch, decoded?: number, placements?: number }} opts
 *   template: source tile URL with {z} {x} {y} (through the proxy)
 */
export function createTileEngine({
  template,
  makeCanvas,
  fetchImpl = (...a) => fetch(...a),
  decoded = 40,
  placements = 64,
}) {
  const tiles = lru(decoded); // 'z/x/y' -> decoded tile (or null: empty)
  const inflight = new Map(); // 'z/x/y' -> Promise
  const labels = lru(placements); // 'kind/z/sz/sx/sy/size' -> placed labels
  let measureCtx = null;
  const measure = (text, font) => {
    measureCtx ??= makeCanvas(8, 8).getContext('2d');
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  };
  let failures = 0;

  async function source(z, x, y) {
    const key = `${z}/${x}/${y}`;
    const have = tiles.get(key);
    if (have !== undefined) return have;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      const r = await fetchImpl(url);
      if (r.status === 404 || r.status === 204) {
        tiles.set(key, null); // nothing here (open ocean): draw the ground
        return null;
      }
      if (!r.ok) throw new Error(`basemap tile ${key}: ${r.status}`);
      const tile = decodeTile(new Uint8Array(await r.arrayBuffer()), WANT);
      tiles.set(key, tile);
      failures = 0;
      return tile;
    })();
    inflight.set(key, p);
    try {
      return await p;
    } catch (err) {
      failures += 1;
      throw err;
    } finally {
      inflight.delete(key);
    }
  }

  /**
   * Render one output tile.
   * @param {'base'|'roads'|'places'} kind
   * @returns {Promise<any>} the canvas (null for a label tile with nothing on it)
   */
  async function render(kind, z, x, y, size, pr) {
    const src = sourceFor(z, x, y);
    const tile = await source(src.z, src.x, src.y);
    const out = { z, x, y, size, pr };
    if (kind === 'base') {
      const canvas = makeCanvas(size, size);
      const ctx = canvas.getContext('2d');
      if (tile) drawBase(ctx, tile, out);
      else {
        ctx.fillStyle = '#0a1417'; // no source tile: open water
        ctx.fillRect(0, 0, size, size);
      }
      return canvas;
    }
    if (!tile) return null;
    const lk = `${kind}/${z}/${src.z}/${src.x}/${src.y}/${size}/${pr}`;
    let placed = labels.get(lk);
    if (!placed) {
      placed = placeLabels(tile, kind, z, size, pr, { measure });
      labels.set(lk, placed);
    }
    if (!placed.length) return null;
    const canvas = makeCanvas(size, size);
    drawLabels(canvas.getContext('2d'), placed, out);
    return canvas;
  }

  return {
    render,
    stats: () => ({
      decoded: tiles.size,
      placements: labels.size,
      inflight: inflight.size,
      failures,
    }),
  };
}

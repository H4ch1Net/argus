import * as Cesium from 'cesium';
import { createRingBuffer } from './ringBuffer.js';
import { interpolateFix } from './interpolate.js';
import { computeViewportQuery } from './viewport.js';
import { getRenderer } from './renderers.js';

// The Layer SDK engine. A layer is config against this interface, not bespoke
// code (CLAUDE.md): fetch -> normalize -> render -> interpolate?, with
// viewport-bounded fetch, clustering hooks, and load-only-in-view baked in.
//
// A LayerDefinition (static, reusable) provides:
//   id, fetch:{ mode, intervalMs, viewportBounded },
//   normalize(raw) -> NormalizedEntity[],
//   render:{ renderType, style(normalized)->styleProps, ...renderConfig },
//   interpolate?:boolean, historyCapacity?, interpolateLagMs?, maxEntities?,
//   cluster?:{ enabled, pixelRange, minimumClusterSize },
//   describe?(normalized) -> cardModel   (for the interaction spine)
//
// A NormalizedEntity is { id, position:{longitude,latitude,altitude}, type,
// meta, velocity? } per the contract.
//
// Runtime bindings (source, onStatus) come in `ctx`, so the definition stays
// free of environment concerns (proxy vs mock, status wiring).

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_HISTORY = 60;
const DEFAULT_MAX_ENTITIES = 2000;

/**
 * @param {import('cesium').Viewer} viewer
 * @param {object} def LayerDefinition
 * @param {{ source: (query: object, signal: AbortSignal) => Promise<unknown>, onStatus?: (s: object) => void }} ctx
 */
export function createLayer(viewer, def, ctx) {
  if (typeof ctx?.source !== 'function') {
    throw new Error(`layer ${def.id}: a source function is required`);
  }
  const scene = viewer.scene;
  const intervalMs = def.fetch?.intervalMs ?? DEFAULT_INTERVAL_MS;
  // A layer is a mover if it interpolates between fixes OR computes its position
  // from time (def.positionAt, e.g. SGP4 satellites). Both force continuous render.
  const isMover = Boolean(def.interpolate || def.positionAt);
  const lagMs = isMover ? (def.interpolateLagMs ?? intervalMs) : 0;
  const historyCap = def.historyCapacity ?? DEFAULT_HISTORY;
  const maxEntities = def.maxEntities ?? DEFAULT_MAX_ENTITIES;
  const renderer = getRenderer(def.render.renderType);
  // 'poll' fetches the full set each interval (removal by absence); 'push'
  // receives incremental updates over a stream (removal by staleness).
  const mode = def.fetch?.mode ?? 'poll';
  const staleMs = def.staleMs ?? 120_000;
  // Scene time for positioning: the shared clock (so the time scrubber rewinds all
  // movers at once) or real time. Feed ingest/staleness always use real time.
  const sceneNow = () => (ctx.clock ? ctx.clock.now() : Date.now());

  const ds = new Cesium.CustomDataSource(def.id);
  viewer.dataSources.add(ds);
  configureClustering(ds, def.cluster);

  /** @type {Map<string, { entity: Cesium.Entity, history: object, normalized: object }>} */
  const records = new Map();
  let running = false;
  let timer = null;
  let aborter = null;
  let savedRenderMode = null;

  function currentPosition(rec) {
    // Compute-position layers (SGP4 satellites) evaluate position from time.
    if (def.positionAt) {
      const p = def.positionAt(rec.normalized, sceneNow());
      if (!p) return undefined;
      return Cesium.Cartesian3.fromDegrees(
        p.longitude,
        p.latitude,
        Math.max(0, p.altitude ?? 0),
      );
    }
    const curr = rec.history.last();
    if (!curr) return undefined;
    let f;
    if (!def.interpolate) {
      f = curr;
    } else if (!ctx.clock || ctx.clock.isLive()) {
      // Live: interpolate between the last two fixes (fast, no allocation).
      f = interpolateFix(rec.history.prev(), curr, sceneNow() - lagMs);
    } else {
      // Scrubbing: bracket the scrub time across the whole retained window.
      f = rec.history.sampleAt(sceneNow(), interpolateFix);
    }
    return Cesium.Cartesian3.fromDegrees(
      f.longitude,
      f.latitude,
      Math.max(0, f.altitude ?? 0),
    );
  }

  function upsert(normalized, batchTimeMs) {
    let rec = records.get(normalized.id);
    if (!rec) {
      const history = createRingBuffer(historyCap);
      const entity = ds.entities.add({
        id: normalized.id,
        position: new Cesium.CallbackProperty(() => currentPosition(rec), false),
      });
      rec = { entity, history, normalized, dispose: null };
      records.set(normalized.id, rec);
      renderer.create(entity, normalized, def.render);
      // Optional per-entity decoration (e.g. a satellite's orbit ring). Returns a
      // dispose fn, cleaned up when the entity is removed or the layer destroyed.
      if (def.onEntityCreate) {
        rec.dispose = def.onEntityCreate(entity, normalized, { viewer, scene });
      }
    }
    rec.normalized = normalized;
    rec.lastSeen = batchTimeMs; // for push-mode staleness removal
    renderer.update(rec.entity, normalized, def.render);
    // Compute-position layers keep no fix history (position is a function of time).
    if (!def.positionAt) {
      rec.history.push({
        t: batchTimeMs, // local ingest time: interpolation spacing is exactly one interval
        longitude: normalized.position.longitude,
        latitude: normalized.position.latitude,
        altitude: normalized.position.altitude,
      });
    }
  }

  function ingest(list, batchTimeMs = Date.now()) {
    const items = list.length > maxEntities ? list.slice(0, maxEntities) : list;
    const seen = new Set();
    for (const n of items) {
      seen.add(n.id);
      upsert(n, batchTimeMs);
    }
    for (const [id, rec] of records) {
      if (!seen.has(id)) {
        rec.dispose?.();
        ds.entities.remove(rec.entity);
        records.delete(id);
      }
    }
    scene.requestRender();
  }

  async function poll() {
    if (!running) return;
    const query = def.fetch?.viewportBounded ? computeViewportQuery(viewer) : {};
    aborter?.abort();
    aborter = new AbortController();
    try {
      const raw = await ctx.source(query, aborter.signal);
      if (!running) return;
      ingest(def.normalize(raw));
      ctx.onStatus?.({ state: 'ok', count: records.size, query });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      ctx.onStatus?.({
        state: 'error',
        status: err?.status,
        message: String(err?.message || err),
      });
    }
  }

  // Push mode: incremental updates arrive over a stream (e.g. AIS). Entities are
  // upserted as they report and removed when they go stale, not by absence.
  let unsubscribe = null;
  let staleTimer = null;
  // Viewport mode: fetch once per region on camera settle, not on a timer (for
  // slow, rate-limited, mostly-static feeds like Overpass).
  let moveEndRemove = null;
  let moveTimer = null;

  function pushIngest(raw) {
    if (!running) return;
    const list = def.normalize(raw);
    const now = Date.now();
    for (const n of list.slice(0, maxEntities)) upsert(n, now);
    scene.requestRender();
    ctx.onStatus?.({ state: 'ok', count: records.size });
  }

  function sweepStale() {
    const cutoff = Date.now() - staleMs;
    for (const [id, rec] of records) {
      if (rec.lastSeen < cutoff) {
        rec.dispose?.();
        ds.entities.remove(rec.entity);
        records.delete(id);
      }
    }
    scene.requestRender();
  }

  function moversActive(on) {
    // Movers force continuous rendering. Single mover assumption for now; a
    // scene-wide ref-count for multiple concurrent mover layers is a later refinement.
    if (!isMover) return;
    if (on) {
      savedRenderMode = scene.requestRenderMode;
      scene.requestRenderMode = false;
    } else if (savedRenderMode !== null) {
      scene.requestRenderMode = savedRenderMode;
      savedRenderMode = null;
      scene.requestRender();
    }
  }

  function pausePolling() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    aborter?.abort();
  }
  function resumePolling() {
    if (!running || timer) return;
    poll();
    timer = setInterval(poll, intervalMs);
  }
  function onVisibilityChange() {
    if (document.hidden) pausePolling();
    else resumePolling();
  }

  return {
    id: def.id,
    start() {
      if (running) return;
      running = true;
      ds.show = true;
      moversActive(true);
      if (mode === 'push') {
        unsubscribe = ctx.source(pushIngest);
        // Sweep at least as often as entities expire, so short-lived push layers
        // (e.g. BGP pulses) cull promptly instead of lingering to the next sweep.
        staleTimer = setInterval(sweepStale, Math.min(10_000, staleMs));
      } else if (mode === 'viewport') {
        document.addEventListener('visibilitychange', onVisibilityChange);
        poll();
        moveEndRemove = viewer.camera.moveEnd.addEventListener(() => {
          clearTimeout(moveTimer);
          moveTimer = setTimeout(() => running && poll(), 700);
        });
      } else if (mode === 'once') {
        // Fetch a single time; entities persist (e.g. user-calibrated CCTV poses).
        poll();
      } else {
        document.addEventListener('visibilitychange', onVisibilityChange);
        poll();
        timer = setInterval(poll, intervalMs);
      }
    },
    stop() {
      running = false;
      if (mode === 'push') {
        unsubscribe?.();
        unsubscribe = null;
        if (staleTimer) {
          clearInterval(staleTimer);
          staleTimer = null;
        }
      } else {
        pausePolling();
        document.removeEventListener('visibilitychange', onVisibilityChange);
        moveEndRemove?.();
        moveEndRemove = null;
        clearTimeout(moveTimer);
      }
      moversActive(false);
    },
    setEnabled(on) {
      ds.show = on;
      if (on) this.start();
      else this.stop();
    },
    destroy() {
      this.stop();
      for (const rec of records.values()) rec.dispose?.();
      viewer.dataSources.remove(ds, true);
      records.clear();
    },
    get size() {
      return records.size;
    },
    // Per-layer search adapter (global search). Matches a query against each
    // entity's def.searchText; returns { id, entity, label }.
    search(query, limit = 6) {
      if (!def.searchText) return [];
      const q = String(query).trim().toLowerCase();
      if (!q) return [];
      const out = [];
      for (const rec of records.values()) {
        const text = String(def.searchText(rec.normalized) || '').toLowerCase();
        if (text.includes(q)) {
          out.push({
            id: rec.entity.id,
            entity: rec.entity,
            label: def.describe
              ? def.describe(rec.normalized).title
              : String(rec.entity.id),
          });
          if (out.length >= limit) break;
        }
      }
      return out;
    },
    // What the interaction spine needs to resolve a picked entity.
    getRecord(id) {
      const rec = records.get(id);
      if (!rec) return null;
      return {
        entity: rec.entity,
        normalized: rec.normalized,
        mover: isMover, // movers can be ridden in cockpit mode
        cardModel: def.describe ? def.describe(rec.normalized) : null,
        getHistoryFixes: () => rec.history.toArray(),
      };
    },
    // Dev-only: feed a normalized list straight in for verification.
    _ingest: import.meta.env.DEV ? (list) => ingest(list) : undefined,
  };
}

function configureClustering(ds, cfg) {
  if (!cfg?.enabled) return;
  const c = ds.clustering;
  c.enabled = true;
  c.pixelRange = cfg.pixelRange ?? 40;
  c.minimumClusterSize = cfg.minimumClusterSize ?? 3;
}

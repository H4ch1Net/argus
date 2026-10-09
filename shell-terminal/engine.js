// The terminal shell's layer runtime: the same Layer SDK contract as the globe
// (fetch -> normalize -> render? -> interpolate?), minus Cesium. A layer here is
// config too; the definitions in layers.js reuse core's parsers, formatters, and
// interpolation, so the data engine is not forked.
//
// Fetch modes match core/layers/sdk/createLayer.js:
//   poll      refetch the full set every interval (removal by absence)
//   viewport  fetch once per region when the view settles (slow, static feeds)
//   once      a single snapshot
//   push      incremental updates over a stream (removal by staleness)
//
// Timers and the clock are injectable so the engine is testable without waiting.

import { createRingBuffer } from '../core/layers/sdk/ringBuffer.js';
import { moverPositionInto } from '../core/layers/sdk/interpolate.js';

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_HISTORY = 40;
const DEFAULT_MAX_ENTITIES = 4000;

/**
 * @param {object} def  terminal layer definition (see layers.js)
 * @param {{ getQuery?: () => object, onChange?: () => void, now?: () => number,
 *   timers?: { setInterval: Function, clearInterval: Function, setTimeout: Function, clearTimeout: Function } }} [env]
 */
export function createTerminalLayer(def, env = {}) {
  const now = env.now ?? (() => Date.now());
  const timers = env.timers ?? globalThis;
  const getQuery = env.getQuery ?? (() => ({}));
  const onChange = env.onChange ?? (() => {});

  const mode = def.mode ?? 'poll';
  const intervalMs = def.intervalMs ?? DEFAULT_INTERVAL_MS;
  const staleMs = def.staleMs ?? 120_000;
  const maxEntities = def.maxEntities ?? DEFAULT_MAX_ENTITIES;
  const lagMs = def.interpolate ? (def.interpolateLagMs ?? intervalMs) : 0;

  /** @type {Map<string, { normalized: object, history: object, lastSeen: number }>} */
  const records = new Map();
  let running = false;
  let timer = null;
  let staleTimer = null;
  let settleTimer = null;
  let aborter = null;
  let unsubscribe = null;
  let generation = 0; // bumped by stop(), so a start() still awaiting its source bails
  const status = { state: 'off', count: 0, message: '', updatedAt: null };

  function setStatus(patch) {
    Object.assign(status, patch, { count: records.size });
    onChange();
  }

  function upsert(n, t) {
    let rec = records.get(n.id);
    if (!rec) {
      rec = {
        normalized: n,
        history: createRingBuffer(def.historyCapacity ?? DEFAULT_HISTORY),
        lastSeen: t,
      };
      records.set(n.id, rec);
    }
    rec.normalized = n;
    rec.lastSeen = t;
    if (!def.positionAt) {
      rec.history.push({
        t,
        longitude: n.position.longitude,
        latitude: n.position.latitude,
        altitude: n.position.altitude,
      });
    }
  }

  function ingestAll(list) {
    const t = now();
    const seen = new Set();
    for (const n of list.slice(0, maxEntities)) {
      seen.add(n.id);
      upsert(n, t);
    }
    for (const id of records.keys()) if (!seen.has(id)) records.delete(id);
  }

  // Cache the promise, not the result, so overlapping starts share one source.
  let sourcePromise = null;
  async function ensureSource() {
    sourcePromise ??= Promise.resolve(def.makeSource());
    const src = await sourcePromise;
    if (!src) {
      sourcePromise = null; // allow a retry once the reason is fixed
      throw new Error(def.unavailable || 'no source available');
    }
    return src;
  }

  async function poll() {
    if (!running) return;
    aborter?.abort();
    const controller = new AbortController();
    aborter = controller;
    if (status.state !== 'ok') setStatus({ state: 'loading', message: '' });
    try {
      const src = await ensureSource();
      const raw = await src(getQuery(), controller.signal);
      if (!running || controller.signal.aborted) return;
      ingestAll(def.normalize(raw));
      setStatus({
        state: 'ok',
        message: def.statusNote?.(getQuery(), raw) ?? '',
        updatedAt: now(),
      });
    } catch (err) {
      if (err?.name === 'AbortError' || controller.signal.aborted) return;
      setStatus({ state: 'error', message: String(err?.message || err) });
    }
  }

  function pushIngest(batch) {
    if (!running) return;
    const t = now();
    for (const n of def.normalize(batch).slice(0, maxEntities)) upsert(n, t);
    def.onBatch?.(batch);
    setStatus({ state: 'ok', message: '', updatedAt: t });
  }

  function sweepStale() {
    const cutoff = now() - staleMs;
    let removed = false;
    for (const [id, rec] of records) {
      if (rec.lastSeen < cutoff) {
        records.delete(id);
        removed = true;
      }
    }
    if (removed) setStatus({});
  }

  /** Position of a record at scene time t (interpolated, computed, or last fix). */
  function positionOf(rec, t) {
    if (def.positionAt) return def.positionAt(rec.normalized, t);
    const curr = rec.history.last();
    if (!curr) return null;
    if (!def.interpolate) return curr;
    // Bracketed across the retained fixes, dead-reckoned when a poll is late
    // (the same smooth-motion rules as the globe, core/layers/sdk).
    const v = rec.normalized.velocity;
    const vel = def.velocityOf
      ? def.velocityOf(rec.normalized)
      : Number.isFinite(v?.speed) && Number.isFinite(v?.heading ?? v?.course)
        ? { mps: v.speed, headingDeg: v.heading ?? v.course }
        : null;
    return moverPositionInto(
      rec.history,
      t - lagMs,
      vel,
      def.extrapolateMs ?? intervalMs,
      {
        longitude: 0,
        latitude: 0,
        altitude: 0,
      },
    );
  }

  return {
    def,
    key: def.key,
    get status() {
      return { ...status };
    },
    get running() {
      return running;
    },
    get size() {
      return records.size;
    },

    async start() {
      if (running) return;
      running = true;
      const gen = ++generation;
      setStatus({ state: 'loading', message: '' });
      if (mode === 'push') {
        try {
          const src = await ensureSource();
          if (gen !== generation || !running) return; // stopped (or restarted) meanwhile
          unsubscribe = src(pushIngest, { getQuery });
          staleTimer = timers.setInterval(sweepStale, Math.min(5_000, staleMs));
          setStatus({
            state: records.size ? 'ok' : 'waiting',
            message: 'waiting for the stream',
          });
        } catch (err) {
          setStatus({ state: 'error', message: String(err?.message || err) });
        }
        return;
      }
      poll();
      if (mode === 'poll') timer = timers.setInterval(poll, intervalMs);
    },

    stop() {
      running = false;
      generation += 1;
      if (timer) timers.clearInterval(timer);
      if (staleTimer) timers.clearInterval(staleTimer);
      if (settleTimer) timers.clearTimeout(settleTimer);
      timer = staleTimer = settleTimer = null;
      aborter?.abort();
      unsubscribe?.();
      unsubscribe = null;
      records.clear();
      setStatus({ state: 'off', message: '' });
    },

    /** The view moved: viewport layers refetch once it settles; push layers re-scope. */
    viewChanged() {
      if (!running) return;
      if (mode === 'viewport' || (mode === 'poll' && def.viewportBounded)) {
        if (settleTimer) timers.clearTimeout(settleTimer);
        settleTimer = timers.setTimeout(() => {
          settleTimer = null;
          poll();
        }, def.settleMs ?? 700);
      }
      if (mode === 'push') def.onViewChanged?.(getQuery());
    },

    /** Entities with their position at scene time t. */
    entities(t = now()) {
      const out = [];
      for (const [id, rec] of records) {
        const p = positionOf(rec, t);
        if (!p) continue;
        out.push({ id, layer: def.key, n: rec.normalized, position: p });
      }
      return out;
    },

    get(id) {
      return records.get(id)?.normalized ?? null;
    },

    history(id) {
      return records.get(id)?.history.toArray() ?? [];
    },

    describe(id, t = now()) {
      const n = records.get(id)?.normalized;
      return n && def.describe ? def.describe(n, t) : null;
    },

    search(query, limit = 6) {
      if (!def.searchText) return [];
      const q = String(query).trim().toLowerCase();
      if (!q) return [];
      const out = [];
      for (const [id, rec] of records) {
        if (
          String(def.searchText(rec.normalized) || '')
            .toLowerCase()
            .includes(q)
        ) {
          const card = def.describe ? def.describe(rec.normalized, now()) : null;
          out.push({ id, layer: def.key, label: card?.title ?? id });
          if (out.length >= limit) break;
        }
      }
      return out;
    },

    // For tests and the dev console.
    _ingest: (list) => {
      ingestAll(list);
      setStatus({ state: 'ok' });
    },
  };
}

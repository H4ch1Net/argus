// A weather layer's source bound to the weather timeline: it learns the
// product's advertised times from GetCapabilities (through the proxy feed
// 'nowcoast', refreshed every metadataTtlMs), reports them to the timeline,
// and returns the raster spec for the frame the timeline selects. No Cesium,
// no DOM.
//
// The returned source carries subscribe(onChange): the raster engine
// (core/layers/sdk/rasterLayer.js) calls it when the layer starts, which joins
// the product to the timeline, and calls onChange-driven refreshes whenever
// this product's selected frame changes; its unsubscribe leaves the timeline.
// It also carries shown(spec), which the engine calls once a frame is on
// screen, so the timeline's play loop can wait for slow frames.
//
// If GetCapabilities fails, live mode falls back to the untimed latest step
// (as before the timeline existed); history mode shows nothing rather than a
// frame from the wrong time.

import { WEATHER_PRODUCTS, weatherSpec, weatherServicePath } from './products.js';
import { CAPABILITIES_PARAMS, parseWmsCapabilities } from './capabilities.js';

/** Fetch and parse one product's advertised times. */
export async function loadProductTimes(proxyClient, productId, { signal, nowMs } = {}) {
  const p = WEATHER_PRODUCTS[productId];
  if (!p) throw new Error(`unknown weather product: ${productId}`);
  const xml = await proxyClient.getText('nowcoast', weatherServicePath(productId), {
    params: CAPABILITIES_PARAMS,
    signal,
  });
  return parseWmsCapabilities(xml, p.layers, { nowMs: nowMs ?? Date.now() });
}

const frameKey = (f) => `${f.live ? 'live' : 'at'}|${f.time ?? ''}`;

/**
 * @param {{ productId: string, proxyClient: object, timeline: object,
 *   now?: () => number, maximumLevel?: number }} opts
 */
export function createTimedWeatherSource({
  productId,
  proxyClient,
  timeline,
  now = Date.now,
  maximumLevel,
}) {
  const p = WEATHER_PRODUCTS[productId];
  if (!p) throw new Error(`unknown weather product: ${productId}`);
  let loadedAt = -Infinity;
  let failedAt = -Infinity;
  let applied = null; // frame key of the spec last returned
  let reporting = false; // our own setTimes: not a reason to refresh again

  async function refreshTimes(signal) {
    const t = now();
    if (t - loadedAt < p.metadataTtlMs || t - failedAt < p.metadataTtlMs) return;
    try {
      const { times } = await loadProductTimes(proxyClient, productId, {
        signal,
        nowMs: t,
      });
      loadedAt = now();
      reporting = true;
      try {
        timeline.setTimes(productId, times);
      } finally {
        reporting = false;
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      failedAt = now(); // keep the last good times; retry after the TTL
    }
  }

  const source = async (_query, signal) => {
    await refreshTimes(signal);
    const frame = timeline.frameFor(productId);
    applied = frameKey(frame);
    if (!frame.time && !frame.live) {
      return { kind: 'empty', label: `${p.label}: no frame near this time` };
    }
    return weatherSpec(productId, proxyClient.buildUrl, now(), {
      time: frame.time,
      maximumLevel,
    });
  };

  // The raster engine reports the frame on screen; play waits on it.
  source.shown = (spec) => timeline.markShown(productId, spec?.time ?? null);

  source.subscribe = (onChange) => {
    const leave = timeline.register(productId, { maxGapMs: p.maxGapMs });
    // The engine refreshes right after subscribing; joining is not a change.
    applied = frameKey(timeline.frameFor(productId));
    const off = timeline.subscribe(() => {
      if (reporting) return;
      if (frameKey(timeline.frameFor(productId)) !== applied) onChange();
    });
    return () => {
      off();
      leave();
    };
  };

  return source;
}

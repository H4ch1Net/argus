// Source for the storm cone and track layers: NHC's CurrentStorms.json (proxy
// feed 'nhc') plus the three GIS forecast layers (feed 'nhc-gis'), fetched only
// while a storm is active. Both layers share one load per proxy client (one
// request set a minute at most; the proxy caches the upstream for 5 minutes).
// Pure: no Cesium, no DOM; the terminal shell can use it as is.

import { NHC_GIS_LAYERS, nhcGisPath, nhcGisParams } from '../cyclones/forecast.js';

const SHARE_MS = 60_000;
const shared = new WeakMap(); // proxyClient -> () => Promise<payload>

const abortError = () => new DOMException('aborted', 'AbortError');

// One caller giving up must not cancel the load another layer is waiting on.
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Fetch the status and, with storms active, the GIS set ({ status, gis }). */
export async function loadCycloneForecast(proxyClient) {
  const status = await proxyClient.getJson('nhc', '/CurrentStorms.json');
  if (!status?.activeStorms?.length) return { status, gis: null };
  const results = await Promise.allSettled(
    NHC_GIS_LAYERS.map((layer) =>
      proxyClient.getJson('nhc-gis', nhcGisPath(layer), { params: nhcGisParams(layer) }),
    ),
  );
  // Any failed layer means no geometry at all: a cone without its track (or
  // the reverse) from a partial answer is never drawn.
  const gis = results.every((r) => r.status === 'fulfilled')
    ? results.map((r) => r.value)
    : null;
  return { status, gis };
}

function loaderFor(proxyClient, now) {
  let loader = shared.get(proxyClient);
  if (loader) return loader;
  let last = null;
  let inflight = null;
  loader = () => {
    if (last && now() - last.at < SHARE_MS) return Promise.resolve(last.value);
    inflight ??= loadCycloneForecast(proxyClient)
      .then((value) => {
        last = { at: now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
  shared.set(proxyClient, loader);
  return loader;
}

/**
 * @param {{ proxyClient: object, now?: () => number }} opts
 * @returns {(query: object, signal?: AbortSignal) => Promise<object>}
 */
export function createCycloneForecastSource({ proxyClient, now = Date.now }) {
  const load = loaderFor(proxyClient, now);
  return (_query, signal) => abortable(load(), signal);
}

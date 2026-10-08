// The public-webcam layer's source: which webcam sources the view (and the
// proxy's keys) allow, how each is fetched through the proxy, and how many of
// their webcams are kept so a dense view stays legible. Pure (no Cesium, no
// DOM): the terminal shell uses it as is.
//
// Sources (proxy feeds in proxy/feeds/webcams.js):
// - Windy Webcams API v3 (feed `windy`, key WINDY_WEBCAMS_KEY, injected by the
//   proxy): the bounding box of the view, most-viewed first, 50 a page, at most
//   `windyPages` pages, only below a zoom ceiling. Offered only when the proxy
//   has the key.
// - NPS webcams (feed `nps-webcams`, key NPS_API_KEY): one national list,
//   cached hard, filtered to the view. Offered only when the proxy has the key.
// - NASA EPIC (feed `epic`, keyless): the latest day's Earth images.
// - the bundled observatory stills (./data/observatories.js), no fetch.
//
// Stills are never fetched here: each record carries its still's proxy URL,
// which only a card loads when it opens.

import { insideView } from '../sdk/bbox.js';
import {
  parseWindy,
  parseNps,
  parseEpic,
  parseObservatories,
  windyTotal,
} from './parse.js';

/** Windy is asked only for views at most this tall (degrees of latitude). */
export const WINDY_MAX_SPAN_DEG = 10;
/** NPS webcams show for any view short of the whole globe. */
export const NPS_MAX_SPAN_DEG = 90;
export const WINDY_PAGE_SIZE = 50;
export const WINDY_INCLUDE = 'categories,images,location,player,urls';
export const NPS_QUERY = Object.freeze({ limit: 500, start: 0 });

const MINUTE = 60_000;
// Windy's free-tier still links expire after about 10 minutes, so its results
// are reused for 4 (the proxy caches 4 more at most); the national lists for
// much longer.
export const MEMO_MS = Object.freeze({
  windy: 4 * MINUTE,
  nps: 60 * MINUTE,
  epic: 30 * MINUTE,
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round4 = (v) => Number(v.toFixed(4));

/**
 * The view grown outward to a grid (a quarter to two degrees by zoom), so
 * small pans ask the same question and the proxy's cache answers them.
 */
export function snapBBox(b) {
  const span = Math.max(b.lamax - b.lamin, (b.lomax - b.lomin) / 2);
  const step = span <= 0.5 ? 0.125 : span <= 2 ? 0.5 : span <= 6 ? 1 : 2;
  const down = (v) => Math.floor(v / step) * step;
  const up = (v) => Math.ceil(v / step) * step;
  return {
    lamin: clamp(down(b.lamin), -90, 90),
    lamax: clamp(up(b.lamax), -90, 90),
    lomin: clamp(down(b.lomin), -180, 180),
    lomax: clamp(up(b.lomax), -180, 180),
  };
}

/** Too wide for a Windy query (or across the antimeridian). */
export function windyTooWide(b) {
  return (
    !b ||
    Boolean(b.wrap) ||
    b.lamax - b.lamin > WINDY_MAX_SPAN_DEG ||
    b.lomax - b.lomin > 2 * WINDY_MAX_SPAN_DEG
  );
}

/**
 * Windy v3 GET /webcams parameters for a view: bbox is north,east,south,west
 * (per Windy's documentation), most-viewed first.
 */
export function windyQuery(bbox, offset = 0) {
  const n = round4(clamp(bbox.lamax, -90, 90));
  const s = round4(clamp(bbox.lamin, -90, 90));
  const e = round4(clamp(bbox.lomax, -180, 180));
  const w = round4(clamp(bbox.lomin, -180, 180));
  return {
    bbox: `${n},${e},${s},${w}`,
    limit: WINDY_PAGE_SIZE,
    offset,
    sortKey: 'popularity',
    sortDirection: 'desc',
    include: WINDY_INCLUDE,
    lang: 'en',
  };
}

/**
 * Decluttering: at most `perCell` webcams in each cell of a cells x cells grid
 * over the view, highest rank first (ties keep their order).
 */
export function thinByGrid(items, bbox, { cells = 16, perCell = 4 } = {}) {
  if (!bbox || items.length <= perCell) return items;
  const dLat = Math.max(1e-6, (bbox.lamax - bbox.lamin) / cells);
  const dLon = Math.max(1e-6, (bbox.lomax - bbox.lomin) / cells);
  const counts = new Map();
  return items
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.rank ?? 0) - (a.c.rank ?? 0) || a.i - b.i)
    .filter(({ c }) => {
      const key = `${Math.floor((c.lat - bbox.lamin) / dLat)}:${Math.floor((c.lon - bbox.lomin) / dLon)}`;
      const n = counts.get(key) ?? 0;
      counts.set(key, n + 1);
      return n < perCell;
    })
    .sort((a, b) => a.i - b.i)
    .map(({ c }) => c);
}

/** A small time-bounded memo: one stored result per key, at most `max` keys. */
function createMemo(ttlMs, now, max = 8) {
  const store = new Map();
  return async (key, load) => {
    const hit = store.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = await load();
    store.delete(key);
    store.set(key, { at: now(), value });
    while (store.size > max) store.delete(store.keys().next().value);
    return value;
  };
}

/**
 * The layer's source.
 * @param {{ proxyClient: { getJson: Function, buildUrl: Function },
 *   isConfigured?: (feedId: string) => boolean, windyPages?: number,
 *   now?: () => number, loadObservatories?: () => Promise<object[]> }} opts
 *   isConfigured: whether the proxy holds a keyed feed's key (main.js passes
 *   feedConfigured(health, id)); keyed sources are not offered without it.
 * @returns {(query: { bbox?: object }, signal?: AbortSignal) => Promise<object>}
 *   resolves to { webcams, offered, tooWide, failed, windyTotal }
 */
export function createWebcamSource({
  proxyClient,
  isConfigured = () => false,
  windyPages = 2,
  now = () => Date.now(),
  loadObservatories = async () =>
    (await import('./data/observatories.js')).OBSERVATORY_CAMERAS,
}) {
  const memo = {
    windy: createMemo(MEMO_MS.windy, now),
    nps: createMemo(MEMO_MS.nps, now, 1),
    epic: createMemo(MEMO_MS.epic, now, 1),
  };

  async function windy(bbox, signal) {
    const box = snapBBox(bbox);
    const key = `${box.lamin},${box.lomin},${box.lamax},${box.lomax}`;
    return memo.windy(key, async () => {
      const cams = [];
      let total = null;
      for (let page = 0; page < Math.max(1, windyPages); page += 1) {
        const json = await proxyClient.getJson('windy', '/webcams', {
          params: windyQuery(box, page * WINDY_PAGE_SIZE),
          signal,
        });
        cams.push(...parseWindy(json));
        total = windyTotal(json) ?? total;
        if (total === null || total <= (page + 1) * WINDY_PAGE_SIZE) break;
      }
      return { cams, total };
    });
  }

  const nps = (signal) =>
    memo.nps('all', async () =>
      parseNps(
        await proxyClient.getJson('nps-webcams', '/webcams', {
          params: NPS_QUERY,
          signal,
        }),
      ),
    );
  const epic = (signal) =>
    memo.epic('latest', async () =>
      parseEpic(await proxyClient.getJson('epic', '/natural', { signal })),
    );

  return async (query, signal) => {
    const bbox = query?.bbox ?? null;
    const span = bbox ? bbox.lamax - bbox.lamin : 180;
    const offered = ['epic', 'observatory'];
    const jobs = [
      ['epic', () => epic(signal)],
      ['observatory', async () => parseObservatories(await loadObservatories())],
    ];
    if (isConfigured('nps-webcams')) {
      offered.push('nps');
      if (span <= NPS_MAX_SPAN_DEG) jobs.push(['nps', () => nps(signal)]);
    }
    let tooWide = false;
    if (isConfigured('windy')) {
      offered.push('windy');
      if (windyTooWide(bbox)) tooWide = true;
      else jobs.push(['windy', () => windy(bbox, signal)]);
    }
    const settled = await Promise.allSettled(jobs.map(([, run]) => run()));
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const failed = settled.filter((r) => r.status === 'rejected');
    if (failed.length === settled.length) throw failed[0].reason;

    const inside = insideView(bbox, 0.1);
    let total = null;
    const dense = []; // Windy and NPS: decluttered on a grid
    const sparse = []; // EPIC and the observatories: always kept
    settled.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      const name = jobs[i][0];
      let cams = r.value;
      if (name === 'windy') {
        total = r.value.total;
        cams = r.value.cams;
      }
      for (const c of cams) {
        if (!inside(c.lat, c.lon)) continue;
        (name === 'windy' || name === 'nps' ? dense : sparse).push(c);
      }
    });
    const webcams = [...sparse, ...thinByGrid(dense, bbox)].map((c) => ({
      ...c,
      imageUrl: c.image
        ? proxyClient.buildUrl(c.image.feedId, c.image.path, c.image.params)
        : null,
      fullImageUrl: c.fullImage
        ? proxyClient.buildUrl(c.fullImage.feedId, c.fullImage.path)
        : null,
    }));
    return { webcams, offered, tooWide, failed: failed.length, windyTotal: total };
  };
}

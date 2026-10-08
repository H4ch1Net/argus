// The GDELT source: each fixed theme query through the proxy's pinned
// 'gdelt-geo' feed, one after another and 5 s apart (GDELT asks for at most one
// request every 5 seconds; the proxy caches each answer 15 minutes, so a
// refresh within that costs nothing upstream). Answers are read as text, since
// GDELT reports some errors as plain text. A theme that fails is skipped.
// Returns { [themeId]: text } for the definition. Pure: no Cesium.

import { GDELT_THEMES, GDELT_GEO_PATH, gdeltQuery } from './parse.js';

const GAP_MS = 5200;

const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(aborted());
      },
      { once: true },
    );
  });

export function createGdeltSource({ proxyClient, gapMs = GAP_MS }) {
  return async (_query, signal) => {
    const out = {};
    let failed = 0;
    for (const [i, theme] of GDELT_THEMES.entries()) {
      if (i > 0) await sleep(gapMs, signal);
      try {
        out[theme.id] = await proxyClient.getText('gdelt-geo', GDELT_GEO_PATH, {
          params: gdeltQuery(theme),
          signal,
        });
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        failed += 1;
      }
    }
    if (failed === GDELT_THEMES.length) throw new Error('GDELT: no theme answered');
    return out;
  };
}

/** Dev / demo stand-in: a few GEO-shaped points per theme. */
export function createGdeltMockSource() {
  const places = [
    ['Manila, Philippines', 120.98, 14.6],
    ['Valencia, Spain', -0.38, 39.47],
    ['Port-au-Prince, Haiti', -72.34, 18.54],
    ['Nairobi, Kenya', 36.82, -1.29],
    ['Dhaka, Bangladesh', 90.41, 23.81],
  ];
  return async () => {
    const out = {};
    for (const [t, theme] of GDELT_THEMES.entries()) {
      out[theme.id] = {
        type: 'FeatureCollection',
        features: places.map(([name, lon, lat], i) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lon + t * 0.4, lat + t * 0.3] },
          properties: {
            name,
            count: 3 + i * 7,
            html: `<a href="https://example.org/${theme.id}/${i}" title="Demo ${theme.label.toLowerCase()} report (simulated)">x</a>`,
            demo: true,
          },
        })),
      };
    }
    return out;
  };
}

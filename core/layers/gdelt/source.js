// The GDELT source: one GET of the proxy's built events document (the
// 'gdelt-events' feed, rebuilt from GDELT's 15-minute exports and cached
// there, so a refresh within 15 minutes costs nothing upstream). No query is
// sent. Returns the document for the definition. Pure: no Cesium.

import { GDELT_FEED, GDELT_EVENTS_PATH, GDELT_THEMES } from './parse.js';

export function createGdeltSource({ proxyClient }) {
  return (_query, signal) =>
    proxyClient.getJson(GDELT_FEED, GDELT_EVENTS_PATH, { signal });
}

/** Dev / demo stand-in: a few events per theme, in the proxy's shape. */
export function createGdeltMockSource() {
  const places = [
    ['Manila, Manila, Philippines', 120.98, 14.6, 'RP'],
    ['Valencia, Comunidad Valenciana, Spain', -0.38, 39.47, 'SP'],
    ['Port-au-Prince, Ouest, Haiti', -72.34, 18.54, 'HA'],
    ['Nairobi, Nairobi Area, Kenya', 36.82, -1.29, 'KE'],
    ['Dhaka, Dhaka, Bangladesh', 90.41, 23.81, 'BG'],
  ];
  const codes = { aid: '073', unrest: '141', conflict: '190' };
  return async () => ({
    v: 1,
    updated: new Date(Math.floor(Date.now() / 900_000) * 900_000)
      .toISOString()
      .replace('.000Z', 'Z'),
    windowMinutes: 60,
    exports: 4,
    events: GDELT_THEMES.flatMap((theme, t) =>
      places.map(([place, lon, lat, cc], i) => ({
        theme: theme.id,
        code: codes[theme.id],
        quad: theme.id === 'conflict' ? 4 : theme.id === 'unrest' ? 3 : 2,
        goldstein: theme.id === 'aid' ? 7.4 : -6.5,
        mentions: 3 + i * 7,
        sources: 1 + i,
        articles: 3 + i * 7,
        tone: -3.5,
        geo: 4,
        place,
        cc,
        lat: lat + t * 0.3,
        lon: lon + t * 0.4,
        added: new Date(Date.now() - i * 600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        n: 1 + (i % 3),
        urls: [`https://example.org/${theme.id}/demo-${theme.id}-report-${i}`],
        demo: true,
      })),
    ),
  });
}

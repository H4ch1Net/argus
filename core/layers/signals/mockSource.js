// Dev-only mock traffic lights: Overpass-shaped nodes on a street grid inside
// the current view (junction signals at the crossings, a few signalled
// pedestrian crossings between them), only when zoomed in like the real
// source. Dev-gated + dynamic-imported.

import { computeViewportQuery } from '../sdk/viewport.js';
import { viewSizeKm } from '../overpass/tiles.js';
import { SIGNALS_MAX_VIEW_KM } from './parse.js';

export function createSignalsMockSource({ viewer }) {
  return async () => {
    const b = computeViewportQuery(viewer).bbox;
    if (viewSizeKm(b).across > SIGNALS_MAX_VIEW_KM) return { tooWide: true, items: [] };
    const elements = [];
    const n = 7;
    let id = 3_000_000;
    for (let i = 1; i < n; i += 1) {
      for (let j = 1; j < n; j += 1) {
        const lat = b.lamin + ((b.lamax - b.lamin) * i) / n;
        const lon = b.lomin + ((b.lomax - b.lomin) * j) / n;
        if ((i + j) % 3 === 0) continue; // not every junction has lights
        elements.push({
          type: 'node',
          id: (id += 1),
          lat,
          lon,
          tags: {
            highway: 'traffic_signals',
            ...(i % 2 ? { traffic_signals: 'signal' } : {}),
          },
        });
        if ((i * j) % 4 === 1) {
          elements.push({
            type: 'node',
            id: (id += 1),
            lat: lat + (b.lamax - b.lamin) / (n * 2.5),
            lon,
            tags: {
              highway: 'crossing',
              crossing: 'traffic_signals',
              button_operated: 'yes',
              'traffic_signals:sound': 'yes',
            },
          });
        }
      }
    }
    return { elements };
  };
}

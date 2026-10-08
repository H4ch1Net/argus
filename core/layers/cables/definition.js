import * as Cesium from 'cesium';
import { parseCables } from './parse.js';
import { describeCable, cableSearchText } from './format.js';

// Submarine cables as polylines (TeleGeography's public map data, fetched once
// a day through the proxy). Drawn slightly above sea level rather than clamped
// to the ground, which keeps ~2,000 long segments cheap on a phone. Each cable
// keeps the colour TeleGeography gives it.

const colors = new Map();
const cableColor = (hex) => {
  const key = hex || '#4fc3f7';
  if (!colors.has(key))
    colors.set(key, Cesium.Color.fromCssColorString(key).withAlpha(0.85));
  return colors.get(key);
};

export const cablesDefinition = {
  id: 'cables',
  fetch: { mode: 'poll', intervalMs: 24 * 60 * 60 * 1000, viewportBounded: false },
  interpolate: false,
  maxEntities: 6000,
  normalize: (raw) => parseCables(raw),
  render: {
    renderType: 'polyline',
    height: 300,
    width: 1.5,
    style: (n) => ({ color: cableColor(n.meta.color) }),
  },
  describe: (n) => describeCable(n),
  searchText: cableSearchText,
};

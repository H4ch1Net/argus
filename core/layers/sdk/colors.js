import * as Cesium from 'cesium';
import { INK, inkFor } from '../../ui/palette.js';

// Cesium colours from the ctOS palette (core/ui/palette.js), cached so a style
// function called per fix never allocates a new Color.

const cache = new Map();

/** A cached Cesium.Color for a CSS colour string and an alpha. */
export function cesiumColor(css, alpha = 1) {
  const key = `${css}|${alpha}`;
  let c = cache.get(key);
  if (!c) {
    c = Cesium.Color.fromCssColorString(css).withAlpha(alpha);
    cache.set(key, c);
  }
  return c;
}

/** A palette colour by name (INK) as a cached Cesium.Color. */
export const ink = (name, alpha = 1) => cesiumColor(INK[name] ?? INK.gray, alpha);

/** A layer's own ink (LAYER_INK) as a cached Cesium.Color. */
export const layerInk = (key, alpha = 1) => cesiumColor(inkFor(key), alpha);

import * as Cesium from 'cesium';
import { parseLaunches, primaryLaunch } from './parse.js';
import { describeLaunchPad, launchColorHex, launchSearchText } from './format.js';

// Launch pads with their launches from a week back to six weeks ahead (Launch
// Library 2). Polled every 15 minutes, and the proxy caches the same window, so
// the keyless 15-calls-per-hour budget is never at risk.

export const launchesDefinition = {
  id: 'launches',
  fetch: { mode: 'poll', intervalMs: 15 * 60 * 1000, viewportBounded: false },
  interpolate: false,
  maxEntities: 200,
  normalize: (raw) => parseLaunches(raw),
  render: {
    renderType: 'point',
    style: (n) => ({
      pixelSize: 11,
      color: Cesium.Color.fromCssColorString(
        launchColorHex(primaryLaunch(n.meta.launches)),
      ),
    }),
  },
  describe: (n) => describeLaunchPad(n),
  searchText: launchSearchText,
};

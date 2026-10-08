import { parseLaunches, primaryLaunch } from './parse.js';
import { describeLaunchPad, launchSearchText } from './format.js';
import { ink } from '../sdk/colors.js';

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
    // Pads: a cross; upcoming launches white, others dimmed.
    renderType: 'point',
    style: (n) => {
      const next = primaryLaunch(n.meta.launches);
      const upcoming = next && Date.parse(next.net) > Date.now();
      return {
        glyph: 'cross',
        pixelSize: 15,
        color: upcoming ? ink('white') : ink('muted'),
      };
    },
  },
  describe: (n) => describeLaunchPad(n),
  searchText: launchSearchText,
};

import * as Cesium from 'cesium';
import { planeImage } from '../flights/definition.js';
import { formatAircraft, aircraftSearchText } from '../flights/format.js';
import { parseLocalAdsb } from './parse.js';

// Aircraft heard by your own receiver (dump1090 / readsb on this machine or the
// LAN, set with LOCAL_ADSB_URL). Polled every 2 s, so motion is near real time.

const LOCAL_COLOR = Cesium.Color.fromCssColorString('#b388ff');

export const localAdsbDefinition = {
  id: 'local-adsb',
  fetch: { mode: 'poll', intervalMs: 2000, viewportBounded: false },
  interpolate: true,
  maxEntities: 1000,
  normalize: (raw) => parseLocalAdsb(raw),
  render: {
    renderType: 'billboard',
    style: (n) => ({
      image: planeImage(),
      rotationRadians: -Cesium.Math.toRadians(n.meta.trueTrack || 0),
      color: LOCAL_COLOR,
      scale: 0.75,
    }),
  },
  describe: (n) => formatAircraft(n.meta),
  searchText: aircraftSearchText,
};

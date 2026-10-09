import { createStreetPhotoSource } from './source.js';

// Dev / demo stand-in for Mapillary: capture sequences (a line of points 15 m
// apart, each facing along the line) in every tile, no photo pixels, every card
// labelled DEMO. Deterministic per tile, so a pan shows the same points again.

const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** Demo images in one tile (the plain image shape of parse.js). */
export function demoTileImages(t) {
  const out = [];
  let h = hash(t.key);
  const rnd = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    return (h ^ (h >>> 16)) / 4294967296;
  };
  const dLat = t.lamax - t.lamin;
  const dLon = t.lomax - t.lomin;
  for (let s = 0; s < 3; s += 1) {
    let lat = t.lamin + dLat * (0.15 + rnd() * 0.7);
    let lon = t.lomin + dLon * (0.15 + rnd() * 0.7);
    const heading = Math.floor(rnd() * 4) * 90 + rnd() * 6;
    const step = 15 / 111_000;
    for (let k = 0; k < 12; k += 1) {
      out.push({
        id: String(1e12 + (hash(`${t.key}:${s}:${k}`) % 1e9)),
        lon,
        lat,
        capturedAt: Date.UTC(2025, 4, 1 + s, 9, k),
        compass: heading,
        pano: s === 2,
        thumb256: null,
        thumb1024: null,
        image: null,
        demo: true,
      });
      lat += Math.cos((heading * Math.PI) / 180) * step;
      lon +=
        (Math.sin((heading * Math.PI) / 180) * step) / Math.cos((lat * Math.PI) / 180);
    }
  }
  return out;
}

/** Demo tiles (for findNearestStreetPhoto) and the demo layer source. */
export function createStreetPhotoMockTiles() {
  return { tile: async (t) => demoTileImages(t) };
}

export function createStreetPhotoMockSource({ maxViewDeg } = {}) {
  return createStreetPhotoSource({
    proxyClient: null,
    tiles: createStreetPhotoMockTiles(),
    maxViewDeg,
  });
}

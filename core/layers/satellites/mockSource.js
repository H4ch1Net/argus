// Dev-only mock satellite source: a small constellation derived from the known-
// valid ISS TLE by varying the catalog number, RAAN, and mean anomaly, so every
// element set stays valid (satellite.js parses positionally, no checksum needed).
// Dev-gated + dynamic-imported, so it never ships in production.

const L1 = '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const L2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';

// Fixed-width field splice: replace `len` chars at `start` with a right-aligned value.
const setField = (line, start, len, value) =>
  line.slice(0, start) + value.slice(0, len).padStart(len) + line.slice(start + len);

const deg = (v) => v.toFixed(4).padStart(8);

function buildConstellation(count) {
  const lines = [];
  for (let k = 0; k < count; k += 1) {
    const satnum = String(90001 + k);
    let l1 = setField(L1, 2, 5, satnum);
    let l2 = setField(L2, 2, 5, satnum);
    l2 = setField(l2, 17, 8, deg((60 * k) % 360)); // RAAN: spread orbital planes
    l2 = setField(l2, 43, 8, deg((47 * k) % 360)); // mean anomaly: spread phase
    lines.push(`MOCKSAT-${k + 1}`, l1, l2);
  }
  return lines.join('\n');
}

export function createSatMockSource({ count = 6 } = {}) {
  const tle = buildConstellation(count);
  return async () => tle;
}

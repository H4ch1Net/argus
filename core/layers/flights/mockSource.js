// Dev-only mock flights source.
//
// Produces OpenSky-shaped payloads so the exact parse -> render -> interpolate
// pipeline can be exercised without OpenSky credentials. Enabled only via
// `?flightsMock=1` in a dev build and dynamic-imported, so it never ships in a
// production bundle. Planes move each poll so interpolation is visibly smooth.

const rand = (a, b) => a + Math.random() * (b - a);

/**
 * @param {{ count?: number, stepSeconds?: number }} [opts]
 * @returns {(query: { bbox: object }) => Promise<{ time: number, states: any[][] }>}
 */
export function createMockSource({ count = 40, stepSeconds = 15 } = {}) {
  let planes = null;

  return async ({ bbox }) => {
    const now = Math.floor(Date.now() / 1000);

    if (!planes) {
      planes = Array.from({ length: count }, (_, i) => ({
        id: `MOCK${String(i).padStart(3, '0')}`,
        callsign: `MOK${i}`,
        lon: rand(bbox.lomin, bbox.lomax),
        lat: rand(bbox.lamin, bbox.lamax),
        track: Math.random() * 360,
        speed: 150 + Math.random() * 150, // m/s
        alt: 2000 + Math.random() * 10000,
      }));
    }

    for (const p of planes) {
      const distM = p.speed * stepSeconds;
      p.lat += (distM * Math.cos((p.track * Math.PI) / 180)) / 111320;
      p.lon +=
        (distM * Math.sin((p.track * Math.PI) / 180)) /
        (111320 * Math.cos((p.lat * Math.PI) / 180));
      // Wrap within the current view so the flock stays visible.
      if (p.lon < bbox.lomin) p.lon = bbox.lomax;
      if (p.lon > bbox.lomax) p.lon = bbox.lomin;
      if (p.lat < bbox.lamin) p.lat = bbox.lamax;
      if (p.lat > bbox.lamax) p.lat = bbox.lamin;
    }

    const states = planes.map((p) => {
      const s = new Array(18).fill(null);
      s[0] = p.id;
      s[1] = p.callsign;
      s[2] = 'MockLand';
      s[3] = now;
      s[4] = now;
      s[5] = p.lon;
      s[6] = p.lat;
      s[7] = p.alt;
      s[8] = false;
      s[9] = p.speed;
      s[10] = p.track;
      s[11] = 0;
      s[13] = p.alt;
      return s;
    });

    return { time: now, states };
  };
}

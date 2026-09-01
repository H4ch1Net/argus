// Earthquake styling + card model. Pure (returns a hex color and plain numbers);
// the definition wraps the color in a Cesium.Color. Testable without Cesium.

/** Color by magnitude: green (minor) grading to red (major). */
export function magnitudeColorHex(mag) {
  if (mag == null) return '#9aa7b8';
  if (mag < 2) return '#39d98a';
  if (mag < 4) return '#e3d357';
  if (mag < 5) return '#e3a857';
  if (mag < 6) return '#e3733f';
  return '#ff3b30';
}

/** Point size by magnitude (energy grows fast, so a super-linear ramp). */
export function magnitudePixelSize(mag) {
  if (mag == null) return 6;
  return Math.min(40, Math.max(5, 4 + Math.pow(Math.max(0, mag), 1.8)));
}

function fmtTime(ms) {
  if (ms == null) return '—';
  return `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

/** @returns {{ id: string, title: string, subtitle: string, rows: [string,string][] }} */
export function describeQuake(n) {
  const m = n.meta;
  return {
    id: n.id,
    title: m.mag != null ? `M ${m.mag.toFixed(1)}` : 'Earthquake',
    subtitle: m.place || '',
    rows: [
      ['Magnitude', m.mag != null ? m.mag.toFixed(1) : '—'],
      ['Depth', m.depthKm != null ? `${Math.round(m.depthKm)} km` : '—'],
      ['Time', fmtTime(m.time)],
      [
        'Coordinates',
        `${n.position.latitude.toFixed(2)}, ${n.position.longitude.toFixed(2)}`,
      ],
    ],
  };
}

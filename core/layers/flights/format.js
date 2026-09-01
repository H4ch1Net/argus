// Human-readable formatting for an aircraft's metadata card. Pure, testable.
// OpenSky reports SI units (metres, m/s); aviation convention is feet, knots,
// and feet/min, so we convert.

const MPS_TO_KT = 1.94384;
const M_TO_FT = 3.28084;
const MPS_TO_FPM = 196.8504;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const groupInt = (v) => Math.round(v).toLocaleString('en-US');

export function formatAltitude(metres) {
  const v = num(metres);
  return v == null ? '—' : `${groupInt(v * M_TO_FT)} ft`;
}

export function formatSpeed(mps) {
  const v = num(mps);
  return v == null ? '—' : `${groupInt(v * MPS_TO_KT)} kt`;
}

export function formatVerticalRate(mps) {
  const v = num(mps);
  if (v == null) return '—';
  const fpm = Math.round(v * MPS_TO_FPM);
  return `${fpm > 0 ? '+' : ''}${groupInt(fpm)} ft/min`;
}

export function formatHeading(deg) {
  const v = num(deg);
  return v == null ? '—' : `${Math.round(v)}°`;
}

/**
 * Build the display model for a metadata card from a parsed aircraft.
 * @returns {{ id: string, title: string, subtitle: string, rows: [string, string][] }}
 */
export function formatAircraft(a) {
  return {
    id: a.id,
    title: (a.callsign && a.callsign.trim()) || a.id || 'unknown',
    subtitle: a.originCountry || '',
    rows: [
      ['ICAO24', a.id ?? '—'],
      ['Status', a.onGround ? 'on ground' : 'airborne'],
      ['Altitude', formatAltitude(a.geoAltitude ?? a.baroAltitude)],
      ['Speed', formatSpeed(a.velocity)],
      ['Heading', formatHeading(a.trueTrack)],
      ['Vertical rate', formatVerticalRate(a.verticalRate)],
    ],
  };
}

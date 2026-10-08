// Storm cone and track cards, styling names and search text. Pure: shared with
// the terminal shell.

import { saffirSimpson } from '../cyclones/format.js';

/** What the cone means, on every card (it is often misread as storm size). */
export const CONE_NOTE = 'cone = uncertainty in the centre track, not storm size';

/** Palette ink name (core/ui/palette.js INK) for a storm's forecast geometry. */
export const forecastInkName = (windKt) => ((windKt ?? 0) >= 96 ? 'error' : 'white');

const deg = (v, pos, neg) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? pos : neg}`;

function pointRow(p) {
  const label = p.tauHours === 0 ? 'Now' : `+${p.tauHours} h`;
  const where = `${deg(p.latitude, 'N', 'S')} ${deg(p.longitude, 'E', 'W')}`;
  const wind =
    p.windKt != null
      ? `, ${p.windKt} kt${p.gustKt != null && p.gustKt > p.windKt ? ` (gusts ${p.gustKt})` : ''}`
      : '';
  return [label, where + wind];
}

function intensity(m) {
  if (m.windKt == null) return '—';
  const cat = saffirSimpson(m.windKt);
  return `${m.windKt} kt${cat ? `, category ${cat}` : ''}`;
}

function describe(n, kind) {
  const m = n.meta;
  const points = Array.isArray(m.forecastPoints) ? m.forecastPoints : [];
  return {
    id: n.id,
    title: m.name,
    subtitle: `${kind}, advisory #${m.advisoryNumber}`,
    rows: [
      ['Storm', [m.stormId?.toUpperCase(), m.basin].filter(Boolean).join(', ')],
      ['Intensity now', intensity(m)],
      ['Forecast to', points.length ? `+${points[points.length - 1].tauHours} h` : '—'],
      ['Cone', CONE_NOTE],
      ['Source', m.demo ? 'demo (simulated)' : 'NOAA National Hurricane Center GIS'],
    ],
    sections: points.length
      ? [{ title: 'Official forecast centre', rows: points.map(pointRow) }]
      : [],
    links: m.advisoryUrl ? [{ label: 'NHC forecast advisory', url: m.advisoryUrl }] : [],
  };
}

export const describeCone = (n) => describe(n, 'Forecast cone');
export const describeTrack = (n) => describe(n, 'Forecast track');

/** Only the first part of a storm's geometry is searchable (no duplicates). */
export const forecastSearchText = (n) =>
  n.meta.part === 0
    ? `${n.meta.name} ${n.meta.stormId} forecast cone track hurricane storm`
    : '';

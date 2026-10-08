// Surveillance-infrastructure styling + card. LOCATIONS ONLY (project guardrail):
// this maps WHERE cameras and ALPR/Flock readers are, and which way they are
// mapped as facing, from OSM's `man_made=surveillance` data. It never reads
// what any camera sees.

import { cameraCones, describeFacing, directionTag } from './cones.js';

export function surveillanceKind(tags) {
  const t = String(tags['surveillance:type'] || '').toLowerCase();
  if (t.includes('alpr') || t.includes('anpr')) return 'ALPR';
  if (t === 'camera' || t === '') return 'camera';
  return t;
}

export function surveillanceColorHex(kind) {
  return kind === 'ALPR' ? '#ff4d4d' : '#ffb454';
}

export function surveillancePixelSize(kind) {
  return kind === 'ALPR' ? 9 : 7;
}

const clip = (v, n = 40) => (v == null || v === '' ? null : String(v).slice(0, n));

export function describeSurveillance(n) {
  const tags = n.meta.tags;
  const kind = surveillanceKind(tags);
  const spec = cameraCones(n);
  const raw = directionTag(tags);
  // camera:angle is the tilt from the horizontal in OSM (not the view width).
  const tilt = clip(tags['camera:angle'], 12);
  return {
    id: n.id,
    title: kind === 'ALPR' ? 'ALPR / plate reader' : 'Surveillance camera',
    subtitle: tags.operator || '',
    rows: [
      ['Type', tags['surveillance:type'] || 'camera'],
      ['Operator', tags.operator || '—'],
      ['Mount', tags['camera:mount'] || tags.surveillance || '—'],
      ['Camera', clip(tags['camera:type'], 20) || '—'],
      ['Direction', describeFacing(spec)],
      ...(raw ? [['Tagged as', raw]] : []),
      ...(tilt ? [['Tilt', /^\d+(\.\d+)?$/.test(tilt) ? `${tilt} deg` : tilt]] : []),
      [
        'Coordinates',
        `${n.position.latitude.toFixed(4)}, ${n.position.longitude.toFixed(4)}`,
      ],
    ],
  };
}

/** The mapped facing for the terminal (degrees of the first cone), or null. */
export function surveillanceHeading(n) {
  const spec = cameraCones(n);
  return spec && !spec.ring ? spec.cones[0].headingDeg : null;
}

// CHP dispatch incident cards and search text. Pure: shared with the terminal.
// Kind glyphs and severity colours are the road-incident ones
// (core/layers/incidents/format.js).

import { INCIDENT_KINDS, formatUtc } from '../incidents/format.js';
import { formatAge } from '../perimeters/format.js';

/** "1183-Trfc Collision-Unkn Inj" -> "Trfc Collision-Unkn Inj (1183)". */
export function chpTypeLabel(type) {
  const m = /^(\d{3,5}[A-Z]?)-(.+)$/.exec(String(type || ''));
  return m ? `${m[2]} (${m[1]})` : String(type || 'Incident');
}

export function describeChp(n, now = Date.now()) {
  const m = n.meta;
  const ago = m.timeMs != null ? formatAge(now - m.timeMs) : null;
  const place = m.location || m.locationDesc || '';
  return {
    id: n.id,
    title: chpTypeLabel(m.logType),
    subtitle: [place, m.area].filter(Boolean).join(', '),
    rows: [
      ['Kind', INCIDENT_KINDS[m.kind]?.label ?? 'Incident'],
      ['Location', m.location || '—'],
      ...(m.locationDesc && m.locationDesc !== m.location
        ? [['Detail', m.locationDesc]]
        : []),
      ['Area', m.area || '—'],
      ['Dispatch', m.centerName ? `CHP ${m.centerName}` : '—'],
      [
        'Logged',
        m.timeMs != null ? `${formatUtc(m.timeMs)}${ago ? ` (${ago} ago)` : ''}` : '—',
      ],
      [
        'Coordinates',
        `${n.position.latitude.toFixed(4)}, ${n.position.longitude.toFixed(4)}`,
      ],
      [
        'Source',
        m.demo
          ? 'demo (simulated)'
          : 'California Highway Patrol CAD, public incident list (no dispatch notes)',
      ],
    ],
  };
}

export const chpSearchText = (n) =>
  `${n.meta.logType || ''} ${n.meta.location || ''} ${n.meta.area || ''} chp incident`;

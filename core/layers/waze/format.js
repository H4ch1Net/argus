// Waze alert and jam styling and cards. Pure: no Cesium, no DOM (the terminal
// uses it too). Glyphs are the road incident kinds (core/layers/incidents/
// format.js); colour is severity from the ctOS palette, red only for a
// closure, a major accident or a standstill.

import { INK } from '../../ui/palette.js';
import { INCIDENT_KINDS, formatDelay, formatLength } from '../incidents/format.js';
import { JAM_LEVELS } from './parse.js';

const SEVERITY_INK = { critical: 'error', notable: 'white', minor: 'dim' };

/** Glyph name (core/ui/glyphs.js) for a Waze record's kind. */
export const wazeGlyph = (kind) => INCIDENT_KINDS[kind]?.glyph ?? 'triangle';

/** Palette ink name for a severity. */
export const wazeInkName = (severity) => SEVERITY_INK[severity] ?? 'dim';

/** Hex colour for a severity (terminal and legends). */
export const wazeColorHex = (severity) => INK[wazeInkName(severity)];

/** Marker size by severity. */
export const wazePixelSize = (severity) =>
  severity === 'critical' ? 15 : severity === 'notable' ? 13 : 11;

/** "4 min ago", "2 h ago"; null without a time. */
export function reportedAgo(ms, now = Date.now()) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

const coords = (n) =>
  `${n.position.latitude.toFixed(4)}, ${n.position.longitude.toFixed(4)}`;

const SOURCE = 'Waze live map (unofficial, personal use)';

/** Card for a Waze alert or jam. */
export function describeWaze(n, now = Date.now()) {
  const m = n.meta;
  const where = [m.street, m.city].filter(Boolean).join(', ');
  const rows =
    n.type === 'waze-jam'
      ? [
          ['Level', m.blocked ? 'Blocked' : `${m.level} of 5 (${JAM_LEVELS[m.level]})`],
          ['Speed', Number.isFinite(m.speedKmh) ? `${m.speedKmh} km/h` : '—'],
          ['Delay', formatDelay(m.delayS) || '—'],
          ['Length', formatLength(m.lengthM) || '—'],
        ]
      : [
          ['Type', m.label],
          ...(Number.isFinite(m.reliability)
            ? [['Reliability', `${m.reliability} / 10`]]
            : []),
          ...(Number.isFinite(m.thumbs) && m.thumbs > 0
            ? [['Confirmed by', `${m.thumbs} driver${m.thumbs === 1 ? '' : 's'}`]]
            : []),
        ];
  return {
    id: n.id,
    title: m.label,
    subtitle: where,
    rows: [
      ...rows,
      ['Street', m.street || '—'],
      ['City', m.city || '—'],
      ['Reported', reportedAgo(m.pubMs, now) || '—'],
      ['Position', coords(n)],
      ['Source', SOURCE],
    ],
    links: [
      {
        // Waze's documented deep link (opens the app or the live map there).
        label: 'Open in Waze',
        url: `https://www.waze.com/ul?ll=${n.position.latitude.toFixed(5)}%2C${n.position.longitude.toFixed(5)}&zoom=16`,
      },
    ],
  };
}

/** Text the search box matches. */
export const wazeSearchText = (n) =>
  ['waze', n.meta.label, n.meta.kind, n.meta.street, n.meta.city]
    .filter(Boolean)
    .join(' ');

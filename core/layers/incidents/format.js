// Road incident styling and cards, shared by the TomTom incident layer and the
// CHP dispatch layer (and the terminal). Pure: no Cesium, no DOM.
//
// Six kinds, one glyph each (core/ui/glyphs.js): accident (cross mark), jam
// (stacked bars), roadworks (barrier), closure (barred square), hazard
// (triangle), weather (slanted strokes). Colour is severity, from the ctOS
// palette: red only for a critical one (a road closed, a major delay, an
// injury collision), white for notable, dim gray for minor.

import { INK } from '../../ui/palette.js';
import { TOMTOM_ICON_LABELS, TOMTOM_DELAY_LABELS } from './parse.js';

export const INCIDENT_KINDS = Object.freeze({
  accident: { label: 'Accident', glyph: 'xmark' },
  jam: { label: 'Traffic jam', glyph: 'queue' },
  roadworks: { label: 'Road works', glyph: 'barrier' },
  closure: { label: 'Closure', glyph: 'noentry' },
  hazard: { label: 'Hazard', glyph: 'triangle' },
  weather: { label: 'Weather', glyph: 'rain' },
});

const SEVERITY_INK = { critical: 'error', notable: 'white', minor: 'dim' };

/** Glyph name (core/ui/glyphs.js) for an incident kind. */
export const incidentGlyph = (kind) => INCIDENT_KINDS[kind]?.glyph ?? 'triangle';

/** Palette ink name (INK key) for a severity. */
export const incidentInkName = (severity) => SEVERITY_INK[severity] ?? 'dim';

/** Hex colour for a severity (terminal and legends). */
export const incidentColorHex = (severity) => INK[incidentInkName(severity)];

/** Marker size by severity. */
export const incidentPixelSize = (severity) =>
  severity === 'critical' ? 15 : severity === 'notable' ? 13 : 11;

/** "12 min", "1 h 05 min"; null for none. */
export function formatDelay(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${Math.max(1, m)} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** "850 m", "2.4 km"; null for none. */
export function formatLength(metres) {
  if (!Number.isFinite(metres) || metres <= 0) return null;
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;
}

/** "2026-10-08 14:05 UTC"; null for none. */
export function formatUtc(ms) {
  return Number.isFinite(ms)
    ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : null;
}

const coords = (n) =>
  `${n.position.latitude.toFixed(4)}, ${n.position.longitude.toFixed(4)}`;

/** Card for a TomTom incident. */
export function describeIncident(n) {
  const m = n.meta;
  const kind = INCIDENT_KINDS[m.kind] ?? INCIDENT_KINDS.hazard;
  const detail = TOMTOM_ICON_LABELS[m.icon] ?? kind.label;
  const where = [m.from, m.to].filter(Boolean).join(' to ');
  return {
    id: n.id,
    title: m.events[0] || detail,
    subtitle: [m.roads.join(', '), where].filter(Boolean).join(': '),
    rows: [
      ['Type', detail],
      ['Delay', formatDelay(m.delayS) || TOMTOM_DELAY_LABELS[m.magnitude] || '—'],
      ['Severity', TOMTOM_DELAY_LABELS[m.magnitude] ?? '—'],
      ['Length', formatLength(m.lengthM) || '—'],
      ['From', m.from || '—'],
      ['To', m.to || '—'],
      ...(m.roads.length ? [['Road', m.roads.join(', ')]] : []),
      ...(m.events.length > 1 ? [['Details', m.events.slice(1).join('; ')]] : []),
      ['Since', formatUtc(m.startMs) || '—'],
      ['Until', formatUtc(m.endMs) || '—'],
      ['Coordinates', coords(n)],
      ['Source', m.demo ? 'demo (simulated)' : 'TomTom Traffic (your key)'],
    ],
  };
}

export const incidentSearchText = (n) =>
  `${n.meta.events?.join(' ') || ''} ${n.meta.roads?.join(' ') || ''} ${n.meta.from || ''} ${n.meta.to || ''} ${INCIDENT_KINDS[n.meta.kind]?.label || ''} incident`;

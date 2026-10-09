// GDELT event cards, styling and search text. Pure: shared with the terminal.
// Links are shown as plain text, https/http only; nothing from GDELT is ever
// rendered as HTML.

import { INK } from '../../ui/palette.js';
import { formatAge } from '../perimeters/format.js';

const THEME_INK = { aid: 'white', unrest: 'dimmer', conflict: 'error' };

export const gdeltInkName = (n) => THEME_INK[n.meta.theme] ?? 'dimmer';
export const gdeltColorHex = (n) => INK[gdeltInkName(n)];

/** Marker size from the number of mentions (log scale, 9..15 px). */
export const gdeltPixelSize = (n) =>
  Math.round(9 + Math.min(6, Math.log10(Math.max(1, n.meta.count)) * 2.5));

const signed = (v, d = 1) => (v > 0 ? `+${v.toFixed(d)}` : v.toFixed(d));

/** "2026-10-09 06:00 UTC". */
const utc = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const ago = (ms) => {
  const a = formatAge(ms);
  return a ? ` (${a} ago)` : '';
};

export function describeGdelt(n, now = Date.now()) {
  const m = n.meta;
  const reports =
    m.events > 1 ? `${m.count} mentions, ${m.events} events` : `${m.count} mentions`;
  return {
    id: n.id,
    title: m.codeLabel,
    subtitle: m.place,
    rows: [
      ['Theme', m.themeLabel],
      ['Event', `${m.codeLabel} (CAMEO ${m.code})`],
      ['Place', m.place || '--'],
      ...(m.precision ? [['Precision', m.precision]] : []),
      ['Reports', reports],
      ...(m.tone !== null ? [['Tone', signed(m.tone)]] : []),
      ...(m.goldstein !== null ? [['Goldstein', signed(m.goldstein)]] : []),
      ...(m.addedMs !== null
        ? [['Added', `${utc(m.addedMs)}${ago(now - m.addedMs)}`]]
        : []),
      [
        'Coordinates',
        `${n.position.latitude.toFixed(3)}, ${n.position.longitude.toFixed(3)}`,
      ],
      [
        'Source',
        m.demo
          ? 'demo (simulated)'
          : "GDELT Project 2.0 Events, machine-coded from news, last hour (articles keep their publishers' terms)",
      ],
    ],
    links: m.articles.map((a) => ({ label: `${a.title} (${a.domain})`, url: a.url })),
  };
}

export const gdeltSearchText = (n) =>
  `${n.meta.codeLabel} ${n.meta.place} ${n.meta.themeLabel} ${n.meta.headline} news`;

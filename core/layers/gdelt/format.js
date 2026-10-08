// GDELT event cards, styling and search text. Pure: shared with the terminal.
// Article titles and links are shown as plain text and https/http links only;
// GDELT's own HTML is never rendered.

import { INK } from '../../ui/palette.js';

const THEME_INK = { disaster: 'white', unrest: 'dimmer', conflict: 'error' };

export const gdeltInkName = (n) => THEME_INK[n.meta.theme] ?? 'dimmer';
export const gdeltColorHex = (n) => INK[gdeltInkName(n)];

/** Marker size from the number of reports (log scale, 9..15 px). */
export const gdeltPixelSize = (n) =>
  Math.round(9 + Math.min(6, Math.log10(Math.max(1, n.meta.count)) * 2.5));

export function describeGdelt(n) {
  const m = n.meta;
  return {
    id: n.id,
    title: m.headline || `${m.themeLabel} reports`,
    subtitle: m.place,
    rows: [
      ['Theme', m.themeLabel],
      ['Place', m.place || '—'],
      ['Reports', String(m.count)],
      ...m.articles
        .slice(1, 4)
        .map((a, i) => [`Also ${i + 1}`, `${a.title} (${a.domain})`]),
      [
        'Coordinates',
        `${n.position.latitude.toFixed(3)}, ${n.position.longitude.toFixed(3)}`,
      ],
      [
        'Source',
        m.demo
          ? 'demo (simulated)'
          : "GDELT Project GEO 2.0, last 24 h (articles keep their publishers' terms)",
      ],
    ],
    links: m.articles.map((a) => ({ label: `${a.title} (${a.domain})`, url: a.url })),
  };
}

export const gdeltSearchText = (n) =>
  `${n.meta.headline} ${n.meta.place} ${n.meta.themeLabel} news`;

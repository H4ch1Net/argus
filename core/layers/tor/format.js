// Tor relay cards, styling and search text. Pure: shared with the terminal.
// Relays are public network infrastructure (assets), described from their
// published descriptors only.

import { INK } from '../../ui/palette.js';

export const TOR_ROLES = Object.freeze({
  exit: { label: 'Exit relay', glyph: 'exit', ink: 'white', px: 12 },
  guard: { label: 'Guard relay', glyph: 'guard', ink: 'teal', px: 11 },
  middle: { label: 'Middle relay', glyph: 'dot', ink: 'muted', px: 7 },
});

export const torRole = (n) => TOR_ROLES[n.meta.role] ?? TOR_ROLES.middle;
export const torColorHex = (n) => INK[torRole(n).ink];

/** Bytes per second -> "12.3 MB/s". */
export function formatBandwidth(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return null;
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let v = bps;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function describeTor(n) {
  const m = n.meta;
  const role = torRole(n);
  return {
    id: n.id,
    title: m.nickname,
    subtitle: role.label,
    rows: [
      ['Role', role.label],
      ['Flags', m.flags.join(' ') || '—'],
      ['Bandwidth', formatBandwidth(m.bandwidth) || '—'],
      ['Network', [m.as, m.asName].filter(Boolean).join(' ') || '—'],
      ['Country', m.countryName || m.country.toUpperCase() || '—'],
      [
        'Placement',
        m.placed === 'country'
          ? 'near the country centroid (Onionoo locates relays to a country)'
          : 'Onionoo coordinates',
      ],
      ['Fingerprint', m.fingerprint],
      ['Source', m.demo ? 'demo (simulated)' : 'Tor Metrics Onionoo (public relay list)'],
    ],
    links: m.demo
      ? []
      : [
          {
            label: 'Tor Metrics relay search',
            url: `https://metrics.torproject.org/rs.html#details/${m.fingerprint}`,
          },
        ],
  };
}

export const torSearchText = (n) =>
  `${n.meta.nickname} ${n.meta.fingerprint} ${n.meta.as} ${n.meta.asName} ${n.meta.role} tor relay`;

/** Status hint: relays Onionoo did not place in a mapped country. */
export const torNote = (list) =>
  list?.unplaced ? `${list.unplaced} without a mapped country` : '';

// Launch-pad styling + card. Pure.

import { primaryLaunch } from './parse.js';

const HOUR = 3600_000;

export function relativeTime(ms, now = Date.now()) {
  if (ms == null) return 'date TBD';
  const d = ms - now;
  const a = Math.abs(d);
  const span =
    a < HOUR
      ? `${Math.round(a / 60_000)} min`
      : a < 48 * HOUR
        ? `${Math.round(a / HOUR)} h`
        : `${Math.round(a / (24 * HOUR))} d`;
  return d >= 0 ? `in ${span}` : `${span} ago`;
}

const utc = (ms) =>
  ms == null ? 'TBD' : `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

/** Colour by what the pad is about to do / just did. */
export function launchColorHex(launch, now = Date.now()) {
  if (!launch) return '#90a4ae';
  if (/fail/i.test(launch.abbrev || launch.status || '')) return '#ef5350';
  if (launch.net != null && launch.net >= now) {
    return launch.net - now < 24 * HOUR ? '#ffd54f' : '#69f0ae';
  }
  return '#4fc3f7';
}

export function describeLaunchPad(n, now = Date.now()) {
  const m = n.meta;
  const p = primaryLaunch(m.launches, now);
  const rows = p
    ? [
        ['Status', p.status || '—'],
        ['NET', `${utc(p.net)} (${relativeTime(p.net, now)})`],
        ['Provider', p.provider || '—'],
        ['Rocket', p.rocket || '—'],
        ['Mission', p.mission || '—'],
        ['Orbit', p.orbit || '—'],
      ]
    : [];
  rows.push([
    'Source',
    m.demo ? 'demo (simulated)' : 'Launch Library 2 (The Space Devs)',
  ]);
  const others = m.launches.filter((l) => l !== p);
  return {
    id: n.id,
    title: p?.name || m.pad,
    subtitle: [m.pad, m.location].filter(Boolean).join(' · '),
    rows,
    sections: others.length
      ? [
          {
            title: 'Also from this pad',
            rows: others.slice(0, 6).map((l) => [relativeTime(l.net, now), l.name]),
          },
        ]
      : [],
  };
}

export const launchSearchText = (n) =>
  `${n.meta.pad} ${n.meta.location || ''} ${n.meta.launches.map((l) => `${l.name} ${l.provider || ''}`).join(' ')}`;

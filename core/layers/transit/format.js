// Transit vehicle styling + card. Pure (hex colours, plain text).

// Distinct, readable colours on a dark globe; a route keeps its colour.
const PALETTE = [
  '#4fc3f7',
  '#81c784',
  '#ffb74d',
  '#e57373',
  '#ba68c8',
  '#4db6ac',
  '#f06292',
  '#dce775',
];

export function transitColorHex(routeId) {
  const s = String(routeId ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function ago(seconds, now) {
  if (!seconds) return '—';
  const d = Math.max(0, Math.round(now / 1000 - seconds));
  return d < 90 ? `${d} s ago` : `${Math.round(d / 60)} min ago`;
}

export function describeTransit(n, now = Date.now()) {
  const m = n.meta;
  const rows = [
    ['Route', m.routeId || '—'],
    ['Vehicle', m.label || m.vehicleId || '—'],
    ['Status', m.status || '—'],
    ['Speed', m.speed != null ? `${Math.round(m.speed * 3.6)} km/h` : '—'],
    ['Heading', m.bearing != null ? `${Math.round(m.bearing)}°` : '—'],
    ['Reported', ago(m.timestamp, now)],
  ];
  if (m.tripId) rows.push(['Trip', m.tripId]);
  if (m.directionId != null) rows.push(['Direction', String(m.directionId)]);
  rows.push(['Source', m.demo ? 'demo (simulated)' : `${m.agency} GTFS-RT`]);
  if (m.license) rows.push(['License', m.license]);
  return {
    id: n.id,
    title: m.routeId ? `Route ${m.routeId}` : m.label || 'Vehicle',
    subtitle: `${m.agency} · ${m.region}`,
    rows,
  };
}

export const transitSearchText = (n) =>
  `${n.meta.routeId ? `Route ${n.meta.routeId}` : ''} ${n.meta.label || ''} ${n.meta.agency} ${n.meta.region}`;

// Border wait entities and their card. Pure (shared with the terminal shell).

const BORDER = { mx: 'US-Mexico border', ca: 'US-Canada border' };

/** The longest current passenger wait into the US at a port (minutes), or null. */
export function maxPassengerDelay(port) {
  let max = null;
  for (const r of port.cbp ?? [])
    for (const l of r.lanes ?? [])
      if (l.kind === 'passenger_vehicle_lanes' && Number.isFinite(l.delay))
        max = Math.max(max ?? 0, l.delay);
  return max;
}

const allClosed = (port) =>
  (port.cbp ?? []).length > 0 &&
  port.cbp.every((r) => /closed/i.test(r.status ?? '') || r.lanes.every((l) => l.closed));

/** Source result -> normalized entities (type 'borderwait'). */
export function parseBorderWaits(result) {
  return (result?.ports ?? []).map((p) => ({
    id: `bw:${p.id}`,
    type: 'borderwait',
    position: { longitude: p.lon, latitude: p.lat, altitude: 0 },
    meta: {
      name: p.name,
      border: p.border,
      state: p.state,
      confidence: p.confidence,
      cbp: p.cbp ?? [],
      cbsa: p.cbsa ?? null,
      cameras: p.cameras ?? null,
      maxDelay: maxPassengerDelay(p),
      closed: allClosed(p),
      demo: Boolean(p.demo),
    },
  }));
}

export function borderWaitNote(result) {
  if (!result) return '';
  const parts = [];
  if (result.failed) parts.push(`${result.failed} feed(s) failed`);
  if (result.unplaced) parts.push(`${result.unplaced} crossing(s) not on the map`);
  return parts.join(' · ');
}

/** "45 min (12 lanes open)", "no delay", "lanes closed", "update pending". */
export function laneText(l) {
  if (!l) return '';
  if (l.closed) return 'lanes closed';
  if (l.pending && l.delay === null) return 'update pending';
  const wait =
    l.delay === null ? 'no figure' : l.delay === 0 ? 'no delay' : `${l.delay} min`;
  const open = l.open === null ? '' : ` (${l.open} lane${l.open === 1 ? '' : 's'} open)`;
  return `${wait}${open}`;
}

const cbsaText = (d) =>
  !d
    ? null
    : d.closed
      ? 'closed'
      : d.delay === 0
        ? 'no delay'
        : d.delay !== null
          ? `${d.delay} min`
          : d.text;

export function describeBorderWait(n) {
  const m = n.meta;
  const rows = [];
  for (const r of m.cbp) {
    const where = r.crossing ? `${r.port}, ${r.crossing}` : r.port;
    if (m.cbp.length > 1) rows.push(['Crossing', where]);
    if (r.status && !/^open$/i.test(r.status)) rows.push(['Port status', r.status]);
    for (const l of r.lanes) rows.push([`Into US: ${l.label}`, laneText(l)]);
    if (!r.lanes.length) rows.push(['Into US', 'no lane figures published']);
    if (r.hours) rows.push(['Hours', r.hours]);
    if (r.updated) rows.push(['CBP updated', r.updated]);
    if (r.notice) rows.push(['Notice', r.notice]);
  }
  if (m.cbsa) {
    const t = cbsaText(m.cbsa.travellers);
    const c = cbsaText(m.cbsa.commercial);
    if (t) rows.push(['Into Canada: Travellers', t]);
    if (c) rows.push(['Into Canada: Commercial', c]);
    if (m.cbsa.updated) rows.push(['CBSA updated', m.cbsa.updated]);
  }
  const links = [];
  if (m.cameras?.length) {
    for (const c of m.cameras) {
      rows.push(['Nearby camera', `${c.name} (${c.provider}, ${c.distanceKm} km)`]);
      if (c.imageUrl) links.push({ label: `Camera still: ${c.name}`, url: c.imageUrl });
    }
  } else if (m.cameras) {
    rows.push(['Nearby camera', 'none published within 20 km']);
  } else {
    rows.push(['Nearby camera', 'zoom in to link the nearest traffic cameras']);
  }
  rows.push(
    [
      'Coordinates',
      `${n.position.latitude.toFixed(4)}, ${n.position.longitude.toFixed(4)} (bundled, ${m.confidence === 'high' ? 'within a few hundred metres' : 'within about a kilometre'})`,
    ],
    [
      'Source',
      m.demo
        ? 'demo (simulated)'
        : [
            m.cbp.length ? 'CBP Border Wait Times' : null,
            m.cbsa ? 'CBSA Border Wait Times' : null,
          ]
            .filter(Boolean)
            .join(' + '),
    ],
  );
  if (m.border === 'mx' || m.cbp.length)
    links.push({ label: 'CBP Border Wait Times', url: 'https://bwt.cbp.gov/' });
  if (m.cbsa)
    links.push({
      label: 'CBSA Border Wait Times',
      url: 'https://www.cbsa-asfc.gc.ca/bwt-taf/menu-eng.html',
    });
  const delay = m.maxDelay;
  return {
    id: n.id,
    title: m.name,
    subtitle: `${BORDER[m.border] ?? 'Border crossing'} · ${m.state}${m.closed ? ' · closed' : delay !== null ? ` · ${delay === 0 ? 'no delay' : `${delay} min`}` : ''}`,
    rows,
    credit: m.demo
      ? null
      : [
          m.cbp.length ? 'U.S. Customs and Border Protection' : null,
          m.cbsa
            ? 'Contains information licensed under the Open Government Licence - Canada (CBSA)'
            : null,
        ]
          .filter(Boolean)
          .join('; '),
    links,
  };
}

export const borderWaitSearchText = (n) =>
  `${n.meta.name} ${n.meta.state} ${n.meta.cbp.map((r) => `${r.port} ${r.crossing}`).join(' ')} ${n.meta.cbsa?.office ?? ''} border crossing port of entry wait`;

/** Terminal colour: gray when closed, brighter as the passenger wait grows. */
export function borderWaitColorHex(meta) {
  if (meta.closed) return '#7a7a7a';
  const d = meta.maxDelay;
  if (d === null) return '#c3c3c3';
  if (d >= 90) return '#ffffff';
  if (d >= 30) return '#deeeed';
  return '#66b2b2';
}

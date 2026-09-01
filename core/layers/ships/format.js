// Ship card model. Pure. AIS speed (SOG) is already in knots, course (COG) and
// heading in degrees; TrueHeading 511 means "not available".

export function describeShip(n) {
  const m = n.meta;
  const heading =
    m.heading != null && m.heading !== 511 ? `${Math.round(m.heading)}°` : '—';
  return {
    id: n.id,
    title: m.name || `MMSI ${m.mmsi}`,
    subtitle: m.name ? `MMSI ${m.mmsi}` : 'vessel',
    rows: [
      ['Speed', m.sog != null ? `${m.sog.toFixed(1)} kn` : '—'],
      ['Course', m.cog != null ? `${Math.round(m.cog)}°` : '—'],
      ['Heading', heading],
      [
        'Coordinates',
        `${n.position.latitude.toFixed(2)}, ${n.position.longitude.toFixed(2)}`,
      ],
    ],
  };
}

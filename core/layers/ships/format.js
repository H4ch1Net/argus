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

/** Heading for the ship glyph: true heading when reported, else course over ground. */
export function shipHeading(n) {
  const h = n.meta.heading;
  return h != null && h !== 511 ? h : (n.meta.cog ?? 0);
}

/** A proxy AIS report { mmsi, name, lat, lon, cog, sog, heading } -> normalized entity. */
export function shipToNormalized(ship) {
  return {
    id: String(ship.mmsi),
    type: 'ship',
    position: { longitude: ship.lon, latitude: ship.lat, altitude: 0 },
    velocity: { speed: ship.sog, heading: ship.heading, course: ship.cog },
    meta: ship,
  };
}

export const shipSearchText = (n) => `${n.meta.name || ''} ${n.meta.mmsi}`;

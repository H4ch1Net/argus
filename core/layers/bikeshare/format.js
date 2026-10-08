// Bikeshare station entities + card. Pure.

export function parseBikeshare(result) {
  return (result?.stations ?? []).map((s) => ({
    id: `bike:${s.system.id}:${s.id}`,
    type: 'bikeshare',
    position: { longitude: s.lon, latitude: s.lat, altitude: 0 },
    meta: {
      name: s.name,
      city: s.system.city,
      provider: s.system.provider,
      capacity: s.capacity,
      bikes: s.bikes,
      docks: s.docks,
      renting: s.renting,
      returning: s.returning,
      lastReported: s.lastReported,
      demo: Boolean(s.demo),
    },
  }));
}

export function bikeshareNote(result) {
  if (!result) return '';
  if (result.tooWide) return 'zoom to a covered city';
  if (!result.inView) return 'no covered system in view';
  return result.failed ? `${result.failed} system(s) failed` : '';
}

/** Red when empty or not renting, amber when low, green otherwise. */
export function bikeColorHex(m) {
  if (m.renting === false || !m.bikes) return '#ef5350';
  if (m.bikes <= 2) return '#ffb74d';
  return '#66bb6a';
}

export function describeBikeStation(n, now = Date.now()) {
  const m = n.meta;
  const age =
    m.lastReported != null ? Math.max(0, Math.round(now / 1000 - m.lastReported)) : null;
  return {
    id: n.id,
    title: m.name,
    subtitle: `${m.provider} · ${m.city}`,
    rows: [
      ['Bikes', m.bikes != null ? String(m.bikes) : '—'],
      ['Free docks', m.docks != null ? String(m.docks) : '—'],
      ['Capacity', m.capacity != null ? String(m.capacity) : '—'],
      ['Renting', m.renting == null ? '—' : m.renting ? 'yes' : 'no'],
      [
        'Reported',
        age == null
          ? '—'
          : age < 120
            ? `${age} s ago`
            : `${Math.round(age / 60)} min ago`,
      ],
      ['Source', m.demo ? 'demo (simulated)' : `${m.provider} GBFS`],
    ],
  };
}

export const bikeshareSearchText = (n) => `${n.meta.name} ${n.meta.city} bike`;

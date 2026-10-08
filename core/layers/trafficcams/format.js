// Traffic camera entities + card. Pure.

/** Source result -> normalized entities (type 'trafficcam'). */
export function parseTrafficCams(result) {
  return (result?.cameras ?? []).map((c) => ({
    id: `cam:${c.id}`,
    type: 'trafficcam',
    position: { longitude: c.lon, latitude: c.lat, altitude: 0 },
    meta: {
      name: c.name,
      provider: c.provider,
      region: c.region,
      license: c.license,
      direction: c.direction ?? null,
      imageUrl: c.imageUrl ?? null,
      demo: Boolean(c.demo),
    },
  }));
}

export function trafficCamNote(result) {
  if (!result) return '';
  if (result.tooWide) return 'zoom to a covered region';
  if (!result.inView) return 'no camera network in view';
  return result.failed ? `${result.failed} catalogue(s) failed` : '';
}

export function describeTrafficCam(n) {
  const m = n.meta;
  return {
    id: n.id,
    title: m.name,
    subtitle: `${m.provider} · ${m.region}`,
    rows: [
      ['Facing', m.direction || '—'],
      [
        'Coordinates',
        `${n.position.latitude.toFixed(4)}, ${n.position.longitude.toFixed(4)}`,
      ],
      ['Source', m.demo ? 'demo (simulated)' : m.license],
      ['Note', 'Published still only; nothing here analyses it'],
    ],
    // The still loads only when this card opens, through the proxy.
    image: m.imageUrl ? { url: m.imageUrl, alt: `Latest still: ${m.name}` } : null,
    links: m.imageUrl ? [{ label: 'Open the latest still', url: m.imageUrl }] : [],
  };
}

export const trafficCamSearchText = (n) =>
  `${n.meta.name} ${n.meta.provider} ${n.meta.region} camera`;

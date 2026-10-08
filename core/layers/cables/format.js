// Submarine cable cards. Pure.

const SOURCE = 'TeleGeography, submarinecablemap.com (CC BY-NC-SA 3.0)';

export function describeCable(n) {
  const m = n.meta;
  return {
    id: n.id,
    title: m.name,
    subtitle: 'Submarine cable',
    rows: [
      ['Cable id', m.cableId],
      ['Source', m.demo ? 'demo (simulated)' : SOURCE],
    ],
    links: m.demo
      ? []
      : [
          {
            label: 'Cable on submarinecablemap.com',
            url: `https://www.submarinecablemap.com/submarine-cable/${encodeURIComponent(m.cableId)}`,
          },
        ],
  };
}

export function describeLanding(n) {
  const m = n.meta;
  return {
    id: n.id,
    title: m.name,
    subtitle: m.tbd ? 'Cable landing point (planned)' : 'Cable landing point',
    rows: [
      [
        'Coordinates',
        `${n.position.latitude.toFixed(3)}, ${n.position.longitude.toFixed(3)}`,
      ],
      ['Source', SOURCE],
    ],
  };
}

export const cableSearchText = (n) => `${n.meta.name} ${n.meta.cableId || ''} cable`;

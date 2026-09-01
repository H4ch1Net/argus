// Surveillance-infrastructure styling + card. LOCATIONS ONLY (project guardrail):
// this maps WHERE cameras and ALPR/Flock readers are, from OSM's
// `man_made=surveillance` data. It never reads what any camera sees.

export function surveillanceKind(tags) {
  const t = String(tags['surveillance:type'] || '').toLowerCase();
  if (t.includes('alpr') || t.includes('anpr')) return 'ALPR';
  if (t === 'camera' || t === '') return 'camera';
  return t;
}

export function surveillanceColorHex(kind) {
  return kind === 'ALPR' ? '#ff4d4d' : '#ffb454';
}

export function surveillancePixelSize(kind) {
  return kind === 'ALPR' ? 9 : 7;
}

export function describeSurveillance(n) {
  const tags = n.meta.tags;
  const kind = surveillanceKind(tags);
  return {
    id: n.id,
    title: kind === 'ALPR' ? 'ALPR / plate reader' : 'Surveillance camera',
    subtitle: tags.operator || '',
    rows: [
      ['Type', tags['surveillance:type'] || 'camera'],
      ['Operator', tags.operator || '—'],
      ['Mount', tags.surveillance || tags['camera:mount'] || '—'],
      ['Direction', tags.direction || '—'],
      [
        'Coordinates',
        `${n.position.latitude.toFixed(4)}, ${n.position.longitude.toFixed(4)}`,
      ],
    ],
  };
}

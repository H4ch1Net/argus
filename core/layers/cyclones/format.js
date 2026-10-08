// Cyclone styling + card. Pure.

const CLASS_NAMES = {
  TD: 'Tropical Depression',
  TS: 'Tropical Storm',
  HU: 'Hurricane',
  MH: 'Major Hurricane',
  STD: 'Subtropical Depression',
  STS: 'Subtropical Storm',
  PTC: 'Potential Tropical Cyclone',
  PC: 'Post-tropical Cyclone',
  TY: 'Typhoon',
};

/** Saffir-Simpson category from sustained wind (kt), or null below hurricane force. */
export function saffirSimpson(windKt) {
  if (windKt == null || windKt < 64) return null;
  if (windKt < 83) return 1;
  if (windKt < 96) return 2;
  if (windKt < 113) return 3;
  if (windKt < 137) return 4;
  return 5;
}

export function cycloneColorHex(windKt) {
  const cat = saffirSimpson(windKt);
  if (cat == null) return windKt != null && windKt >= 34 ? '#ffd54f' : '#81d4fa';
  return ['#ffb74d', '#ff8a65', '#f4511e', '#d81b60', '#8e24aa'][cat - 1];
}

export function cyclonePixelSize(windKt) {
  return Math.min(34, 12 + Math.max(0, (windKt ?? 0) - 30) / 5);
}

export function describeCyclone(n) {
  const m = n.meta;
  const cat = saffirSimpson(m.windKt);
  const kind = CLASS_NAMES[m.classification] || m.classification || 'Cyclone';
  const rows = [
    ['Class', cat ? `${kind}, category ${cat}` : kind],
    [
      'Wind',
      m.windKt != null ? `${m.windKt} kt (${Math.round(m.windKt * 1.852)} km/h)` : '—',
    ],
    ['Pressure', m.pressureHpa != null ? `${m.pressureHpa} hPa` : '—'],
    [
      'Moving',
      m.movementDir != null && m.movementKt != null
        ? `${Math.round(m.movementDir)}° at ${m.movementKt} kt`
        : '—',
    ],
    ['Basin', m.basin || '—'],
    ['Advisory', m.advisoryNumber ? `#${m.advisoryNumber}` : '—'],
    ['Updated', m.lastUpdate || '—'],
    ['Source', m.demo ? 'demo (simulated)' : 'NOAA National Hurricane Center'],
  ];
  return {
    id: n.id,
    title: m.name,
    subtitle: m.stormId.toUpperCase(),
    rows,
    links: m.advisoryUrl ? [{ label: 'NHC forecast advisory', url: m.advisoryUrl }] : [],
  };
}

export const cycloneSearchText = (n) =>
  `${n.meta.name} ${n.meta.stormId} ${n.meta.classification || ''} hurricane storm`;

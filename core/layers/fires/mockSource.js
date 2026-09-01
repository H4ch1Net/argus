// Dev-only mock fires source: FIRMS-shaped CSV so the layer is demonstrable
// without a MAP_KEY or a running proxy. Dev-gated + dynamic-imported.

const HEADER =
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight';

const FIRES = [
  [37.5, -119.6, 3.2, 'D'],
  [34.1, -118.2, 45.0, 'D'],
  [-3.4, 119.9, 92.5, 'N'],
  [-9.1, -55.2, 130.0, 'D'],
  [-33.9, 150.9, 18.0, 'N'],
  [61.2, 105.3, 60.0, 'D'],
  [43.7, 1.4, 4.5, 'D'],
  [-1.3, 36.8, 22.0, 'N'],
];

export function createFireMockSource() {
  return async () => {
    const date = new Date().toISOString().slice(0, 10);
    const rows = FIRES.map(([lat, lon, frp, dn]) =>
      [
        lat,
        lon,
        335,
        0.4,
        0.4,
        date,
        '1200',
        'N',
        'VIIRS',
        'n',
        '2.0NRT',
        298,
        frp,
        dn,
      ].join(','),
    );
    return [HEADER, ...rows].join('\n');
  };
}

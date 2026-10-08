// Dev / demo-only radio stations: a Radio Browser-shaped list of simulated
// stations (no real streams), so the layer works offline.

const CITIES = [
  ['Demo City FM', 40.71, -74.0, 'news,talk'],
  ['Demo Jazz', 51.5, -0.12, 'jazz'],
  ['Demo Scanner', 41.88, -87.63, 'scanner,emergency'],
  ['Demo Pop', 35.68, 139.69, 'pop'],
  ['Demo Classical', 48.86, 2.35, 'classical'],
  ['Demo Aviation', -33.87, 151.21, 'aviation'],
];

export function createRadioMockSource() {
  return async () =>
    CITIES.map(([name, lat, lon, tags], i) => ({
      stationuuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      name: `${name} (simulated)`,
      url_resolved: 'https://example.invalid/demo-stream',
      tags,
      country: 'Demo',
      codec: 'MP3',
      bitrate: 128,
      clickcount: 100 * (i + 1),
      lastcheckok: 1,
      geo_lat: lat,
      geo_long: lon,
    }));
}

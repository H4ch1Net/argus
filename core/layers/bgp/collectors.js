// RIPE RIS route-collector locations (rrc00..rrc26). Real, stable reference geo
// sourced from RIPEstat's rrc-info: each collector observes BGP updates from a
// known city, so we can plot live routing activity at the collector without any
// per-message geolocation. Coordinates are the collector city centroids.

export const RIS_COLLECTORS = {
  rrc00: { city: 'Amsterdam, NL', longitude: 4.9, latitude: 52.37 },
  rrc01: { city: 'London, UK', longitude: -0.13, latitude: 51.51 },
  rrc03: { city: 'Amsterdam, NL', longitude: 4.9, latitude: 52.37 },
  rrc04: { city: 'Geneva, CH', longitude: 6.14, latitude: 46.2 },
  rrc05: { city: 'Vienna, AT', longitude: 16.37, latitude: 48.21 },
  rrc06: { city: 'Tokyo, JP', longitude: 139.69, latitude: 35.69 },
  rrc07: { city: 'Stockholm, SE', longitude: 18.07, latitude: 59.33 },
  rrc10: { city: 'Milan, IT', longitude: 9.19, latitude: 45.46 },
  rrc11: { city: 'New York, US', longitude: -74.01, latitude: 40.71 },
  rrc12: { city: 'Frankfurt, DE', longitude: 8.68, latitude: 50.11 },
  rrc13: { city: 'Moscow, RU', longitude: 37.62, latitude: 55.75 },
  rrc14: { city: 'Palo Alto, US', longitude: -122.14, latitude: 37.44 },
  rrc15: { city: 'Sao Paulo, BR', longitude: -46.63, latitude: -23.55 },
  rrc16: { city: 'Miami, US', longitude: -80.19, latitude: 25.76 },
  rrc18: { city: 'Barcelona, ES', longitude: 2.17, latitude: 41.39 },
  rrc19: { city: 'Johannesburg, ZA', longitude: 28.05, latitude: -26.2 },
  rrc20: { city: 'Zurich, CH', longitude: 8.54, latitude: 47.37 },
  rrc21: { city: 'Paris, FR', longitude: 2.35, latitude: 48.86 },
  rrc22: { city: 'Bucharest, RO', longitude: 26.1, latitude: 44.43 },
  rrc23: { city: 'Singapore, SG', longitude: 103.82, latitude: 1.35 },
  rrc24: { city: 'Montevideo, UY', longitude: -56.16, latitude: -34.9 },
  rrc25: { city: 'Amsterdam, NL', longitude: 4.9, latitude: 52.37 },
  rrc26: { city: 'Dubai, AE', longitude: 55.27, latitude: 25.2 },
};

/** Look up a collector by a RIS host string (e.g. "rrc21" or "rrc21.ripe.net"). */
export function collectorFor(host) {
  const m = String(host || '').match(/rrc\d+/i);
  return m ? (RIS_COLLECTORS[m[0].toLowerCase()] ?? null) : null;
}

// DEV-only stand-in for the Nominatim geocoder so place fly-to is demoable
// without the proxy. A tiny static gazetteer, substring-matched. Never shipped:
// main.js imports this only under import.meta.env.DEV.

const PLACES = [
  { name: 'Paris, France', longitude: 2.3522, latitude: 48.8566 },
  { name: 'London, United Kingdom', longitude: -0.1276, latitude: 51.5074 },
  { name: 'New York, United States', longitude: -74.006, latitude: 40.7128 },
  { name: 'Tokyo, Japan', longitude: 139.6917, latitude: 35.6895 },
  { name: 'Sydney, Australia', longitude: 151.2093, latitude: -33.8688 },
  { name: 'Cairo, Egypt', longitude: 31.2357, latitude: 30.0444 },
  { name: 'Rio de Janeiro, Brazil', longitude: -43.1729, latitude: -22.9068 },
  { name: 'Reykjavik, Iceland', longitude: -21.8174, latitude: 64.1265 },
];

export function createMockGeocoder() {
  return async (query) => {
    const q = String(query).trim().toLowerCase();
    if (!q) return [];
    return PLACES.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 5);
  };
}

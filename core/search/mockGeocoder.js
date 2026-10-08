// DEV / demo stand-in for the network geocoder so place fly-to works with no
// proxy: the bundled offline places only (core/search/places.js), exact names
// and prefixes. main.js imports this only under import.meta.env.DEV; the
// terminal shell uses it for --demo.

import { searchPlaces } from './places.js';

export function createMockGeocoder() {
  return async (query) => searchPlaces(query, { limit: 5 });
}

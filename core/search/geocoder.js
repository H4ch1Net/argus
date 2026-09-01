// Place geocoding for global search fly-to, via OSM Nominatim through the proxy.
// parseNominatim is pure and tested; createGeocoder wires it to the proxy client.

export function parseNominatim(json) {
  const arr = Array.isArray(json) ? json : [];
  return arr
    .map((p) => ({
      name: p.display_name,
      longitude: Number(p.lon),
      latitude: Number(p.lat),
    }))
    .filter((p) => p.name && Number.isFinite(p.longitude) && Number.isFinite(p.latitude));
}

export function createGeocoder(proxyClient) {
  return async (query, signal) => {
    const json = await proxyClient.getJson('nominatim', '/search', {
      params: { q: query, format: 'json', limit: 5 },
      signal,
    });
    return parseNominatim(json);
  };
}

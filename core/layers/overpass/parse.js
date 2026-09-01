// Parse an Overpass API JSON response into normalized entities. Pure: no Cesium.
//
// Overpass returns { elements: [...] }. Nodes carry lat/lon directly; ways and
// relations carry a `center` (from `out center;`). We keep the tags for styling
// and the card, and synthesize a stable id from the OSM type + id.

export function parseOverpass(json) {
  const elements = Array.isArray(json?.elements) ? json.elements : [];
  const out = [];
  for (const e of elements) {
    const lat = typeof e.lat === 'number' ? e.lat : e.center?.lat;
    const lon = typeof e.lon === 'number' ? e.lon : e.center?.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    out.push({
      id: `${e.type}/${e.id}`,
      type: 'osm',
      position: { longitude: lon, latitude: lat, altitude: 0 },
      meta: { tags: e.tags || {}, osmType: e.type, osmId: e.id },
    });
  }
  return out;
}

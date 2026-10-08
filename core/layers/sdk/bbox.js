// Bounding-box helpers shared by the multi-feed sources (transit, bikeshare,
// traffic cameras), whose feeds cover a whole city or country while the view
// may be one district. Pure.

/** The bbox grown by `fraction` of its span on each side (at least minDeg). */
export function padBBox(bbox, fraction = 0.25, minDeg = 0.05) {
  const dLat = Math.max(minDeg, (bbox.lamax - bbox.lamin) * fraction);
  const dLon = Math.max(minDeg, (bbox.lomax - bbox.lomin) * fraction);
  return {
    lamin: bbox.lamin - dLat,
    lamax: bbox.lamax + dLat,
    lomin: bbox.lomin - dLon,
    lomax: bbox.lomax + dLon,
  };
}

/** A predicate for "this lat/lon is inside the (padded) view". */
export function insideView(bbox, fraction = 0.25) {
  if (!bbox) return () => true;
  const b = padBBox(bbox, fraction);
  return (lat, lon) =>
    lat >= b.lamin && lat <= b.lamax && lon >= b.lomin && lon <= b.lomax;
}

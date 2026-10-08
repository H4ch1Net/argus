// The Stadt Warendorf Marktplatz webcam (Germany), a curated catalogue of one.
// Copied from gods-eye-view config/cctv_sources.warendorf.json (MIT, commit
// 95fa816). Credit: webcam courtesy of Stadt Warendorf (webcam.warendorf.de);
// the mount and heading were derived from OpenStreetMap geometry,
// (c) OpenStreetMap contributors (ODbL).
//
// The still is served over plain http by the city; the browser only ever sees
// it through the proxy's HTTPS origin (feed warendorf-img).

export const WARENDORF_CAMERAS = [
  {
    id: 'warendorf-marktplatz-rathaus',
    name: 'Marktplatz / Historisches Rathaus',
    lat: 51.9526613,
    lon: 7.9908867,
    path: '/jpeg.cgi',
    headingDeg: 221,
    headingConfidence: 'high',
    // Measured pose (the reference stores pitch negated: -23).
    pitch: 23,
    fovDeg: 84,
    rangeM: 260,
    heightM: 14,
    groundM: 55,
  },
];

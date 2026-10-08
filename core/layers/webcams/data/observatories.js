// A deliberately tiny, curated catalogue of observatory cameras whose latest
// still is published at a stable URL. Only stills whose URLs are well
// established are listed; each host has its own image-only proxy feed
// (proxy/feeds/webcams.js: sdo-img, soho-img). Per the providers'
// documentation, not live-tested here.
//
// Ground-based all-sky cameras are not listed: none of their still URLs could
// be confirmed while this was written (no network). Windy's "observatory"
// category covers the ones that are on that network.
//
// These are space observatories, so a map position is a choice: each is placed
// at NASA Goddard Space Flight Center (Greenbelt, Maryland), where SDO and the
// SOHO Experimenters' Operations Facility are run, a few hundred metres apart
// so their markers do not stack. The card says so.

const GODDARD =
  'NASA Goddard Space Flight Center, Greenbelt, Maryland (where the mission is operated)';
const SDO = {
  provider: 'NASA Solar Dynamics Observatory',
  pageUrl: 'https://sdo.gsfc.nasa.gov/data/',
  license: 'NASA imagery (public domain)',
  licenseUrl: 'https://sdo.gsfc.nasa.gov/data/',
  credit: 'Courtesy of NASA/SDO and the AIA, EVE, and HMI science teams',
};
const SOHO = {
  provider: 'SOHO (ESA & NASA)',
  pageUrl: 'https://soho.nascom.nasa.gov/data/realtime-images.html',
  license: 'Free use with credit: SOHO (ESA & NASA)',
  licenseUrl: 'https://soho.nascom.nasa.gov/data/realtime-images.html',
  credit: 'SOHO (ESA & NASA)',
};

export const OBSERVATORY_CAMERAS = Object.freeze([
  {
    id: 'sdo-aia-193',
    name: 'The Sun now: SDO AIA 193 (corona)',
    lat: 38.9935,
    lon: -76.8535,
    place: GODDARD,
    feedId: 'sdo-img',
    path: '/assets/img/latest/latest_1024_0193.jpg',
    note: 'Latest image from the Atmospheric Imaging Assembly, 19.3 nm.',
    ...SDO,
  },
  {
    id: 'sdo-hmi-ic',
    name: 'The Sun now: SDO HMI (visible surface)',
    lat: 38.9935,
    lon: -76.8495,
    place: GODDARD,
    feedId: 'sdo-img',
    path: '/assets/img/latest/latest_1024_HMIIC.jpg',
    note: 'Latest continuum intensity image from the Helioseismic and Magnetic Imager.',
    ...SDO,
  },
  {
    id: 'soho-lasco-c3',
    name: 'Solar wind now: SOHO LASCO C3 coronagraph',
    lat: 38.9905,
    lon: -76.8515,
    place: GODDARD,
    feedId: 'soho-img',
    path: '/data/realtime/c3/1024/latest.jpg',
    note: 'Latest wide-field coronagraph image (the Sun is behind the occulting disc).',
    ...SOHO,
  },
]);

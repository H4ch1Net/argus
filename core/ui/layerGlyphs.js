import { glyph } from './glyphs.js';
import { aircraftGlyph } from './aircraftIcons.js';
import { inkFor } from './palette.js';

// The marker each layer draws, as a small tinted canvas for menu tiles and
// legends, so the menu shows exactly what the map shows.

const LAYER_GLYPH = {
  flights: ['aircraft', 'airliner'],
  military: ['aircraft', 'fastjet'],
  localadsb: ['aircraft', 'light'],
  satellites: 'sat',
  constellations: 'sat',
  launches: 'cross',
  transit: 'vehicle',
  bikeshare: 'square',
  ships: 'hull',
  quakes: 'pulse',
  fires: 'triangle',
  perimeters: 'triangle',
  cyclones: 'diamond',
  cyclonecones: 'diamond',
  cyclonetracks: 'dot',
  goes: 'frame',
  imagery: 'frame',
  clouds: 'frame',
  radar: 'frame',
  lightning: 'cross',
  surveillance: 'bracket',
  landmarks: 'frame',
  myplaces: 'diamond',
  cctv: 'bracket',
  trafficcams: 'bracket',
  trafficflow: 'vehicle',
  datacenters: 'frame',
  dams: 'square',
  cables: 'dot',
  installations: 'diamond',
  radio: 'cross',
  shodan: 'frame',
  threats: 'triangle',
  bgp: 'dot',
  wind: 'dot',
  incidents: 'xmark',
  chp: 'triangle',
  aurora: 'wave',
  airquality: 'cells',
  terminator: 'half',
  tor: 'exit',
  gdelt: 'news',
};

function source(key) {
  const g = LAYER_GLYPH[key] ?? 'node';
  return Array.isArray(g) ? aircraftGlyph(g[1]).image : glyph(g).image;
}

/** A canvas of a layer's marker tinted with its ink (or a given colour). */
export function layerTile(key, color = inkFor(key)) {
  const img = source(key);
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(img, 0, 0);
  return c;
}

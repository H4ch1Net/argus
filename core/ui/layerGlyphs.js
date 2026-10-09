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
  surveillance: 'alpr',
  landmarks: 'frame',
  myplaces: 'diamond',
  cctv: 'bracket',
  trafficcams: 'bracket',
  webcams: 'wc-mountain',
  borderwaits: 'gate',
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
  signals: 'signal',
  simtraffic: 'vehicle',
  streetphotos: 'photo',
};

function source(key) {
  const g = LAYER_GLYPH[key] ?? 'node';
  return Array.isArray(g) ? aircraftGlyph(g[1]).image : glyph(g).image;
}

/** A canvas of a layer's marker tinted with its ink (or a given colour). */
export function layerTile(key, color = inkFor(key)) {
  return tint(source(key), color);
}

/**
 * A canvas of any named map glyph (core/ui/glyphs.js) tinted with a colour,
 * for chips and legends inside a layer (webcam categories).
 */
export function glyphTile(name, color = inkFor(null)) {
  return tint(glyph(name).image, color);
}

function tint(img, color) {
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

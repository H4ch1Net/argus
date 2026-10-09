// The ctOS vector basemap: OpenMapTiles-schema vector tiles (OpenFreeMap)
// drawn on a 2D canvas in the ctOS palette, so the map stays sharp at any zoom
// (vector, drawn at the screen's pixel density) and reads like the rest of the
// interface: near-black ground, gray roads with hairline edges, building
// footprints, dark teal water, labels in white monospace on a dark keyline.
//
// Three kinds of tile, all from the same source tiles:
//   base    ground, landuse, water, buildings, roads (no text)
//   roads   street names, road numbers, house numbers, points of interest
//   places  place names (cities to neighbourhoods), water names, borders
// The two label kinds are transparent overlays (VIEW > LABELS), drawn over
// any basemap, so street names are never the yellow of a raster overlay.
//
// Source tiles stop at zoom 14; deeper tiles draw a part of their zoom-14
// ancestor scaled up (vector, so nothing blurs). Labels are placed once per
// source tile and zoom, in that tile's own pixel space, then each output tile
// draws the ones that touch it: a street name crossing two output tiles is
// drawn whole in both halves, so labels are never cut at tile seams (except at
// the zoom-14 source tile borders).
//
// Pure apart from the canvas context it is given: runs in the basemap worker
// (OffscreenCanvas) or on the main thread as a fallback, never imports Cesium.

export const SOURCE_MAX_ZOOM = 14;
export const TILE_CSS = 256; // the size Cesium is told; images are drawn denser

// Properties each layer needs (decodeTile's `want`): fewer kept, faster decode.
const NAME_KEYS = ['name', 'name:latin', 'name_en', 'name:en'];
export const WANT = {
  water: ['class'],
  waterway: ['class', 'brunnel'],
  landcover: ['class', 'subclass'],
  landuse: ['class'],
  park: ['class'],
  aeroway: ['class'],
  building: [],
  transportation: ['class', 'subclass', 'brunnel', 'ramp'],
  transportation_name: ['class', 'ref', 'network', ...NAME_KEYS],
  housenumber: ['housenumber'],
  poi: ['class', 'subclass', 'rank', ...NAME_KEYS],
  place: ['class', 'rank', 'capital', ...NAME_KEYS],
  water_name: ['class', ...NAME_KEYS],
  boundary: ['admin_level', 'maritime', 'disputed'],
};

// ---------------------------------------------------------------- palette
// Grays from the ctOS ground (#0e0e0e) up; water and parks take a breath of
// the Mono Glow teal. Nothing here is red or green: those are state colours.
export const MAP = Object.freeze({
  ground: '#121212',
  residential: '#141414',
  commercial: '#161616',
  industrial: '#151515',
  institution: '#151717',
  park: '#111917',
  green: '#121815',
  sand: '#171615',
  ice: '#1b1d1e',
  water: '#0a1417',
  waterLine: '#0f2025',
  aeroway: '#202020',
  building: '#1c1c1c',
  buildingEdge: '#2c2c2c',
  buildingEdgeNear: '#3a3a3a',
  border: '#4a4a4a',
  borderMinor: '#303030',
  text: '#d6d6d6',
  textMinor: '#a9a9a9',
  textFaint: '#6f6f6f',
  textWater: '#5f8c97',
  halo: '#0b0b0b',
});

// Roads: [real width in metres, minimum px, fill, edge] per class. Close up
// they draw at their real width with a lighter hairline edge (the ctOS
// schematic look); far out they are thin single lines.
const ROAD = {
  motorway: [22, 1.4, '#424242', '#9a9a9a'],
  trunk: [19, 1.3, '#3d3d3d', '#8c8c8c'],
  primary: [16, 1.2, '#383838', '#7c7c7c'],
  secondary: [13, 1.1, '#333333', '#6e6e6e'],
  tertiary: [11, 1, '#303030', '#646464'],
  minor: [9, 0.8, '#2c2c2c', '#5a5a5a'],
  service: [5, 0.6, '#262626', '#484848'],
  track: [3, 0.6, null, '#3a3a3a'],
  path: [2, 0.6, null, '#353535'],
  raceway: [10, 0.8, '#2b2b2b', '#555555'],
  busway: [9, 0.8, '#272727', '#4e4e4e'],
  rail: [3, 0.8, null, '#4a4a4a'],
  transit: [3, 0.7, null, '#3c3c3c'],
  ferry: [2, 0.7, null, '#1f3a42'],
  pier: [6, 0.7, '#1e1e1e', '#3a3a3a'],
};
// The zoom a class first appears at (OpenMapTiles carries more than we draw).
const ROAD_MINZOOM = {
  motorway: 4,
  trunk: 5,
  primary: 7,
  secondary: 9,
  tertiary: 10,
  minor: 12,
  service: 14,
  track: 14,
  path: 15,
  raceway: 13,
  busway: 13,
  rail: 10,
  transit: 13,
  ferry: 9,
  pier: 15,
};
const MAJOR = new Set(['motorway', 'trunk', 'primary']);

const LANDUSE = {
  residential: 'residential',
  suburb: 'residential',
  neighbourhood: 'residential',
  commercial: 'commercial',
  retail: 'commercial',
  industrial: 'industrial',
  railway: 'industrial',
  garages: 'industrial',
  school: 'institution',
  college: 'institution',
  university: 'institution',
  hospital: 'institution',
  military: 'institution',
  cemetery: 'green',
  stadium: 'institution',
  pitch: 'park',
  playground: 'park',
};
const LANDCOVER = {
  grass: 'green',
  wood: 'park',
  farmland: 'residential',
  wetland: 'park',
  sand: 'sand',
  ice: 'ice',
  rock: 'sand',
};

/** Font stack: JetBrains Mono when the system has it, any monospace otherwise. */
export const FONT = `"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, "Droid Sans Mono", monospace`;

// ---------------------------------------------------------------- geometry
const EARTH_M = 40075016.686;
/** Metres per CSS pixel at a zoom (256 px tiles) and latitude. */
export const metresPerPixel = (z, lat) =>
  (EARTH_M * Math.cos((lat * Math.PI) / 180)) / (TILE_CSS * 2 ** z);

/** Latitude of a tile row's middle at a zoom. */
export function tileLat(z, y) {
  const n = Math.PI - (2 * Math.PI * (y + 0.5)) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/**
 * Where an output tile reads from: its zoom-14 (or own) ancestor, and which
 * part of it. scale = 2^(z - sourceZ); ox / oy = the output tile's column and
 * row inside the source tile, in output tiles.
 */
export function sourceFor(z, x, y, maxZoom = SOURCE_MAX_ZOOM) {
  if (z <= maxZoom) return { z, x, y, scale: 1, ox: 0, oy: 0 };
  const d = z - maxZoom;
  const scale = 2 ** d;
  return {
    z: maxZoom,
    x: Math.floor(x / scale),
    y: Math.floor(y / scale),
    scale,
    ox: x - Math.floor(x / scale) * scale,
    oy: y - Math.floor(y / scale) * scale,
  };
}

/** Road width in device px at a zoom: the real width, never under a floor. */
export function roadWidth(cls, z, lat, pr = 1) {
  const r = ROAD[cls];
  if (!r) return 0;
  return Math.max(r[1], r[0] / metresPerPixel(z, lat)) * pr;
}

const partBoxes = new WeakMap();
function boxesOf(f) {
  let boxes = partBoxes.get(f);
  if (boxes) return boxes;
  boxes = f.parts.map((p) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < x0) x0 = p[i];
      if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1];
      if (p[i + 1] > y1) y1 = p[i + 1];
    }
    return [x0, y0, x1, y1];
  });
  partBoxes.set(f, boxes);
  return boxes;
}

/** The transform from source-tile units to the output canvas. */
function makeView(layerExtent, size, src) {
  const k = (size * src.scale) / layerExtent;
  return { k, tx: -src.ox * size, ty: -src.oy * size, size };
}

const visible = (v, b, pad) =>
  b[2] * v.k + v.tx >= -pad &&
  b[0] * v.k + v.tx <= v.size + pad &&
  b[3] * v.k + v.ty >= -pad &&
  b[1] * v.k + v.ty <= v.size + pad;

function tracePart(ctx, p, v) {
  ctx.moveTo(p[0] * v.k + v.tx, p[1] * v.k + v.ty);
  for (let i = 2; i < p.length; i += 2)
    ctx.lineTo(p[i] * v.k + v.tx, p[i + 1] * v.k + v.ty);
}

/** Fill every visible polygon of a feature list in one path. */
function fillFeatures(ctx, layer, v, color, pick = () => true) {
  if (!layer) return;
  ctx.beginPath();
  let any = false;
  for (const f of layer.features) {
    if (f.type !== 3 || !pick(f)) continue;
    if (!visible(v, f.bbox, 2)) continue;
    const boxes = f.parts.length > 8 ? boxesOf(f) : null;
    f.parts.forEach((p, i) => {
      if (boxes && !visible(v, boxes[i], 2)) return;
      tracePart(ctx, p, v);
      ctx.closePath();
      any = true;
    });
  }
  if (!any) return;
  ctx.fillStyle = color;
  ctx.fill('evenodd');
}

// ---------------------------------------------------------------- base
/**
 * Draw the base map (no text) of one output tile.
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {Record<string, object>} tile decoded source tile (decodeTile with WANT)
 * @param {{ z: number, x: number, y: number, size: number, pr: number }} out
 */
export function drawBase(ctx, tile, out) {
  const { z, size, pr } = out;
  const src = sourceFor(z, out.x, out.y);
  const lat = tileLat(z, out.y);
  ctx.fillStyle = MAP.ground;
  ctx.fillRect(0, 0, size, size);
  const ext = (name) => tile[name]?.extent ?? 4096;
  const view = (name) => makeView(ext(name), size, src);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Ground cover, quietest first.
  const lc = view('landcover');
  for (const [cls, tone] of Object.entries(LANDCOVER)) {
    fillFeatures(ctx, tile.landcover, lc, MAP[tone], (f) => f.props.class === cls);
  }
  const lu = view('landuse');
  for (const tone of [
    'residential',
    'commercial',
    'industrial',
    'institution',
    'green',
    'park',
  ]) {
    fillFeatures(
      ctx,
      tile.landuse,
      lu,
      MAP[tone],
      (f) => LANDUSE[f.props.class] === tone,
    );
  }
  fillFeatures(ctx, tile.park, view('park'), MAP.park);

  // Water: areas, then rivers and streams as lines.
  fillFeatures(ctx, tile.water, view('water'), MAP.water);
  if (tile.waterway) {
    const wv = view('waterway');
    ctx.strokeStyle = MAP.waterLine;
    for (const f of tile.waterway.features) {
      if (f.type !== 2 || !visible(wv, f.bbox, 8)) continue;
      const cls = f.props.class;
      const w = cls === 'river' ? 14 : cls === 'canal' ? 8 : 3;
      ctx.lineWidth = Math.max(0.7, w / metresPerPixel(z, lat)) * pr;
      ctx.beginPath();
      for (const p of f.parts) tracePart(ctx, p, wv);
      ctx.stroke();
    }
  }

  // Runways and aprons.
  if (tile.aeroway && z >= 10) {
    const av = view('aeroway');
    fillFeatures(ctx, tile.aeroway, av, MAP.aeroway);
    ctx.strokeStyle = MAP.aeroway;
    for (const f of tile.aeroway.features) {
      if (f.type !== 2 || !visible(av, f.bbox, 8)) continue;
      ctx.lineWidth =
        Math.max(1, (f.props.class === 'runway' ? 45 : 20) / metresPerPixel(z, lat)) * pr;
      ctx.beginPath();
      for (const p of f.parts) tracePart(ctx, p, av);
      ctx.stroke();
    }
  }

  // Building footprints: a dark fill and, close up, a hairline edge.
  if (tile.building && z >= 14) {
    const bv = view('building');
    fillFeatures(ctx, tile.building, bv, MAP.building);
    if (z >= 15) {
      ctx.strokeStyle = z >= 17 ? MAP.buildingEdgeNear : MAP.buildingEdge;
      ctx.lineWidth = (z >= 18 ? 1.2 : 0.9) * pr;
      ctx.beginPath();
      for (const f of tile.building.features) {
        if (f.type !== 3 || !visible(bv, f.bbox, 2)) continue;
        const boxes = f.parts.length > 8 ? boxesOf(f) : null;
        f.parts.forEach((p, i) => {
          if (boxes && !visible(bv, boxes[i], 2)) return;
          tracePart(ctx, p, bv);
          ctx.closePath();
        });
      }
      ctx.stroke();
    }
  }

  drawRoads(ctx, tile.transportation, view('transportation'), z, lat, pr);
}

function roadsOf(layer, z, brunnel, v) {
  const out = [];
  for (const f of layer.features) {
    if (f.type !== 2) continue;
    const cls = f.props.class;
    if (!ROAD[cls] || z < (ROAD_MINZOOM[cls] ?? 99)) continue;
    const b =
      f.props.brunnel === 'bridge'
        ? 'bridge'
        : f.props.brunnel === 'tunnel'
          ? 'tunnel'
          : '';
    if (b !== brunnel) continue;
    if (!visible(v, f.bbox, 30)) continue;
    out.push(f);
  }
  // Small roads under big ones.
  const order = Object.keys(ROAD);
  out.sort((a, b) => order.indexOf(b.props.class) - order.indexOf(a.props.class));
  return out;
}

function strokeRoad(ctx, f, v, width, color, dash) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash ?? []);
  ctx.beginPath();
  for (const p of f.parts) tracePart(ctx, p, v);
  ctx.stroke();
}

function drawRoads(ctx, layer, v, z, lat, pr) {
  if (!layer) return;
  const edged = z >= 15; // real-width roads with a hairline edge
  for (const brunnel of ['tunnel', '', 'bridge']) {
    const roads = roadsOf(layer, z, brunnel, v);
    if (!roads.length) continue;
    // Edges (or the single line far out), then fills on top.
    for (const f of roads) {
      const cls = f.props.class;
      const [, , fill, edge] = ROAD[cls];
      const w = roadWidth(cls, z, lat, pr);
      const dash =
        cls === 'rail' || cls === 'transit'
          ? [3 * pr, 3 * pr]
          : cls === 'path' || cls === 'track'
            ? [2 * pr, 2.5 * pr]
            : brunnel === 'tunnel'
              ? [4 * pr, 3 * pr]
              : null;
      if (!fill || !edged || w < 3 * pr) {
        strokeRoad(ctx, f, v, w, brunnel === 'tunnel' ? MAP.borderMinor : edge, dash);
        continue;
      }
      if (brunnel === 'bridge') strokeRoad(ctx, f, v, w + 4 * pr, MAP.halo, null);
      strokeRoad(ctx, f, v, w + 2 * pr, edge, dash);
    }
    if (!edged) continue;
    for (const f of roads) {
      const cls = f.props.class;
      const fill = ROAD[cls][2];
      const w = roadWidth(cls, z, lat, pr);
      if (!fill || w < 3 * pr) continue;
      strokeRoad(ctx, f, v, w, brunnel === 'tunnel' ? MAP.ground : fill, null);
    }
  }
  ctx.setLineDash([]);
}

// ---------------------------------------------------------------- labels
const nameOf = (p) => p['name:latin'] || p.name_en || p['name:en'] || p.name || '';

/** Font for a label size (CSS px) at a pixel ratio. */
export const fontFor = (px, pr, weight = 600) =>
  `${weight} ${Math.round(px * pr)}px ${FONT}`;

/**
 * Place the labels of one source tile at one zoom, in that tile's own pixel
 * space (size * scale on a side), with collisions resolved once for every
 * output tile that will draw them. Returns draw commands.
 * @param {{ measure: (text: string, font: string) => number }} m
 */
export function placeLabels(tile, kind, z, size, pr, m) {
  const src = sourceFor(z, 0, 0);
  const span = size * src.scale; // the whole source tile at this zoom
  const placed = [];
  const boxes = [];
  const fits = (b) => {
    for (const o of boxes)
      if (b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]) return false;
    return true;
  };
  const k = (layer) => span / (tile[layer]?.extent ?? 4096);
  const add = (cmd, box) => {
    if (!fits(box)) return false;
    boxes.push(box);
    placed.push({ ...cmd, box });
    return true;
  };

  if (kind === 'places') {
    // Borders first (lines, no collision), then names, biggest places first.
    if (tile.boundary) {
      const kb = k('boundary');
      for (const f of tile.boundary.features) {
        const lvl = Number(f.props.admin_level);
        if (f.type !== 2 || f.props.maritime || !(lvl === 2 || lvl === 4)) continue;
        if (lvl === 4 && z < 4) continue;
        placed.push({
          line: f.parts.map((p) => p.map((c) => c * kb)),
          color: lvl === 2 ? MAP.border : MAP.borderMinor,
          width: (lvl === 2 ? 1.2 : 0.8) * pr,
          dash: [5 * pr, 3 * pr],
          box: f.bbox.map((c) => c * kb),
        });
      }
    }
    const places = (tile.place?.features ?? [])
      .filter((f) => f.type === 1 && nameOf(f.props))
      .map((f) => ({ f, s: PLACE[f.props.class] }))
      .filter(({ s }) => s && z >= s.minZoom)
      .sort(
        (a, b) =>
          a.s.order - b.s.order || (a.f.props.rank ?? 99) - (b.f.props.rank ?? 99),
      );
    const kp = k('place');
    for (const { f, s } of places) {
      const text = nameOf(f.props).toUpperCase();
      const font = fontFor(s.size, pr, s.weight);
      const w = m.measure(text, font) + s.spacing * pr * text.length;
      const h = s.size * pr * 1.3;
      const x = f.parts[0][0] * kp;
      const y = f.parts[0][1] * kp;
      add({ text, x, y, font, color: s.color, halo: 3 * pr, spacing: s.spacing * pr }, [
        x - w / 2 - 4 * pr,
        y - h / 2,
        x + w / 2 + 4 * pr,
        y + h / 2,
      ]);
    }
    const kw = k('water_name');
    for (const f of tile.water_name?.features ?? []) {
      const name = nameOf(f.props);
      if (!name || z < (f.props.class === 'ocean' ? 1 : f.props.class === 'sea' ? 4 : 11))
        continue;
      const font = fontFor(11, pr, 500);
      const text = name.toUpperCase();
      const w = m.measure(text, font);
      const at =
        f.type === 1
          ? [f.parts[0][0] * kw, f.parts[0][1] * kw]
          : midpoint(f.parts[0], kw);
      if (!at) continue;
      const h = 14 * pr;
      add({ text, x: at[0], y: at[1], font, color: MAP.textWater, halo: 2.5 * pr }, [
        at[0] - w / 2,
        at[1] - h / 2,
        at[0] + w / 2,
        at[1] + h / 2,
      ]);
    }
    return placed;
  }

  // kind === 'roads': road numbers, street names, house numbers, POIs.
  const roads = (tile.transportation_name?.features ?? []).filter(
    (f) => f.type === 2 && z >= (NAME_MINZOOM[f.props.class] ?? 99),
  );
  roads.sort(
    (a, b) =>
      Object.keys(NAME_MINZOOM).indexOf(a.props.class) -
      Object.keys(NAME_MINZOOM).indexOf(b.props.class),
  );
  const kt = k('transportation_name');
  // Road numbers in a ctOS bracket box on the big roads.
  if (z <= 15) {
    for (const f of roads) {
      const ref = String(f.props.ref ?? '').split(';')[0];
      if (!ref || !MAJOR.has(f.props.class)) continue;
      const at = midpoint(longestPart(f.parts), kt);
      if (!at) continue;
      const font = fontFor(10, pr, 700);
      const w = m.measure(ref, font) + 8 * pr;
      const h = 14 * pr;
      add({ text: ref, x: at[0], y: at[1], font, color: MAP.text, shield: true, w, h }, [
        at[0] - w / 2 - 2 * pr,
        at[1] - h / 2 - 2 * pr,
        at[0] + w / 2 + 2 * pr,
        at[1] + h / 2 + 2 * pr,
      ]);
    }
  }
  const seen = new Map(); // name -> placed points (one label per ~220 px per name)
  for (const f of roads) {
    const raw = nameOf(f.props);
    if (!raw) continue;
    const text = raw.toUpperCase();
    const major = MAJOR.has(f.props.class) || f.props.class === 'secondary';
    const px = major ? 13 : f.props.class === 'service' ? 11 : 12;
    const font = fontFor(px, pr, 600);
    const w = m.measure(text, font);
    for (const run of runs(f.parts, kt)) {
      if (run.len < w + 16 * pr) continue;
      let a = run.angle;
      if (a > Math.PI / 2) a -= Math.PI;
      if (a < -Math.PI / 2) a += Math.PI;
      const h = px * pr * 1.3;
      const ca = Math.abs(Math.cos(a));
      const sa = Math.abs(Math.sin(a));
      const bw = (w * ca + h * sa) / 2;
      const bh = (w * sa + h * ca) / 2;
      // The middle of the run first; where that collides (often a crossing
      // street's own name), a quarter of the way in from either end, if the
      // text still fits on the run there.
      const room = (run.len - w) / 2 / run.len;
      const spots = [0.5, ...(room > 0.25 ? [0.25, 0.75] : [])];
      for (const t of spots) {
        const x = run.x0 + (run.x1 - run.x0) * t;
        const y = run.y0 + (run.y1 - run.y0) * t;
        const pts = seen.get(text) ?? [];
        if (pts.some(([sx, sy]) => Math.hypot(sx - x, sy - y) < 220 * pr)) break;
        const ok = add(
          {
            text,
            x,
            y,
            angle: a,
            font,
            color: major ? MAP.text : MAP.textMinor,
            halo: 3 * pr,
          },
          [x - bw, y - bh, x + bw, y + bh],
        );
        if (ok) {
          pts.push([x, y]);
          seen.set(text, pts);
          break;
        }
      }
    }
  }
  if (z >= 17 && tile.poi) {
    const kq = k('poi');
    const pois = tile.poi.features
      .filter((f) => f.type === 1 && nameOf(f.props))
      .sort((a, b) => (a.props.rank ?? 99) - (b.props.rank ?? 99));
    for (const f of pois) {
      if (z < 18 && (f.props.rank ?? 99) > 20) continue;
      const text = nameOf(f.props).toUpperCase();
      const font = fontFor(10, pr, 500);
      const w = m.measure(text, font);
      const x = f.parts[0][0] * kq;
      const y = f.parts[0][1] * kq;
      const h = 13 * pr;
      add(
        {
          text,
          x,
          y: y + 9 * pr,
          font,
          color: MAP.textMinor,
          halo: 2.5 * pr,
          dot: [x, y],
        },
        [x - w / 2 - 2 * pr, y - 3 * pr, x + w / 2 + 2 * pr, y + 9 * pr + h / 2],
      );
    }
  }
  if (z >= 18 && tile.housenumber) {
    const kh = k('housenumber');
    for (const f of tile.housenumber.features) {
      const text = String(f.props.housenumber ?? '');
      if (f.type !== 1 || !text) continue;
      const font = fontFor(10, pr, 500);
      const w = m.measure(text, font);
      const x = f.parts[0][0] * kh;
      const y = f.parts[0][1] * kh;
      const h = 11 * pr;
      add({ text, x, y, font, color: MAP.textFaint, halo: 2 * pr }, [
        x - w / 2,
        y - h / 2,
        x + w / 2,
        y + h / 2,
      ]);
    }
  }
  return placed;
}

const PLACE = {
  country: { minZoom: 2, size: 13, weight: 700, color: MAP.text, spacing: 2.5, order: 0 },
  state: {
    minZoom: 5,
    size: 11,
    weight: 600,
    color: MAP.textMinor,
    spacing: 2,
    order: 1,
  },
  city: { minZoom: 4, size: 14, weight: 700, color: MAP.text, spacing: 2, order: 2 },
  town: { minZoom: 8, size: 12, weight: 700, color: MAP.text, spacing: 1.5, order: 3 },
  village: {
    minZoom: 11,
    size: 11,
    weight: 600,
    color: MAP.textMinor,
    spacing: 1,
    order: 4,
  },
  suburb: {
    minZoom: 12,
    size: 11,
    weight: 600,
    color: MAP.textMinor,
    spacing: 1.5,
    order: 5,
  },
  hamlet: {
    minZoom: 13,
    size: 10,
    weight: 600,
    color: MAP.textFaint,
    spacing: 1,
    order: 6,
  },
  neighbourhood: {
    minZoom: 14,
    size: 10,
    weight: 600,
    color: MAP.textFaint,
    spacing: 1,
    order: 7,
  },
  quarter: {
    minZoom: 14,
    size: 10,
    weight: 600,
    color: MAP.textFaint,
    spacing: 1,
    order: 7,
  },
};

// Street names by class, biggest first (the order also decides collisions).
const NAME_MINZOOM = {
  motorway: 11,
  trunk: 12,
  primary: 13,
  secondary: 14,
  tertiary: 14,
  minor: 15,
  busway: 15,
  service: 17,
  track: 17,
  path: 17,
  raceway: 15,
};

function longestPart(parts) {
  let best = parts[0];
  let bestLen = -1;
  for (const p of parts) {
    let len = 0;
    for (let i = 2; i < p.length; i += 2)
      len += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    if (len > bestLen) {
      bestLen = len;
      best = p;
    }
  }
  return best;
}

/** The point halfway along a line, scaled. */
function midpoint(p, k) {
  if (!p || p.length < 2) return null;
  if (p.length < 4) return [p[0] * k, p[1] * k];
  let total = 0;
  for (let i = 2; i < p.length; i += 2)
    total += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  let half = total / 2;
  for (let i = 2; i < p.length; i += 2) {
    const d = Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    if (half <= d && d > 0) {
      const t = half / d;
      return [
        (p[i - 2] + (p[i] - p[i - 2]) * t) * k,
        (p[i - 1] + (p[i + 1] - p[i - 1]) * t) * k,
      ];
    }
    half -= d;
  }
  return [p[0] * k, p[1] * k];
}

/**
 * Nearly straight runs of a line (segments turning less than ~20 degrees
 * between them), with their length, middle and direction, in scaled px.
 */
export function runs(parts, k) {
  const out = [];
  for (const p of parts) {
    let start = 0;
    let len = 0;
    let prevAngle = null;
    const flush = (end) => {
      if (end - start < 2) return;
      const x0 = p[start] * k;
      const y0 = p[start + 1] * k;
      const x1 = p[end] * k;
      const y1 = p[end + 1] * k;
      out.push({
        len,
        x: (x0 + x1) / 2,
        y: (y0 + y1) / 2,
        x0,
        y0,
        x1,
        y1,
        angle: Math.atan2(y1 - y0, x1 - x0),
      });
    };
    for (let i = 2; i < p.length; i += 2) {
      const dx = (p[i] - p[i - 2]) * k;
      const dy = (p[i + 1] - p[i - 1]) * k;
      const d = Math.hypot(dx, dy);
      if (d === 0) continue;
      const a = Math.atan2(dy, dx);
      if (prevAngle !== null) {
        let turn = Math.abs(a - prevAngle);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        if (turn > 0.35) {
          flush(i - 2);
          start = i - 2;
          len = 0;
        }
      }
      len += d;
      prevAngle = a;
    }
    flush(p.length - 2);
  }
  return out.sort((a, b) => b.len - a.len);
}

/**
 * Draw placed labels into one output tile: those whose box touches it, shifted
 * by the tile's offset inside the source tile.
 */
export function drawLabels(ctx, placed, out) {
  const src = sourceFor(out.z, out.x, out.y);
  const ox = src.ox * out.size;
  const oy = src.oy * out.size;
  const s = out.size;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const c of placed) {
    const b = c.box;
    if (b[2] < ox || b[0] > ox + s || b[3] < oy || b[1] > oy + s) continue;
    if (c.line) {
      ctx.strokeStyle = c.color;
      ctx.lineWidth = c.width;
      ctx.setLineDash(c.dash ?? []);
      ctx.beginPath();
      for (const p of c.line) {
        ctx.moveTo(p[0] - ox, p[1] - oy);
        for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] - ox, p[i + 1] - oy);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      continue;
    }
    const x = c.x - ox;
    const y = c.y - oy;
    ctx.save();
    ctx.translate(x, y);
    if (c.angle) ctx.rotate(c.angle);
    ctx.font = c.font;
    if ('letterSpacing' in ctx) ctx.letterSpacing = c.spacing ? `${c.spacing}px` : '0px';
    if (c.shield) {
      // A road number: a dark plate with ctOS corner brackets.
      ctx.fillStyle = MAP.halo;
      ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      ctx.strokeStyle = MAP.textMinor;
      ctx.lineWidth = Math.max(1, c.h / 12);
      bracket(ctx, -c.w / 2, -c.h / 2, c.w, c.h, c.h / 3.5);
    } else if (c.halo) {
      ctx.strokeStyle = MAP.halo;
      ctx.lineWidth = c.halo;
      ctx.strokeText(c.text, 0, 0);
    }
    ctx.fillStyle = c.color;
    ctx.fillText(c.text, 0, 0);
    ctx.restore();
    if (c.dot) {
      ctx.fillStyle = MAP.textMinor;
      const d = Math.max(2, c.halo);
      ctx.fillRect(c.dot[0] - ox - d / 2, c.dot[1] - oy - d / 2, d, d);
    }
  }
}

/** ctOS corner brackets round a box. */
function bracket(ctx, x, y, w, h, arm) {
  ctx.beginPath();
  ctx.moveTo(x, y + arm);
  ctx.lineTo(x, y);
  ctx.lineTo(x + arm, y);
  ctx.moveTo(x + w - arm, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + arm);
  ctx.moveTo(x + w, y + h - arm);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + w - arm, y + h);
  ctx.moveTo(x + arm, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + h - arm);
  ctx.stroke();
}

// "Merge nearby": screen-space grid clustering for point and billboard layers.
// Pure (no Cesium, no DOM), so the grid, the policy and the label rules are
// unit-tested; createLayer.js projects the records and draws the markers.
//
// The view is cut into fixed square cells (CSS px). Every cell holding at least
// minPoints visible contacts becomes one cluster: its members are hidden (no
// draw, no pick, not "visible" to the overlay) and one bracket marker with the
// count stands at their centroid. The grid is offset by the screen position of
// a world anchor, so it slides with the globe during a pan and the groups hold
// still instead of reshuffling every frame. Below minHeightM nothing merges.
//
// Allocation-free once warm: typed arrays sized to the grid, grown only when the
// screen grows; a recluster only writes numbers.

export const CLUSTER = Object.freeze({
  cellPx: 52, // cell size with a mouse
  cellTouchPx: 60, // cell size on a touch screen (a fingertip is ~45 px)
  minPoints: 2,
  minHeightM: 3000, // camera height below which every contact is drawn
  intervalMs: 250, // recluster at most 4 Hz while the view changes
  moverIntervalMs: 1000, // movers drift under a still camera: once a second
  padCells: 1, // grid margin past the screen edge, so a pan does not pop
});

/**
 * The grid. Use per recluster: begin(), add() each contact, finish(), then
 * slotOf(cell) per contact and count()/centroid() per cluster slot.
 */
export function createGridClusterer() {
  let cols = 0;
  let rows = 0;
  let cell = CLUSTER.cellPx;
  let originX = 0;
  let originY = 0;
  let size = 0;
  let counts = new Int32Array(0);
  let sumX = new Float64Array(0);
  let sumY = new Float64Array(0);
  let sumZ = new Float64Array(0);
  let sumR = new Float64Array(0);
  let slots = new Int32Array(0);
  let slotCells = new Int32Array(0);
  let clusters = 0;

  function ensure(n) {
    if (counts.length >= n) return;
    const cap = Math.max(n, counts.length * 2, 64);
    counts = new Int32Array(cap);
    sumX = new Float64Array(cap);
    sumY = new Float64Array(cap);
    sumZ = new Float64Array(cap);
    sumR = new Float64Array(cap);
    slots = new Int32Array(cap);
    slotCells = new Int32Array(cap);
  }

  return {
    /**
     * Start a pass over a width x height (CSS px) view. offsetX/Y (any value)
     * shift the grid so a world anchor keeps its cell during a pan.
     */
    begin(width, height, cellPx, offsetX = 0, offsetY = 0, padCells = CLUSTER.padCells) {
      cell = Math.max(8, cellPx);
      const ox = ((offsetX % cell) + cell) % cell;
      const oy = ((offsetY % cell) + cell) % cell;
      originX = ox - (padCells + 1) * cell;
      originY = oy - (padCells + 1) * cell;
      cols = Math.ceil((width - originX) / cell) + padCells;
      rows = Math.ceil((height - originY) / cell) + padCells;
      size = cols * rows;
      ensure(size);
      counts.fill(0, 0, size);
      clusters = 0;
    },
    /**
     * Count a contact at screen (x, y), world (wx, wy, wz). Returns its cell, or
     * -1 when it lies outside the grid (it then never merges).
     */
    add(x, y, wx, wy, wz) {
      const cx = Math.floor((x - originX) / cell);
      const cy = Math.floor((y - originY) / cell);
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return -1;
      const c = cy * cols + cx;
      if (counts[c] === 0) {
        sumX[c] = 0;
        sumY[c] = 0;
        sumZ[c] = 0;
        sumR[c] = 0;
      }
      counts[c] += 1;
      sumX[c] += wx;
      sumY[c] += wy;
      sumZ[c] += wz;
      sumR[c] += Math.sqrt(wx * wx + wy * wy + wz * wz);
      return c;
    },
    /** Number the cells holding at least minPoints contacts; returns how many. */
    finish(minPoints = CLUSTER.minPoints) {
      let n = 0;
      for (let c = 0; c < size; c += 1) {
        if (counts[c] >= minPoints) {
          slots[c] = n;
          slotCells[n] = c;
          n += 1;
        } else {
          slots[c] = -1;
        }
      }
      clusters = n;
      return n;
    },
    /** The cluster slot of a cell (from add), or -1 when that cell did not merge. */
    slotOf(c) {
      return c >= 0 && c < size ? slots[c] : -1;
    },
    /** Members of a cluster slot. */
    count(slot) {
      return slot >= 0 && slot < clusters ? counts[slotCells[slot]] : 0;
    },
    /**
     * A cluster's centroid into out ({x, y, z}): the members' mean position
     * lifted back out to their mean distance from the Earth's centre (a plain
     * mean of far-apart points sinks below the surface).
     */
    centroid(slot, out) {
      const c = slotCells[slot];
      const k = counts[c];
      const mx = sumX[c] / k;
      const my = sumY[c] / k;
      const mz = sumZ[c] / k;
      const m = Math.sqrt(mx * mx + my * my + mz * mz);
      const s = m > 0 ? sumR[c] / k / m : 0;
      out.x = mx * s;
      out.y = my * s;
      out.z = mz * s;
      return out;
    },
    /** The window position of a cluster slot's cell centre into out ({x, y}). */
    cellCenter(slot, out) {
      const c = slotCells[slot];
      out.x = originX + ((c % cols) + 0.5) * cell;
      out.y = originY + (Math.floor(c / cols) + 0.5) * cell;
      return out;
    },
    get clusters() {
      return clusters;
    },
    get cells() {
      return size;
    },
  };
}

/** The count printed on a marker: exact below 100, then coarse (120 -> "100+"). */
export function clusterLabel(n) {
  if (n < 100) return String(n);
  if (n < 1000) return `${Math.floor(n / 100) * 100}+`;
  if (n < 100_000) return `${Math.floor(n / 1000)}K+`;
  return '99K+';
}

/** Marker height in CSS px, stepping up with the count. */
export function clusterSizePx(n) {
  return n < 10 ? 24 : n < 100 ? 28 : n < 1000 ? 32 : 36;
}

/**
 * The box to fit a cluster's members ([{ lon, lat }], degrees). Longitudes are
 * taken relative to the first member, so a group across the antimeridian gets
 * a narrow box (west > east) instead of the whole world.
 * @returns {{ west: number, south: number, east: number, north: number } | null}
 */
export function membersBox(points) {
  let lon0 = null;
  let minD = 0;
  let maxD = 0;
  let south = 90;
  let north = -90;
  for (const p of points) {
    if (!Number.isFinite(p?.lon) || !Number.isFinite(p?.lat)) continue;
    if (lon0 === null) lon0 = p.lon;
    const d = ((((p.lon - lon0) % 360) + 540) % 360) - 180;
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
  }
  if (lon0 === null) return null;
  const wrap = (v) => ((((v + 180) % 360) + 360) % 360) - 180;
  return { west: wrap(lon0 + minD), south, east: wrap(lon0 + maxD), north };
}

// Where a group's marker sits around its centroid when groups of other layers
// share its cell (slot 0 stays put): they fan out instead of stacking, each in
// its own ink. CSS px.
const FAN = [
  [0, 0],
  [0, -24],
  [0, 24],
  [-36, 0],
  [36, 0],
  [-36, -24],
  [36, 24],
  [-36, 24],
  [36, -24],
];

/** A marker's pixel offset for its slot in a shared cell. */
export function fanOffset(slot) {
  return slot > 0 ? FAN[slot % FAN.length] : FAN[0];
}

/**
 * A grid cell's key relative to the shared anchor (window px of the anchor,
 * ax, ay): stable while a pan carries the anchor and the cell along, and the
 * same for every layer of the scene.
 */
export function cellKey(x, y, ax, ay, cellPx) {
  const kx = Math.floor((x - ax) / cellPx) + 4096;
  const ky = Math.floor((y - ay) / cellPx) + 4096;
  return kx * 8192 + ky;
}

/**
 * The merge switch shared by every layer of one scene: on/off (the MERGE
 * NEARBY setting), a temporary hold (cockpit view), and the selected target,
 * which always stays drawn. Each change bumps version and asks for a frame.
 *
 * Merging layers join() while running and place() their groups by cell key
 * after each pass: a group gets the slot of its layer among the layers with a
 * group in the same cell (in join order), so markers of different layers fan
 * out (fanOffset). A layer whose slot may have changed because another one
 * came or went is poked (takePoke) to regroup. anchor is the world point every
 * layer's grid follows, so all layers cut the screen along the same lines.
 */
export function createClusterPolicy(onChange) {
  const state = { merge: true, hold: false, pinned: null, version: 0 };
  let nextToken = 1;
  const cells = new Map(); // cell key -> tokens with a group there, ascending
  const owned = new Map(); // token -> Set of its cell keys
  const pokes = new Set();
  const bump = () => {
    state.version += 1;
    onChange?.();
  };
  const poke = (token) => {
    if (pokes.has(token)) return;
    pokes.add(token);
    onChange?.();
  };
  // Remove token from a cell; those after it may move down a slot.
  const drop = (key, token) => {
    const list = cells.get(key);
    if (!list) return;
    const i = list.indexOf(token);
    if (i < 0) return;
    list.splice(i, 1);
    for (let j = i; j < list.length; j += 1) poke(list[j]);
    if (!list.length) cells.delete(key);
  };
  return {
    get merge() {
      return state.merge;
    },
    get hold() {
      return state.hold;
    },
    get pinned() {
      return state.pinned;
    },
    get version() {
      return state.version;
    },
    /** Merging applies now (on, and not held). */
    get active() {
      return state.merge && !state.hold;
    },
    /** Update some of { merge, hold, pinned }. */
    set(patch) {
      let changed = false;
      for (const k of ['merge', 'hold', 'pinned']) {
        if (!(k in patch)) continue;
        const v = k === 'pinned' ? (patch[k] ?? null) : Boolean(patch[k]);
        if (state[k] !== v) {
          state[k] = v;
          changed = true;
        }
      }
      if (changed) bump();
      return changed;
    },
    /** A merging layer starts: its token, for place() and leave(). */
    join() {
      const token = nextToken;
      nextToken += 1;
      owned.set(token, new Set());
      return token;
    },
    /** The layer stopped: its groups leave every cell. */
    leave(token) {
      const keys = owned.get(token);
      if (!keys) return;
      for (const k of keys) drop(k, token);
      owned.delete(token);
      pokes.delete(token);
    },
    /**
     * A layer's groups now sit in these cells (keys from cellKey). Writes each
     * group's slot into slots (same order) and returns slots.
     */
    place(token, keys, slots = []) {
      const mine = owned.get(token);
      if (!mine) return slots;
      const next = new Set(keys);
      for (const k of mine) if (!next.has(k)) drop(k, token);
      for (const k of next) {
        if (mine.has(k)) continue;
        let list = cells.get(k);
        if (!list) cells.set(k, (list = []));
        let i = 0;
        while (i < list.length && list[i] < token) i += 1;
        list.splice(i, 0, token);
        for (let j = i + 1; j < list.length; j += 1) poke(list[j]);
      }
      owned.set(token, next);
      for (let n = 0; n < keys.length; n += 1) {
        slots[n] = cells.get(keys[n])?.indexOf(token) ?? 0;
      }
      return slots;
    },
    /** Whether this layer was asked to regroup since it last looked (clears it). */
    takePoke(token) {
      return pokes.delete(token);
    },
    /** The shared grid anchor (world metres); ok is false until one is set. */
    anchor: { x: 0, y: 0, z: 0, ok: false },
  };
}

const policies = new WeakMap();

/** The policy of a scene (one per Cesium scene; created on first use). */
export function clusterPolicy(scene) {
  let p = policies.get(scene);
  if (!p) {
    p = createClusterPolicy(() => scene?.requestRender?.());
    policies.set(scene, p);
  }
  return p;
}

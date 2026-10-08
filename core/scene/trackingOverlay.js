import * as Cesium from 'cesium';
import { INK } from '../ui/palette.js';

// The tracking overlay: Bagley's "blob tracking" (design/ctos BagleyAvatar)
// laid over the live globe. One 2D canvas above the scene, painted after each
// render, carries every piece of screen-space text and tracking chrome:
//
//   - a tracking box with a two-digit ID on the contacts nearest the middle of
//     the view, lagging slightly behind each one, with dashed mesh edges
//     between neighbours (the detection layer);
//   - the selected target as the hub (ID 00): corner brackets, its name and a
//     short readout, spine edges to its nearest contacts carrying signal
//     packets, turning success green with LOCK while the camera follows it;
//   - the viewport frame with Bagley's corner readouts: state with a status
//     square top left, ID00 and track quality top right, the hub's screen
//     position bottom left, SIG (live layers) and TRK (boxes) bottom right;
//   - offline city names from a bundled list, decluttered on a grid.
//
// Cesium labels are never used: one canvas is far cheaper than thousands of
// label primitives and lets everything share one declutter pass. The box set
// is re-chosen at most every 125 ms; only the chosen few are re-projected per
// frame. It draws only when Cesium renders, plus a few follow-up frames while
// boxes are still easing into place.

const PICK_INTERVAL_MS = 125;
const LAG = 0.38; // fraction of the gap a box closes per frame
const DENSITY = { off: 0, low: 10, med: 22, high: 40 };
const LABELLED = { low: 4, med: 8, high: 12 };
const LAYER_WEIGHT = {
  military: 1.4,
  flights: 1.2,
  ships: 1.1,
  cctv: 1.1,
  satellites: 0.9,
};
const MAX_SPINES = 6;
const FONT = `10.5px 'JetBrainsMono Nerd Font', 'JetBrains Mono', ui-monospace, monospace`;
const FONT_BIG = `12px 'JetBrainsMono Nerd Font', 'JetBrains Mono', ui-monospace, monospace`;

const scratch = new Cesium.Cartesian3();
const win = new Cesium.Cartesian2();

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{
 *   getLayers: () => { key: string, label: string, layer: object }[],
 *   places?: [string, number, number, number][],
 *   labelFor?: (target: object) => string|null,
 * }} opts
 */
export function createTrackingOverlay(viewer, { getLayers, places = [], labelFor }) {
  const scene = viewer.scene;
  const canvas = document.createElement('canvas');
  canvas.className = 'argus-overlay';
  canvas.setAttribute('aria-hidden', 'true');
  const host = viewer.container ?? scene.canvas.parentElement;
  host.appendChild(canvas);
  const g = canvas.getContext('2d');

  const opts = { density: 'med', cities: true, frame: true };
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  let dpr = 1;
  let w = 0;
  let h = 0;

  const ids = new Map(); // target -> 2-digit id
  let nextId = 1;
  const idFor = (t) => {
    let id = ids.get(t);
    if (id === undefined) {
      id = nextId;
      nextId = nextId >= 99 ? 1 : nextId + 1;
      ids.set(t, id);
      if (ids.size > 400) ids.delete(ids.keys().next().value);
    }
    return id;
  };

  const boxes = new Map(); // target -> { x, y, sx, sy, key, label, near, seen }
  let hub = null; // { target, key, x, y, sx, sy, label, sub }
  let following = false;
  let lastPick = 0;
  let summary = { state: 'IDLE', total: 0, layers: 0, boxes: 0, hub: null, contacts: [] };
  const listeners = new Set();
  let settleFrames = 0;
  const occluder = new Cesium.EllipsoidalOccluder(
    Cesium.Ellipsoid.WGS84,
    Cesium.Cartesian3.ZERO,
  );

  function resize() {
    const r = host.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = r.width;
    h = r.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    scene.requestRender();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const project = (pos) => {
    if (!pos) return null;
    const p = Cesium.SceneTransforms.worldToWindowCoordinates(scene, pos, win);
    return p ? { x: p.x, y: p.y } : null;
  };

  const inView = (p, pad = 0) =>
    p &&
    p.x >= insets.left + pad &&
    p.x <= w - insets.right - pad &&
    p.y >= insets.top + pad &&
    p.y <= h - insets.bottom - pad;

  // ---------------------------------------------------------------- picking
  function pick(now) {
    lastPick = now;
    const layers = getLayers();
    const cx = insets.left + (w - insets.left - insets.right) / 2;
    const cy = insets.top + (h - insets.top - insets.bottom) / 2;
    const dmax = Math.hypot(w, h) / 2;
    const want = DENSITY[opts.density] ?? 0;
    const cand = [];
    let total = 0;
    const hubWorld = hub
      ? hub.target.position.getValue(viewer.clock.currentTime, new Cesium.Cartesian3())
      : null;
    const near = []; // nearest contacts to the hub (world distance)

    for (const { key, layer } of layers) {
      if (!layer.forEachVisible) continue;
      const weight = LAYER_WEIGHT[key] ?? 1;
      layer.forEachVisible((target, world) => {
        total += 1;
        if (hub && target === hub.target) return;
        if (hubWorld) {
          const d = Cesium.Cartesian3.distance(hubWorld, world);
          if (near.length < 16 || d < near[near.length - 1].d) {
            near.push({ target, key, layer, d, world: Cesium.Cartesian3.clone(world) });
            near.sort((a, b) => a.d - b.d);
            if (near.length > 16) near.pop();
          }
        }
        if (!want) return;
        const p = project(world);
        if (!inView(p, 8)) return;
        const score = weight * (1 - Math.min(1, Math.hypot(p.x - cx, p.y - cy) / dmax));
        cand.push({ target, key, layer, score, p });
      });
    }
    cand.sort((a, b) => b.score - a.score);
    const chosen = cand.slice(0, want);
    const keep = new Set();
    const nLabels = LABELLED[opts.density] ?? 0;
    chosen.forEach((c, i) => {
      keep.add(c.target);
      let b = boxes.get(c.target);
      if (!b) {
        b = { x: c.p.x, y: c.p.y, key: c.key, label: null };
        boxes.set(c.target, b);
      }
      b.key = c.key;
      b.sx = c.p.x;
      b.sy = c.p.y;
      b.id = idFor(c.target);
      b.label = i < nLabels ? (labelFor?.(c.target) ?? null) : null;
    });
    for (const t of [...boxes.keys()]) if (!keep.has(t)) boxes.delete(t);
    // Mesh: each box to its nearest neighbour on screen.
    const list = [...boxes.values()];
    for (const b of list) {
      let best = null;
      let bd = Infinity;
      for (const o of list) {
        if (o === b) continue;
        const d = (o.sx - b.sx) ** 2 + (o.sy - b.sy) ** 2;
        if (d < bd) {
          bd = d;
          best = o;
        }
      }
      b.near = best;
    }

    const contacts = (hubWorld ? near : chosen.slice(0, 12)).map((c) => {
      const id = idFor(c.target);
      return {
        id,
        target: c.target,
        key: c.key,
        distanceM: hubWorld ? c.d : null,
        bearingDeg: hubWorld ? bearing(hubWorld, c.world) : null,
        label: labelFor?.(c.target) ?? null,
      };
    });
    if (hub) hub.spines = near.slice(0, MAX_SPINES).map((c) => c.target);

    const state = !layers.length
      ? 'NO SIGNAL'
      : hub
        ? following
          ? 'LOCK'
          : 'TRACK'
        : boxes.size
          ? 'SCAN'
          : 'IDLE';
    summary = {
      state,
      total,
      layers: layers.length,
      boxes: boxes.size,
      hub: hub && { ...hub },
      contacts,
    };
    listeners.forEach((fn) => fn(summary));
  }

  // ---------------------------------------------------------------- drawing
  function draw() {
    const now = performance.now();
    // Thousands of contacts in view: re-choose the boxes less often (each pass
    // projects every visible contact), keeping phones cool.
    const interval = summary.total > 2000 ? PICK_INTERVAL_MS * 3 : PICK_INTERVAL_MS;
    if (now - lastPick > interval) pick(now);
    occluder.cameraPosition = scene.camera.positionWC;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    let moving = false;
    // Re-project chosen boxes every frame and ease toward the new spot.
    for (const [t, b] of boxes) {
      const p = project(t.position.getValue(viewer.clock.currentTime, scratch));
      if (!p) continue;
      b.sx = p.x;
      b.sy = p.y;
      b.x += (b.sx - b.x) * LAG;
      b.y += (b.sy - b.y) * LAG;
      if (Math.abs(b.sx - b.x) + Math.abs(b.sy - b.y) > 0.5) moving = true;
    }
    if (hub) {
      const p = project(hub.target.position.getValue(viewer.clock.currentTime, scratch));
      hub.visible = Boolean(p);
      if (p) {
        hub.sx = p.x;
        hub.sy = p.y;
        if (hub.x === undefined) {
          hub.x = p.x;
          hub.y = p.y;
        }
        hub.x += (hub.sx - hub.x) * LAG;
        hub.y += (hub.sy - hub.y) * LAG;
        if (Math.abs(hub.sx - hub.x) + Math.abs(hub.sy - hub.y) > 0.5) moving = true;
      }
    }
    layoutLabels();
    if (opts.cities) drawCities();
    drawMesh();
    drawBoxes();
    if (hub?.visible) drawHub(now);
    if (opts.frame) drawFrame();
    // A few follow-up frames while boxes settle, then fall idle.
    if (moving && settleFrames < 30) {
      settleFrames += 1;
      requestAnimationFrame(() => scene.requestRender());
    } else if (!moving) settleFrames = 0;
  }

  // One occupancy grid per frame shared by every text label, so box labels,
  // the hub readout and city names never print over each other.
  const CELL_W = 12;
  const CELL_H = 8;
  const grid = new Set();
  function claim(x0, y0, x1, y1) {
    const c0 = Math.floor(x0 / CELL_W);
    const c1 = Math.floor(x1 / CELL_W);
    const r0 = Math.floor(y0 / CELL_H);
    const r1 = Math.floor(y1 / CELL_H);
    for (let r = r0; r <= r1; r += 1)
      for (let c = c0; c <= c1; c += 1) if (grid.has(c * 4096 + r)) return false;
    for (let r = r0; r <= r1; r += 1)
      for (let c = c0; c <= c1; c += 1) grid.add(c * 4096 + r);
    return true;
  }
  function layoutLabels() {
    grid.clear();
    g.font = FONT;
    if (hub?.visible) claim(hub.x - 20, hub.y - 34, hub.x + 220, hub.y + 22);
    for (const b of boxes.values()) {
      const s = boxSize(b);
      claim(b.x - s / 2, b.y - s / 2 - 13, b.x + s / 2, b.y + s / 2); // the box and its id
    }
    for (const b of boxes.values()) {
      if (!b.label) {
        b.showLabel = false;
        continue;
      }
      const s = boxSize(b);
      const x = b.x + s / 2 + 4;
      const y = b.y - s / 2;
      b.showLabel = claim(x, y, x + g.measureText(b.label).width + 6, y + 13);
    }
  }
  const boxSize = (b) => (b.key === 'flights' || b.key === 'military' ? 26 : 20);

  function drawMesh() {
    g.save();
    g.lineWidth = 1;
    g.setLineDash([3, 4]);
    g.strokeStyle = 'rgba(217,217,217,0.22)';
    g.beginPath();
    for (const b of boxes.values()) {
      if (!b.near || (b.near.near === b && b.id > b.near.id)) continue;
      g.moveTo(b.x, b.y);
      g.lineTo(b.near.x, b.near.y);
    }
    g.stroke();
    g.restore();
  }

  function drawBoxes() {
    g.save();
    g.font = FONT;
    g.textBaseline = 'bottom';
    for (const b of boxes.values()) {
      const s = boxSize(b);
      const x = Math.round(b.x - s / 2) + 0.5;
      const y = Math.round(b.y - s / 2) + 0.5;
      g.strokeStyle = 'rgba(217,217,217,0.7)';
      g.lineWidth = 1;
      g.strokeRect(x, y, s, s);
      const tag = String(b.id).padStart(2, '0');
      g.fillStyle = 'rgba(14,14,14,0.75)';
      const tw = g.measureText(tag).width;
      g.fillRect(x - 0.5, y - 13, tw + 4, 12);
      g.fillStyle = INK.dim;
      g.fillText(tag, x + 1.5, y - 1.5);
      if (b.label && b.showLabel) {
        g.fillStyle = 'rgba(14,14,14,0.75)';
        const lw = g.measureText(b.label).width;
        g.fillRect(x + s + 4, y - 0.5, lw + 6, 13);
        g.fillStyle = INK.white;
        g.fillText(b.label, x + s + 7, y + 11.5);
      }
    }
    g.restore();
  }

  function drawHub(now) {
    const c = following ? INK.success : INK.white;
    const x = Math.round(hub.x) + 0.5;
    const y = Math.round(hub.y) + 0.5;
    const r = 19;
    const arm = 8;
    g.save();
    // Spine edges to the nearest contacts, each carrying a packet.
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,255,255,0.4)';
    const spineTargets = hub.spines || [];
    let i = 0;
    for (const t of spineTargets) {
      const b = boxes.get(t);
      const p = b ? b : project(t.position.getValue(viewer.clock.currentTime, scratch));
      if (!p || !inView(p)) continue;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(p.x, p.y);
      g.stroke();
      const k = (((now / 1400 + i * 0.37) % 1) + 1) % 1;
      const px = x + (p.x - x) * k;
      const py = y + (p.y - y) * k;
      g.fillStyle = INK.white;
      g.fillRect(px - 1.5, py - 1.5, 3, 3);
      g.globalAlpha = 0.35;
      g.fillRect(px - (p.x - x) * 0.04 - 1, py - (p.y - y) * 0.04 - 1, 2, 2);
      g.globalAlpha = 1;
      i += 1;
    }
    // Corner brackets around the hub.
    g.strokeStyle = c;
    g.lineWidth = 1.5;
    g.beginPath();
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      const cx = x + sx * r;
      const cy = y + sy * r;
      g.moveTo(cx - sx * arm, cy);
      g.lineTo(cx, cy);
      g.lineTo(cx, cy - sy * arm);
    }
    g.stroke();
    // ID and readout block to the right.
    g.font = FONT;
    g.textBaseline = 'alphabetic';
    g.fillStyle = c;
    g.fillText(following ? '00 LOCK' : '00', x - r, y - r - 5);
    const lines = [hub.label, hub.sub].filter(Boolean);
    if (lines.length) {
      g.font = FONT_BIG;
      const tw = Math.max(
        ...lines.map((l, j) =>
          j ? g.measureText(l).width * 0.88 : g.measureText(l).width,
        ),
      );
      const bx = x + r + 10;
      const by = y - r;
      g.fillStyle = 'rgba(14,14,14,0.82)';
      g.fillRect(bx, by, tw + 14, lines.length > 1 ? 34 : 20);
      g.fillStyle = c;
      g.fillRect(bx, by, 2, lines.length > 1 ? 34 : 20);
      g.fillStyle = INK.white;
      g.fillText(lines[0], bx + 8, by + 14);
      if (lines[1]) {
        g.font = FONT;
        g.fillStyle = INK.dim;
        g.fillText(lines[1], bx + 8, by + 28);
      }
      g.strokeStyle = 'rgba(255,255,255,0.5)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x + r, y - r + 0.5);
      g.lineTo(bx, by + 0.5);
      g.stroke();
    }
    g.restore();
  }

  function drawFrame() {
    const x0 = insets.left + 10.5;
    const y0 = insets.top + 10.5;
    const x1 = w - insets.right - 10.5;
    const y1 = h - insets.bottom - 10.5;
    if (x1 - x0 < 120 || y1 - y0 < 80) return;
    const arm = 14;
    g.save();
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 1;
    g.beginPath();
    for (const [cx, cy, sx, sy] of [
      [x0, y0, 1, 1],
      [x1, y0, -1, 1],
      [x0, y1, 1, -1],
      [x1, y1, -1, -1],
    ]) {
      g.moveTo(cx + sx * arm, cy);
      g.lineTo(cx, cy);
      g.lineTo(cx, cy + sy * arm);
    }
    g.stroke();
    const s = summary;
    g.font = FONT;
    g.textBaseline = 'middle';
    // Top left: status square + state.
    const stateColor =
      s.state === 'LOCK' ? INK.success : s.state === 'NO SIGNAL' ? INK.muted : INK.gray;
    g.fillStyle = stateColor;
    g.fillRect(x0 + 8, y0 + 9, 5, 5);
    g.fillStyle = s.state === 'NO SIGNAL' ? INK.muted : INK.white;
    g.fillText(s.state, x0 + 18, y0 + 12);
    // Top right: hub id + track quality, or the object count.
    g.textAlign = 'right';
    g.fillStyle = INK.dim;
    const tr = hub
      ? `ID00 ${quality(hub).toFixed(2)}`
      : `OBJ ${String(s.total).padStart(4, '0')}`;
    g.fillText(tr, x1 - 8, y0 + 12);
    // Bottom right: SIG (live layers) and TRK (boxes).
    g.fillStyle = INK.muted;
    g.fillText(
      `SIG ${String(s.layers).padStart(2, '0')}  TRK ${String(boxes.size + (hub ? 1 : 0)).padStart(2, '0')}`,
      x1 - 8,
      y1 - 10,
    );
    // Bottom left: the hub's normalised screen position (or the centre).
    g.textAlign = 'left';
    const hx = hub?.visible ? hub.x : (x0 + x1) / 2;
    const hy = hub?.visible ? hub.y : (y0 + y1) / 2;
    g.fillText(`x.${frac(hx / w)} y.${frac(hy / h)}`, x0 + 8, y1 - 10);
    g.restore();
  }

  // City names: the larger the view, the fewer (rank 1 from orbit, 3 regional).
  function drawCities() {
    const height = scene.camera.positionCartographic.height;
    const maxRank = height > 6e6 ? 1 : height > 1.8e6 ? 2 : 3;
    g.save();
    g.font = FONT;
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    for (const [name, lat, lon, rank] of places) {
      if (rank > maxRank) continue;
      const pos = Cesium.Cartesian3.fromDegrees(
        lon,
        lat,
        0,
        Cesium.Ellipsoid.WGS84,
        scratch,
      );
      if (!occluder.isPointVisible(pos)) continue;
      const p = project(pos);
      if (!inView(p, 4)) continue;
      const text = name.toUpperCase();
      const tw = g.measureText(text).width;
      // Declutter: skip a name that would overlap a box label or another name.
      if (!claim(p.x - 4, p.y - 7, p.x + tw + 10, p.y + 7)) continue;
      g.fillStyle = rank === 1 ? INK.gray : INK.muted;
      g.fillRect(Math.round(p.x) - 2, Math.round(p.y) - 2, 4, 4);
      g.strokeStyle = 'rgba(14,14,14,0.85)';
      g.lineWidth = 3;
      g.strokeText(text, p.x + 6, p.y);
      g.fillStyle = rank === 1 ? INK.dim : INK.dimmer;
      g.globalAlpha = rank === 1 ? 1 : 0.85;
      g.fillText(text, p.x + 6, p.y);
      g.globalAlpha = 1;
    }
    g.restore();
  }

  const remove = scene.postRender.addEventListener(draw);

  return {
    el: canvas,
    /** Make a target the hub. info: { label, sub } for its readout. */
    setSelected(target, info = {}) {
      if (!target) {
        hub = null;
        following = false;
      } else if (hub?.target === target) {
        hub.label = info.label ?? hub.label;
        hub.sub = info.sub ?? hub.sub;
        hub.history = info.history ?? hub.history;
      } else {
        hub = { target, label: info.label, sub: info.sub, history: info.history };
        boxes.delete(target);
      }
      lastPick = 0;
      scene.requestRender();
    },
    setFollowing(on) {
      following = Boolean(on);
      lastPick = 0;
      scene.requestRender();
    },
    setOptions(next) {
      Object.assign(opts, next);
      lastPick = 0;
      scene.requestRender();
    },
    options: () => ({ ...opts }),
    setInsets(next) {
      Object.assign(insets, next);
      lastPick = 0;
      scene.requestRender();
    },
    /** fn(summary) after each pick pass: { state, total, layers, boxes, hub, contacts }. */
    subscribe(fn) {
      listeners.add(fn);
      fn(summary);
      return () => listeners.delete(fn);
    },
    idFor,
    /** The drawing area and insets, for diagnostics. */
    geometry: () => ({ w, h, dpr, insets: { ...insets } }),
    destroy() {
      remove();
      ro.disconnect();
      canvas.remove();
    },
  };
}

function frac(v) {
  return String(Math.round(Math.max(0, Math.min(0.999, v)) * 1000)).padStart(3, '0');
}

// Track quality for the hub readout: more fixes, more confidence.
function quality(hub) {
  const n = hub.history?.() ?? 0;
  return Math.min(0.99, 0.62 + n * 0.03);
}

// Initial bearing from a to b (ECEF), degrees clockwise from north.
function bearing(a, b) {
  const ca = Cesium.Cartographic.fromCartesian(a);
  const cb = Cesium.Cartographic.fromCartesian(b);
  if (!ca || !cb) return null;
  const dl = cb.longitude - ca.longitude;
  const y = Math.sin(dl) * Math.cos(cb.latitude);
  const x =
    Math.cos(ca.latitude) * Math.sin(cb.latitude) -
    Math.sin(ca.latitude) * Math.cos(cb.latitude) * Math.cos(dl);
  return ((Cesium.Math.toDegrees(Math.atan2(y, x)) % 360) + 360) % 360;
}

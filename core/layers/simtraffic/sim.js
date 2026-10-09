import { pointAt } from './roads.js';

// The traffic simulation behind the simtraffic layer: a deterministic fleet of
// SIMULATED vehicles on the OSM road graph (roads.js buildNetwork). It is a
// picture of how traffic moves on these roads, not a measurement of any real
// vehicle: nothing here tracks anyone.
//
// Each direction of a road has its lanes; each lane keeps its vehicles in order
// (head first). Vehicles follow the one ahead with the Intelligent Driver Model
// (Treiber, Hennecke, Helbing 2000): they accelerate toward a desired speed,
// keep a time gap, and brake smoothly for a slower leader, also across a
// junction (each vehicle picks its next road when it enters a lane, so it can
// see who is on it). The desired speed is the road's free-flow speed (TomTom's
// when measured, else maxspeed or the class default) times the road's
// congestion factor (TomTom current / free-flow; 1 when nothing is measured),
// times a small per-driver spread. Turns slow vehicles down before the corner.
//
// Seeded (mulberry32), so the same view and seed give the same fleet. State is
// typed arrays sized once by the fleet cap: a step allocates nothing.

const A_MAX = 1.4; // comfortable acceleration, m/s2
const B_COMF = 2.2; // comfortable braking, m/s2
const S0 = 2.5; // jam gap, m
const T_HEAD = 1.3; // time gap, s
const VEH_LEN = 4.6; // m, plus S0 is the spacing in a queue
const LANE_W = 3.3; // m
const MAX_DT = 0.25; // s per integration step
const IDM_SQRT_AB = 2 * Math.sqrt(A_MAX * B_COMF);
/** Vehicles per lane-kilometre in free flow; congestion packs more in. */
export const DENSITY_PER_LANE_KM = 9;

/** A small seeded PRNG (mulberry32): () => [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {{ cap?: number, seed?: number }} [opts] cap: the most vehicles ever
 */
export function createSimulation({ cap = 400, seed = 1 } = {}) {
  const CAP = Math.max(1, cap | 0);
  let rnd = mulberry32(seed);

  // Vehicles (structure of arrays).
  let n = 0;
  const vLane = new Int32Array(CAP);
  const vS = new Float32Array(CAP); // metres along the lane's direction of travel
  const vV = new Float32Array(CAP); // m/s
  const vFactor = new Float32Array(CAP);
  const vNext = new Int32Array(CAP); // the lane it turns onto, -1 for none
  const vTurnV = new Float32Array(CAP); // speed limit for that turn, m/s
  const vHint = new Int32Array(CAP); // segment index cache for positions
  const vAcc = new Float32Array(CAP);
  // Outputs, written by computePositions().
  const outLon = new Float64Array(CAP);
  const outLat = new Float64Array(CAP);
  const outH = new Float32Array(CAP);
  const outHeading = new Float32Array(CAP); // radians clockwise from north

  // Lanes and the network.
  let net = null;
  let lanes = 0;
  let laneEdge = new Int32Array(0);
  let laneDir = new Int8Array(0);
  let laneIdx = new Uint8Array(0);
  let laneOffset = new Float32Array(0);
  let laneLen = new Float32Array(0);
  let laneNear = new Uint8Array(0); // edge midpoint inside the focus circle
  let laneQ = []; // vehicle ids per lane, head (largest s) first
  let laneWeight = new Float64Array(0); // cumulative spawn weights
  let edgeFwd = new Int32Array(0); // first forward lane of an edge, or -1
  let edgeBack = new Int32Array(0);
  let edgeRatio = new Float32Array(0); // congestion factor 0..1
  let edgeFree = new Float32Array(0); // free-flow speed, m/s
  let edgeDist = new Float32Array(0); // edge midpoint distance from the focus, m
  let focus = { lat: 0, lon: 0 };
  let radiusM = 2000;
  let leftHand = false;
  let target = 0;

  const scratch = { lon: 0, lat: 0, seg: 0, f: 0 };

  // --- lanes -------------------------------------------------------------------

  const laneKey = (e, dir, k) => `${e.id}|${dir}|${k}`;
  const laneOf = (edge, dir, k) => {
    const base = dir > 0 ? edgeFwd[edge] : edgeBack[edge];
    if (base < 0) return -1;
    const count = dir > 0 ? net.edges[edge].lanesFwd : net.edges[edge].lanesBack;
    return base + Math.min(k, count - 1);
  };

  function buildLanes() {
    const E = net.edges.length;
    edgeFwd = new Int32Array(E).fill(-1);
    edgeBack = new Int32Array(E).fill(-1);
    let L = 0;
    for (const e of net.edges) L += e.lanesFwd + e.lanesBack;
    lanes = L;
    laneEdge = new Int32Array(L);
    laneDir = new Int8Array(L);
    laneIdx = new Uint8Array(L);
    laneOffset = new Float32Array(L);
    laneLen = new Float32Array(L);
    laneNear = new Uint8Array(L);
    laneWeight = new Float64Array(L);
    laneQ = Array.from({ length: L }, () => []);
    const side = leftHand ? -1 : 1;
    let id = 0;
    for (const e of net.edges) {
      const twoWay = e.lanesFwd > 0 && e.lanesBack > 0;
      for (const [dir, count] of [
        [1, e.lanesFwd],
        [-1, e.lanesBack],
      ]) {
        if (!count) continue;
        if (dir > 0) edgeFwd[e.index] = id;
        else edgeBack[e.index] = id;
        for (let k = 0; k < count; k += 1) {
          laneEdge[id] = e.index;
          laneDir[id] = dir;
          laneIdx[id] = k;
          laneLen[id] = e.lengthM;
          // Positive is to the right of the direction of travel.
          laneOffset[id] = twoWay
            ? side * (k + 0.5) * LANE_W
            : (k - (count - 1) / 2) * LANE_W;
          id += 1;
        }
      }
    }
  }

  function measureFocus() {
    const E = net.edges.length;
    edgeDist = new Float32Array(E);
    const kx = net.kx;
    const ky = net.ky;
    for (const e of net.edges) {
      edgeDist[e.index] = Math.hypot(
        (e.midLon - focus.lon) * kx,
        (e.midLat - focus.lat) * ky,
      );
    }
    let acc = 0;
    let laneKm = 0;
    let boostKm = 0;
    for (let l = 0; l < lanes; l += 1) {
      const e = laneEdge[l];
      const near = edgeDist[e] <= radiusM;
      laneNear[l] = near ? 1 : 0;
      if (near) {
        const boost = 1 + 1.2 * (1 - edgeRatio[e]);
        acc += laneLen[l] * boost;
        laneKm += laneLen[l] / 1000;
        boostKm += (laneLen[l] / 1000) * boost;
      }
      laneWeight[l] = acc;
    }
    target = Math.min(CAP, Math.round(boostKm * DENSITY_PER_LANE_KM));
    if (laneKm > 0) target = Math.max(target, Math.min(CAP, 8));
  }

  // --- queues ------------------------------------------------------------------

  function insertSorted(l, i) {
    const q = laneQ[l];
    let k = q.length;
    while (k > 0 && vS[q[k - 1]] < vS[i]) k -= 1;
    q.splice(k, 0, i);
  }

  function removeFromLane(l, i) {
    const q = laneQ[l];
    const k = q.indexOf(i);
    if (k >= 0) q.splice(k, 1);
  }

  /** Free vehicle slot i by moving the last vehicle into it. */
  function dropVehicle(i) {
    removeFromLane(vLane[i], i);
    const last = n - 1;
    if (i !== last) {
      const q = laneQ[vLane[last]];
      const k = q.indexOf(last);
      if (k >= 0) q[k] = i;
      vLane[i] = vLane[last];
      vS[i] = vS[last];
      vV[i] = vV[last];
      vFactor[i] = vFactor[last];
      vNext[i] = vNext[last];
      vTurnV[i] = vTurnV[last];
      vHint[i] = vHint[last];
    }
    n -= 1;
  }

  // --- routing -------------------------------------------------------------------

  // Exit direction of lane l (unit, local metres) at its end, and entry
  // direction of a lane at its start.
  function exitDir(l, out) {
    const e = net.edges[laneEdge[l]];
    if (laneDir[l] > 0) {
      const k = e.ux.length - 1;
      out[0] = e.ux[k];
      out[1] = e.uy[k];
    } else {
      out[0] = -e.ux[0];
      out[1] = -e.uy[0];
    }
    return out;
  }
  function entryDir(edge, dir, out) {
    const e = net.edges[edge];
    if (dir > 0) {
      out[0] = e.ux[0];
      out[1] = e.uy[0];
    } else {
      const k = e.ux.length - 1;
      out[0] = -e.ux[k];
      out[1] = -e.uy[k];
    }
    return out;
  }
  const dA = [0, 0];
  const dB = [0, 0];
  const optW = new Float64Array(16);

  /** Pick the lane vehicle i turns onto after lane l; sets vNext and vTurnV. */
  function chooseNext(i, l) {
    const edge = laneEdge[l];
    const dir = laneDir[l];
    const e = net.edges[edge];
    const node = dir > 0 ? e.to : e.from;
    const opts = net.out[node];
    exitDir(l, dA);
    let total = 0;
    const count = Math.min(opts.length, optW.length);
    for (let k = 0; k < count; k += 1) {
      const o = opts[k];
      let w = 0;
      if (!(o.edge === edge && o.dir === -dir)) {
        const oe = net.edges[o.edge];
        entryDir(o.edge, o.dir, dB);
        const cos = dA[0] * dB[0] + dA[1] * dB[1];
        // Mostly straight on, staying on roads of the same rank and name.
        w = (0.25 + Math.max(0, cos) ** 2) / (1 + Math.abs(oe.rank - e.rank));
        if (oe.name && oe.name === e.name) w *= 2.5;
        if (edgeDist[o.edge] > radiusM * 1.3) w *= 0.15; // drift back to the view
      }
      optW[k] = w;
      total += w;
    }
    let pick = -1;
    if (total > 0) {
      let r = rnd() * total;
      for (let k = 0; k < count; k += 1) {
        r -= optW[k];
        if (r <= 0 && optW[k] > 0) {
          pick = k;
          break;
        }
      }
      if (pick < 0)
        for (let k = count - 1; k >= 0 && pick < 0; k -= 1) if (optW[k] > 0) pick = k;
    }
    let nl = -1;
    if (pick >= 0) nl = laneOf(opts[pick].edge, opts[pick].dir, laneIdx[l]);
    else if ((dir > 0 ? e.lanesBack : e.lanesFwd) > 0)
      nl = laneOf(edge, -dir, laneIdx[l]); // dead end: U-turn
    vNext[i] = nl;
    if (nl < 0) {
      vTurnV[i] = 4;
      return;
    }
    entryDir(laneEdge[nl], laneDir[nl], dB);
    const cos = dA[0] * dB[0] + dA[1] * dB[1];
    vTurnV[i] = cos > 0.9 ? 1e9 : cos > 0.5 ? 11 : cos > 0 ? 7.5 : 5;
  }

  // --- spawning ------------------------------------------------------------------

  function pickLane() {
    const totalW = lanes ? laneWeight[lanes - 1] : 0;
    if (!(totalW > 0)) return -1;
    const r = rnd() * totalW;
    let lo = 0;
    let hi = lanes - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (laneWeight[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Put vehicle slot i somewhere free on a weighted random lane near the focus. */
  function place(i) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const l = pickLane();
      if (l < 0) return false;
      const len = laneLen[l];
      const s = rnd() * len;
      const q = laneQ[l];
      let clear = true;
      for (let k = 0; k < q.length; k += 1) {
        if (Math.abs(vS[q[k]] - s) < VEH_LEN + S0 + 4) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      const e = laneEdge[l];
      vLane[i] = l;
      vS[i] = s;
      vFactor[i] = 0.86 + rnd() * 0.26;
      vV[i] = edgeFree[e] * edgeRatio[e] * vFactor[i] * (0.6 + rnd() * 0.3);
      vHint[i] = 0;
      insertSorted(l, i);
      chooseNext(i, l);
      return true;
    }
    return false;
  }

  /** Grow or shrink the fleet toward the target (a few per call when shrinking). */
  function rebalance(all = false) {
    while (n < target) {
      if (!place(n)) break;
      n += 1;
    }
    let drop = all ? n - target : Math.min(n - target, Math.max(4, Math.ceil(n * 0.05)));
    // Shrink from the far end: the vehicles furthest from the view go first.
    while (drop > 0 && n > 0) {
      let far = 0;
      for (let i = 1; i < n; i += 1)
        if (edgeDist[laneEdge[vLane[i]]] > edgeDist[laneEdge[vLane[far]]]) far = i;
      dropVehicle(far);
      drop -= 1;
    }
  }

  // --- stepping ------------------------------------------------------------------

  function idm(i, l, idx) {
    const e = laneEdge[l];
    let v0 = Math.max(0.3, edgeFree[e] * edgeRatio[e] * vFactor[i]);
    const toEnd = laneLen[l] - vS[i];
    if (toEnd < 40 && vTurnV[i] < v0) v0 = Math.min(v0, vTurnV[i] + toEnd * 0.3);
    const v = vV[i];
    let gap = 1e9;
    let dv = 0;
    const q = laneQ[l];
    if (idx > 0) {
      const j = q[idx - 1];
      gap = vS[j] - vS[i] - VEH_LEN;
      dv = v - vV[j];
    } else {
      const nl = vNext[i];
      if (nl >= 0 && nl !== l) {
        const nq = laneQ[nl];
        if (nq.length) {
          const j = nq[nq.length - 1];
          gap = toEnd + vS[j] - VEH_LEN;
          dv = v - vV[j];
        }
      }
    }
    const sStar = S0 + Math.max(0, v * T_HEAD + (v * dv) / IDM_SQRT_AB);
    const g = Math.max(0.1, gap);
    let a = A_MAX * (1 - (v / v0) ** 4 - (sStar / g) ** 2);
    if (a < -9) a = -9;
    return a;
  }

  function advanceLane(i, l) {
    const over = vS[i] - laneLen[l];
    const nl = vNext[i];
    laneQ[l].shift(); // i is the head of l
    if (nl < 0 || (!laneNear[nl] && edgeDist[laneEdge[nl]] > radiusM * 1.6)) {
      // Off the network, or wandered far from the view: re-enter near it.
      if (!place(i)) {
        // Nowhere free right now: park it at the end of its lane.
        vS[i] = laneLen[l] - 0.1;
        vV[i] = 0;
        insertSorted(l, i);
      }
      return;
    }
    const nq = laneQ[nl];
    const tail = nq.length ? vS[nq[nq.length - 1]] : Infinity;
    if (tail - over < VEH_LEN + 0.5) {
      // The next lane is full at its start: wait at the stop line.
      vS[i] = laneLen[l] - 0.05;
      vV[i] = 0;
      laneQ[l].unshift(i);
      return;
    }
    vS[i] = Math.min(over, laneLen[nl]);
    vLane[i] = nl;
    vHint[i] = 0;
    nq.push(i);
    chooseNext(i, nl);
  }

  function stepOnce(dt) {
    for (let l = 0; l < lanes; l += 1) {
      const q = laneQ[l];
      for (let idx = 0; idx < q.length; idx += 1) {
        const i = q[idx];
        vAcc[i] = idm(i, l, idx);
      }
    }
    for (let i = 0; i < n; i += 1) {
      const v0 = vV[i];
      const v1 = Math.max(0, v0 + vAcc[i] * dt);
      vV[i] = v1;
      vS[i] += ((v0 + v1) / 2) * dt;
    }
    for (let l = 0; l < lanes; l += 1) {
      const q = laneQ[l];
      // Never let a step push a follower into its leader.
      for (let idx = 1; idx < q.length; idx += 1) {
        const i = q[idx];
        const j = q[idx - 1];
        const maxS = vS[j] - VEH_LEN;
        if (vS[i] > maxS) {
          vS[i] = Math.max(0, maxS);
          if (vV[i] > vV[j]) vV[i] = vV[j];
        }
      }
      let guard = q.length;
      while (q.length && vS[q[0]] >= laneLen[l] && guard > 0) {
        advanceLane(q[0], l);
        guard -= 1;
      }
    }
  }

  // --- output ------------------------------------------------------------------

  function computePositions() {
    if (!net) return 0;
    const kx = net.kx;
    const ky = net.ky;
    for (let i = 0; i < n; i += 1) {
      const l = vLane[i];
      const e = net.edges[laneEdge[l]];
      const dir = laneDir[l];
      const d = dir > 0 ? vS[i] : laneLen[l] - vS[i];
      pointAt(e, d, vHint[i], scratch);
      const k = scratch.seg;
      vHint[i] = k;
      const tx = e.ux[k] * dir;
      const ty = e.uy[k] * dir;
      const off = laneOffset[l];
      outLon[i] = scratch.lon + (ty * off) / kx;
      outLat[i] = scratch.lat - (tx * off) / ky;
      outHeading[i] = Math.atan2(tx, ty);
      const hs = e.heights;
      outH[i] = hs ? (hs[k] || 0) + ((hs[k + 1] || 0) - (hs[k] || 0)) * scratch.f : 0;
    }
    return n;
  }

  return {
    /**
     * Load a road network. Vehicles on lanes that still exist keep their
     * place; the fleet is then topped up or trimmed for the new view.
     * @param {ReturnType<import('./roads.js').buildNetwork>} network
     * @param {{ focus: {lat:number, lon:number}, radiusM: number, leftHand?: boolean,
     *   seed?: number }} opts
     */
    setNetwork(network, opts) {
      const old = net
        ? Array.from({ length: n }, (_, i) => ({
            key: laneKey(
              net.edges[laneEdge[vLane[i]]],
              laneDir[vLane[i]],
              laneIdx[vLane[i]],
            ),
            s: vS[i],
            v: vV[i],
            f: vFactor[i],
          }))
        : [];
      const oldRatio = new Map();
      const oldFree = new Map();
      if (net) {
        for (const e of net.edges) {
          oldRatio.set(e.id, edgeRatio[e.index]);
          oldFree.set(e.id, edgeFree[e.index]);
        }
      }
      net = network;
      focus = { ...opts.focus };
      radiusM = opts.radiusM;
      leftHand = Boolean(opts.leftHand);
      if (opts.seed != null && !old.length) rnd = mulberry32(opts.seed);
      buildLanes();
      const E = net.edges.length;
      edgeRatio = new Float32Array(E);
      edgeFree = new Float32Array(E);
      for (const e of net.edges) {
        edgeRatio[e.index] = oldRatio.get(e.id) ?? 1;
        edgeFree[e.index] = oldFree.get(e.id) ?? e.freeKmh / 3.6;
      }
      measureFocus();
      // Carry vehicles over by lane key.
      const keyToLane = new Map();
      for (let l = 0; l < lanes; l += 1) {
        keyToLane.set(laneKey(net.edges[laneEdge[l]], laneDir[l], laneIdx[l]), l);
      }
      n = 0;
      for (const o of old) {
        const l = keyToLane.get(o.key);
        if (l === undefined || n >= CAP) continue;
        vLane[n] = l;
        vS[n] = Math.min(o.s, laneLen[l] - 0.1);
        vV[n] = o.v;
        vFactor[n] = o.f;
        vHint[n] = 0;
        insertSorted(l, n);
        n += 1;
      }
      for (let i = 0; i < n; i += 1) chooseNext(i, vLane[i]);
      rebalance(true);
    },
    /**
     * Congestion per edge: ratio (current / free-flow, 0..1) and optionally a
     * measured free-flow speed (km/h). Edges not listed keep theirs.
     * @param {(edge: object) => ({ ratio?: number, freeKmh?: number }|null)} lookup
     */
    setFlow(lookup) {
      if (!net) return;
      for (const e of net.edges) {
        const f = lookup(e);
        const r = f?.ratio;
        edgeRatio[e.index] = Number.isFinite(r) ? Math.max(0.03, Math.min(1, r)) : 1;
        edgeFree[e.index] =
          Number.isFinite(f?.freeKmh) && f.freeKmh > 3
            ? f.freeKmh / 3.6
            : e.freeKmh / 3.6;
      }
      measureFocus();
      rebalance();
    },
    /** The view moved: weight spawning and the fleet size to the new focus. */
    setFocus(f, r) {
      if (!net) return;
      focus = { lat: f.lat, lon: f.lon };
      radiusM = r;
      measureFocus();
      rebalance();
    },
    /** Advance by dt seconds (sub-stepped; more than a second is skipped). */
    step(dt) {
      if (!net || !n) return;
      let left = Math.min(Math.max(0, dt), 1);
      while (left > 1e-4) {
        const h = Math.min(MAX_DT, left);
        stepOnce(h);
        left -= h;
      }
    },
    computePositions,
    get count() {
      return n;
    },
    get target() {
      return target;
    },
    get network() {
      return net;
    },
    // Read-only views of the outputs (valid for the first `count` entries).
    lon: outLon,
    lat: outLat,
    height: outH,
    heading: outHeading,
    speed: vV,
    /** The edge a vehicle drives on (for tests and readouts). */
    edgeOf: (i) => (net && i < n ? net.edges[laneEdge[vLane[i]]] : null),
    /** Distance along the lane and lane id (for tests). */
    _state: (i) => ({ lane: vLane[i], s: vS[i], v: vV[i], len: laneLen[vLane[i]] }),
    _lanes: () => ({ count: lanes, queues: laneQ }),
  };
}

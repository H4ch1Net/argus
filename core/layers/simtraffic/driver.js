import { createSimulation } from './sim.js';
import { congestionLevel } from './flow.js';

// The simulation driven from the traffic model without Cesium: the terminal
// shell's simulated traffic (a vehicle per record, positioned by time). It
// follows the model's version counters exactly as the globe's renderer does
// and steps lazily to the time it is asked about. Pure.

/** A view for the model from a map box: its middle, and a camera height that sees it. */
export function viewOfBbox(bbox) {
  if (!bbox) return null;
  const spanM = (bbox.lamax - bbox.lamin) * 110_540;
  return {
    lat: (bbox.lamin + bbox.lamax) / 2,
    lon: (bbox.lomin + bbox.lomax) / 2,
    heightM: spanM / 1.15,
  };
}

/** @param {{ cap?: number }} [opts] */
export function createSimDriver({ cap = 150 } = {}) {
  const sim = createSimulation({ cap });
  const seen = { version: -1, flowVersion: -1, focusVersion: -1 };
  let model = null;
  let lastT = null;

  function sync(m) {
    model = m;
    if (!m) return;
    if (seen.version !== m.version) {
      seen.version = m.version;
      seen.focusVersion = m.focusVersion;
      seen.flowVersion = -1;
      if (m.network && m.active) {
        sim.setNetwork(m.network, {
          focus: m.focus,
          radiusM: m.radiusM,
          leftHand: m.leftHand,
          seed: m.seed,
        });
      }
    }
    if (seen.flowVersion !== m.flowVersion) {
      seen.flowVersion = m.flowVersion;
      sim.setFlow((e) => m.flow.get(e.id));
    }
    if (seen.focusVersion !== m.focusVersion) {
      seen.focusVersion = m.focusVersion;
      sim.setFocus(m.focus, m.radiusM);
    }
    m.vehicles = m.active ? sim.count : 0;
  }

  function advance(t) {
    if (lastT == null || t < lastT) lastT = t;
    if (t - lastT > 0) {
      sim.step((t - lastT) / 1000);
      lastT = t;
      sim.computePositions();
    }
  }

  return {
    sync,
    advance,
    /** Normalized records for the current fleet (ids by slot). */
    vehicles(t) {
      if (!model?.active) return [];
      advance(t);
      sim.computePositions();
      const out = [];
      for (let i = 0; i < sim.count; i += 1) {
        const e = sim.edgeOf(i);
        out.push({
          id: `sim-${i}`,
          type: 'simvehicle',
          position: { longitude: sim.lon[i], latitude: sim.lat[i], altitude: 0 },
          meta: {
            slot: i,
            road: e?.name || e?.ref || e?.cls || 'road',
            cls: e?.cls ?? null,
            freeKmh: e?.freeKmh ?? null,
            flow: e ? (model.flow.get(e.id) ?? null) : null,
            demo: Boolean(model.demo),
          },
        });
      }
      return out;
    },
    /** A slot's position at time t, or null (the fleet shrank). */
    positionAt(slot, t) {
      if (!model?.active || slot >= sim.count) return null;
      advance(t);
      return { longitude: sim.lon[slot], latitude: sim.lat[slot], altitude: 0 };
    },
    speedKmh: (slot) => (slot < sim.count ? sim.speed[slot] * 3.6 : null),
    sim,
  };
}

/** The card for a simulated vehicle (the terminal; the globe never selects one). */
export function describeSimVehicle(n, speedKmh = null) {
  const m = n.meta;
  const level = m.flow ? congestionLevel(m.flow.ratio) : null;
  return {
    id: n.id,
    title: 'SIMULATED VEHICLE',
    subtitle: m.demo
      ? 'demo roads, not a real vehicle'
      : 'a model on OSM roads, not a real vehicle',
    rows: [
      ['Road', m.road],
      ['Class', m.cls ?? '—'],
      ['Speed', Number.isFinite(speedKmh) ? `${Math.round(speedKmh)} km/h` : '—'],
      ['Free-flow', Number.isFinite(m.freeKmh) ? `${Math.round(m.freeKmh)} km/h` : '—'],
      [
        'Congestion',
        level
          ? `${level} (${m.flow.measured ? 'TomTom, measured' : 'TomTom, inferred'})`
          : 'none known: free-flow',
      ],
    ],
  };
}

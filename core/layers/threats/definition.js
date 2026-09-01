import * as Cesium from 'cesium';
import { arcPeakHeight, arcPointAt } from '../sdk/greatCircle.js';
import { describeThreat, severityColorHex } from './format.js';

// Threat-map arcs (Pillar 3): animated great-circle arcs source-geo -> target-geo
// over the globe, the ethical-hacker analogue of the earthquakes layer. A PUSH
// layer of ephemeral events; each arc fades out after staleMs. GUARDRAIL: this is
// awareness/ambiance, NOT forensic attribution. IP geolocation is not locating a
// person, attackers proxy, and inputs are geos, never people. Real feeds
// (GreyNoise, honeypots, AbuseIPDB) are keyed and unverified, so this ships with
// a synthetic dev source; a verified feed drops into the same push contract.

const PULSE_PERIOD_MS = 3200;

// Stable small hash of the id, so each arc's pulse starts at its own phase
// instead of all pulses marching in lockstep.
function phaseOf(id) {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % PULSE_PERIOD_MS;
}

function toNormalized(a) {
  return {
    id: a.id,
    type: 'threat',
    position: { longitude: a.from.longitude, latitude: a.from.latitude, altitude: 0 },
    meta: {
      arc: { from: a.from, to: a.to },
      category: a.category,
      severity: a.severity,
      sourceLabel: a.sourceLabel,
      targetLabel: a.targetLabel,
    },
  };
}

export const threatsDefinition = {
  id: 'threats',
  fetch: { mode: 'push' },
  staleMs: 15_000, // ambient events: fade the arc out ~15s after it arrives
  maxEntities: 250,
  normalize: (arcs) => arcs.map(toNormalized),
  // Rides a bright pulse point along the arc; presence of positionAt makes the
  // layer a mover, so the SDK forces continuous rendering while it is enabled.
  positionAt: (n, nowMs) => {
    const { arc } = n.meta;
    n.meta._peak ??= arcPeakHeight(arc.from, arc.to);
    n.meta._phase ??= phaseOf(n.id);
    const t = ((nowMs + n.meta._phase) % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
    return arcPointAt(arc.from, arc.to, t, n.meta._peak);
  },
  render: {
    renderType: 'arc',
    width: 2,
    style: (n) => {
      const c = Cesium.Color.fromCssColorString(severityColorHex(n.meta.severity));
      return { color: c.withAlpha(0.85), pulseColor: c, pulseSize: 7 };
    },
  },
  describe: (n) => describeThreat(n),
  searchText: (n) =>
    `${n.meta.category} ${n.meta.targetLabel || ''} ${n.meta.sourceLabel || ''}`,
};

import * as Cesium from 'cesium';
import { collectorFor } from './collectors.js';

// BGP routing activity (Pillar 3, CT/BGP stage): live RIPE RIS Live UPDATEs,
// sampled by the proxy, plotted as brief pulses at the RIS collector that
// observed them. A PUSH layer of ephemeral events (each fades out via staleness),
// so active collectors "heartbeat" as routes change. Announcements are cyan,
// withdrawals amber. GUARDRAIL: public routing telemetry, an asset-level view of
// the internet's own infrastructure; no people, nothing sent at any host.

let eventSeq = 0;

// Small deterministic jitter so overlapping pulses at one collector don't stack
// exactly on top of each other.
function jitter(seed) {
  const r = Math.sin(seed * 12.9898) * 43758.5453;
  return (r - Math.floor(r) - 0.5) * 1.6; // ~+/-0.8 degrees
}

function toNormalized(ev) {
  const c = collectorFor(ev.rrc);
  if (!c) return null;
  const seed = ev.id ?? eventSeq++;
  return {
    id: `bgp:${ev.rrc}:${ev.id ?? seed}`,
    type: 'bgp',
    position: {
      longitude: c.longitude + jitter(seed),
      latitude: c.latitude + jitter(seed + 7.1),
      altitude: 0,
    },
    meta: { rrc: ev.rrc, city: c.city, kind: ev.kind, asn: ev.asn },
  };
}

export const bgpDefinition = {
  id: 'bgp',
  fetch: { mode: 'push' },
  staleMs: 2200, // a pulse lingers ~2s, then the sweep removes it
  maxEntities: 400,
  normalize: (events) => events.map(toNormalized).filter(Boolean),
  render: {
    renderType: 'point',
    style: (n) => {
      const announce = n.meta.kind === 'A';
      return {
        pixelSize: 7,
        color: Cesium.Color.fromCssColorString(
          announce ? '#5fe3ff' : '#ffb454',
        ).withAlpha(0.9),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.5),
        outlineWidth: 1,
      };
    },
  },
  describe: (n) => ({
    id: n.id,
    title: `BGP ${n.meta.kind === 'A' ? 'announcement' : 'withdrawal'}`,
    subtitle: `observed at ${n.meta.city} (${n.meta.rrc})`,
    rows: [
      ['Collector', n.meta.rrc],
      ['Location', n.meta.city],
      ['Origin AS', n.meta.asn != null ? `AS${n.meta.asn}` : '—'],
      ['Type', n.meta.kind === 'A' ? 'announcement' : 'withdrawal'],
    ],
  }),
  searchText: (n) => `${n.meta.rrc} ${n.meta.city} AS${n.meta.asn ?? ''}`,
};

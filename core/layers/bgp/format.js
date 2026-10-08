import { collectorFor } from './collectors.js';

// BGP event normalization + card. Pure (no Cesium), shared by the globe layer and
// the terminal shell. GUARDRAIL: public routing telemetry about the internet's
// own infrastructure; no people, nothing sent at any host.

let eventSeq = 0;

// Small deterministic jitter so overlapping pulses at one collector don't stack
// exactly on top of each other.
function jitter(seed) {
  const r = Math.sin(seed * 12.9898) * 43758.5453;
  return (r - Math.floor(r) - 0.5) * 1.6; // ~+/-0.8 degrees
}

/** A proxy BGP event { id, rrc, kind, asn } -> a normalized entity at its collector. */
export function bgpEventToNormalized(ev) {
  const c = collectorFor(ev?.rrc);
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

export function describeBgp(n) {
  return {
    id: n.id,
    title: `BGP ${n.meta.kind === 'A' ? 'announcement' : 'withdrawal'}`,
    subtitle: `observed at ${n.meta.city} (${n.meta.rrc})`,
    rows: [
      ['Collector', n.meta.rrc],
      ['Location', n.meta.city],
      ['Origin AS', n.meta.asn != null ? `AS${n.meta.asn}` : '—'],
      ['Type', n.meta.kind === 'A' ? 'announcement' : 'withdrawal'],
    ],
  };
}

export const bgpSearchText = (n) => `${n.meta.rrc} ${n.meta.city} AS${n.meta.asn ?? ''}`;

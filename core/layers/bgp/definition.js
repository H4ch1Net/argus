import { bgpEventToNormalized, describeBgp, bgpSearchText } from './format.js';
import { ink } from '../sdk/colors.js';

// BGP routing activity (Pillar 3, CT/BGP stage): live RIPE RIS Live UPDATEs,
// sampled by the proxy, plotted as brief pulses at the RIS collector that
// observed them. A PUSH layer of ephemeral events (each fades out via staleness),
// so active collectors "heartbeat" as routes change. Announcements are cyan,
// withdrawals amber. GUARDRAIL: public routing telemetry, an asset-level view of
// the internet's own infrastructure; no people, nothing sent at any host.

export const bgpDefinition = {
  id: 'bgp',
  fetch: { mode: 'push' },
  staleMs: 2200, // a pulse lingers ~2s, then the sweep removes it
  maxEntities: 400,
  normalize: (events) => events.map(bgpEventToNormalized).filter(Boolean),
  render: {
    // Announcements cyan, withdrawals textSecondary.
    renderType: 'point',
    style: (n) => ({
      glyph: 'dot',
      pixelSize: 9,
      color: n.meta.kind === 'A' ? ink('cyan', 0.9) : ink('muted', 0.9),
    }),
  },
  describe: describeBgp,
  searchText: bgpSearchText,
};

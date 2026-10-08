import * as Cesium from 'cesium';
import { bgpEventToNormalized, describeBgp, bgpSearchText } from './format.js';

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
  describe: describeBgp,
  searchText: bgpSearchText,
};

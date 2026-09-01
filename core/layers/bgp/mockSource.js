import { RIS_COLLECTORS } from './collectors.js';

// Dev-only mock BGP source: synthetic RIS-Live-shaped events at random real
// collectors, emitted in bursts, so the push pipeline and the collector-pulse
// visualization are demoable without a proxy. Dev-gated + dynamic-imported.

const RRCS = Object.keys(RIS_COLLECTORS);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export function createBgpMockSource({ intervalMs = 700, perBurst = 5 } = {}) {
  let id = 0;
  return (onBatch) => {
    const tick = () => {
      const events = [];
      for (let i = 0; i < perBurst; i += 1) {
        events.push({
          id: id++,
          rrc: pick(RRCS),
          kind: Math.random() < 0.75 ? 'A' : 'W',
          asn: 64500 + Math.floor(Math.random() * 500),
        });
      }
      onBatch(events);
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  };
}

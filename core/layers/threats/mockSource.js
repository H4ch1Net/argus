// Dev-only mock threat-arc source: synthetic source->target attack arcs between
// well-known city centroids, emitted in bursts. It feeds the exact push pipeline
// the real (keyed, unverified) honeypot / GreyNoise feeds will use. GUARDRAIL:
// synthetic, ambient/awareness only, never forensic attribution; the endpoints
// are geographies, never people. Dev-gated + dynamic-imported, never shipped.

const NODES = [
  { label: 'Ashburn, US', longitude: -77.49, latitude: 39.04 },
  { label: 'Frankfurt, DE', longitude: 8.68, latitude: 50.11 },
  { label: 'Amsterdam, NL', longitude: 4.9, latitude: 52.37 },
  { label: 'Singapore, SG', longitude: 103.82, latitude: 1.35 },
  { label: 'Sao Paulo, BR', longitude: -46.63, latitude: -23.55 },
  { label: 'Moscow, RU', longitude: 37.62, latitude: 55.75 },
  { label: 'Mumbai, IN', longitude: 72.88, latitude: 19.08 },
  { label: 'Tokyo, JP', longitude: 139.69, latitude: 35.69 },
  { label: 'Sydney, AU', longitude: 151.21, latitude: -33.87 },
  { label: 'Lagos, NG', longitude: 3.38, latitude: 6.52 },
];

// [category, severity]
const CATS = [
  ['scanner', 1],
  ['bruteforce', 2],
  ['exploit', 3],
  ['malware', 3],
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function createThreatMockSource({ intervalMs = 1500, perBurst = 3 } = {}) {
  let seq = 0;
  return (onBatch) => {
    const tick = () => {
      const arcs = [];
      for (let i = 0; i < perBurst; i += 1) {
        const s = pick(NODES);
        let d = pick(NODES);
        while (d === s) d = pick(NODES);
        const [category, severity] = pick(CATS);
        arcs.push({
          id: `atk-${seq++}`,
          from: { longitude: s.longitude, latitude: s.latitude },
          to: { longitude: d.longitude, latitude: d.latitude },
          sourceLabel: s.label,
          targetLabel: d.label,
          category,
          severity,
        });
      }
      onBatch(arcs);
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  };
}

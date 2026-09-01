// Threat-arc styling + card model. Pure. Severity is 1 (low) .. 3 (high).
// GUARDRAIL: these are ambient, awareness-only events (IP geolocation, never a
// person); the card says so and the layer never claims forensic attribution.

const CATEGORY_LABEL = {
  scanner: 'Mass scanner',
  bruteforce: 'Brute-force',
  exploit: 'Exploit attempt',
  malware: 'Malware C2',
};

const SEVERITY_LABEL = { 1: 'low', 2: 'medium', 3: 'high' };

export function severityColorHex(severity) {
  if (severity >= 3) return '#ff3b3b';
  if (severity === 2) return '#ff9a3b';
  return '#ffd23b';
}

const coord = (p) => `${p.latitude.toFixed(1)}, ${p.longitude.toFixed(1)}`;

export function describeThreat(n) {
  const m = n.meta;
  return {
    id: n.id,
    title: CATEGORY_LABEL[m.category] || m.category || 'Threat event',
    subtitle: 'awareness / ambient (not attribution)',
    rows: [
      ['Source', m.sourceLabel || coord(m.arc.from)],
      ['Target', m.targetLabel || coord(m.arc.to)],
      ['Severity', SEVERITY_LABEL[m.severity] || 'low'],
    ],
  };
}

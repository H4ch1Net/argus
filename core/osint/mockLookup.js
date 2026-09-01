// DEV-only stand-in for the RIPEstat lookup so the query console is demoable
// without a proxy. Returns deterministic, obviously-synthetic enrichment at a
// hashed location. Never shipped: main.js imports this only under import.meta.env.DEV.

const hash = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

// Deterministic pseudo-coordinates from the asset string.
function coordsFor(value) {
  const h = hash(value);
  return { longitude: (h % 3600) / 10 - 180, latitude: ((h >> 5) % 1700) / 10 - 85 };
}

export function createMockLookup() {
  return async ({ kind, value }) => {
    const { longitude, latitude } = coordsFor(value);
    const asn = 64500 + (hash(value) % 500); // documentation ASN range
    const rows = [
      ['Prefix', kind === 'asn' ? '203.0.113.0/24' : '198.51.100.0/24'],
      ['ASN', `AS${asn}`],
      ['Operator', 'MOCK-NET (synthetic)'],
      ['Location', 'Synthetic, XX'],
      ['Coordinates', `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`],
    ];
    if (kind === 'domain') rows.unshift(['Resolves to', '198.51.100.7']);
    return {
      id: `${kind}:${value}`,
      kind,
      value,
      position: { longitude, latitude },
      card: {
        id: `${kind}:${value}`,
        title: value,
        subtitle: `${kind} (synthetic dev lookup)`,
        rows,
      },
      sources: ['mock'],
    };
  };
}

// DEV-only stand-in for the multi-source correlator: a synthetic sectioned
// composite so asset correlation is demoable without a proxy.
export function createMockCorrelator() {
  return async ({ kind, value }) => {
    const { longitude, latitude } = coordsFor(value);
    const asn = 64500 + (hash(value) % 500);
    const rows = [];
    if (kind === 'domain') rows.push(['Resolves to', '198.51.100.7']);
    rows.push(['Location', 'Synthetic, XX']);
    rows.push(['Coordinates', `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`]);
    return {
      id: `corr:${kind}:${value}`,
      kind,
      value,
      variant: 'correlated',
      position: { longitude, latitude },
      card: {
        id: `corr:${kind}:${value}`,
        title: value,
        subtitle: `${kind} · correlated across RIPEstat + Shodan (synthetic)`,
        rows,
        sections: [
          {
            title: 'Routing (RIPEstat)',
            rows: [
              ['Prefix', '198.51.100.0/24'],
              ['ASN', `AS${asn}`],
              ['Operator', 'MOCK-NET (synthetic)'],
              ['Announced prefixes', '7'],
            ],
          },
          {
            title: 'Announced prefixes (sample)',
            rows: [
              ['#1', '198.51.100.0/24'],
              ['#2', '203.0.113.0/24'],
            ],
          },
          {
            title: 'Exposure (Shodan)',
            rows: [
              ['Open ports', '22, 80, 443'],
              ['Hostnames', `${value}`],
              ['Tags', 'cloud'],
            ],
          },
        ],
      },
      sources: ['RIPEstat', 'Shodan'],
    };
  };
}

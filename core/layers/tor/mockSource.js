// Dev / demo stand-in for Onionoo: an Onionoo-shaped relay list (no
// coordinates, as Onionoo answers today) across a few countries.

const COUNTRIES = ['de', 'us', 'nl', 'fr', 'se', 'ch', 'lu', 'ro'];

export function demoOnionoo(count = 160) {
  const relays = Array.from({ length: count }, (_, i) => {
    const flags = ['Fast', 'Running', 'Valid', 'Stable'];
    if (i % 5 === 0) flags.push('Exit');
    if (i % 3 === 0) flags.push('Guard');
    return {
      nickname: `demoRelay${i}`,
      fingerprint: (i * 2654435761).toString(16).toUpperCase().padStart(40, '0').slice(-40),
      country: COUNTRIES[i % COUNTRIES.length],
      country_name: 'Demo (simulated)',
      as: `AS${64500 + (i % 10)}`,
      as_name: 'Demo network (simulated)',
      flags,
      observed_bandwidth: 1_000_000 + i * 50_000,
      demo: true,
    };
  });
  return { relays_published: new Date().toISOString().slice(0, 19), relays };
}

export function createTorMockSource() {
  return async () => demoOnionoo();
}

// DEV-only mock CT firehose: synthetic newly-issued certs, matching the proxy's
// /ws/ct event shape, so the issuance ticker is demoable without a working
// CertStream upstream (the public one is frequently silent). Dev-gated.

const LABELS = [
  'app',
  'api',
  'mail',
  'cdn',
  'shop',
  'dev',
  'staging',
  'vpn',
  'auth',
  'login',
];
const TLDS = ['com', 'net', 'io', 'org', 'dev', 'co', 'app', 'xyz'];
const CAS = [
  "Let's Encrypt",
  'Google Trust Services',
  'DigiCert Inc',
  'Sectigo Limited',
  'Cloudflare, Inc.',
];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const word = () =>
  Math.random()
    .toString(36)
    .slice(2, 2 + 4 + Math.floor(Math.random() * 5));

export function createCtMockSource({ intervalMs = 600, perBurst = 4 } = {}) {
  let id = 0;
  return (onBatch) => {
    const tick = () => {
      const certs = [];
      for (let i = 0; i < perBurst; i += 1) {
        const base = `${word()}.${pick(TLDS)}`;
        certs.push({
          id: id++,
          domain: Math.random() < 0.5 ? `${pick(LABELS)}.${base}` : base,
          domains: 1 + Math.floor(Math.random() * 6),
          ca: pick(CAS),
        });
      }
      onBatch(certs);
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  };
}

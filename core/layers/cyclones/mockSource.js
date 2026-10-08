// Dev / demo-only cyclones: a CurrentStorms.json-shaped payload with two
// simulated storms, so the layer can be exercised offline or out of season.

export function createCycloneMockSource() {
  const t0 = Date.now();
  return async () => {
    const drift = (Date.now() - t0) / 3.6e6; // degrees per hour, roughly
    return {
      demo: true,
      activeStorms: [
        {
          id: 'al992026',
          name: 'Demo Alpha',
          classification: 'HU',
          intensity: '105',
          pressure: '950',
          latitudeNumeric: 24 + drift * 0.2,
          longitudeNumeric: -70 - drift * 0.3,
          movementDir: 300,
          movementSpeed: 11,
          lastUpdate: new Date().toISOString(),
        },
        {
          id: 'ep982026',
          name: 'Demo Beta',
          classification: 'TS',
          intensity: '45',
          pressure: '1000',
          latitudeNumeric: 15 + drift * 0.1,
          longitudeNumeric: -108 - drift * 0.2,
          movementDir: 290,
          movementSpeed: 9,
          lastUpdate: new Date().toISOString(),
        },
      ],
    };
  };
}

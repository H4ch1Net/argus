// Presets: first-class core UX (master plan 8). "Everything on" is unusable mud
// and a phone-killer; presets make omniscience navigable. Each preset is a named
// set of layers. Only presets whose layers exist today are listed; more join as
// their layers land (Surveillance, Environment, etc.).
//
// Pure over the manager interface, so applyPreset is unit-testable with a fake.

export const PRESETS = [
  { id: 'around-me', label: 'Around Me', layers: ['flights', 'quakes'], geolocate: true },
  { id: 'sky', label: 'Sky', layers: ['flights', 'satellites'] },
  { id: 'disaster', label: 'Disaster', layers: ['quakes', 'fires'] },
  { id: 'environment', label: 'Environment', layers: ['fires'] },
  {
    id: 'surveillance',
    label: 'Surveillance',
    layers: ['surveillance', 'landmarks', 'cctv'],
  },
];

/** The default-on set (master plan 8): flights + earthquakes (+ one transit, N/A yet). */
export const DEFAULT_LAYERS = ['flights', 'quakes'];

/**
 * Enable exactly the preset's layers, disabling the rest.
 * @param {{ keys: () => string[], enable: (k: string) => unknown, disable: (k: string) => void }} manager
 * @param {{ layers: string[] }} preset
 */
export async function applyPreset(manager, preset) {
  const wanted = new Set(preset.layers);
  await Promise.all(
    manager
      .keys()
      .map((key) => (wanted.has(key) ? manager.enable(key) : manager.disable(key))),
  );
}

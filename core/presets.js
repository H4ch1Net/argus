// Presets: first-class core UX (master plan 8). "Everything on" is unusable mud
// and a phone-killer; presets make omniscience navigable. Each preset is a named
// set of layers. A shell that lacks a layer (the terminal has no imagery
// overlays) simply skips it.
//
// Pure over the manager interface, so applyPreset is unit-testable with a fake.

export const PRESETS = [
  {
    id: 'around-me',
    label: 'Around Me',
    layers: ['flights', 'quakes', 'transit'],
    geolocate: true,
  },
  { id: 'sky', label: 'Sky', layers: ['flights', 'military', 'satellites', 'launches'] },
  {
    id: 'disaster',
    label: 'Disaster',
    layers: ['quakes', 'fires', 'cyclones', 'clouds'],
  },
  { id: 'environment', label: 'Environment', layers: ['fires', 'clouds', 'radar'] },
  {
    id: 'surveillance',
    label: 'Surveillance',
    layers: ['surveillance', 'landmarks', 'cctv', 'installations'],
  },
  { id: 'internet', label: 'Internet', layers: ['bgp', 'cables', 'datacenters'] },
];

/** The default-on set (master plan 8): flights + earthquakes + one transit feed. */
export const DEFAULT_LAYERS = ['flights', 'quakes', 'transit'];

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

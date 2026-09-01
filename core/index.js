// Core public API.
//
// The shared engine (master plan 3.2): capability detection, Cesium scene setup,
// and later the Layer SDK, data integrations, proxy client, and search. Nothing
// in here may require a mouse, keyboard, or desktop GPU. Shells consume this API
// and add input + layout + quality-unlock on top.

import { detectCapabilities } from './capability/detect.js';
import { deriveTier } from './capability/tier.js';
import { qualityProfileForTier } from './capability/profile.js';
import { createViewer } from './scene/createViewer.js';
import { createCapabilityReadout } from './ui/capabilityReadout.js';

export { detectCapabilities } from './capability/detect.js';
export { deriveTier, Tier } from './capability/tier.js';
export { qualityProfileForTier } from './capability/profile.js';
export { createCapabilityReadout } from './ui/capabilityReadout.js';

/**
 * Boot the bare globe into a container.
 *
 * Detects capabilities, derives a tier and quality profile, builds the Cesium
 * scene, and returns handles the shell can use. This is the Phase 1 entry point;
 * layers and presets attach here in later phases.
 *
 * @param {HTMLElement} container
 * @param {object} [opts]
 * @param {(state: { lost: boolean }) => void} [opts.onContextChange]
 * @returns {Promise<{
 *   viewer: import('cesium').Viewer,
 *   capabilities: object,
 *   tier: string,
 *   reasons: string[],
 *   profile: object,
 *   readout: { el: HTMLElement, setContextLost: (lost: boolean) => void },
 *   detach: () => void,
 * }>}
 */
export async function bootGlobe(container, opts = {}) {
  const capabilities = detectCapabilities();
  const { tier, reasons } = deriveTier(capabilities);
  const profile = qualityProfileForTier(tier, capabilities);

  const readout = createCapabilityReadout({ capabilities, tier, reasons, profile });

  const onContextChange = ({ lost }) => {
    readout.setContextLost(lost);
    opts.onContextChange?.({ lost });
  };

  const { viewer, detach } = await createViewer(container, { profile, onContextChange });

  return { viewer, capabilities, tier, reasons, profile, readout, detach };
}

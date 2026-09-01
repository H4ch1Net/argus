// Capability tier: interpret a raw capabilities snapshot into one of three
// quality tiers. The tier is what the scene and (later) the layers branch on.
//
// The S25 Ultra is the baseline reference: desktop-class GPU silicon in a
// chassis that cannot dissipate desktop-class heat. So a strong-but-thermally-
// limited phone lands at BALANCED (30fps ambient, modest resolution, free
// terrain), and only a machine with real thermal + GPU headroom reaches FULL.

export const Tier = {
  // Weak or software GPU, low memory, or a save-data / metered environment.
  // Everything conservative; this is also the thermal-ladder fallback target.
  MINIMAL: 'minimal',
  // The mobile baseline. Capable device, limited sustained power budget.
  BALANCED: 'balanced',
  // Real headroom: discrete-class GPU, plenty of memory, unmetered network.
  // Quality unlocks upward from here (photorealistic, 60fps, stacked shaders).
  FULL: 'full',
};

export const TIER_ORDER = [Tier.MINIMAL, Tier.BALANCED, Tier.FULL];

/**
 * Derive a quality tier from a capabilities snapshot.
 *
 * @param {ReturnType<import('./detect.js').detectCapabilities>} caps
 * @returns {{ tier: string, reasons: string[] }}
 */
export function deriveTier(caps) {
  const reasons = [];

  // Hard floor: no WebGL, or software rendering, cannot run the globe well
  // (and Cesium hard-fails on software rendering by default). Pin to MINIMAL
  // and let the boot layer surface the hardware-acceleration warning.
  if (!caps.webgl.supported) {
    return { tier: Tier.MINIMAL, reasons: ['no WebGL support'] };
  }
  if (caps.webgl.softwareRendering) {
    return { tier: Tier.MINIMAL, reasons: ['software rendering (no GPU acceleration)'] };
  }

  // Score upward from a neutral baseline. Positive points push toward FULL,
  // negative toward MINIMAL; the middle band is BALANCED.
  let score = 0;

  // GPU capability, proxied by max texture size and WebGL2.
  if (caps.webgl.version >= 2) score += 1;
  if (caps.webgl.maxTextureSize >= 16384) score += 1;
  else if (caps.webgl.maxTextureSize < 8192) score -= 1;

  // Memory (GiB). navigator.deviceMemory is coarse and caps out at 8 on many
  // browsers, so treat 8 as "ample" rather than expecting more.
  if (caps.deviceMemory != null) {
    if (caps.deviceMemory <= 2) score -= 2;
    else if (caps.deviceMemory <= 4) score -= 1;
    else if (caps.deviceMemory >= 8) score += 1;
  }

  // CPU cores: a weak proxy for overall device class.
  if (caps.cpuCores != null) {
    if (caps.cpuCores <= 4) score -= 1;
    else if (caps.cpuCores >= 8) score += 1;
  }

  // Network: metered / save-data caps quality regardless of raw horsepower.
  if (caps.network.metered) {
    score -= 2;
    reasons.push('metered or save-data network');
  }

  // Input + form factor: a coarse-pointer, touch-primary device is treated as
  // a phone/tablet for thermal purposes even when its GPU benchmarks high.
  // This is the S25-baseline rule: capable, but never chase FULL on a phone.
  const looksHandheld =
    caps.input.coarsePointer && !caps.input.hover && caps.screen.longEdge <= 1600;
  if (looksHandheld) {
    reasons.push('handheld form factor (thermal cap)');
  }

  let tier;
  if (score <= -2) tier = Tier.MINIMAL;
  else if (score >= 2 && !looksHandheld) tier = Tier.FULL;
  else tier = Tier.BALANCED;

  if (reasons.length === 0) {
    reasons.push(`derived from capability score ${score >= 0 ? '+' : ''}${score}`);
  }

  return { tier, reasons };
}

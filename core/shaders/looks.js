// Which post-processing looks each capability tier may use, and the numbers
// behind the bloom and sharpen controls. Pure (no Cesium), so the gating is
// testable and readable in one place; sensorShaders.js applies it.
//
//   minimal  no post-processing at all (the caller creates no shaders).
//   balanced (phone) one full-screen pass at reduced resolution: NVG, FLIR or
//            Noir. Snow's particle field (~45 hashes per pixel, animated) is
//            the heaviest pass and is desktop-only; so are the stacked passes
//            (CRT, sharpen, bloom), which multiply the per-frame cost.
//   full     (desktop) every look at full resolution, stackable.

/** Every sensor mode, in menu order. */
export const SENSOR_MODES = Object.freeze(['none', 'nvg', 'flir', 'noir', 'snow']);

/** Display labels for the modes. */
export const SENSOR_LABELS = Object.freeze({
  none: 'Normal',
  nvg: 'NVG',
  flir: 'FLIR',
  noir: 'Noir',
  snow: 'Snow',
});

/** Modes whose shader animates (needs frames while on). */
export const ANIMATED_MODES = Object.freeze(['nvg', 'snow']);

/**
 * @param {string} tier  'minimal' | 'balanced' | 'full'
 * @returns {{ modes: string[], crt: boolean, sharpen: boolean, bloom: boolean,
 *   textureScale: number }}
 */
export function lookSupport(tier) {
  if (tier === 'full') {
    return {
      modes: [...SENSOR_MODES],
      crt: true,
      sharpen: true,
      bloom: true,
      textureScale: 1,
    };
  }
  if (tier === 'balanced') {
    return {
      modes: ['none', 'nvg', 'flir', 'noir'],
      crt: false,
      sharpen: false,
      bloom: false,
      textureScale: 0.66,
    };
  }
  return { modes: ['none'], crt: false, sharpen: false, bloom: false, textureScale: 1 };
}

/** A toggle or slider value as a strength in [0, 1]: true is the default 0.5. */
export function strength(value, fallback = 0.5) {
  if (value === true) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/** Unsharp-mask amount for a sharpen strength (reference: 0.1 + 2 x intensity). */
export const sharpenAmount = (s) => 0.1 + strength(s) * 2;

/**
 * Uniforms for Cesium's built-in bloom stage at a strength in [0, 1]. Below
 * 0.06 bloom is off. The eased mapping is the reference project's
 * (gods-eye-view src/ui/visualEffects.js, MIT).
 */
export function bloomUniforms(s) {
  const raw = strength(s);
  if (raw <= 0.06) return { enabled: false };
  const t = (raw - 0.06) / 0.94;
  const e = t * t * (3 - 2 * t);
  return {
    enabled: true,
    glowOnly: false,
    contrast: 255 - e * 168,
    brightness: -0.5 + e * 0.36,
    sigma: 0.28 + e * 6.3,
    delta: 0.2 + e * 2.25,
    stepSize: 1 + e * 1.25,
  };
}

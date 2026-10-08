import * as Cesium from 'cesium';
import { acquireContinuousRender, releaseContinuousRender } from '../scene/renderMode.js';
import {
  SENSOR_MODES,
  SENSOR_LABELS,
  ANIMATED_MODES,
  FLIR_PALETTES,
  NVG_GAINS,
  flirPaletteIndex,
  nvgGain,
  tapsFor,
  lookSupport,
  sharpenAmount,
  strength,
  bloomUniforms,
} from './looks.js';

// Sensor shaders and looks: NVG (night vision), FLIR (thermal, four palettes), Noir and Snow
// sensor modes, a CRT overlay, and sharpen and bloom toggles, as Cesium
// PostProcessStages. The danger zone on mobile (full-screen fragment passes,
// master plan 6.1), so they are capability-gated (looks.js):
//   - minimal tier: not created at all.
//   - balanced (phone): one pass (NVG, FLIR or Noir), rendered at reduced
//     resolution and upscaled (textureScale < 1).
//   - full (desktop): full resolution, every mode including Snow, and the CRT
//     overlay, sharpen and bloom may stack on top (multi-pass, desktop-only).
// Only animated looks (NVG noise, falling snow) hold a continuous-render claim;
// static ones re-apply on whatever frames the scene renders anyway.
//
// Cesium post-process fragment shaders receive `colorTexture`,
// `colorTextureDimensions` and `v_textureCoordinates`, and write `out_FragColor`.
// Noir, Snow and the sharpen pass are adapted from gods-eye-view
// src/styles/noir.js, src/styles/snow.js and src/ui/visualPresets.js (MIT).

export { SENSOR_MODES, SENSOR_LABELS, FLIR_PALETTES, NVG_GAINS };

// Night vision, as a Gen 3 image intensifier behaves: an automatic gain that
// lifts a dark scene and holds back a bright one (measured from a sparse grid
// over the frame), a soft-saturating tube response, halos around bright
// points (lights, contacts), scintillation that is strongest in the dark, the
// fibre-optic honeycomb, the P43 green-yellow phosphor and a soft tube edge.
// TAPS sets the halo samples (fewer on the phone).
const nvgFragment = (taps) => `
#define TAPS ${taps}
uniform sampler2D colorTexture;
uniform vec2 colorTextureDimensions;
uniform float time;
uniform float gain;
in vec2 v_textureCoordinates;
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  vec2 uv = v_textureCoordinates;
  vec2 px = 1.0 / colorTextureDimensions;
  float lum = luma(texture(colorTexture, uv).rgb);
  float avg = 0.0;
  for (int i = 0; i < 3; i++) {
    for (int j = 0; j < 3; j++) {
      avg += luma(texture(colorTexture, vec2(0.17 + 0.33 * float(i), 0.17 + 0.33 * float(j))).rgb);
    }
  }
  avg /= 9.0;
  float g = gain * clamp(0.32 / max(avg, 0.02), 0.7, 7.0);
  float l = 1.0 - exp(-lum * g * 1.8);
  float halo = 0.0;
  for (int k = 0; k < TAPS; k++) {
    float a = float(k) * 6.2831853 / float(TAPS);
    vec2 o = vec2(cos(a), sin(a)) * px * 7.0;
    halo += smoothstep(0.6, 1.0, luma(texture(colorTexture, uv + o).rgb) * g * 0.6);
  }
  l += halo / float(TAPS) * 0.45;
  float n = hash(floor(uv * colorTextureDimensions) + floor(fract(time * 7.3) * 97.0)) - 0.5;
  l += n * (0.06 + 0.16 * (1.0 - clamp(l, 0.0, 1.0)));
  vec2 q = uv * colorTextureDimensions / 2.5;
  l *= 0.95 + 0.05 * abs(sin(q.x * 3.1416) * sin((q.y + 0.5 * mod(floor(q.x), 2.0)) * 3.1416));
  vec3 phos = mix(vec3(0.015, 0.05, 0.02), vec3(0.66, 1.0, 0.52), clamp(l, 0.0, 1.15));
  vec2 d = (uv - 0.5) * vec2(colorTextureDimensions.x / colorTextureDimensions.y, 1.0);
  phos *= smoothstep(0.98, 0.42, length(d));
  out_FragColor = vec4(phos, 1.0);
}
`;

// Thermal (FLIR). A scene camera sees colour, not heat, so heat is estimated
// from it: water reads cold, vegetation cool, built-up and bare ground warm,
// lights and contacts (bright, white glyphs) hottest. Then what a thermal
// imager does: a slightly soft detector, an edge-enhancement pass (DDE), a
// fixed-pattern column noise, and the palette the operator picks (white hot,
// black hot, ironbow, rainbow). TAPS sets the edge kernel size.
const flirFragment = (taps) => `
#define TAPS ${taps}
uniform sampler2D colorTexture;
uniform vec2 colorTextureDimensions;
uniform float palette;
in vec2 v_textureCoordinates;
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float heatOf(vec3 c) {
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  float water = clamp((c.b - max(c.r, c.g)) * 4.0, 0.0, 1.0);
  float veg = clamp((c.g - max(c.r, c.b)) * 4.0, 0.0, 1.0);
  float h = 0.12 + lum * 0.82 - water * 0.3 - veg * 0.12;
  return clamp(h + smoothstep(0.85, 1.0, lum) * 0.25, 0.0, 1.0);
}
vec3 ironbow(float t) {
  vec3 a = vec3(0.0, 0.0, 0.0), b = vec3(0.2, 0.0, 0.45), c = vec3(0.75, 0.05, 0.35);
  vec3 d = vec3(1.0, 0.45, 0.0), e = vec3(1.0, 0.85, 0.2), f = vec3(1.0, 1.0, 0.95);
  if (t < 0.2) return mix(a, b, t / 0.2);
  if (t < 0.45) return mix(b, c, (t - 0.2) / 0.25);
  if (t < 0.65) return mix(c, d, (t - 0.45) / 0.2);
  if (t < 0.85) return mix(d, e, (t - 0.65) / 0.2);
  return mix(e, f, (t - 0.85) / 0.15);
}
vec3 rainbow(float t) {
  return clamp(vec3(
    1.5 - abs(4.0 * t - 3.0),
    1.5 - abs(4.0 * t - 2.0),
    1.5 - abs(4.0 * t - 1.0)
  ), 0.0, 1.0);
}
void main() {
  vec2 uv = v_textureCoordinates;
  vec2 px = 1.0 / colorTextureDimensions;
  float h = heatOf(texture(colorTexture, uv).rgb);
  float soft = 0.0;
  float edge = 0.0;
  for (int k = 0; k < TAPS; k++) {
    float a = float(k) * 6.2831853 / float(TAPS);
    float s = heatOf(texture(colorTexture, uv + vec2(cos(a), sin(a)) * px * 1.5).rgb);
    soft += s;
  }
  soft /= float(TAPS);
  edge = h - soft;
  float t = clamp(mix(h, soft, 0.35) + edge * 1.6, 0.0, 1.0);
  t += (hash(vec2(floor(uv.x * colorTextureDimensions.x), 3.0)) - 0.5) * 0.025;
  t = clamp(t, 0.0, 1.0);
  vec3 col;
  if (palette < 0.5) col = vec3(t);
  else if (palette < 1.5) col = vec3(1.0 - t);
  else if (palette < 2.5) col = ironbow(t);
  else col = rainbow(t);
  out_FragColor = vec4(col, 1.0);
}
`;

// CRT monitor: barrel curvature with rounded corners, an aperture-grille RGB
// mask, scanlines that thin out on bright lines, chromatic fringing, a little
// phosphor glow and a vignette. Static (no frames needed while idle).
const crtFragment = (taps) => `
#define TAPS ${taps}
uniform sampler2D colorTexture;
uniform vec2 colorTextureDimensions;
in vec2 v_textureCoordinates;
void main() {
  vec2 cc = v_textureCoordinates - 0.5;
  vec2 uv = v_textureCoordinates + cc * dot(cc, cc) * 0.14;
  vec2 edgeD = abs(uv - 0.5) * 2.0;
  float corner = smoothstep(1.0, 0.985, max(edgeD.x, edgeD.y))
    * smoothstep(0.06, 0.0, length(max(edgeD - 0.94, 0.0)));
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    out_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec2 px = 1.0 / colorTextureDimensions;
  float ca = 1.6 * px.x;
  vec3 col = vec3(
    texture(colorTexture, uv + vec2(ca, 0.0)).r,
    texture(colorTexture, uv).g,
    texture(colorTexture, uv - vec2(ca, 0.0)).b
  );
  vec3 glow = vec3(0.0);
  for (int k = 0; k < TAPS; k++) {
    float a = float(k) * 6.2831853 / float(TAPS);
    glow += texture(colorTexture, uv + vec2(cos(a), sin(a)) * px * 3.0).rgb;
  }
  col += glow / float(TAPS) * 0.18;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  float line = 0.5 + 0.5 * cos(uv.y * colorTextureDimensions.y * 3.1416);
  col *= mix(1.0, 0.55 + 0.45 * line, 1.0 - clamp(lum * 0.8, 0.0, 0.7));
  float m = mod(floor(uv.x * colorTextureDimensions.x), 3.0);
  vec3 mask = m < 1.0 ? vec3(1.0, 0.72, 0.72) : (m < 2.0 ? vec3(0.72, 1.0, 0.72) : vec3(0.72, 0.72, 1.0));
  col *= mask * 1.12;
  col *= smoothstep(0.98, 0.32, length(cc)) * corner;
  out_FragColor = vec4(col, 1.0);
}
`;

// Desaturate, contrast S-curve, static film grain, vignette, 15 % sepia.
const NOIR_FRAGMENT = `
uniform sampler2D colorTexture;
uniform vec2 colorTextureDimensions;
uniform float intensity;
uniform float contrastAmt;
uniform float grainAmt;
uniform float vignetteAmt;
in vec2 v_textureCoordinates;
void main() {
  vec2 uv = v_textureCoordinates;
  vec4 color = texture(colorTexture, uv);
  float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  vec3 desaturated = mix(color.rgb, vec3(luma), intensity);
  float contrast = 1.0 + contrastAmt * intensity;
  vec3 c = clamp((desaturated - 0.5) * contrast + 0.5, 0.0, 1.0);
  float grain = fract(sin(dot(uv * colorTextureDimensions, vec2(12.9898, 78.233))) * 43758.5453);
  c += (grain - 0.5) * 0.08 * grainAmt * intensity;
  vec2 vigUV = uv * (1.0 - uv);
  float vig = pow(vigUV.x * vigUV.y * 16.0, 0.3 + 0.4 * vignetteAmt * intensity);
  vec3 sepia = vec3(
    dot(c, vec3(0.393, 0.769, 0.189)),
    dot(c, vec3(0.349, 0.686, 0.168)),
    dot(c, vec3(0.272, 0.534, 0.131))
  );
  vec3 result = mix(c, sepia, 0.15 * intensity) * vig;
  out_FragColor = vec4(mix(color.rgb, result, intensity), color.a);
}
`;

// Cool shift, frost on bright areas, five layers of falling particles (a 3x3
// cell neighbourhood each, ~45 hashes per pixel), low fog. Desktop only.
const SNOW_FRAGMENT = `
uniform sampler2D colorTexture;
uniform float intensity;
uniform float time;
uniform float density;
uniform float wind;
in vec2 v_textureCoordinates;
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float snowLayer(vec2 uv, float layer) {
  float depth = 0.5 + layer * 0.5;
  float speed = 0.4 + layer * 0.3;
  float size = mix(0.01, 0.025, layer);
  float windForce = sin(time * 0.5 + layer * 3.14) * (0.05 + wind * 0.2);
  vec2 snowUV = uv * vec2(1.0, 0.5) * (4.0 + layer * 4.0);
  snowUV.y += time * speed;
  snowUV.x += time * windForce;
  vec2 cell = floor(snowUV);
  vec2 f = fract(snowUV);
  float snow = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 n = vec2(float(x), float(y));
      vec2 point = vec2(hash(cell + n), hash(cell + n + 100.0));
      point = 0.5 + 0.4 * sin(time * 0.3 + 6.2831 * point);
      snow += smoothstep(size, 0.0, length(f - n - point)) * depth;
    }
  }
  return snow;
}
void main() {
  vec2 uv = v_textureCoordinates;
  vec4 color = texture(colorTexture, uv);
  vec3 cool = color.rgb * vec3(0.85, 0.9, 1.1);
  float luma = dot(cool, vec3(0.299, 0.587, 0.114));
  vec3 c = mix(cool, vec3(luma), 0.4 * intensity);
  c = mix(c, vec3(1.0), 0.15 * intensity);
  c = mix(c, vec3(0.95, 0.97, 1.0), smoothstep(0.3, 0.8, luma) * 0.25 * intensity);
  float snow = snowLayer(uv, 0.0) * 0.5 + snowLayer(uv, 0.25) * 0.6
    + snowLayer(uv, 0.5) * 0.7 + snowLayer(uv, 0.75) * 0.8 + snowLayer(uv, 1.0);
  snow = clamp(snow * (0.4 + density * 1.2), 0.0, 1.0);
  vec3 result = c + snow * 0.8 * intensity;
  float fog = smoothstep(0.0, 0.4, 1.0 - uv.y) * 0.1 * intensity;
  result = mix(result, vec3(0.85, 0.88, 0.95), fog);
  out_FragColor = vec4(mix(color.rgb, result, intensity), color.a);
}
`;

// 9-tap unsharp mask: centre plus (centre - box blur) x amount.
const SHARPEN_FRAGMENT = `
uniform sampler2D colorTexture;
uniform vec2 colorTextureDimensions;
uniform float amount;
in vec2 v_textureCoordinates;
void main() {
  vec2 uv = v_textureCoordinates;
  vec2 t = 1.0 / colorTextureDimensions;
  vec4 center = texture(colorTexture, uv);
  vec4 blur = (
    texture(colorTexture, uv + vec2(-t.x, -t.y)) +
    texture(colorTexture, uv + vec2(0.0, -t.y)) +
    texture(colorTexture, uv + vec2(t.x, -t.y)) +
    texture(colorTexture, uv + vec2(-t.x, 0.0)) +
    center +
    texture(colorTexture, uv + vec2(t.x, 0.0)) +
    texture(colorTexture, uv + vec2(-t.x, t.y)) +
    texture(colorTexture, uv + vec2(0.0, t.y)) +
    texture(colorTexture, uv + vec2(t.x, t.y))
  ) / 9.0;
  vec4 sharpened = center + (center - blur) * amount;
  out_FragColor = vec4(clamp(sharpened.rgb, 0.0, 1.0), center.a);
}
`;

const BLOOM_KEYS = ['glowOnly', 'contrast', 'brightness', 'delta', 'sigma', 'stepSize'];

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{ tier: string }} opts
 */
export function createSensorShaders(viewer, { tier }) {
  const scene = viewer.scene;
  const collection = scene.postProcessStages;
  const support = lookSupport(tier);
  // Reduced-resolution post-process on the phone; full resolution on desktop.
  const textureScale = support.textureScale;
  const crtSupported = support.crt; // stacking is desktop-only

  let stages = [];
  let sensor = 'none';
  let crtOn = false;
  let sharpen = 0;
  let bloom = 0;
  let savedBloom = null; // the scene's own bloom settings, restored when ours is off
  let holdsRender = false;
  let flirPalette = 'white';
  let nvgGainId = 'med';
  const taps = tapsFor(tier);

  const makeStage = (name, fragmentShader, uniforms) =>
    new Cesium.PostProcessStage({ name, fragmentShader, uniforms, textureScale });

  function rebuild() {
    for (const stage of stages) collection.remove(stage);
    stages = [];
    // Sharpen first (on the clean image), then the sensor look, then CRT on top.
    if (sharpen > 0 && support.sharpen) {
      stages.push(
        makeStage('argus-sharpen', SHARPEN_FRAGMENT, { amount: sharpenAmount(sharpen) }),
      );
    }
    if (sensor === 'nvg') {
      stages.push(
        makeStage('argus-nvg', nvgFragment(taps), {
          time: () => performance.now() / 1000,
          gain: () => nvgGain(nvgGainId),
        }),
      );
    } else if (sensor === 'flir') {
      stages.push(
        makeStage('argus-flir', flirFragment(taps), {
          palette: () => flirPaletteIndex(flirPalette),
        }),
      );
    } else if (sensor === 'noir') {
      stages.push(
        makeStage('argus-noir', NOIR_FRAGMENT, {
          intensity: 1.0,
          contrastAmt: 1.2,
          grainAmt: 0.5,
          vignetteAmt: 0.5,
        }),
      );
    } else if (sensor === 'snow') {
      stages.push(
        makeStage('argus-snow', SNOW_FRAGMENT, {
          intensity: 1.0,
          density: 0.6,
          wind: 0.5,
          time: () => performance.now() / 1000,
        }),
      );
    }
    if (crtOn && crtSupported) stages.push(makeStage('argus-crt', crtFragment(taps), {}));
    for (const stage of stages) collection.add(stage);
    updateRenderMode();
    scene.requestRender();
  }

  // Cesium's built-in bloom stage, driven by one strength. The scene's own
  // settings are saved the first time and put back when bloom goes off.
  function applyBloom() {
    const stage = collection.bloom;
    if (!stage) return;
    const u = bloomUniforms(bloom);
    if (!u.enabled) {
      if (savedBloom) {
        stage.enabled = savedBloom.enabled;
        Object.assign(stage.uniforms, savedBloom.uniforms);
        savedBloom = null;
      }
    } else {
      savedBloom ??= {
        enabled: stage.enabled,
        uniforms: Object.fromEntries(BLOOM_KEYS.map((k) => [k, stage.uniforms[k]])),
      };
      for (const k of BLOOM_KEYS) stage.uniforms[k] = u[k];
      stage.enabled = true;
    }
    scene.requestRender();
  }

  // Animated looks need frames; hold one continuous-render claim while one is
  // on (shared with the moving layers, core/scene/renderMode.js).
  function updateRenderMode() {
    const animated = ANIMATED_MODES.includes(sensor);
    if (animated && !holdsRender) {
      holdsRender = true;
      acquireContinuousRender(scene);
    } else if (!animated && holdsRender) {
      holdsRender = false;
      releaseContinuousRender(scene);
    }
  }

  return {
    crtSupported,
    sharpenSupported: support.sharpen,
    bloomSupported: support.bloom,
    FLIR_PALETTES,
    NVG_GAINS,
    /** The sensor modes this tier offers, in menu order (labels: SENSOR_LABELS). */
    modes: [...support.modes],
    labels: SENSOR_LABELS,
    get sensor() {
      return sensor;
    },
    get crt() {
      return crtOn;
    },
    /** Sharpen strength, 0 (off) to 1. */
    get sharpen() {
      return sharpen;
    },
    /** Bloom strength, 0 (off) to 1. */
    get bloom() {
      return bloom;
    },
    setSensor(mode) {
      sensor = support.modes.includes(mode) ? mode : 'none';
      rebuild();
    },
    get flirPalette() {
      return flirPalette;
    },
    get nvgGain() {
      return nvgGainId;
    },
    /** FLIR palette: 'white' | 'black' | 'iron' | 'rainbow' (a uniform: no rebuild). */
    setFlirPalette(id) {
      flirPalette = FLIR_PALETTES.some((p) => p.id === id) ? id : 'white';
      scene.requestRender();
    },
    /** NVG manual gain: 'low' | 'med' | 'high' (a uniform: no rebuild). */
    setNvgGain(id) {
      nvgGainId = NVG_GAINS.some((g) => g.id === id) ? id : 'med';
      scene.requestRender();
    },
    setCrt(on) {
      if (!crtSupported) return;
      crtOn = Boolean(on);
      rebuild();
    },
    /** true (default strength), false, or a strength 0..1. Desktop only. */
    setSharpen(value) {
      if (!support.sharpen) return;
      sharpen = strength(value);
      rebuild();
    },
    /** true (default strength), false, or a strength 0..1. Desktop only. */
    setBloom(value) {
      if (!support.bloom) return;
      bloom = strength(value);
      applyBloom();
    },
    destroy() {
      sensor = 'none';
      crtOn = false;
      sharpen = 0;
      bloom = 0;
      rebuild();
      applyBloom();
    },
  };
}

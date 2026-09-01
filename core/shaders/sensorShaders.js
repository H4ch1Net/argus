import * as Cesium from 'cesium';

// Sensor shaders: NVG (night vision), FLIR (thermal), and a CRT overlay, as
// Cesium PostProcessStages. The danger zone on mobile (full-screen fragment
// passes, master plan 6.1), so they are capability-gated by the caller:
//   - minimal tier: not created at all.
//   - balanced (phone): rendered at reduced resolution and upscaled
//     (textureScale < 1), single pass only.
//   - full (desktop): full resolution, and the CRT overlay may stack on top of
//     a sensor mode (multi-pass, desktop-only).
//
// Cesium post-process fragment shaders receive `colorTexture` and
// `v_textureCoordinates`, and write `out_FragColor`.

const NVG_FRAGMENT = `
uniform sampler2D colorTexture;
uniform float time;
in vec2 v_textureCoordinates;
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 c = texture(colorTexture, v_textureCoordinates).rgb;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  lum = pow(clamp(lum, 0.0, 1.0), 0.7) * 1.5;      // gain
  vec3 nvg = vec3(0.03, 1.0, 0.12) * lum;          // green phosphor
  vec2 d = v_textureCoordinates - 0.5;
  nvg *= smoothstep(0.85, 0.25, length(d));        // vignette
  nvg += (hash(v_textureCoordinates + fract(time)) - 0.5) * 0.08; // sensor noise
  out_FragColor = vec4(nvg, 1.0);
}
`;

const FLIR_FRAGMENT = `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
vec3 thermal(float t) {
  return vec3(
    smoothstep(0.0, 0.45, t),
    smoothstep(0.35, 0.8, t),
    smoothstep(0.7, 1.0, t)
  );
}
void main() {
  vec3 c = texture(colorTexture, v_textureCoordinates).rgb;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  out_FragColor = vec4(thermal(pow(clamp(lum, 0.0, 1.0), 0.85)), 1.0);
}
`;

const CRT_FRAGMENT = `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
void main() {
  vec2 cc = v_textureCoordinates - 0.5;
  vec2 uv = v_textureCoordinates + cc * dot(cc, cc) * 0.12; // slight barrel
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    out_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float ca = 0.0016;                                // chromatic aberration
  vec3 col = vec3(
    texture(colorTexture, uv + vec2(ca, 0.0)).r,
    texture(colorTexture, uv).g,
    texture(colorTexture, uv - vec2(ca, 0.0)).b
  );
  col -= sin(uv.y * 900.0) * 0.06;                  // scanlines
  col *= smoothstep(0.95, 0.3, length(cc));         // vignette
  out_FragColor = vec4(col, 1.0);
}
`;

export const SENSOR_MODES = ['none', 'nvg', 'flir'];

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{ tier: string }} opts
 */
export function createSensorShaders(viewer, { tier }) {
  const scene = viewer.scene;
  const collection = scene.postProcessStages;
  // Reduced-resolution post-process on the phone; full resolution on desktop.
  const textureScale = tier === 'balanced' ? 0.66 : 1.0;
  const crtSupported = tier === 'full'; // stacking is desktop-only

  let sensorStage = null;
  let crtStage = null;
  let sensor = 'none';
  let crtOn = false;
  let savedRenderMode = null;

  const makeStage = (name, fragmentShader, uniforms) =>
    new Cesium.PostProcessStage({ name, fragmentShader, uniforms, textureScale });

  function rebuild() {
    if (sensorStage) {
      collection.remove(sensorStage);
      sensorStage = null;
    }
    if (crtStage) {
      collection.remove(crtStage);
      crtStage = null;
    }
    // Sensor first, then CRT, so CRT composites on top.
    if (sensor === 'nvg') {
      sensorStage = makeStage('argus-nvg', NVG_FRAGMENT, {
        time: () => performance.now() / 1000,
      });
      collection.add(sensorStage);
    } else if (sensor === 'flir') {
      sensorStage = makeStage('argus-flir', FLIR_FRAGMENT, {});
      collection.add(sensorStage);
    }
    if (crtOn && crtSupported) {
      crtStage = makeStage('argus-crt', CRT_FRAGMENT, {});
      collection.add(crtStage);
    }
    updateRenderMode();
    scene.requestRender();
  }

  // Animated shaders need frames; force continuous render while any stage is on.
  // Save the mode when the first stage activates (capturing whatever the movers
  // set) and restore it when the last turns off.
  function updateRenderMode() {
    const anyActive = sensor !== 'none' || (crtOn && crtSupported);
    if (anyActive && savedRenderMode === null) {
      savedRenderMode = scene.requestRenderMode;
      scene.requestRenderMode = false;
    } else if (!anyActive && savedRenderMode !== null) {
      scene.requestRenderMode = savedRenderMode;
      savedRenderMode = null;
    }
  }

  return {
    crtSupported,
    get sensor() {
      return sensor;
    },
    get crt() {
      return crtOn;
    },
    setSensor(mode) {
      sensor = SENSOR_MODES.includes(mode) ? mode : 'none';
      rebuild();
    },
    setCrt(on) {
      if (!crtSupported) return;
      crtOn = Boolean(on);
      rebuild();
    },
    destroy() {
      sensor = 'none';
      crtOn = false;
      rebuild();
    },
  };
}

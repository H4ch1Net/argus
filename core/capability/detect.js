// Capability detection: probe the runtime environment once at load.
//
// Rationale (see gods-eye-view-master-plan.md 3.1): capability is runtime state,
// not a build target. We detect GPU limits, memory, input modality, network type,
// and screen size, then derive a quality tier from the result. Nothing here
// branches on "is mobile"; it reports facts, and tier.js interprets them.

/**
 * Probe the WebGL implementation. Cesium sets failIfMajorPerformanceCaveat:true
 * by default and hard-fails on software rendering, so knowing the renderer up
 * front lets us surface a clear message instead of a cryptic init crash.
 */
function detectWebGL() {
  const canvas = document.createElement('canvas');
  let gl = null;
  let version = 0;

  try {
    gl = canvas.getContext('webgl2');
    if (gl) {
      version = 2;
    } else {
      gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) version = 1;
    }
  } catch {
    gl = null;
  }

  if (!gl) {
    return {
      supported: false,
      version: 0,
      renderer: 'unknown',
      vendor: 'unknown',
      maxTextureSize: 0,
      softwareRendering: true,
    };
  }

  let renderer = 'unknown';
  let vendor = 'unknown';
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  if (debugInfo) {
    renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || renderer;
    vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || vendor;
  }

  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;

  // Heuristic for software rasterizers. These names mean the browser is not
  // getting hardware acceleration, which is a pass/fail check for Cesium.
  const softwarePattern =
    /swiftshader|llvmpipe|software|microsoft basic render|mesa offscreen/i;
  const softwareRendering =
    softwarePattern.test(renderer) || softwarePattern.test(vendor);

  // Release the probe context so we do not hold a GPU context we will not use.
  const loseCtx = gl.getExtension('WEBGL_lose_context');
  if (loseCtx) loseCtx.loseContext();

  return {
    supported: true,
    version,
    renderer,
    vendor,
    maxTextureSize,
    softwareRendering,
  };
}

/**
 * Input modality. Pointer Events unify mouse/touch/pen, but layout and pick
 * tolerance still depend on whether the primary pointer is coarse (finger) or
 * fine (mouse), and whether hover is genuinely available.
 */
function detectInput() {
  const coarsePointer = matchMedia('(pointer: coarse)').matches;
  const finePointer = matchMedia('(pointer: fine)').matches;
  const hover = matchMedia('(hover: hover)').matches;
  const maxTouchPoints = navigator.maxTouchPoints || 0;

  return {
    coarsePointer,
    finePointer,
    hover,
    maxTouchPoints,
    touchCapable: coarsePointer || maxTouchPoints > 0,
  };
}

/**
 * Network hints. Used to default terrain quality: free terrain on cellular /
 * save-data, photorealistic tiles as an explicit opt-in only.
 */
function detectNetwork() {
  const c =
    navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;

  if (!c) {
    return { effectiveType: 'unknown', saveData: false, downlink: null, metered: false };
  }

  const effectiveType = c.effectiveType || 'unknown';
  const saveData = Boolean(c.saveData);
  // Treat anything slower than 4g, or save-data, as metered for defaults.
  const metered = saveData || ['slow-2g', '2g', '3g'].includes(effectiveType);

  return { effectiveType, saveData, downlink: c.downlink ?? null, metered };
}

function detectScreen() {
  return {
    width: window.screen?.width ?? window.innerWidth,
    height: window.screen?.height ?? window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    // Longest edge in CSS pixels: a rough form-factor signal for shell choice.
    longEdge: Math.max(window.screen?.width ?? 0, window.screen?.height ?? 0),
  };
}

/**
 * Probe the full runtime environment. Pure and synchronous: safe to call once
 * at boot. Returns a flat, serializable snapshot.
 */
export function detectCapabilities() {
  const webgl = detectWebGL();
  const input = detectInput();
  const network = detectNetwork();
  const screen = detectScreen();

  return {
    webgl,
    input,
    network,
    screen,
    deviceMemory: navigator.deviceMemory ?? null, // GiB, coarse and often absent
    cpuCores: navigator.hardwareConcurrency ?? null,
    prefersReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    detectedAt: Date.now(),
  };
}

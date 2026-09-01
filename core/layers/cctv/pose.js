// Camera pose math for CCTV projection. Pure (no Cesium): computes the view
// direction and the four far-plane corners of the camera frustum in the camera's
// local East-North-Up frame, in metres. The Cesium layer transforms these into
// world coordinates. No computer vision anywhere: this only places where a
// camera looks, it never analyzes the footage (project guardrail).

const D2R = Math.PI / 180;

export const DEFAULT_POSE = {
  heading: 0, // degrees clockwise from north
  pitch: 25, // degrees below horizontal
  fovDeg: 55, // horizontal field of view
  rangeM: 250, // how far the frustum extends
  heightM: 8, // camera mount height
};

const cross = (a, b) => ({
  e: a.n * b.u - a.u * b.n,
  n: a.u * b.e - a.e * b.u,
  u: a.e * b.n - a.n * b.e,
});
const add = (a, b) => ({ e: a.e + b.e, n: a.n + b.n, u: a.u + b.u });
const scale = (a, k) => ({ e: a.e * k, n: a.n * k, u: a.u * k });

/** Unit view direction in ENU. heading clockwise from north, pitch down. */
export function viewDirEnu(heading, pitchDeg) {
  const h = heading * D2R;
  const p = pitchDeg * D2R;
  return { e: Math.sin(h) * Math.cos(p), n: Math.cos(h) * Math.cos(p), u: -Math.sin(p) };
}

/** Horizontal "right" vector of the screen in ENU (view rotated 90 in azimuth). */
export function rightEnu(heading) {
  const h = heading * D2R;
  return { e: Math.cos(h), n: -Math.sin(h), u: 0 };
}

/**
 * Frustum far-plane geometry in ENU metres relative to the camera.
 * @returns {{ center: object, corners: object[] }} corners: TL, TR, BR, BL
 */
export function frustumCornersEnu(pose, aspect = 16 / 9) {
  const dir = viewDirEnu(pose.heading, pose.pitch);
  const right = rightEnu(pose.heading);
  const up = cross(right, dir);
  const halfW = pose.rangeM * Math.tan((pose.fovDeg * D2R) / 2);
  const halfH = halfW / aspect;
  const center = scale(dir, pose.rangeM);
  return {
    center,
    corners: [
      add(center, add(scale(right, -halfW), scale(up, halfH))),
      add(center, add(scale(right, halfW), scale(up, halfH))),
      add(center, add(scale(right, halfW), scale(up, -halfH))),
      add(center, add(scale(right, -halfW), scale(up, -halfH))),
    ],
  };
}

// Geometry for projecting a public traffic camera's published still into the 3D
// scene. Pure (no Cesium, no DOM): the pose a projection starts from, the
// frustum's mount, far-plane centre and corners in lon/lat/height, and the
// check that decides which image sources the projection may hand to WebGL.
// core/layers/trafficcams/projection.js turns this into Cesium entities.
//
// The far plane is the cctv layer's frustum (core/layers/cctv/pose.js), lifted
// as one rigid rectangle until its lowest corner clears the ground under the
// camera, so the still never sinks into the terrain and the corner rays still
// end exactly on its corners. The rigid lift follows gods-eye-view
// src/layers/cctv/geometry.js computeFrustumGeometry (MIT).
//
// GUARDRAIL: this places a published still where the camera looks. Nothing
// here, or in the projection, reads or analyses the pixels.

import { DEFAULT_POSE, frustumCornersEnu, viewDirEnu, rightEnu } from '../cctv/pose.js';
import { directionToHeading, fallbackHeading } from './pose.js';

const D2R = Math.PI / 180;
// WGS84, for the local tangent-plane step from metres to degrees.
const WGS84_A = 6378137;
const WGS84_E2 = 6.69437999014e-3;

export const PROJECTION_DEFAULTS = Object.freeze({
  aspect: 16 / 9, // until the still loads and gives its own
  clearanceM: 2, // lowest far-plane corner above the ground at the camera
});

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const wrap360 = (d) => (d >= 0 && d < 360 ? d : ((d % 360) + 360) % 360);

// What a pose may hold. The gizmo (core/layers/cctv/gizmo.js) edits heading,
// pitch, fovDeg and rangeM inside these bounds; anything else is clamped.
const LIMITS = {
  pitch: [-30, 89], // degrees BELOW horizontal (the cctv convention)
  fovDeg: [5, 150],
  rangeM: [10, 5000],
  heightM: [0, 500],
};

/**
 * A pose with every field present and in range; missing or non-numeric fields
 * fall back to the cctv DEFAULT_POSE. groundM (the ground's height at the
 * camera, metres) is kept when finite, else null.
 * @returns {{ heading: number, pitch: number, fovDeg: number, rangeM: number,
 *   heightM: number, groundM: number|null }}
 */
export function normalizePose(pose) {
  const p = pose && typeof pose === 'object' ? pose : {};
  const out = {
    heading: wrap360(finite(p.heading) ? p.heading : DEFAULT_POSE.heading),
    groundM: finite(p.groundM) ? p.groundM : null,
  };
  for (const [k, [lo, hi]] of Object.entries(LIMITS))
    out[k] = clamp(finite(p[k]) ? p[k] : DEFAULT_POSE[k], lo, hi);
  return out;
}

/**
 * The pose a traffic camera's projection starts from. Precedence, per field:
 * the caller's edited pose (the gizmo), then the camera's pose prior
 * (meta.pose from ./pose.js posePrior: heading, and the network's or curated
 * pitch / FOV / range / mount height), then the cctv DEFAULT_POSE (8 m mount).
 * A camera with no prior (the demo source) takes its heading from its
 * direction text, else the same hashed stand-in heading posePrior uses.
 * @param {object} record  a normalized trafficcam ({ id, meta: { pose, direction } })
 *   or a catalogue record ({ id, pose, direction })
 * @param {object|null} [edited]  a pose (or part of one) that wins over the prior
 */
export function camPose(record, edited = null) {
  const meta = record?.meta ?? record ?? {};
  const prior = meta.pose && typeof meta.pose === 'object' ? meta.pose : {};
  const merged = { ...DEFAULT_POSE };
  for (const src of [prior, edited]) {
    for (const k of ['heading', 'pitch', 'fovDeg', 'rangeM', 'heightM', 'groundM'])
      if (finite(src?.[k])) merged[k] = src[k];
  }
  if (!finite(prior.heading) && !finite(edited?.heading)) {
    merged.heading =
      directionToHeading(meta.direction, true) ?? fallbackHeading(record?.id ?? '');
  }
  return normalizePose(merged);
}

/**
 * Local ENU offset (metres east, north) from a point -> lon/lat in degrees,
 * on the WGS84 tangent plane. Sub-centimetre over a camera's range (the
 * curvature drop over 1 km is about 8 cm, and it is vertical).
 */
export function enuToLonLat(lon, lat, e, n) {
  const s = Math.sin(lat * D2R);
  const w = Math.sqrt(1 - WGS84_E2 * s * s);
  const primeVertical = WGS84_A / w;
  const meridional = (WGS84_A * (1 - WGS84_E2)) / (w * w * w);
  const cosLat = Math.max(1e-9, Math.cos(lat * D2R));
  return {
    lon: lon + e / (primeVertical * cosLat) / D2R,
    lat: lat + n / meridional / D2R,
  };
}

const cross = (a, b) => ({
  e: a.n * b.u - a.u * b.n,
  n: a.u * b.e - a.e * b.u,
  u: a.e * b.n - a.n * b.e,
});

/**
 * The projection's geometry for a camera at (lon, lat) on ground groundM.
 * @param {{ lon: number, lat: number, groundM?: number }} at
 * @param {object} pose  see normalizePose
 * @param {{ aspect?: number, clearanceM?: number }} [opts]  aspect: the still's
 *   width / height
 * @returns {{ pose: object, aspect: number, halfW: number, halfH: number,
 *   liftM: number,
 *   mount: { lon: number, lat: number, height: number },
 *   center: { lon: number, lat: number, height: number },
 *   corners: { lon: number, lat: number, height: number }[],
 *   axes: { dir: object, right: object, up: object } }}
 *   heights are above the ellipsoid (ground + mount + offset); corners are
 *   TL, TR, BR, BL as seen from the camera; axes are unit ENU vectors at the
 *   mount: the view direction and the far plane's right and up.
 */
export function projectionGeometry(at, pose, opts = {}) {
  const p = normalizePose(pose);
  const aspect = clamp(
    finite(opts.aspect) && opts.aspect > 0 ? opts.aspect : PROJECTION_DEFAULTS.aspect,
    0.5,
    4,
  );
  const clearanceM = finite(opts.clearanceM)
    ? opts.clearanceM
    : PROJECTION_DEFAULTS.clearanceM;
  const { center, corners } = frustumCornersEnu(p, aspect);
  const halfW = p.rangeM * Math.tan((p.fovDeg * D2R) / 2);
  const halfH = halfW / aspect;
  // One rigid lift: the lowest corner ends clearanceM above the camera's ground.
  const lowest = Math.min(...corners.map((c) => c.u));
  const liftM = Math.max(0, clearanceM - (p.heightM + lowest));
  const ground = finite(at?.groundM) ? at.groundM : 0;
  const mountH = ground + p.heightM;
  const place = (v) => ({
    ...enuToLonLat(at.lon, at.lat, v.e, v.n),
    height: mountH + v.u + liftM,
  });
  const dir = viewDirEnu(p.heading, p.pitch);
  const right = rightEnu(p.heading);
  return {
    pose: p,
    aspect,
    halfW,
    halfH,
    liftM,
    mount: { lon: at.lon, lat: at.lat, height: mountH },
    center: place(center),
    corners: corners.map(place),
    axes: { dir, right, up: cross(right, dir) },
  };
}

/**
 * Which image sources the projection may load into a WebGL texture: a blob:
 * URL (a still the caller already fetched), a data:image URL, or an http(s)
 * URL on this page's origin or under the proxy. Anything else (a third-party
 * host, javascript:, data:text/html) is refused, so the projection never
 * reaches past the proxy.
 * @param {unknown} src
 * @param {{ origin?: string|null, proxyBase?: string|null }} [opts]
 * @returns {'blob'|'data'|'same-origin'|'proxy'|null}
 */
export function stillSourceKind(src, { origin = null, proxyBase = null } = {}) {
  if (typeof src !== 'string') return null;
  const s = src.trim();
  if (/^blob:/i.test(s)) return 'blob';
  if (/^data:image\/(?:jpeg|png|webp|gif);base64,/i.test(s)) return 'data';
  let u;
  try {
    u = origin ? new URL(s, origin) : new URL(s);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  try {
    if (origin && u.origin === new URL(origin).origin) return 'same-origin';
    if (proxyBase) {
      const base = origin ? new URL(proxyBase, origin) : new URL(proxyBase);
      const root = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
      if (u.origin === base.origin && u.pathname.startsWith(root)) return 'proxy';
    }
  } catch {
    return null;
  }
  return null;
}

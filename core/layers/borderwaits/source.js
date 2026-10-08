// The border waits layer's source: CBP (into the US) and CBSA (into Canada)
// wait times through the proxy, placed on the bundled ports table, and, when
// the view is tight enough for traffic cameras, the nearest published traffic
// cameras to each crossing in view (their stills stay unfetched until a card
// link is opened). Pure: the terminal shell uses it too.

import { insideView } from '../sdk/bbox.js';
import { haversineKm } from '../trafficcams/nearest.js';
import { CAMERA_MAX_SPAN_DEG } from '../trafficcams/sources.js';
import { parseCbp, parseCbsa, joinPorts } from './parse.js';

export const CBP_PATH = '/bwtnew';
export const CBSA_PATH = '/bwt-eng.csv';

/**
 * The cameras nearest a point: at most `limit`, within `maxKm`, nearest first,
 * as small link records ({ name, provider, distanceKm, imageUrl }). A still
 * that is not a plain image (TxDOT's JSON) gets no link.
 */
export function nearestCameras(cams, at, { maxKm = 20, limit = 2 } = {}) {
  const out = [];
  for (const c of cams ?? []) {
    if (!Number.isFinite(c?.lat) || !Number.isFinite(c?.lon)) continue;
    const distanceKm = haversineKm(at, c);
    if (distanceKm <= maxKm) out.push({ c, distanceKm });
  }
  return out
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit)
    .map(({ c, distanceKm }) => ({
      id: c.id,
      name: c.name,
      provider: c.provider,
      distanceKm: Math.round(distanceKm * 10) / 10,
      imageUrl: c.imageUrl && !c.imageFormat ? c.imageUrl : null,
    }));
}

/**
 * @param {{ proxyClient: { getJson: Function, getText: Function },
 *   cameraSource?: ((query: object, signal?: AbortSignal) => Promise<{ cameras: object[] }>)|null,
 *   cameraMaxKm?: number, camerasPerPort?: number }} opts
 *   cameraSource: the traffic camera source (createTrafficCamSource), to link
 *   each crossing in view to its nearest published cameras; null skips it.
 * @returns {(query: { bbox?: object }, signal?: AbortSignal) => Promise<object>}
 *   resolves to { ports, unplaced, unplacedNames, failed, camerasLinked }
 */
export function createBorderWaitSource({
  proxyClient,
  cameraSource = null,
  cameraMaxKm = 20,
  camerasPerPort = 2,
}) {
  return async (query, signal) => {
    const [cbp, cbsa] = await Promise.allSettled([
      proxyClient.getJson('cbp-bwt', CBP_PATH, { signal }),
      proxyClient.getText('cbsa-bwt', CBSA_PATH, { signal }),
    ]);
    if (cbp.status === 'rejected' && cbsa.status === 'rejected') throw cbp.reason;
    const joined = joinPorts(
      cbp.status === 'fulfilled' ? parseCbp(cbp.value) : [],
      cbsa.status === 'fulfilled' ? parseCbsa(cbsa.value) : [],
    );
    const failed = [cbp, cbsa].filter((r) => r.status === 'rejected').length;

    let camerasLinked = false;
    const bbox = query?.bbox;
    if (cameraSource && bbox && bbox.lamax - bbox.lamin <= CAMERA_MAX_SPAN_DEG) {
      const inside = insideView(bbox);
      const inView = joined.ports.filter((p) => inside(p.lat, p.lon));
      if (inView.length) {
        try {
          const cams = (await cameraSource({ bbox }, signal))?.cameras ?? [];
          for (const p of inView)
            p.cameras = nearestCameras(cams, p, {
              maxKm: cameraMaxKm,
              limit: camerasPerPort,
            });
          camerasLinked = true;
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          // No cameras is not a reason to lose the wait times.
        }
      }
    }
    return {
      ports: joined.ports,
      unplaced: joined.unplaced.length,
      unplacedNames: joined.unplaced
        .map((r) => [r.port, r.crossing].filter(Boolean).join(', '))
        .slice(0, 40),
      failed,
      camerasLinked,
    };
  };
}

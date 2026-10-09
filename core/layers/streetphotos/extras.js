import * as Cesium from 'cesium';
import { findNearestStreetPhoto } from './source.js';
import { streetPhotoToNormalized } from './parse.js';
import { describeStreetPhoto } from './format.js';

// STREET PHOTO on the target card of any place on the ground: the nearest
// Mapillary image within 400 m. When the street photos layer holds it, that
// pin is selected; otherwise the photo is placed as a query output (the OSINT
// plotter) and selected, so its card (with the photo) opens either way. The
// outcome of a search with nothing found shows as a card row, never a popup.

const MAX_ALT_M = 3000; // aircraft at cruise and satellites have no street

/**
 * @param {{ tiles: { tile: Function }|null, manager: object,
 *   plot: (result: object) => object, select: (target: object) => void,
 *   time?: () => import('cesium').JulianDate }} deps
 */
export function createStreetPhotoExtras({ tiles, manager, plot, select, time }) {
  const state = new Map(); // `${key}:${id}` -> 'busy' | { none } | { error }
  const scratch = new Cesium.Cartesian3();
  const where = (target) => {
    const p = target?.position?.getValue?.(time?.() ?? Cesium.JulianDate.now(), scratch);
    if (!p) return null;
    const c = Cesium.Cartographic.fromCartesian(p);
    return c
      ? {
          lat: Cesium.Math.toDegrees(c.latitude),
          lon: Cesium.Math.toDegrees(c.longitude),
          alt: c.height,
        }
      : null;
  };

  async function find(key, target, ll, ctx) {
    const k = `${key}:${target.id}`;
    state.set(k, 'busy');
    ctx.refresh();
    try {
      const best = await findNearestStreetPhoto(tiles, ll.lat, ll.lon);
      if (!best) {
        state.set(k, { none: true });
        return ctx.refresh();
      }
      state.delete(k);
      const n = streetPhotoToNormalized(best.image);
      const layer = manager.isEnabled('streetphotos')
        ? manager.getLayer('streetphotos')
        : null;
      const rec = layer?.getRecord(n.id);
      if (rec?.entity) return select(rec.entity);
      const entity = plot({
        id: n.id,
        kind: 'streetphoto',
        value: 'STREET PHOTO',
        position: { longitude: n.position.longitude, latitude: n.position.latitude },
        card: describeStreetPhoto(n, { distanceM: best.distanceM }),
      });
      if (entity) select(entity);
    } catch (err) {
      console.warn('[argus] street photo:', err?.message || err);
      state.set(k, { error: String(err?.message || err).slice(0, 80) });
      ctx.refresh();
    }
  }

  return {
    rows(key, n) {
      const st = n ? state.get(`${key}:${n.id}`) : null;
      if (!st || st === 'busy') return [];
      return [
        ['Street photo', st.none ? 'none within 400 m' : `unavailable (${st.error})`],
      ];
    },
    actions(target, rec, ctx) {
      if (!tiles || rec.key === 'streetphotos' || rec.key === 'osint') return [];
      const ll = where(target);
      if (!ll || ll.alt > MAX_ALT_M) return [];
      const busy = state.get(`${rec.key}:${target.id}`) === 'busy';
      return [
        {
          label: busy ? 'PHOTO...' : 'STREET PHOTO',
          title: 'The nearest street-level photo (Mapillary, within 400 m)',
          pressed: busy,
          onClick: () => !busy && find(rec.key, target, ll, ctx),
        },
      ];
    },
  };
}

import * as Cesium from 'cesium';

// What the simulated traffic centres on: the ground in the middle of the view
// (ahead of the car in a tilted follow view), at most two camera heights from
// the point under the camera, plus the camera height that picks the detail
// band. Allocation-light: called about once a second.

const mid = new Cesium.Cartesian2();
const hit = new Cesium.Cartesian3();
const carto = new Cesium.Cartographic();

/** @returns {{ lat: number, lon: number, heightM: number }} */
export function simTrafficView(viewer) {
  const scene = viewer.scene;
  const cam = scene.camera;
  const c = cam.positionCartographic;
  const heightM = c.height;
  let lat = Cesium.Math.toDegrees(c.latitude);
  let lon = Cesium.Math.toDegrees(c.longitude);
  const canvas = scene.canvas;
  mid.x = (canvas.clientWidth || canvas.width || 0) / 2;
  mid.y = (canvas.clientHeight || canvas.height || 0) / 2;
  const p = cam.pickEllipsoid?.(mid, scene.globe?.ellipsoid, hit);
  if (p) {
    const g = Cesium.Cartographic.fromCartesian(p, Cesium.Ellipsoid.WGS84, carto);
    if (g) {
      const gLat = Cesium.Math.toDegrees(g.latitude);
      const gLon = Cesium.Math.toDegrees(g.longitude);
      const dy = (gLat - lat) * 110_540;
      const dx = (gLon - lon) * 111_320 * Math.cos((lat * Math.PI) / 180);
      const d = Math.hypot(dx, dy);
      const k = d > heightM * 2 && d > 0 ? (heightM * 2) / d : 1;
      lat += (gLat - lat) * k;
      lon += (gLon - lon) * k;
    }
  }
  return { lat, lon, heightM };
}

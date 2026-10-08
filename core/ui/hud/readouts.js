import * as Cesium from 'cesium';
import { createSegment } from './bar.js';
import { pad } from '../dom.js';

// Live bar and strip readouts in the ctOS idiom: terse, uppercase, fixed width
// and zero padded. All refresh from the render loop at most a few times a
// second, so an idle scene costs nothing.

const hemi = (v, pos, neg, width) =>
  `${Math.abs(v).toFixed(2).padStart(width, '0')}${v >= 0 ? pos : neg}`;

/** Camera readout segments for the bottom strip: POS, ALT, HDG. */
export function createCameraReadout(viewer) {
  const posSeg = createSegment({ label: 'POS', value: '--.--N ---.--E' });
  const altSeg = createSegment({ label: 'ALT', value: '-----' });
  const hdgSeg = createSegment({ label: 'HDG', value: '---' });
  let last = 0;
  viewer.scene.postRender.addEventListener(() => {
    const now = performance.now();
    if (now - last < 250) return;
    last = now;
    const c = viewer.camera.positionCartographic;
    posSeg.set(
      `${hemi(Cesium.Math.toDegrees(c.latitude), 'N', 'S', 5)} ${hemi(Cesium.Math.toDegrees(c.longitude), 'E', 'W', 6)}`,
    );
    const h = c.height;
    altSeg.set(
      h >= 1e6
        ? `${(h / 1e6).toFixed(2)}MM`
        : h >= 1000
          ? `${(h / 1000).toFixed(1)}KM`
          : `${Math.round(h)}M`,
    );
    hdgSeg.set(`${pad((Cesium.Math.toDegrees(viewer.camera.heading) + 360) % 360)}°`);
  });
  return [posSeg, altSeg, hdgSeg];
}

/** FPS meter: frames actually rendered in the last second (0 when idle). */
export function createFpsMeter(viewer, { target = 60 } = {}) {
  const seg = createSegment({
    label: 'FPS <>',
    value: '000',
    meter: true,
    title: 'Frames rendered per second (0 while idle)',
  });
  let frames = 0;
  viewer.scene.postRender.addEventListener(() => {
    frames += 1;
  });
  setInterval(() => {
    seg.set(pad(frames));
    seg.setMeter(frames / target);
    frames = 0;
  }, 1000);
  return seg;
}

/** OBJ meter: contacts visible in view (fed by the tracking overlay). */
export function createObjMeter() {
  const seg = createSegment({
    label: 'OBJ ##',
    value: '0000',
    meter: true,
    title: 'Contacts in view',
  });
  return {
    ...seg,
    update(n) {
      seg.set(pad(n, 4));
      seg.setMeter(Math.log10(1 + n) / 4);
    },
  };
}

/** Status: ddMMyy-hhmm-UTC-ARGUS- (date dim, -hhmm- bright, the rest dim). */
export function createStatusSegment() {
  const seg = createSegment({ className: 'ct-status', title: 'UTC date and time' });
  const tick = () => {
    const d = new Date();
    const two = (n) => String(n).padStart(2, '0');
    seg.setHtml(
      `${two(d.getUTCDate())}${two(d.getUTCMonth() + 1)}${two(d.getUTCFullYear() % 100)}` +
        `<b>-${two(d.getUTCHours())}${two(d.getUTCMinutes())}-</b>UTC-ARGUS-`,
    );
  };
  tick();
  setInterval(tick, 15_000);
  return seg;
}

/** Feed state: a round dot (green when a proxy serves live data) and a word. */
export function createFeedSegment({ live, onClick }) {
  const seg = createSegment({
    value: '',
    title: live
      ? 'Live feeds through the Argus proxy'
      : 'No proxy reachable: every layer is simulated',
    onClick,
  });
  seg.setHtml(
    `<span class="ct-dot${live ? ' is-ok' : ''}"></span>&nbsp;${live ? '-LIVE--' : '-DEMO--'}`,
  );
  return seg;
}

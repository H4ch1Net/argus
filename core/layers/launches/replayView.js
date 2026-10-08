import * as Cesium from 'cesium';
import {
  acquireContinuousRender,
  releaseContinuousRender,
} from '../../scene/renderMode.js';
import { primaryLaunch } from './parse.js';
import {
  buildReplay,
  replaySchedule,
  replayState,
  samplePath,
  formatMissionClock,
  REPLAY_LABEL,
} from './replay.js';
import { launchDetailPath, parseLaunchDetail } from './parse.js';

// Launch replay on the globe: the reconstructed ascent (white) and the
// estimated orbit (gray, dashed), a marker riding them, and a small ctOS HUD
// with the countdown, the mission clock, the phase and the speed. Everything
// is labelled RECONSTRUCTED ESTIMATE: LL2 publishes no trajectory, so the path
// is modelled from the pad, the orbit class and the mission timeline.

const SPEEDS = [0.5, 1, 2, 4];

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{ proxyClient?: object, mount: (el: HTMLElement) => void,
 *   notify: Function, onChange?: () => void }} deps
 */
export function createReplayView(viewer, { proxyClient, mount, notify, onChange }) {
  const scene = viewer.scene;
  let run = null; // { entities, timer, schedule, replay, speed }

  const hud = document.createElement('div');
  hud.className = 'ct-replay ct-panel';
  hud.hidden = true;
  hud.innerHTML = `
    <div class="ct-replay__head"><span class="ct-sq"></span><span data-r="name"></span></div>
    <div class="ct-replay__clock" data-r="clock">T-10</div>
    <div class="ct-replay__phase" data-r="phase"></div>
    <div class="ct-seg ct-replay__ctl" data-r="speeds"></div>
    <div class="ct-replay__note">${REPLAY_LABEL}</div>`;
  const $ = (k) => hud.querySelector(`[data-r="${k}"]`);
  const speedsEl = $('speeds');
  for (const sp of SPEEDS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ct-btn';
    b.textContent = `${sp}X`;
    b.addEventListener('click', () => setSpeed(sp));
    speedsEl.appendChild(b);
  }
  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'ct-btn';
  stopBtn.textContent = 'STOP';
  stopBtn.addEventListener('click', () => stop());
  speedsEl.appendChild(stopBtn);
  mount(hud);

  function paintSpeeds() {
    for (const b of speedsEl.querySelectorAll('.ct-btn'))
      b.setAttribute('aria-pressed', String(b.textContent === `${run?.speed}X`));
  }

  function setSpeed(sp) {
    if (!run) return;
    // Keep the marker where it is: rebase the start for the new speed.
    const now = Date.now();
    const elapsed = (now - run.schedule.liftoffAt) / 1000;
    if (elapsed > 0) run.schedule.liftoffAt = now - (elapsed * run.speed * 1000) / sp;
    run.speed = sp;
    paintSpeeds();
  }

  const toCart = (p) =>
    Cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, Math.max(0, p.altitude ?? 0));

  async function start(n) {
    stop();
    const now = Date.now();
    const past = n.meta.launches.filter((l) => l.net != null && l.net <= now);
    const launch = past[past.length - 1] ?? primaryLaunch(n.meta.launches);
    if (!launch) return;
    // The detailed record adds the mission timeline (insertion time); without
    // the proxy, the summary still gives pad and orbit class.
    let detail = null;
    const path = launchDetailPath(launch.id);
    if (proxyClient && path) {
      try {
        detail = parseLaunchDetail(await proxyClient.getJson('ll2', path));
      } catch {
        detail = null;
      }
    }
    detail ??= {
      ...launch,
      pad: { latitude: n.position.latitude, longitude: n.position.longitude },
      timeline: [],
      failed: /fail/i.test(launch.status || ''),
    };
    const r = buildReplay(detail);
    if (!r.ok) {
      notify({ title: 'NO REPLAY', body: `${launch.name}: ${r.reason}.`, level: 'low' });
      return;
    }
    const ascent = viewer.entities.add({
      polyline: {
        positions: r.ascent.map(toCart),
        width: 2,
        arcType: Cesium.ArcType.NONE,
        material: Cesium.Color.WHITE.withAlpha(0.85),
      },
    });
    const orbit = viewer.entities.add({
      polyline: {
        positions: [...r.orbit, r.orbit[0]].map(toCart),
        width: 1.5,
        arcType: Cesium.ArcType.NONE,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString('#d9d9d9').withAlpha(0.55),
          dashLength: 12,
        }),
      },
    });
    const scratch = new Cesium.Cartesian3();
    const marker = viewer.entities.add({
      position: new Cesium.CallbackProperty(() => {
        if (!run) return undefined;
        const st = run.state;
        const p =
          st.phase === 'orbit'
            ? samplePath(r.orbit, st.progress)
            : st.phase === 'ascent'
              ? samplePath(r.ascent, st.progress)
              : r.ascent[0];
        return p
          ? Cesium.Cartesian3.fromDegrees(
              p.longitude,
              p.latitude,
              p.altitude ?? 0,
              Cesium.Ellipsoid.WGS84,
              scratch,
            )
          : undefined;
      }, false),
      point: {
        pixelSize: 9,
        color: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.fromCssColorString('#0e0e0e'),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    run = {
      entities: [ascent, orbit, marker],
      schedule: replaySchedule(Date.now()),
      replay: r,
      detail,
      speed: 1,
      state: { phase: 'settle', progress: 0 },
    };
    $('name').textContent = `${detail.name ?? launch.name}`.toUpperCase();
    hud.hidden = false;
    paintSpeeds();
    acquireContinuousRender(scene, 30);
    run.timer = setInterval(tick, 100);
    tick();
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        n.position.longitude,
        n.position.latitude - 9,
        2_400_000,
      ),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-55), roll: 0 },
      duration: 2.2,
    });
    onChange?.();
  }

  function tick() {
    if (!run) return;
    const r = run.replay;
    const st = replayState({
      liftoffAt: run.schedule.liftoffAt,
      ascentSec: r.ascentSec,
      orbitSec: r.orbitSec,
      orbitPeriodSec: r.orbitPeriodSec,
      insertionOffsetSec: r.insertionOffsetSec,
      launchEpochMs: run.detail.net,
      speed: run.speed,
      nowMs: Date.now(),
    });
    run.state = st;
    $('clock').textContent =
      st.phase === 'countdown'
        ? `T-${String(st.countdownSeconds).padStart(2, '0')}`
        : st.phase === 'settle'
          ? 'STANDBY'
          : formatMissionClock(st.missionOffsetSec ?? 0);
    $('phase').textContent =
      st.phase === 'ascent'
        ? `ASCENT ${Math.round(st.progress * 100)}%`
        : st.phase === 'orbit'
          ? `ORBIT ${Math.round(r.orbitAltitudeM / 1000)} KM`
          : 'PAD';
  }

  function stop() {
    if (!run) return;
    clearInterval(run.timer);
    for (const e of run.entities) viewer.entities.remove(e);
    run = null;
    hud.hidden = true;
    releaseContinuousRender(scene, 30);
    scene.requestRender();
    onChange?.();
  }

  return { start, stop, running: () => Boolean(run) };
}

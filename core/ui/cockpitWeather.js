import { weatherAltitudeFactors, weatherEffectProfile } from '../cockpit/briefing.js';

// Cockpit weather: while riding along, the observed weather at the point below
// (Open-Meteo, fetched by the briefing) drawn over the view on a 2D canvas:
// haze and fog veils, drifting cloud, rain streaks slanted by the wind, snow,
// droplets on the glass and the odd storm flash. It thins out as the aircraft
// climbs above each layer. Greys only (ctOS). It costs the globe nothing (no
// Cesium frames), animates at ~30 fps only while shown and the page is
// visible, and holds still under reduced motion. Missing weather draws
// nothing: conditions are never invented. Adapted from gods-eye-view
// src/cockpitCloudEffects.js and src/weatherEffectsMath.js (MIT).

const FRAME_MS = 33;

/** @param {import('cesium').Viewer} viewer */
export function createCockpitWeather(viewer) {
  const host = viewer.container ?? viewer.scene.canvas.parentElement;
  const canvas = document.createElement('canvas');
  canvas.className = 'argus-overlay argus-wx';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.hidden = true;
  host.insertBefore(canvas, host.querySelector('.argus-overlay'));
  const g = canvas.getContext('2d');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  let profile = weatherEffectProfile(null);
  let active = false;
  let raf = 0;
  let last = 0;
  let w = 0;
  let h = 0;
  let flash = 0;
  let parts = { clouds: [], rain: [], snow: [], drops: [] };

  function resize() {
    const r = host.getBoundingClientRect();
    w = r.width;
    h = r.height;
    // One canvas pixel per CSS pixel: soft effects need no more, and it keeps
    // the fill cost low on a high-density screen.
    canvas.width = Math.round(w);
    canvas.height = Math.round(h);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    seed();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  const rnd = (a, b) => a + Math.random() * (b - a);
  function seed() {
    const p = profile;
    parts = {
      clouds: Array.from({ length: Math.round(p.cloud * 14) }, () => ({
        x: rnd(-0.2, 1.2) * w,
        y: rnd(0, 0.7) * h,
        r: rnd(0.12, 0.3) * Math.max(w, h),
        a: rnd(0.04, 0.09),
      })),
      rain: Array.from({ length: Math.round(p.rain * 240) }, () => ({
        x: rnd(0, w),
        y: rnd(0, h),
        l: rnd(14, 28),
        v: rnd(18, 30),
      })),
      snow: Array.from({ length: Math.round(p.snow * 170) }, () => ({
        x: rnd(0, w),
        y: rnd(0, h),
        r: rnd(1, 2.4),
        v: rnd(0.6, 1.6),
        ph: rnd(0, 6.28),
      })),
      drops: Array.from({ length: Math.round(p.droplets * 46) }, () => ({
        x: rnd(0, w),
        y: rnd(0, h),
        r: rnd(1.5, 4),
        life: rnd(0, 1),
      })),
    };
  }

  function draw(t) {
    const alt = weatherAltitudeFactors(viewer.camera.positionCartographic?.height ?? 0);
    const p = profile;
    g.clearRect(0, 0, w, h);
    if (!p.available) return;
    // The wind across the view: the screen-space slant of rain and the drift
    // of cloud, from the wind's direction against the camera's heading.
    const heading = ((viewer.camera.heading ?? 0) * 180) / Math.PI;
    const toward = (((p.windDirectionDeg + 180 - heading) % 360) + 360) % 360;
    const side = Math.sin((toward * Math.PI) / 180) * p.wind;

    const haze = p.haze * alt.haze;
    if (haze > 0.01) {
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, `rgba(190,190,190,${0.05 * haze})`);
      grad.addColorStop(0.55, `rgba(200,200,200,${0.2 * haze})`);
      grad.addColorStop(1, `rgba(210,210,210,${0.32 * haze})`);
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
    }
    const fog = p.fog * alt.haze;
    if (fog > 0.01) {
      g.fillStyle = `rgba(205,205,205,${0.38 * fog})`;
      g.fillRect(0, 0, w, h);
    }

    const cloudK = alt.cloud;
    if (cloudK > 0.01) {
      for (const c of parts.clouds) {
        c.x += side * 0.6 + 0.15;
        if (c.x - c.r > w) c.x = -c.r;
        if (c.x + c.r < 0) c.x = w + c.r;
        const grad = g.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r);
        grad.addColorStop(0, `rgba(225,225,225,${c.a * cloudK})`);
        grad.addColorStop(1, 'rgba(225,225,225,0)');
        g.fillStyle = grad;
        g.fillRect(c.x - c.r, c.y - c.r, c.r * 2, c.r * 2);
      }
    }

    const precip = alt.precipitation;
    if (precip > 0.01 && parts.rain.length) {
      g.strokeStyle = `rgba(217,217,217,${0.32 * precip})`;
      g.lineWidth = 1;
      g.beginPath();
      const dx = side * 10;
      for (const r of parts.rain) {
        r.y += r.v;
        r.x += dx * 0.5;
        if (r.y > h) {
          r.y = -r.l;
          r.x = rnd(0, w);
        }
        if (r.x < 0) r.x += w;
        if (r.x > w) r.x -= w;
        g.moveTo(r.x, r.y);
        g.lineTo(r.x + (dx * r.l) / 24, r.y + r.l);
      }
      g.stroke();
    }
    if (precip > 0.01 && parts.snow.length) {
      g.fillStyle = `rgba(240,240,240,${0.7 * precip})`;
      for (const s of parts.snow) {
        s.y += s.v;
        s.x += Math.sin(t / 900 + s.ph) * 0.5 + side;
        if (s.y > h) {
          s.y = -4;
          s.x = rnd(0, w);
        }
        if (s.x < 0) s.x += w;
        if (s.x > w) s.x -= w;
        g.fillRect(s.x, s.y, s.r, s.r);
      }
    }
    if (precip > 0.01 && parts.drops.length) {
      g.strokeStyle = `rgba(230,230,230,${0.22 * precip})`;
      for (const d of parts.drops) {
        d.life -= 0.006;
        if (d.life <= 0) {
          d.life = 1;
          d.x = rnd(0, w);
          d.y = rnd(0, h);
        }
        g.globalAlpha = Math.min(1, d.life * 2);
        g.beginPath();
        g.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        g.stroke();
      }
      g.globalAlpha = 1;
    }

    // A storm: now and then the whole view lights up and fades.
    if (p.storm > 0 && !reduced && Math.random() < p.storm * 0.004) flash = 1;
    if (flash > 0.02) {
      g.fillStyle = `rgba(255,255,255,${0.22 * flash})`;
      g.fillRect(0, 0, w, h);
      flash *= 0.8;
    }
  }

  function tick(t) {
    raf = 0;
    if (!active || document.hidden) return;
    if (t - last >= FRAME_MS) {
      last = t;
      draw(t);
    }
    if (!reduced) raf = requestAnimationFrame(tick);
  }
  const kick = () => {
    if (!raf && active && !document.hidden) raf = requestAnimationFrame(tick);
  };
  document.addEventListener('visibilitychange', kick);

  return {
    /** Weather from the briefing (normalizeWeather), or null for none. */
    setWeather(weather) {
      profile = weatherEffectProfile(weather);
      seed();
      kick();
    },
    show() {
      active = true;
      canvas.hidden = false;
      resize();
      kick();
    },
    hide() {
      active = false;
      canvas.hidden = true;
      cancelAnimationFrame(raf);
      raf = 0;
      g.clearRect(0, 0, w, h);
    },
    destroy() {
      this.hide();
      ro.disconnect();
      document.removeEventListener('visibilitychange', kick);
      canvas.remove();
    },
  };
}

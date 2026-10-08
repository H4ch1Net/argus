import { h } from './dom.js';
import { section } from './controls.js';

// The radio tuner (TOOLS > RADIO): an analog dial over the stations the radio
// layer holds, in Radio Browser's dial order (specialist tags first: news,
// weather, emergency, scanner, aviation, marine...). Drag the tape, use the
// arrow keys, or step with ◀ ▶; releasing on a station selects it on the globe,
// and PLAY streams it. Faint static plays while the dial moves. Audio streams
// come straight from the broadcaster's public https stream, exactly as the
// card's Listen link would open it; the listen count goes through the proxy.
// Adapted from gods-eye-view src/ui/radioTunerModel.js and tuning (MIT).

/**
 * @param {{ manager: object, select: (target: object) => void,
 *   proxyClient: object|null, notify: Function }} deps
 */
export function createRadioTuner({ manager, select, proxyClient, notify }) {
  const canvas = h('canvas.ct-tuner__tape', {
    tabindex: '0',
    role: 'slider',
    'aria-label': 'Radio dial',
  });
  const name = h('div.ct-tuner__name', {}, '--');
  const meta = h('div.ct-tuner__meta', {}, '');
  const playBtn = h(
    'button.ct-btn',
    { type: 'button', onclick: () => togglePlay() },
    'PLAY',
  );
  const body = h(
    'div.ct-tuner',
    {},
    canvas,
    name,
    meta,
    h(
      'div.ct-seg',
      {},
      h('button.ct-btn', { type: 'button', onclick: () => step(-1) }, '◀'),
      playBtn,
      h('button.ct-btn', { type: 'button', onclick: () => step(1) }, '▶'),
    ),
  );
  const hint = h(
    'div.ct-section__note',
    {},
    'Turn on the Radio layer to tune its stations.',
  );
  const el = section('RADIO', hint, body);
  body.hidden = true;

  let model = null;
  let stations = []; // [{ id, meta, target }]
  let coord = 0;
  let current = -1;
  let audio = null;
  let noise = null;

  async function load() {
    model ??= await import('../layers/radio/tuner.js');
    const layer = manager.getLayer('radio');
    const list = [];
    if (layer && manager.isEnabled('radio'))
      layer.forEachRecord((target, n) => list.push({ ...n, target }));
    stations = model.tunerStations(list);
    body.hidden = !stations.length;
    hint.hidden = Boolean(stations.length);
    if (current >= stations.length) current = stations.length - 1;
    if (current < 0 && stations.length) current = 0;
    coord = Math.max(0, current);
    draw();
    paint();
  }

  function paint() {
    const s = stations[current];
    name.textContent = s ? String(s.meta?.name ?? s.id).toUpperCase() : '--';
    meta.textContent = s
      ? [
          `CH ${String(current + 1).padStart(3, '0')}/${String(stations.length).padStart(3, '0')}`,
          s.meta?.country,
          (s.meta?.tags || '').toString().split(',').slice(0, 2).join(' '),
        ]
          .filter(Boolean)
          .join('  ')
          .toUpperCase()
      : '';
  }

  function draw() {
    if (!model) return;
    const r = canvas.getBoundingClientRect();
    const w = r.width || 280;
    const hgt = 46;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const tape = model.tunerTape(coord, stations.length, w);
    g.font = `9.5px 'JetBrains Mono', ui-monospace, monospace`;
    g.textAlign = 'center';
    for (const t of tape.ticks) {
      const x = Math.round(t.xPx) + 0.5;
      g.strokeStyle = t.current ? '#ffffff' : t.label ? '#c3c3c3' : '#7a7a7a';
      g.beginPath();
      g.moveTo(x, hgt - 6);
      g.lineTo(x, hgt - (t.label ? 18 : 12));
      g.stroke();
      if (t.label) {
        g.fillStyle = t.current ? '#ffffff' : '#7a7a7a';
        g.fillText(t.label, x, 12);
      }
    }
    const nx = Math.round(tape.needleX) + 0.5;
    g.strokeStyle = '#ffffff';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(nx, 16);
    g.lineTo(nx, hgt - 2);
    g.stroke();
    g.lineWidth = 1;
  }

  // Faint static while the dial moves (WebAudio, gain at most 0.018).
  function staticOn() {
    try {
      const ctx = (noise ??= {
        ctx: new (window.AudioContext || window.webkitAudioContext)(),
      }).ctx;
      if (noise.src) return;
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = model?.TUNER_STATIC_MAX_GAIN ?? 0.018;
      src.connect(gain).connect(ctx.destination);
      src.start();
      noise.src = src;
    } catch {
      // no audio context (autoplay rules): the dial still works silently
    }
  }
  function staticOff() {
    try {
      noise?.src?.stop();
    } catch {
      // already stopped
    }
    if (noise) noise.src = null;
  }

  function commit(index) {
    if (index < 0 || !stations[index]) return;
    current = index;
    coord = index;
    draw();
    paint();
    select(stations[index].target);
    if (audio) play();
  }

  function step(d) {
    if (!stations.length) return;
    commit(Math.max(0, Math.min(stations.length - 1, current + d)));
  }

  function play() {
    const s = stations[current];
    const url = s?.meta?.stream;
    if (!/^https:\/\//i.test(url || '')) {
      notify({
        title: 'NO HTTPS STREAM',
        body: 'This station has no https stream to play here.',
        level: 'low',
      });
      stop();
      return;
    }
    audio ??= new Audio();
    audio.src = url;
    audio.play().catch(() => {
      notify({
        title: 'STREAM FAILED',
        body: 'The station did not start playing.',
        level: 'low',
      });
    });
    playBtn.textContent = 'STOP';
    playBtn.setAttribute('aria-pressed', 'true');
    // Count the listen with Radio Browser (through the proxy, cached).
    const path = model?.stationClickPath(s);
    if (proxyClient && path) proxyClient.getJson('radiobrowser', path).catch(() => {});
  }
  function stop() {
    audio?.pause();
    audio = null;
    playBtn.textContent = 'PLAY';
    playBtn.setAttribute('aria-pressed', 'false');
  }
  const togglePlay = () => (audio ? stop() : play());

  // Dragging the tape (Pointer Events: mouse, touch and pen alike).
  let dragging = false;
  canvas.addEventListener('pointerdown', (e) => {
    if (!model || !stations.length) return;
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    staticOn();
    move(e);
  });
  const move = (e) => {
    if (!dragging) return;
    const r = canvas.getBoundingClientRect();
    const p = model.pointerToTuner(e.clientX, r.left, r.width, stations.length);
    coord = p.coordinate;
    current = p.stationIndex;
    draw();
    paint();
  };
  canvas.addEventListener('pointermove', move);
  const end = () => {
    if (!dragging) return;
    dragging = false;
    staticOff();
    commit(current);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('keydown', (e) => {
    if (!model) return;
    const next = model.keyStep(e.key, current, stations.length);
    if (next === null) return;
    e.preventDefault();
    commit(next);
  });

  manager.subscribe(load);
  manager.subscribeStatus((key) => key === 'radio' && load());
  new ResizeObserver(draw).observe(canvas);
  return { el, refresh: load };
}

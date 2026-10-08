// The tracking widget: Bagley's avatar (design/ctos BagleyAvatar) driven by
// real contacts. A small node graph seen through a tracking overlay: the hub
// (ID00, the ctOS diamond) is the selected target, or the middle of the view
// while scanning; square satellite nodes are its nearest contacts, placed by
// true bearing and log distance, each with a lagging tracking box and its
// two-digit ID (the same IDs as the boxes on the map). Spine edges join each
// node to the hub, dashed mesh edges join neighbours, and signal packets run
// along them. Corner readouts: state top left, ID00 and quality top right, hub
// position bottom left, SIG and TRK bottom right. Greys and white; success
// green on LOCK; dimmed and dashed with no signal.
//
// It animates at ~20 fps only while on screen and the page is visible; reduced
// motion freezes it.

const GRAY = '#d9d9d9';
const WHITE = '#ffffff';
const MUTED = '#7a7a7a';
const OK = '#00fa9a';
const FONT = `10px 'JetBrainsMono Nerd Font', 'JetBrains Mono', ui-monospace, monospace`;
const FRAME_MS = 50;

export function createTrackWidget() {
  const canvas = document.createElement('canvas');
  canvas.className = 'ct-trackwidget';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute(
    'aria-label',
    'Tracking graph of the target and its nearest contacts',
  );
  const g = canvas.getContext('2d');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  let model = { state: 'IDLE', quality: 0, contacts: [], layers: 0, hubPos: [0.5, 0.5] };
  const nodes = new Map(); // id -> { x, y, tx, ty, bx, by, glow }
  const hub = { x: 0, y: 0, bx: 0, by: 0, glow: 0 };
  let w = 0;
  let hgt = 0;
  let dpr = 1;
  let raf = 0;
  let last = 0;
  let visible = true;
  let packets = [];

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = r.width;
    hgt = r.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    layout();
    // Resizing clears the canvas, and the loop stops while it has no size
    // (a closed panel): redraw now and restart the loop.
    step(performance.now());
    draw();
    kick();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    kick();
  });
  io.observe(canvas);
  document.addEventListener('visibilitychange', kick);

  function layout() {
    const cx = w / 2;
    const cy = hgt / 2 + 4;
    hub.tx = cx;
    hub.ty = cy;
    if (!hub.x) {
      hub.x = hub.bx = cx;
      hub.y = hub.by = cy;
    }
    const rMax = Math.min(w, hgt) / 2 - 26;
    const list = model.contacts.slice(0, 8);
    const far = Math.max(1, ...list.map((c) => c.distanceM ?? 0));
    const keep = new Set();
    list.forEach((c, i) => {
      let ang;
      let rad;
      if (Number.isFinite(c.bearingDeg)) {
        ang = ((c.bearingDeg - 90) * Math.PI) / 180;
        rad = 26 + (rMax - 26) * (Math.log1p(c.distanceM ?? 0) / Math.log1p(far));
      } else {
        ang = i * 2.399963; // golden angle: an even scatter while scanning
        rad = 30 + ((rMax - 30) * (i + 1)) / (list.length + 1);
      }
      const tx = cx + Math.cos(ang) * rad * 1.35;
      const ty = cy + Math.sin(ang) * rad * 0.9;
      keep.add(c.id);
      const n = nodes.get(c.id) ?? { x: cx, y: cy, bx: cx, by: cy, glow: 0 };
      n.tx = Math.max(14, Math.min(w - 14, tx));
      n.ty = Math.max(26, Math.min(hgt - 22, ty));
      nodes.set(c.id, n);
    });
    for (const id of [...nodes.keys()]) if (!keep.has(id)) nodes.delete(id);
    // Contacts on similar bearings would stack: push overlapping nodes apart.
    const list2 = [...nodes.values()];
    for (let pass = 0; pass < 8; pass += 1) {
      for (let i = 0; i < list2.length; i += 1) {
        for (let j = i + 1; j < list2.length; j += 1) {
          const a = list2[i];
          const b = list2[j];
          const dx = b.tx - a.tx;
          const dy = b.ty - a.ty;
          const d = Math.hypot(dx, dy) || 0.01;
          if (d >= 24) continue;
          const push = (24 - d) / 2;
          const ux = dx / d || 1;
          const uy = dy / d;
          a.tx -= ux * push;
          a.ty -= uy * push;
          b.tx += ux * push;
          b.ty += uy * push;
        }
      }
    }
    for (const n of list2) {
      n.tx = Math.max(14, Math.min(w - 14, n.tx));
      n.ty = Math.max(26, Math.min(hgt - 22, n.ty));
    }
  }

  function tick(t) {
    raf = 0;
    if (!visible || document.hidden || !w) return;
    if (t - last >= FRAME_MS) {
      last = t;
      step(t);
      draw(t);
    }
    if (!reduced) raf = requestAnimationFrame(tick);
  }
  function kick() {
    if (!raf && visible && !document.hidden) raf = requestAnimationFrame(tick);
  }

  function step(t) {
    const ease = (o, k) => {
      o.x += (o.tx - o.x) * k;
      o.y += (o.ty - o.y) * k;
      o.bx += (o.x - o.bx) * 0.25; // the tracking box lags its node
      o.by += (o.y - o.by) * 0.25;
      o.glow *= 0.85;
    };
    ease(hub, 0.3);
    for (const n of nodes.values()) ease(n, 0.18);
    const live = model.state !== 'NO SIGNAL' && model.state !== 'IDLE';
    if (live && nodes.size && Math.random() < 0.35) {
      const ids = [...nodes.keys()];
      const id = ids[Math.floor(Math.random() * ids.length)];
      // Tracking: packets flow out of the hub; scanning: into it.
      packets.push({ id, k: 0, out: model.state !== 'SCAN', born: t });
    }
    packets = packets.filter((p) => {
      p.k += 0.07;
      if (p.k >= 1) {
        const n = nodes.get(p.id);
        if (p.out && n) n.glow = 1;
        else hub.glow = 1;
        return false;
      }
      return nodes.has(p.id);
    });
  }

  function draw() {
    const ok = model.state === 'LOCK';
    const off = model.state === 'NO SIGNAL';
    const accent = ok ? OK : GRAY;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    // Faint square grid.
    g.strokeStyle = 'rgba(255,255,255,0.045)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0.5; x < w; x += 20) {
      g.moveTo(x, 0);
      g.lineTo(x, hgt);
    }
    for (let y = 0.5; y < hgt; y += 20) {
      g.moveTo(0, y);
      g.lineTo(w, y);
    }
    g.stroke();
    corners(6.5, 6.5, w - 6.5, hgt - 6.5, 9, WHITE, 1);

    g.globalAlpha = off ? 0.35 : 1;
    const list = [...nodes.entries()];
    // Mesh: dashed edges between neighbours (each to the next nearest).
    g.setLineDash([3, 3]);
    g.strokeStyle = 'rgba(217,217,217,0.3)';
    g.beginPath();
    for (let i = 0; i < list.length; i += 1) {
      const [, a] = list[i];
      const [, b] = list[(i + 1) % list.length];
      if (list.length < 3 && i > 0) break;
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
    }
    g.stroke();
    g.setLineDash(off ? [2, 3] : []);
    // Spines from the hub.
    g.strokeStyle = ok ? 'rgba(0,250,154,0.5)' : 'rgba(255,255,255,0.45)';
    g.beginPath();
    for (const [, n] of list) {
      g.moveTo(hub.x, hub.y);
      g.lineTo(n.x, n.y);
    }
    g.stroke();
    g.setLineDash([]);
    // Packets: a 3px square with a short tail.
    for (const p of packets) {
      const n = nodes.get(p.id);
      if (!n) continue;
      const k = p.out ? p.k : 1 - p.k;
      const x = hub.x + (n.x - hub.x) * k;
      const y = hub.y + (n.y - hub.y) * k;
      const dx = (n.x - hub.x) * 0.06 * (p.out ? 1 : -1);
      const dy = (n.y - hub.y) * 0.06 * (p.out ? 1 : -1);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(x - dx - 1, y - dy - 1, 2, 2);
      g.fillStyle = WHITE;
      g.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
    // Nodes: a filled core and a thin tracking square, with the ID.
    g.font = FONT;
    g.textBaseline = 'bottom';
    for (const [id, n] of list) {
      const core = 6;
      g.fillStyle = n.glow > 0.2 ? WHITE : GRAY;
      g.fillRect(Math.round(n.x - core / 2), Math.round(n.y - core / 2), core, core);
      const s = 16;
      g.strokeStyle = `rgba(217,217,217,${0.55 + n.glow * 0.45})`;
      g.strokeRect(Math.round(n.bx - s / 2) + 0.5, Math.round(n.by - s / 2) + 0.5, s, s);
      g.fillStyle = MUTED;
      g.fillText(
        String(id).padStart(2, '0'),
        Math.round(n.bx - s / 2),
        Math.round(n.by - s / 2) - 2,
      );
    }
    // Hub: the ctOS diamond inside corner brackets.
    const r = 7;
    g.strokeStyle = accent;
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(hub.x, hub.y - r);
    g.lineTo(hub.x + r, hub.y);
    g.lineTo(hub.x, hub.y + r);
    g.lineTo(hub.x - r, hub.y);
    g.closePath();
    g.stroke();
    g.fillStyle = hub.glow > 0.2 ? WHITE : accent;
    g.beginPath();
    g.moveTo(hub.x, hub.y - 3);
    g.lineTo(hub.x + 3, hub.y);
    g.lineTo(hub.x, hub.y + 3);
    g.lineTo(hub.x - 3, hub.y);
    g.closePath();
    g.fill();
    corners(hub.bx - 14.5, hub.by - 14.5, hub.bx + 14.5, hub.by + 14.5, 5, accent, 1.2);
    g.fillStyle = accent;
    g.fillText(ok ? '00 LOCK' : '00', hub.bx - 14, hub.by - 17);
    g.globalAlpha = 1;

    // Corner readouts.
    g.font = FONT;
    g.textBaseline = 'middle';
    g.fillStyle = ok ? OK : off ? MUTED : GRAY;
    g.fillRect(14, 15, 4, 4);
    g.fillStyle = off ? MUTED : WHITE;
    g.textAlign = 'left';
    g.fillText(model.state, 22, 17.5);
    g.textAlign = 'right';
    g.fillStyle = ok ? OK : WHITE;
    g.fillText(
      model.state === 'SCAN' || model.state === 'IDLE' || off
        ? `OBJ ${String(model.total ?? 0).padStart(4, '0')}`
        : `ID00 ${model.quality.toFixed(2)}`,
      w - 14,
      17.5,
    );
    g.fillStyle = MUTED;
    g.fillText(
      `SIG ${String(packets.length).padStart(2, '0')}  TRK ${String(nodes.size + 1).padStart(2, '0')}`,
      w - 14,
      hgt - 15,
    );
    g.textAlign = 'left';
    const [hx, hy] = model.hubPos;
    g.fillText(`x.${frac(hx)} y.${frac(hy)}`, 14, hgt - 15);
  }

  function corners(x0, y0, x1, y1, arm, color, lw) {
    g.strokeStyle = color;
    g.lineWidth = lw;
    g.beginPath();
    for (const [x, y, sx, sy] of [
      [x0, y0, 1, 1],
      [x1, y0, -1, 1],
      [x0, y1, 1, -1],
      [x1, y1, -1, -1],
    ]) {
      g.moveTo(x + sx * arm, y);
      g.lineTo(x, y);
      g.lineTo(x, y + sy * arm);
    }
    g.stroke();
  }

  return {
    el: canvas,
    /**
     * @param {{ state: string, quality?: number, total?: number, layers?: number,
     *   contacts?: { id: number, bearingDeg?: number|null, distanceM?: number|null }[],
     *   hubPos?: [number, number] }} m
     */
    update(m) {
      model = { ...model, ...m, quality: m.quality ?? model.quality };
      layout();
      kick();
      if (reduced)
        requestAnimationFrame(() => {
          step(performance.now());
          draw();
        });
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', kick);
    },
  };
}

function frac(v) {
  return String(Math.round(Math.max(0, Math.min(0.999, v ?? 0.5)) * 1000)).padStart(
    3,
    '0',
  );
}

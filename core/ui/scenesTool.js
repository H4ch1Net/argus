import './scenesTool.css';
import { h } from './dom.js';
import { section, createSwitch } from './controls.js';
import {
  createSceneStore,
  validateShot,
  serializeScene,
  parseSceneJson,
  planPlayback,
  describeCamera,
  formatDuration,
  cleanName,
  moveItem,
  SCENE_MAX_SHOTS,
  SCENE_MAX_BYTES,
  SCENE_HOLD_MAX_MS,
  SCENE_STORE_MAX,
  SHOT_DEFAULT_HOLD_MS,
  SHOT_DEFAULT_FLY_MS,
} from '../share/scenes.js';

// The TOOLS menu's scene director: capture views as shots, play them back in
// order (fly to each, then hold), save scenes on this device and export or
// import them as JSON files. Nothing is uploaded. The model (validation, the
// store, the timeline) is core/share/scenes.js; this is the UI and the player.
// The camera, layers and selection belong to main.js, reached through the
// capture / apply / flyTo callbacks.
//
// Adapted from gods-eye-view src/ui/sceneControls.js and
// src/director/playback.js (MIT).

/** Extra time a flight may take past its duration before the player moves on. */
const FLY_GRACE_MS = 5000;
/** How long applying a shot (layers, look, target) may run past its hold. */
const APPLY_GRACE_MS = 10_000;
/** A looping run takes at least this long per cycle (zero-length shots never spin). */
const LOOP_MIN_MS = 1000;
/** How long a two-step button (NEW, DELETE) stays armed. */
const ARM_MS = 3000;

const pad2 = (n) => String(n).padStart(2, '0');
const secs = (ms) => String(Number((ms / 1000).toFixed(2)));
const same = (a, b) => cleanName(a).toLowerCase() === cleanName(b).toLowerCase();
const note = (text) => h('div.ct-section__note', {}, text);
const btn = (label, onclick, title = label) =>
  h('button.ct-btn', { type: 'button', title, onclick }, label);

/** A file name from a scene name: lower-case ASCII words joined by '-'. */
const slug = (name) =>
  name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'scene';

/** localStorage, or null where touching it throws (blocked site data). */
function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The tooltip of a shot row: everything it will do, one line each. */
function describeShot(shot) {
  const c = shot.camera;
  const lines = [
    describeCamera(c),
    `HDG ${Math.round(c.heading)}  PITCH ${Math.round(c.pitch)}  ROLL ${Math.round(c.roll)}`,
    `LAYERS: ${shot.layers.length ? shot.layers.join(', ').toUpperCase() : 'NONE'}`,
  ];
  if (shot.look) lines.push(`LOOK: ${shot.look.toUpperCase()}`);
  if (shot.target)
    lines.push(`TARGET: ${shot.target.layer.toUpperCase()} ${shot.target.id}`);
  lines.push(`FLY ${secs(shot.flyMs)} S  HOLD ${secs(shot.holdMs)} S`);
  return lines.join('\n');
}

/**
 * A two-step button: the first press arms it (CONFIRM) for a few seconds, the
 * second runs the action. needs() false skips the confirmation.
 */
function twoStep(label, title, action, needs = () => true) {
  let timer = null;
  const disarm = () => {
    clearTimeout(timer);
    timer = null;
    b.textContent = label;
    b.classList.remove('is-armed');
  };
  const b = btn(
    label,
    () => {
      if (timer === null && needs()) {
        b.textContent = 'CONFIRM';
        b.classList.add('is-armed');
        timer = setTimeout(disarm, ARM_MS);
        return;
      }
      disarm();
      action();
    },
    title,
  );
  return b;
}

/**
 * The SCENES section for the TOOLS menu.
 *
 * capture(): the current view as a shot state { camera: { lon, lat, alt,
 *   heading, pitch, roll } (degrees, metres), layers, look?, target? }; async ok.
 * apply(shot, { signal }): switch layers, look and target to the shot's; async
 *   ok. Called on arrival, alongside the hold; signal aborts on STOP.
 * flyTo(camera, durationMs, signal): fly there; resolve when the flight ends,
 *   resolve false (or reject) when it was cancelled. signal aborts on STOP.
 * notify({ title, body, level }): a HUD notice.
 * canvas (optional): the globe's canvas; a press or wheel on it stops playback.
 * storage (optional): a localStorage-like object (default: localStorage).
 *
 * @param {{ capture: Function, apply: Function, flyTo: Function, notify?: Function,
 *   canvas?: EventTarget|null, storage?: object|null }} deps
 * @returns {{ el: HTMLElement, stop: () => void, isPlaying: () => boolean }}
 */
export function createScenesTool({
  capture,
  apply,
  flyTo,
  notify,
  canvas = null,
  storage = defaultStorage(),
}) {
  const store = createSceneStore(storage);
  let shots = [];
  let loop = false;
  let selected = null; // name of the saved scene picked in the list
  /** The active run: { cancelled, signal, abort, wakers, index, total } or null. */
  let run = null;

  const say = (title, body = '') =>
    notify?.({ title, body, level: 'low', key: 'scenes' });

  // ------------------------------------------------------------ elements
  const nameInput = h('input.ct-scenes__input', {
    type: 'text',
    maxlength: '60',
    placeholder: 'Scene name',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Scene name',
  });
  const list = h('div.ct-scenes__shots.ct-scroll', { role: 'list' });
  const status = h('div.ct-tool__summary.ct-scenes__status', { 'aria-live': 'polite' });
  const savedList = h('div.ct-scenes__saved.ct-scroll');

  const captureBtn = btn(
    'CAPTURE SHOT',
    () => captureShot(),
    'Add the current view as the next shot',
  );
  const newBtn = twoStep(
    'NEW',
    'Start an empty scene',
    () => {
      shots = [];
      nameInput.value = '';
      renderShots();
    },
    () => shots.length > 0,
  );
  const playBtn = h(
    'button.ct-btn.ct-btn--ok',
    {
      type: 'button',
      title: 'Play the shots in order',
      'aria-pressed': 'false',
      onclick: () => play(),
    },
    'PLAY',
  );
  const stopBtn = btn('STOP', () => stop(), 'Stop playback (Esc, or touch the globe)');
  stopBtn.disabled = true;
  const loopSwitch = createSwitch({
    label: 'Loop',
    title: 'Start over after the last shot',
    onToggle: (on) => {
      loop = on;
    },
  });
  const saveBtn = btn('SAVE', () => save(), 'Keep this scene on this device');
  const exportBtn = btn(
    'EXPORT',
    () => exportScene(),
    'Download this scene as a JSON file',
  );
  const fileInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    hidden: true,
    onchange: () => importFile(),
  });
  const importBtn = btn('IMPORT', () => fileInput.click(), 'Open a scene JSON file');
  const loadBtn = btn('LOAD', () => loadSaved(), 'Open the selected saved scene');
  const renameBtn = btn(
    'RENAME',
    () => renameSaved(),
    'Rename the selected saved scene to the name above',
  );
  const deleteBtn = twoStep('DELETE', 'Delete the selected saved scene', () =>
    deleteSaved(),
  );

  // ------------------------------------------------------------ shot list
  function renderStatus() {
    if (run) return; // the player owns the readout while it runs
    const plan = planPlayback({ shots });
    status.classList.remove('is-playing');
    status.textContent = plan.total
      ? `${pad2(plan.total)} SHOTS  ${formatDuration(plan.totalMs)}`
      : '';
  }

  function iconBtn(glyph, title, act, onclick, disabled) {
    return h(
      'button.ct-btn.ct-scenes__icon',
      { type: 'button', title, 'aria-label': title, dataset: { act }, onclick, disabled },
      glyph,
    );
  }

  function shotRow(shot, i) {
    const locked = Boolean(run);
    const hold = h('input.ct-scenes__hold', {
      type: 'number',
      min: '0',
      max: String(SCENE_HOLD_MAX_MS / 1000),
      step: '0.5',
      inputmode: 'decimal',
      value: secs(shot.holdMs),
      title: 'Hold, seconds',
      'aria-label': `Shot ${i + 1} hold, seconds`,
      disabled: locked,
      onchange: () => setHold(i, hold),
    });
    return h(
      'div.ct-scenes__shot',
      { role: 'listitem', title: describeShot(shot), dataset: { index: String(i) } },
      h('span.ct-scenes__num', {}, pad2(i + 1)),
      h('span.ct-scenes__cap', {}, shot.caption || describeCamera(shot.camera)),
      h('span.ct-scenes__holdwrap', {}, hold, 'S'),
      iconBtn('▲', 'Move up', 'up', () => move(i, -1), locked || i === 0),
      iconBtn(
        '▼',
        'Move down',
        'down',
        () => move(i, 1),
        locked || i === shots.length - 1,
      ),
      iconBtn('×', 'Delete shot', 'del', () => removeShot(i), locked),
    );
  }

  function renderShots() {
    list.textContent = '';
    if (!shots.length) list.append(note('NO SHOTS. CAPTURE SHOT ADDS THE CURRENT VIEW.'));
    shots.forEach((shot, i) => list.append(shotRow(shot, i)));
    paintPlayingRow();
    renderStatus();
  }

  function paintPlayingRow() {
    const at = run ? String(run.index) : null;
    for (const row of list.children)
      row.classList.toggle('is-playing', row.dataset.index === at);
  }

  function setHold(i, input) {
    const shot = shots[i];
    const raw = input.value.trim();
    const sec = Number(raw);
    // Unreadable input keeps the hold it had (validateShot would default it).
    const next =
      raw === '' || !Number.isFinite(sec)
        ? null
        : validateShot({ ...shot, holdMs: sec * 1000 });
    if (next) shots[i] = next;
    input.value = secs(shots[i].holdMs);
    input.closest('.ct-scenes__shot')?.setAttribute('title', describeShot(shots[i]));
    renderStatus();
  }

  function move(i, delta) {
    if (run) return;
    shots = moveItem(shots, i, delta);
    renderShots();
    // Keep focus on the control that moved, so repeated presses keep moving it.
    const row = list.children[i + delta];
    const again = row?.querySelector(`[data-act="${delta < 0 ? 'up' : 'down'}"]`);
    (again && !again.disabled ? again : row?.querySelector('[data-act="del"]'))?.focus();
  }

  function removeShot(i) {
    if (run) return;
    shots = shots.filter((_, j) => j !== i);
    renderShots();
  }

  async function captureShot() {
    if (run) return;
    if (shots.length >= SCENE_MAX_SHOTS) {
      say('SCENE FULL', `A scene holds ${SCENE_MAX_SHOTS} shots.`);
      return;
    }
    let state = null;
    try {
      state = await capture();
    } catch {
      state = null;
    }
    const shot = validateShot({
      holdMs: SHOT_DEFAULT_HOLD_MS,
      flyMs: SHOT_DEFAULT_FLY_MS,
      ...state,
    });
    if (!shot) {
      say('NO VIEW', 'The camera position could not be read.');
      return;
    }
    if (run || shots.length >= SCENE_MAX_SHOTS) return; // changed while capturing
    shots = [...shots, shot];
    renderShots();
    list.scrollTop = list.scrollHeight;
  }

  // ------------------------------------------------------------ player
  /** A timer that STOP ends early. clear() resolves it now. */
  function delay(token, ms) {
    let id = null;
    let wake = () => {};
    const done = new Promise((resolve) => {
      wake = () => {
        clearTimeout(id);
        token.wakers.delete(wake);
        resolve();
      };
      if (token.cancelled) {
        resolve();
        return;
      }
      token.wakers.add(wake);
      id = setTimeout(wake, Math.max(0, ms));
    });
    return { done, clear: () => wake() };
  }

  /** Race work against a deadline (or STOP). Resolves to the work's value, or undefined. */
  async function bounded(token, work, ms) {
    const guard = delay(token, ms);
    try {
      return await Promise.race([work, guard.done.then(() => undefined)]);
    } finally {
      guard.clear();
    }
  }

  /** Fly to a shot. False when the flight was cancelled by something else. */
  async function fly(token, shot) {
    try {
      const landed = await bounded(
        token,
        Promise.resolve().then(() => flyTo(shot.camera, shot.flyMs, token.signal)),
        shot.flyMs + FLY_GRACE_MS,
      );
      return landed !== false;
    } catch {
      return false;
    }
  }

  function applyShot(token, step) {
    const work = Promise.resolve()
      .then(() => apply(step.shot, { signal: token.signal }))
      .catch((err) => {
        if (!token.cancelled)
          say(`${step.label}: NOT FULLY APPLIED`, String(err?.message || err));
      });
    return bounded(token, work, step.shot.holdMs + APPLY_GRACE_MS);
  }

  function showStep(token, step, phase) {
    if (run !== token) return;
    token.index = step.index;
    status.textContent = `${step.label}  ${phase}`;
    paintPlayingRow();
  }

  const onKey = (e) => {
    if (e.key === 'Escape') stop();
  };
  const onGlobe = () => stop();

  function paintPlaying(on) {
    playBtn.setAttribute('aria-pressed', String(on));
    stopBtn.disabled = !on;
    for (const b of [captureBtn, newBtn, saveBtn, importBtn]) b.disabled = on;
    status.classList.toggle('is-playing', on);
    el.classList.toggle('is-playing', on);
    renderShots();
    renderSaved();
  }

  function startRun(total) {
    const abort = new AbortController();
    const token = {
      cancelled: false,
      signal: abort.signal,
      abort,
      wakers: new Set(),
      index: 0,
      total,
    };
    run = token;
    document.addEventListener('keydown', onKey);
    canvas?.addEventListener('pointerdown', onGlobe);
    canvas?.addEventListener('wheel', onGlobe, { passive: true });
    paintPlaying(true);
    return token;
  }

  function finishRun(token, how) {
    if (run !== token) return;
    run = null;
    document.removeEventListener('keydown', onKey);
    canvas?.removeEventListener('pointerdown', onGlobe);
    canvas?.removeEventListener('wheel', onGlobe);
    paintPlaying(false);
    const at = `${pad2(token.index + 1)}/${pad2(token.total)}`;
    if (how === 'done') status.textContent = `PLAYED ${pad2(token.total)} SHOTS`;
    else if (how === 'interrupted') status.textContent = `INTERRUPTED AT ${at}`;
    else status.textContent = `STOPPED AT ${at}`;
  }

  async function play() {
    if (run) return;
    const plan = planPlayback({ shots });
    if (!plan.total) {
      say('NO SHOTS', 'Capture a shot first.');
      return;
    }
    const token = startRun(plan.total);
    let how = 'done';
    try {
      do {
        const cycleStart = Date.now();
        for (const step of plan.steps) {
          if (token.cancelled) break;
          showStep(token, step, 'FLY');
          const landed = await fly(token, step.shot);
          if (token.cancelled) break;
          if (!landed) {
            how = 'interrupted';
            break;
          }
          showStep(token, step, 'HOLD');
          await Promise.all([
            applyShot(token, step),
            delay(token, step.shot.holdMs).done,
          ]);
        }
        if (how !== 'done' || token.cancelled || !loop) break;
        await delay(token, LOOP_MIN_MS - (Date.now() - cycleStart)).done;
      } while (!token.cancelled && loop);
    } finally {
      finishRun(token, token.cancelled ? 'stopped' : how);
    }
  }

  /** Stop playback now (Esc, a press on the globe, STOP). Safe to call any time. */
  function stop() {
    const token = run;
    if (!token) return;
    token.cancelled = true;
    token.abort.abort();
    for (const wake of [...token.wakers]) wake();
    finishRun(token, 'stopped');
  }

  // ------------------------------------------------------------ saved scenes
  function renderSaved() {
    const items = store.list();
    if (selected && !items.some((s) => same(s.name, selected))) selected = null;
    savedList.textContent = '';
    if (!items.length) savedList.append(note('NO SAVED SCENES ON THIS DEVICE.'));
    for (const s of items) {
      savedList.append(
        h(
          'button.ct-row',
          {
            type: 'button',
            title: s.name,
            'aria-pressed': String(Boolean(selected) && same(s.name, selected)),
            disabled: Boolean(run),
            onclick: () => {
              selected = s.name;
              renderSaved();
            },
          },
          h('span.ct-row__label', {}, s.name),
          h('span.ct-row__meta', {}, `${pad2(s.shots)} SHOTS`),
        ),
      );
    }
    for (const b of [loadBtn, renameBtn, deleteBtn])
      b.disabled = !selected || Boolean(run);
  }

  /** The first free "SCENE 01", "SCENE 02", ... */
  function freeName() {
    const taken = store.list();
    for (let n = 1; ; n += 1) {
      const name = `SCENE ${pad2(n)}`;
      if (!taken.some((s) => same(s.name, name))) return name;
    }
  }

  function save() {
    if (run) return;
    if (!shots.length) {
      say('NOTHING TO SAVE', 'Capture a shot first.');
      return;
    }
    const name = cleanName(nameInput.value) || freeName();
    const r = store.save({ v: 1, name, shots });
    if (!r.ok) {
      if (r.reason === 'full')
        say('STORE FULL', `Delete a saved scene first (${SCENE_STORE_MAX} at most).`);
      else
        say(
          'NOT SAVED',
          'This browser is not keeping site data. EXPORT saves the scene as a file instead.',
        );
      return;
    }
    nameInput.value = r.scene.name;
    selected = r.scene.name;
    renderSaved();
    say(
      r.replaced ? 'SCENE UPDATED' : 'SCENE SAVED',
      `${r.scene.name}: ${r.scene.shots.length} shots, on this device only.`,
    );
  }

  function openScene(scene) {
    stop();
    shots = scene.shots;
    nameInput.value = scene.name;
    renderShots();
    list.scrollTop = 0;
  }

  function loadSaved() {
    if (run || !selected) return;
    const scene = store.get(selected);
    if (!scene) {
      say('NOT FOUND', 'That scene is no longer saved here.');
      renderSaved();
      return;
    }
    openScene(scene);
    say('SCENE LOADED', `${scene.name}: ${scene.shots.length} shots.`);
  }

  function renameSaved() {
    if (run || !selected) return;
    const to = cleanName(nameInput.value);
    if (!to) {
      say('NAME FIRST', 'Type the new name in NAME, then RENAME.');
      return;
    }
    const r = store.rename(selected, to);
    if (!r.ok) {
      const why = {
        exists: 'Another saved scene has that name.',
        missing: 'That scene is no longer saved here.',
        invalid: 'Type the new name in NAME, then RENAME.',
        storage: 'This browser is not keeping site data.',
      };
      say('NOT RENAMED', why[r.reason] ?? '');
      renderSaved();
      return;
    }
    selected = r.name;
    renderSaved();
    say('SCENE RENAMED', r.name);
  }

  function deleteSaved() {
    if (run || !selected) return;
    const name = selected;
    if (store.remove(name)) say('SCENE DELETED', name);
    else say('NOT DELETED', 'This browser did not accept the change.');
    selected = null;
    renderSaved();
  }

  // ------------------------------------------------------------ files
  function exportScene() {
    if (!shots.length) {
      say('NOTHING TO EXPORT', 'Capture a shot first.');
      return;
    }
    const name = cleanName(nameInput.value) || 'UNTITLED';
    const text = serializeScene({ v: 1, name, shots });
    if (!text) {
      say('NOTHING TO EXPORT', 'Capture a shot first.');
      return;
    }
    const file = `argus-scene-${slug(name)}.json`;
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = h('a', { href: url, download: file, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    say('SCENE EXPORTED', `${file}, to this device's downloads. Nothing is uploaded.`);
  }

  async function importFile() {
    const file = fileInput.files?.[0];
    fileInput.value = ''; // the same file can be picked again
    if (!file) return;
    let scene = null;
    if (file.size <= SCENE_MAX_BYTES) {
      try {
        scene = parseSceneJson(await file.text());
      } catch {
        scene = null;
      }
    }
    if (!scene) {
      say(
        'IMPORT FAILED',
        file.size > SCENE_MAX_BYTES
          ? 'Scene files are at most 256 KB. Nothing was changed.'
          : 'Not a valid Argus scene file. Nothing was changed.',
      );
      return;
    }
    openScene(scene);
    say(
      'SCENE IMPORTED',
      `${scene.name}: ${scene.shots.length} shots. SAVE keeps it on this device.`,
    );
  }

  // ------------------------------------------------------------ section
  const el = section(
    'SCENES',
    note('Captured views played in order: fly, then hold. Kept on this device only.'),
    h('label.ct-scenes__field', {}, h('span.ct-scenes__label', {}, 'NAME'), nameInput),
    h('div.ct-seg', {}, captureBtn, newBtn),
    list,
    status,
    h('div.ct-seg', {}, playBtn, stopBtn),
    loopSwitch.el,
    h('div.ct-seg', {}, saveBtn, exportBtn, importBtn),
    fileInput,
    h('div.ct-scenes__sub', {}, 'SAVED'),
    savedList,
    h('div.ct-seg', {}, loadBtn, renameBtn, deleteBtn),
  );
  el.classList.add('ct-scenes');

  renderShots();
  renderSaved();

  return { el, stop, isPlaying: () => Boolean(run) };
}

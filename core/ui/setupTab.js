import './settings.css';
import { h } from './dom.js';
import { collapsible, disclosure, section } from './controls.js';
import { createLogsPanel, copyText } from './logs.js';

// SETUP: getting Argus running well, in one tab, the everyday first.
//   SETTINGS (the dialog; in the Android app also its own settings screen)
//   STATUS   connection, feeds, location and compass (with ALLOW where a
//            permission is missing), GPU
//   KEYS     folded: which optional keys are set; tap one to set it (saved by
//            the proxy on this machine, never in the browser); move them to
//            another device as a passphrase-encrypted file
//   INSTALL  in a browser only: install as an app, the Android app
//   MORE     folded: details for a bug report (tier, renderer, font, the
//            capability readout), another proxy (a phone browser using the
//            proxy on a home machine), keyboard shortcuts
//   LOGS     folded: feed failures. main.js adds CREDITS after it.

const RELEASES = 'https://github.com/H4ch1Net/argus/releases/latest';
export const PROXY_OVERRIDE_KEY = 'argus.proxyBase';
const PASSPHRASE_MIN = 10; // as the proxy requires (proxy/lib/setup.js)
const IMPORT_MAX_BYTES = 64 * 1024;
const keysWord = (n) => `${n} KEY${n === 1 ? '' : 'S'}`;

/**
 * What an import box or file holds: an Argus keys file (the bundle itself, or
 * the export answer around it) or .env text. Pure.
 * @returns {{ bundle: object } | { env: string } | null}
 */
export function importPayload(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    try {
      const json = JSON.parse(s);
      const bundle = json?.bundle ?? json;
      if (bundle && typeof bundle === 'object' && bundle.kdf) return { bundle };
    } catch {
      // not JSON after all: read it as .env text
    }
  }
  return { env: s };
}

/**
 * @param {{ proxyBase: string|null, health: object|null, tier: string,
 *   capabilities: object, notify: Function, openSettings: () => void,
 *   openKeys: () => void, logs?: object, readout?: HTMLElement|null,
 *   keyboard?: boolean }} deps  logs: the app's log store; readout: the
 *   capability readout (MORE > DETAILS); keyboard: offer the shortcut list
 */
export function createSetupTab({
  proxyBase,
  health,
  tier,
  capabilities,
  notify,
  openSettings,
  openKeys,
  logs = null,
  readout = null,
  keyboard = true,
}) {
  const host = typeof window !== 'undefined' ? window.ArgusAndroid : null;
  const inApp = Boolean(host && typeof host.openSettings === 'function');

  // A status row: LABEL ........ VALUE [ACTION]
  const row = (label, value, state = '', action = null) =>
    h(
      'div.ct-setup__check',
      {},
      h('span', {}, label),
      h('b', { dataset: { state } }, value),
      action,
    );

  // ---------------------------------------------------------------- STATUS
  const feeds = health?.feeds ?? [];
  const ready = feeds.filter((f) => f.configured).length;
  const soft = Boolean(capabilities?.webgl?.softwareRendering);

  const locState = h('b', {}, '--');
  const locAllow = h(
    'button.ct-btn.ct-setup__act',
    { type: 'button', hidden: true, onclick: () => askLocation() },
    'ALLOW',
  );
  const paintLocation = (state) => {
    locState.textContent = state;
    locState.dataset.state = state === 'GRANTED' ? 'ok' : state === 'DENIED' ? 'bad' : '';
    locAllow.hidden = state === 'GRANTED';
  };
  const askLocation = () =>
    navigator.geolocation?.getCurrentPosition(
      () => paintLocation('GRANTED'),
      (e) => paintLocation(e.code === 1 ? 'DENIED' : 'NO FIX'),
      { timeout: 10_000 },
    );
  paintLocation(navigator.geolocation ? 'ASK' : 'NONE');
  navigator.permissions
    ?.query({ name: 'geolocation' })
    .then((p) => {
      const paint = () =>
        paintLocation(p.state === 'prompt' ? 'ASK' : p.state.toUpperCase());
      paint();
      p.onchange = paint;
    })
    .catch(() => {});

  // The compass: only a row where the device has one (iOS asks first).
  const hasMotion = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  const needsAsk = typeof window.DeviceOrientationEvent?.requestPermission === 'function';
  const motionState = h('b', {}, needsAsk ? 'ASK' : 'ON');
  const motionAllow = h(
    'button.ct-btn.ct-setup__act',
    {
      type: 'button',
      hidden: !needsAsk,
      onclick: async () => {
        try {
          const r = String(await window.DeviceOrientationEvent.requestPermission());
          motionState.textContent = r === 'granted' ? 'ON' : 'DENIED';
          motionAllow.hidden = r === 'granted';
        } catch {
          motionState.textContent = 'DENIED';
        }
      },
    },
    'ALLOW',
  );
  const motionRow = h(
    'div.ct-setup__check',
    {},
    h('span', {}, 'COMPASS'),
    motionState,
    motionAllow,
  );

  const status = section(
    'STATUS',
    row('CONNECTION', proxyBase ? 'LIVE' : 'DEMO DATA', proxyBase ? 'ok' : 'bad'),
    feeds.length
      ? row('FEEDS READY', `${ready}/${feeds.length}`, ready ? 'ok' : '')
      : null,
    h('div.ct-setup__check', {}, h('span', {}, 'LOCATION'), locState, locAllow),
    hasMotion && matchMedia?.('(pointer: coarse)').matches ? motionRow : null,
    row('GPU', soft ? 'SOFTWARE (SLOW)' : 'HARDWARE', soft ? 'bad' : 'ok'),
  );

  // ------------------------------------------------------------------ KEYS
  // The list comes from the proxy; values never come back.
  const keyList = h('div.ct-setup__keys');
  const keyNote = h('div.ct-section__note', {}, 'Loading...');
  const keyMeta = h('span', {}, '');
  async function loadKeys() {
    keyList.innerHTML = '';
    if (!proxyBase) {
      keyNote.textContent = 'Keys are set on the machine running Argus.';
      keyMeta.textContent = '';
      return;
    }
    let data;
    try {
      const r = await fetch(`${proxyBase}/setup/keys`, {
        headers: { accept: 'application/json' },
      });
      data = r.ok ? await r.json() : null;
    } catch {
      data = null;
    }
    if (!data) {
      keyNote.textContent = 'Key setup is not offered here.';
      keyMeta.textContent = '';
      return;
    }
    const set = data.keys.filter((k) => k.set).length;
    keyMeta.textContent = `${set}/${data.keys.length} SET`;
    keyNote.textContent = data.writable
      ? 'All optional. Saved on this device, never in the page.'
      : 'Read only here: set keys on the machine running Argus.';
    keyNote.title = data.file ? `Saved to ${data.file}` : '';
    for (const k of data.keys) keyList.appendChild(keyRow(k, data.writable));
    transfer.hidden = !(data.writable && data.transfer);
  }

  // One line per key (NAME ...... SET); tapping it opens its field.
  function keyRow(k, writable) {
    const state = h(
      'span.ct-setup__state',
      { dataset: { on: String(k.set) } },
      k.set ? 'SET' : 'NOT SET',
    );
    const name = h('span.ct-setup__name', {}, k.name);
    if (!writable) return h('div.ct-setup__row', {}, name, state);
    const input = h('input', {
      type: k.kind === 'url' ? 'url' : 'password',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: k.set
        ? 'Replace...'
        : k.kind === 'url'
          ? 'http://192.168.1.20:8080'
          : 'Paste key',
      'aria-label': k.name,
    });
    const save = h(
      'button.ct-btn',
      {
        type: 'button',
        onclick: async () => {
          const value = input.value.trim();
          input.value = '';
          if (await saveKey(k.name, value)) loadKeys();
        },
      },
      'SAVE',
    );
    const clear = k.set
      ? h(
          'button.ct-btn',
          {
            type: 'button',
            title: 'Remove this key',
            onclick: async () => (await saveKey(k.name, '')) && loadKeys(),
          },
          'X',
        )
      : null;
    const edit = h(
      'div.ct-setup__edit',
      { hidden: true },
      h('div.ct-setup__input', {}, input, save, clear),
      h(
        'div.ct-setup__for',
        {},
        `FOR ${k.feeds.join(', ').toUpperCase()}${k.restart ? ' (RESTART TO USE)' : ''}`,
      ),
    );
    const head = h(
      'button.ct-setup__row.ct-setup__keyhead',
      {
        type: 'button',
        'aria-expanded': 'false',
        onclick: () => {
          edit.hidden = !edit.hidden;
          head.setAttribute('aria-expanded', String(!edit.hidden));
          if (!edit.hidden) input.focus();
        },
      },
      name,
      state,
    );
    return h('div.ct-setup__key', {}, head, edit);
  }

  // Results of key actions show inline, beside the action, never as popups.
  const statusLine = () => {
    const el = h('div.ct-setup__status', { role: 'status', hidden: true });
    const set = (text, state = '') => {
      el.hidden = !text;
      el.textContent = text;
      el.dataset.state = state;
    };
    return { el, set };
  };
  const keyStatus = statusLine();
  const say = keyStatus.set;
  const transferStatus = statusLine();
  const sayT = transferStatus.set;
  const restartWord = inApp ? 'Restart Argus' : 'Restart the proxy (argus web)';

  // POST to the proxy's setup API (same origin, the app's header, JSON).
  async function setupPost(route, payload) {
    try {
      const r = await fetch(`${proxyBase}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-argus-setup': '1' },
        body: JSON.stringify(payload),
        cache: 'no-store',
      });
      const body = await r.json().catch(() => ({}));
      return { ok: r.ok, body, error: body.error || `HTTP ${r.status}` };
    } catch {
      return { ok: false, body: {}, error: 'The proxy did not answer.' };
    }
  }

  async function saveKey(name, value) {
    const r = await setupPost('/setup/keys', { keys: { [name]: value } });
    if (!r.ok) {
      say(`${name} NOT SAVED: ${r.error}`, 'bad');
      logs?.add({
        level: 'warn',
        source: 'setup',
        title: `${name} NOT SAVED`,
        body: r.error,
      });
      return false;
    }
    say(
      `${name} ${value ? 'SAVED' : 'REMOVED'}. ${
        r.body.restartNeeded
          ? `${restartWord} for this one to take effect.`
          : 'In use now: toggle its layer off and on to load it.'
      }`,
      'ok',
    );
    restartBtn.hidden = !(
      r.body.restartNeeded &&
      inApp &&
      typeof host.restart === 'function'
    );
    return true;
  }
  const restartBtn = h(
    'button.ct-btn',
    { type: 'button', hidden: true, onclick: () => host?.restart?.() },
    'RESTART ARGUS',
  );

  // EXPORT / IMPORT: all set keys as one passphrase-encrypted file
  // (proxy/lib/setup.js), for moving them to another machine's proxy, e.g.
  // the laptop's keys onto the phone. Only offered where keys can be written.
  const pass = (placeholder) =>
    h('input', {
      type: 'password',
      autocomplete: 'new-password',
      spellcheck: 'false',
      placeholder,
      'aria-label': placeholder,
    });
  const exportPass = pass(`Passphrase (${PASSPHRASE_MIN}+ characters)`);
  const exportPass2 = pass('Repeat the passphrase');
  const bundleBox = h('textarea.ct-setup__text', {
    readonly: true,
    rows: 4,
    spellcheck: 'false',
    'aria-label': 'Encrypted keys file',
  });
  let lastBundle = '';
  const download = (text) => {
    // A Blob download; the Android app's WebView cannot save one, which is
    // why the same text is shown with COPY as well.
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = h('a', { href: url, download: 'argus-keys.json', hidden: true });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      // no download here: COPY is the way
    }
  };
  const exportResult = h(
    'div.ct-setup__result',
    { hidden: true },
    bundleBox,
    h(
      'div.ct-seg',
      {},
      h(
        'button.ct-btn',
        {
          type: 'button',
          onclick: async () =>
            sayT(
              (await copyText(lastBundle))
                ? 'Keys file copied: paste it into IMPORT on the other device.'
                : 'Copy is blocked here: select the text and copy it.',
              'ok',
            ),
        },
        'COPY',
      ),
      h(
        'button.ct-btn',
        { type: 'button', onclick: () => download(lastBundle) },
        'SAVE FILE',
      ),
    ),
    h(
      'div.ct-section__note',
      {},
      'Keep the file and the passphrase apart: together they unlock your keys.',
    ),
  );
  async function doExport() {
    const p = exportPass.value;
    if ([...p].length < PASSPHRASE_MIN) {
      sayT(`The passphrase needs at least ${PASSPHRASE_MIN} characters.`, 'bad');
      return;
    }
    if (p !== exportPass2.value) {
      sayT('The two passphrases differ.', 'bad');
      return;
    }
    sayT('Encrypting...');
    const r = await setupPost('/setup/keys/export', { passphrase: p });
    exportPass.value = '';
    exportPass2.value = '';
    if (!r.ok) {
      sayT(`NOT EXPORTED: ${r.error}`, 'bad');
      return;
    }
    lastBundle = JSON.stringify(r.body.bundle);
    bundleBox.value = lastBundle;
    exportResult.hidden = false;
    download(lastBundle);
    sayT(`${keysWord(r.body.names.length)} EXPORTED: ${r.body.names.join(', ')}.`, 'ok');
  }

  const importFile = h('input.ct-setup__file', {
    type: 'file',
    'aria-label': 'Keys file or .env file',
  });
  const importBox = h('textarea.ct-setup__text', {
    rows: 3,
    spellcheck: 'false',
    placeholder: 'Or paste the keys file, or .env lines (NAME=value)',
    'aria-label': 'Keys file or .env text',
  });
  const importPass = pass('Passphrase (for a keys file)');
  importFile.addEventListener('change', async () => {
    const f = importFile.files?.[0];
    if (!f) return;
    if (f.size > IMPORT_MAX_BYTES) {
      sayT('That file is too large to be a keys file.', 'bad');
      return;
    }
    importBox.value = await f.text().catch(() => '');
  });
  async function doImport() {
    const payload = importPayload(importBox.value);
    if (!payload) {
      sayT('Choose a file or paste its text first.', 'bad');
      return;
    }
    if (payload.bundle && [...importPass.value].length < PASSPHRASE_MIN) {
      sayT('Enter the passphrase the file was exported with.', 'bad');
      return;
    }
    sayT('Importing...');
    const r = await setupPost(
      '/setup/keys/import',
      payload.bundle ? { ...payload, passphrase: importPass.value } : payload,
    );
    importPass.value = '';
    if (!r.ok) {
      sayT(`NOT IMPORTED: ${r.error}`, 'bad');
      return;
    }
    importBox.value = '';
    importFile.value = '';
    const skipped = r.body.ignored?.length
      ? ` Left out: ${r.body.ignored.join(', ')}.`
      : '';
    sayT(
      `${keysWord(r.body.saved.length)} IMPORTED: ${r.body.saved.join(', ')}.${skipped}${
        r.body.restartNeeded ? ` ${restartWord} for OAuth and stream keys.` : ''
      }`,
      'ok',
    );
    restartBtn.hidden = !(
      r.body.restartNeeded &&
      inApp &&
      typeof host.restart === 'function'
    );
    loadKeys();
  }

  const exportForm = h(
    'div.ct-setup__form',
    { hidden: true },
    exportPass,
    exportPass2,
    h('button.ct-btn', { type: 'button', onclick: doExport }, 'EXPORT'),
    exportResult,
  );
  const importForm = h(
    'div.ct-setup__form',
    { hidden: true },
    importFile,
    importBox,
    importPass,
    h('button.ct-btn', { type: 'button', onclick: doImport }, 'IMPORT'),
  );
  const transferBtns = {};
  // One form open at a time; pressing the open one's button closes it.
  const showForm = (which) => {
    const openExport = which === 'export' && exportForm.hidden;
    const openImport = which === 'import' && importForm.hidden;
    exportForm.hidden = !openExport;
    importForm.hidden = !openImport;
    transferBtns.export.setAttribute('aria-pressed', String(!exportForm.hidden));
    transferBtns.import.setAttribute('aria-pressed', String(!importForm.hidden));
  };
  transferBtns.export = h(
    'button.ct-btn',
    { type: 'button', 'aria-pressed': 'false', onclick: () => showForm('export') },
    'EXPORT KEYS',
  );
  transferBtns.import = h(
    'button.ct-btn',
    { type: 'button', 'aria-pressed': 'false', onclick: () => showForm('import') },
    'IMPORT KEYS',
  );
  const transfer = h(
    'div.ct-setup__transfer',
    { hidden: true },
    h(
      'div.ct-seg.ct-seg--grid',
      { style: { '--cols': '2' } },
      transferBtns.export,
      transferBtns.import,
    ),
    transferStatus.el,
    exportForm,
    importForm,
  );

  const keys = collapsible(
    section('KEYS', keyNote, keyStatus.el, restartBtn, keyList, transfer),
    { id: 'setup.keys', meta: keyMeta },
  );

  // --------------------------------------------------------------- INSTALL
  // In a browser only: the Android app (and an installed page) needs neither.
  let deferred = null;
  const installBtn = h(
    'button.ct-btn',
    {
      type: 'button',
      hidden: true,
      onclick: async () => {
        if (!deferred) return;
        deferred.prompt();
        await deferred.userChoice.catch(() => null);
        deferred = null;
        installBtn.hidden = true;
      },
    },
    'INSTALL APP',
  );
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    installBtn.hidden = false;
  });
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches;
  const install =
    host || standalone
      ? null
      : section(
          'INSTALL',
          h(
            'div.ct-seg',
            {},
            installBtn,
            h(
              'a.ct-btn',
              {
                href: RELEASES,
                target: '_blank',
                rel: 'noopener noreferrer',
                title: 'The Argus app runs everything on the phone and in Android Auto',
              },
              'ANDROID APP ↗',
            ),
          ),
        );

  // ------------------------------------------------------------------ MORE
  // DETAILS: what a bug report needs.
  const gpu = capabilities?.webgl?.renderer || 'unknown';
  let fontOk = false;
  try {
    fontOk = document.fonts?.check?.("12px 'JetBrains Mono'") ?? false;
  } catch {
    fontOk = false;
  }
  const details = section(
    'DETAILS',
    row('QUALITY TIER', String(tier).toUpperCase()),
    row('RENDERER', String(gpu).slice(0, 60)),
    row('FONT', fontOk ? 'JETBRAINS MONO' : 'FALLBACK MONO', fontOk ? 'ok' : ''),
    row(
      'SECURE CONTEXT',
      window.isSecureContext ? 'YES' : 'NO (LOCATION OFF)',
      window.isSecureContext ? 'ok' : 'bad',
    ),
    readout,
  );

  // PROXY: point a phone browser at the proxy on another machine.
  let stored = '';
  try {
    stored = localStorage.getItem(PROXY_OVERRIDE_KEY) || '';
  } catch {
    stored = '';
  }
  const proxyInput = h('input', {
    type: 'url',
    value: stored,
    placeholder: 'https://192.168.1.20:8787',
    'aria-label': 'Proxy address',
    spellcheck: 'false',
  });
  const applyProxy = (value) => {
    const v = value.trim();
    if (v && !/^https?:\/\/[^\s/]+(:\d+)?\/?$/i.test(v)) {
      notify({
        title: 'NOT A PROXY ADDRESS',
        body: 'Use http(s)://host:port',
        level: 'low',
      });
      return;
    }
    try {
      if (v) localStorage.setItem(PROXY_OVERRIDE_KEY, v.replace(/\/$/, ''));
      else localStorage.removeItem(PROXY_OVERRIDE_KEY);
    } catch {
      notify({
        title: 'CANNOT REMEMBER IT',
        body: 'Storage is blocked here.',
        level: 'low',
      });
      return;
    }
    location.reload();
  };
  const proxy = section(
    'PROXY',
    row('IN USE', proxyBase ? proxyBase.replace(/^https?:\/\//, '') : 'NONE'),
    h(
      'div.ct-setup__input',
      {},
      proxyInput,
      h(
        'button.ct-btn',
        { type: 'button', onclick: () => applyProxy(proxyInput.value) },
        'USE',
      ),
      h('button.ct-btn', { type: 'button', onclick: () => applyProxy('') }, 'RESET'),
    ),
  );

  const more = disclosure(
    'MORE',
    { id: 'setup.more' },
    details,
    host ? null : proxy,
    keyboard
      ? section(
          'KEYBOARD',
          h('button.ct-btn', { type: 'button', onclick: () => openKeys() }, 'SHORTCUTS'),
        )
      : null,
  );

  const logsPanel = logs ? createLogsPanel(logs) : null;

  const el = h(
    'div.ct-setup',
    {},
    // The settings dialog first: on a phone this is its only way in (the
    // desktop bar also has SET, and the comma key). In the Android app, its
    // own settings screen (keys file, LAN sharing, full screen) sits beside.
    h(
      'div.ct-seg.ct-setup__top',
      {},
      h('button.ct-btn', { type: 'button', onclick: () => openSettings() }, 'SETTINGS'),
      inApp
        ? h(
            'button.ct-btn',
            { type: 'button', onclick: () => host.openSettings() },
            'APP SETTINGS',
          )
        : null,
    ),
    status,
    keys,
    install,
    more,
    // Feed failures, for when something looks wrong.
    logsPanel?.el ?? null,
  );
  loadKeys();
  return { el, refresh: loadKeys, logs: logsPanel };
}

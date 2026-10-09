import './settings.css';
import { h } from './dom.js';
import { section } from './controls.js';
import { createLogsPanel, copyText } from './logs.js';

// SETUP: everything needed to get Argus running well, in one tab, in the
// order a first run needs it. STATUS (proxy, GPU, tier, font, secure context),
// KEYS (which optional keys are set, saving new ones to the proxy on this
// machine: never kept in the browser; and moving them to another machine as
// a passphrase-encrypted file), PROXY (point the app at another proxy, e.g.
// your home machine from the phone), PERMISSIONS (location, motion), INSTALL
// (as an app, the Android app, Android Auto), a short START guide, and LOGS
// (feed failures, collapsed, out of the way).

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
 *   openKeys: () => void, logs?: object }} deps  logs: the app's log store
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
}) {
  const checks = h('div');
  const check = (label, value, state = '') =>
    h(
      'div.ct-setup__check',
      {},
      h('span', {}, label),
      h('b', { dataset: { state } }, value),
    );

  const feeds = health?.feeds ?? [];
  const ready = feeds.filter((f) => f.configured).length;
  const gpu = capabilities?.webgl?.renderer || 'unknown';
  let fontOk = false;
  try {
    fontOk = document.fonts?.check?.("12px 'JetBrains Mono'") ?? false;
  } catch {
    fontOk = false;
  }
  checks.append(
    check('PROXY', proxyBase ? 'LIVE' : 'DEMO (NO PROXY)', proxyBase ? 'ok' : 'bad'),
    check(
      'FEEDS READY',
      feeds.length ? `${ready}/${feeds.length}` : '--',
      ready ? 'ok' : '',
    ),
    check('QUALITY TIER', String(tier).toUpperCase()),
    check(
      'GPU',
      capabilities?.webgl?.softwareRendering ? 'SOFTWARE (SLOW)' : 'HARDWARE',
      capabilities?.webgl?.softwareRendering ? 'bad' : 'ok',
    ),
    h('div.ct-section__note', {}, String(gpu).slice(0, 120)),
    check('FONT', fontOk ? 'JETBRAINS MONO' : 'FALLBACK MONO', fontOk ? 'ok' : ''),
    check(
      'SECURE CONTEXT',
      window.isSecureContext ? 'YES' : 'NO (LOCATION OFF)',
      window.isSecureContext ? 'ok' : 'bad',
    ),
  );

  // KEYS: the list comes from the proxy; values never come back.
  const keyList = h('div');
  const keyNote = h('div.ct-section__note', {}, 'Loading...');
  async function loadKeys() {
    keyList.innerHTML = '';
    if (!proxyBase) {
      keyNote.textContent =
        'No proxy: keys are set on the machine running it (argus web).';
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
      keyNote.textContent = 'This proxy does not offer key setup (update it).';
      return;
    }
    keyNote.textContent = data.writable
      ? `Saved to ${data.file ?? 'the keys file'} on this machine (mode 600), never in the browser.`
      : 'Read only here: open SETUP on the machine running the proxy to set keys, or edit ~/.config/argus/.env there.';
    for (const k of data.keys) keyList.appendChild(keyRow(k, data.writable));
    transfer.hidden = !(data.writable && data.transfer);
  }

  function keyRow(k, writable) {
    const state = h(
      'span.ct-setup__state',
      { dataset: { on: String(k.set) } },
      k.set ? 'SET' : 'NOT SET',
    );
    const row = h(
      'div.ct-setup__row',
      {},
      h('span.ct-setup__name', {}, k.name),
      state,
      h(
        'span.ct-setup__for',
        {},
        `FOR ${k.feeds.join(', ').toUpperCase()}${k.restart ? ' (RESTART TO USE)' : ''}`,
      ),
    );
    if (writable) {
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
            const ok = await saveKey(k.name, value);
            if (ok) loadKeys();
          },
        },
        k.set ? 'REPLACE' : 'SAVE',
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
      row.appendChild(h('div.ct-setup__input', {}, input, save, clear));
    }
    return row;
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
          ? 'Restart the proxy (argus web) for this one to take effect.'
          : 'In use now: toggle its layer off and on to load it.'
      }`,
      'ok',
    );
    return true;
  }

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
      'Encrypted (scrypt + AES-256-GCM). Keep the file and the passphrase apart: anyone with both has your keys.',
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
        r.body.restartNeeded ? ' Restart the proxy for OAuth and stream keys.' : ''
      }`,
      'ok',
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
  const logsPanel = logs ? createLogsPanel(logs) : null;

  const transfer = h(
    'div.ct-setup__transfer',
    { hidden: true },
    h('div.ct-field__label', {}, 'MOVE KEYS TO ANOTHER DEVICE'),
    h('div.ct-seg', {}, transferBtns.export, transferBtns.import),
    transferStatus.el,
    exportForm,
    importForm,
  );

  // PROXY override, for a phone browser using a proxy on another machine.
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

  // PERMISSIONS.
  const locState = h('b', {}, '--');
  const askLocation = () =>
    navigator.geolocation?.getCurrentPosition(
      () => (locState.textContent = 'GRANTED'),
      (e) => (locState.textContent = e.code === 1 ? 'DENIED' : 'UNAVAILABLE'),
      { timeout: 10_000 },
    );
  navigator.permissions
    ?.query({ name: 'geolocation' })
    .then((p) => {
      locState.textContent = p.state.toUpperCase();
      p.onchange = () => (locState.textContent = p.state.toUpperCase());
    })
    .catch(() => {});
  const motionState = h(
    'b',
    {},
    'DeviceOrientationEvent' in window ? 'AVAILABLE' : 'NONE',
  );
  const askMotion = async () => {
    const req = window.DeviceOrientationEvent?.requestPermission;
    if (typeof req !== 'function') {
      motionState.textContent = 'NO PROMPT NEEDED';
      return;
    }
    try {
      motionState.textContent = String(await req()).toUpperCase();
    } catch {
      motionState.textContent = 'DENIED';
    }
  };

  // INSTALL as an app (PWA), when the browser offers it.
  let deferred = null;
  const installBtn = h(
    'button.ct-btn',
    {
      type: 'button',
      disabled: true,
      onclick: async () => {
        if (!deferred) return;
        deferred.prompt();
        await deferred.userChoice.catch(() => null);
        deferred = null;
        installBtn.disabled = true;
      },
    },
    'INSTALL APP',
  );
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    installBtn.disabled = false;
  });
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches;

  const el = h(
    'div',
    {},
    // The settings dialog, first: on a phone this is its only way in (the
    // desktop bar also has SET, and the comma key).
    h(
      'div.ct-seg',
      { style: { marginBottom: '10px' } },
      h(
        'button.ct-btn',
        { type: 'button', style: { flex: '1' }, onclick: () => openSettings() },
        'SETTINGS  \u2699',
      ),
    ),
    section('STATUS', checks),
    section(
      'KEYS',
      keyNote,
      // Export / import first: the list of every key is long.
      transfer,
      keyStatus.el,
      keyList,
      h(
        'div.ct-section__note',
        {},
        'Every key is optional: without one, its layer is simply not offered.',
      ),
    ),
    section(
      'PROXY',
      h(
        'div.ct-section__note',
        {},
        proxyBase ? `Using ${proxyBase}.` : 'No proxy found: the app runs on demo data.',
      ),
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
      h(
        'div.ct-section__note',
        {},
        'From a phone browser, point at the proxy on your own machine over HTTPS (npm run start:https prints its LAN address).',
      ),
    ),
    section(
      'PERMISSIONS',
      h('div.ct-setup__check', {}, h('span', {}, 'LOCATION'), locState),
      h('button.ct-btn', { type: 'button', onclick: askLocation }, 'ALLOW LOCATION'),
      h('div.ct-setup__check', {}, h('span', {}, 'MOTION / COMPASS'), motionState),
      h('button.ct-btn', { type: 'button', onclick: askMotion }, 'ALLOW MOTION'),
    ),
    section(
      'INSTALL',
      h(
        'div.ct-section__note',
        {},
        standalone
          ? 'Running as an installed app.'
          : 'Install this page as an app (needs HTTPS or localhost).',
      ),
      installBtn,
      h(
        'div.ct-section__note',
        {},
        'Android: the Argus app runs the whole stack on the phone, no laptop, and works as an Android Auto map. Download the APK from the releases page on the phone.',
      ),
      h(
        'a.ct-btn',
        { href: RELEASES, target: '_blank', rel: 'noopener noreferrer' },
        'ANDROID APP ↗',
      ),
    ),
    section(
      'START',
      h(
        'div.ct-section__note',
        {},
        'Pick a preset (NEAR, SKY, HAZ, ENV, WATCH, NET), tap a contact to open its card, FOLLOW to ride its camera, COCKPIT to ride along. Search with / or the SEARCH cell.',
      ),
      h(
        'div.ct-seg',
        {},
        h('button.ct-btn', { type: 'button', onclick: () => openKeys() }, 'KEYBOARD'),
      ),
    ),
    // Last and collapsed: feed failures, for when something looks wrong.
    logsPanel?.el ?? null,
  );
  loadKeys();
  return { el, refresh: loadKeys, logs: logsPanel };
}

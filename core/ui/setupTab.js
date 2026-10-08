import './settings.css';
import { h } from './dom.js';
import { section } from './controls.js';

// SETUP: everything needed to get Argus running well, in one tab, in the
// order a first run needs it. STATUS (proxy, GPU, tier, font, secure context),
// KEYS (which optional keys are set, and saving new ones to the proxy on this
// machine: never kept in the browser), PROXY (point the app at another proxy,
// e.g. your home machine from the phone), PERMISSIONS (location, motion),
// INSTALL (as an app, the Android app, Android Auto) and a short START guide.

const RELEASES = 'https://github.com/H4ch1Net/argus/releases/latest';
export const PROXY_OVERRIDE_KEY = 'argus.proxyBase';

/**
 * @param {{ proxyBase: string|null, health: object|null, tier: string,
 *   capabilities: object, notify: Function, openSettings: () => void,
 *   openKeys: () => void }} deps
 */
export function createSetupTab({
  proxyBase,
  health,
  tier,
  capabilities,
  notify,
  openSettings,
  openKeys,
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

  async function saveKey(name, value) {
    try {
      const r = await fetch(`${proxyBase}/setup/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-argus-setup': '1' },
        body: JSON.stringify({ keys: { [name]: value } }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        notify({
          title: 'KEY NOT SAVED',
          body: body.error || `HTTP ${r.status}`,
          level: 'low',
        });
        return false;
      }
      notify({
        title: value ? `${name} SAVED` : `${name} REMOVED`,
        body: body.restartNeeded
          ? 'Restart the proxy (argus web) for this one to take effect.'
          : 'In use now. Toggle its layer off and on to load it.',
        level: 'low',
      });
      return true;
    } catch {
      notify({ title: 'KEY NOT SAVED', body: 'The proxy did not answer.', level: 'low' });
      return false;
    }
  }

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
  );
  loadKeys();
  return { el, refresh: loadKeys };
}

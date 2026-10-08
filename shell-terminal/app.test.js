import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTuiApp } from './app.js';
import { connectBackend } from './backend.js';
import { composeFrame } from './ui.js';
import { parseKeys } from './keys.js';

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

async function demoApp(opts = {}) {
  const backend = await connectBackend({ demo: true });
  let output = '';
  let quit = false;
  const app = createTuiApp({
    backend,
    write: (s) => {
      output += s;
    },
    size: () => ({ cols: 120, rows: 36 }),
    unicode: opts.unicode ?? true,
    colorMode: 'none',
    onQuit: () => {
      quit = true;
    },
    ...opts,
  });
  await app.start({ layers: opts.layers ?? null });
  await settle();
  return { app, output: () => output, quitCalled: () => quit };
}

const plain = (app) => {
  app.render();
  return composeFrame(app.state).screen.toPlain().join('\n');
};
const logText = (app) => app.state.log.map((l) => l.text).join('\n');

test('boots on demo data with the default layers and says so', async () => {
  const { app, output } = await demoApp();
  try {
    const running = app.layers.filter((l) => l.running).map((l) => l.key);
    assert.deepEqual(running, ['flights', 'quakes', 'transit']);
    assert.ok(output().includes('ARGUS'));
    const frame = plain(app);
    assert.match(frame, /DEMO DATA/);
    assert.match(frame, /LAYERS/);
    assert.ok(app.state.entities.length > 0, 'entities are plotted');
  } finally {
    app.stop();
  }
});

test('shared commands drive layers, the view, and passive lookups', async () => {
  const { app } = await demoApp();
  try {
    await app.runCommand('layer ships on');
    await settle();
    assert.ok(app.layers.find((l) => l.key === 'ships').running);

    await app.runCommand('goto 48.85,2.35 500000');
    assert.ok(Math.abs(app.state.view.lat - 48.85) < 1e-9);
    assert.ok(Math.abs(app.state.view.lon - 2.35) < 1e-9);

    await app.runCommand('query 8.8.8.8');
    assert.equal(app.state.selected.layer, 'osint');
    assert.equal(app.state.card.title, '8.8.8.8');
    assert.match(plain(app), /8\.8\.8\.8/);

    await app.runCommand('query jane smith');
    assert.match(logText(app), /not a valid asset/);

    await app.runCommand('nonsense');
    assert.match(logText(app), /unknown command/);
  } finally {
    app.stop();
  }
});

test('keys: number toggles a layer, tab selects, enter tracks, escape releases', async () => {
  const { app } = await demoApp();
  try {
    app.handleKeys(parseKeys('2'));
    assert.equal(app.layers.find((l) => l.key === 'quakes').running, false);

    app.handleKeys(parseKeys('\t'));
    assert.ok(app.state.selected, 'tab selected something in view');
    assert.ok(app.state.card?.title);
    app.handleKeys(parseKeys('\r'));
    assert.equal(app.state.tracking, true);
    app.handleKeys(parseKeys('\x1b'));
    assert.equal(app.state.tracking, false);
    app.handleKeys(parseKeys('\x1b'));
    assert.equal(app.state.selected, null);

    const before = app.state.view.degPerDot;
    app.handleKeys(parseKeys('+'));
    assert.ok(app.state.view.degPerDot < before);
    app.handleKeys(parseKeys('w'));
    assert.ok(app.state.view.degPerDot >= before);
  } finally {
    app.stop();
  }
});

test('command mode edits a line and runs it on enter', async () => {
  const { app } = await demoApp();
  try {
    app.handleKeys(parseKeys(':layrs'));
    app.handleKeys(parseKeys('\x1b[D\x1b[D'));
    app.handleKeys(parseKeys('e'));
    assert.equal(app.state.input, 'layers');
    app.handleKeys(parseKeys('\r'));
    await settle();
    assert.equal(app.state.mode, 'map');
    assert.match(logText(app), /\[on\] {2}flights/);
  } finally {
    app.stop();
  }
});

test('presets apply the shared layer sets and skip globe-only layers', async () => {
  const { app } = await demoApp();
  try {
    await app.runCommand('preset surveillance');
    await settle();
    const on = app.layers.filter((l) => l.running).map((l) => l.key);
    assert.deepEqual(on.sort(), [
      'borderwaits',
      'installations',
      'surveillance',
      'trafficcams',
    ]);
    assert.match(logText(app), /globe-only layers skipped: cctv/);
  } finally {
    app.stop();
  }
});

test('export writes the entities in view as JSON', async () => {
  const { app } = await demoApp();
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'argus-exp-')),
    'view.json',
  );
  try {
    await app.runCommand(`export ${file}`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(data.entities) && data.entities.length > 0);
    assert.ok(data.entities[0].card?.title);
  } finally {
    app.stop();
  }
});

test('ascii mode draws no braille or arrows; q quits', async () => {
  const { app, quitCalled } = await demoApp({ unicode: false });
  try {
    const frame = plain(app);
    assert.equal(/[⠀-⣿←-↙]/.test(frame), false);
    app.handleKeys(parseKeys('q'));
    assert.equal(quitCalled(), true);
  } finally {
    app.stop();
  }
});

test('a terminal smaller than the minimum does not redraw or refetch every frame', async () => {
  const backend = await connectBackend({ demo: true });
  let clears = 0;
  const app = createTuiApp({
    backend,
    write: (s) => {
      if (s.includes('\x1b[2J')) clears += 1;
    },
    size: () => ({ cols: 30, rows: 8 }),
    colorMode: 'none',
  });
  await app.start({ layers: [] });
  for (let i = 0; i < 5; i += 1) app.render();
  assert.equal(clears, 1, 'only the first frame clears the screen');
  app.stop();
});

test('tracking a mover re-scopes the viewport feeds once it drifts', async () => {
  const { app } = await demoApp({ layers: ['quakes'] });
  try {
    const layer = app.layers.find((l) => l.key === 'quakes');
    let refetches = 0;
    const original = layer.viewChanged;
    layer.viewChanged = () => {
      refetches += 1;
      original();
    };
    await app.runCommand('goto 0,0 500000');
    await settle(400);
    const before = refetches;
    // Simulate following an entity that keeps moving east.
    app.state.selected = { layer: 'osint', id: 'probe' };
    app.state.osint = [
      { id: 'probe', value: 'x', position: { longitude: 0, latitude: 0 } },
    ];
    app.state.tracking = true;
    for (let lon = 0; lon <= 12; lon += 0.5) {
      app.state.osint[0].position = { longitude: lon, latitude: 0 };
      app.render();
    }
    await settle(400);
    assert.ok(refetches > before, 'the feeds followed the tracked entity');
  } finally {
    app.stop();
  }
});

test('every layer ported from the reference runs on demo data', async () => {
  const keys = [
    'transit',
    'military',
    'cyclones',
    'launches',
    'radio',
    'datacenters',
    'installations',
    'landings',
    'trafficcams',
    'bikeshare',
  ];
  const { app } = await demoApp({ layers: keys });
  try {
    await settle(250);
    for (const key of keys) {
      const rt = app.layers.find((l) => l.key === key);
      assert.ok(rt, key);
      assert.ok(rt.running, `${key} running`);
      assert.notEqual(rt.status.state, 'error', `${key}: ${rt.status.message}`);
    }
    // The global ones have something on the world view straight away.
    for (const key of ['military', 'cyclones', 'launches', 'radio', 'landings']) {
      const rt = app.layers.find((l) => l.key === key);
      assert.ok(rt.entities(Date.now()).length > 0, `${key} has entities`);
    }
    // Their cards come from the shared formatters.
    await app.runCommand('track Demo Alpha');
    assert.equal(app.state.card?.title, 'Demo Alpha');
  } finally {
    app.stop();
  }
});

test('a click or tap on a side-panel layer row toggles that layer', async () => {
  const { app } = await demoApp();
  try {
    app.render();
    const hit = app.state.sideHits.find((h) => h.key === 'satellites');
    assert.ok(hit, 'satellites row drawn');
    const x = 100; // inside the side panel at 120 columns
    const at = `${x + 1};${hit.y + 1}`;
    app.handleKeys(parseKeys(`\x1b[<0;${at}M\x1b[<0;${at}m`));
    await settle();
    assert.equal(app.layers.find((l) => l.key === 'satellites').running, true);
  } finally {
    app.stop();
  }
});

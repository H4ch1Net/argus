import './styles.css';
import { detectCapabilities } from './core/index.js';

// App entry point.
//
// One web app, three targets. This file does exactly one form-factor decision:
// which shell to mount. Shell choice is a layout + input concern (bottom sheet +
// touch vs side panel + mouse), so it branches on input modality and screen
// size. It deliberately does NOT decide quality: that is capability-tier state,
// owned by core and re-derived from the same probe. Keeping the two decisions
// separate is the rule from master plan 3.1.

/**
 * Pick a shell by form factor. A coarse primary pointer with no real hover on a
 * small screen is a phone/tablet and gets the mobile shell; everything else
 * gets the desktop shell. A `?shell=mobile|desktop` query override helps testing
 * one shell on the other's hardware.
 */
function pickShell(caps) {
  const override = new URLSearchParams(location.search).get('shell');
  if (override === 'mobile' || override === 'desktop') return override;
  // The Android Auto map (android/, shell-car/): only ever chosen explicitly.
  if (override === 'car') return 'car';

  const handheld =
    caps.input.coarsePointer && !caps.input.hover && caps.screen.longEdge <= 1600;
  return handheld ? 'mobile' : 'desktop';
}

function showFatal(root, title, message) {
  root.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'argus-fatal';
  el.innerHTML = `<div><h1>${title}</h1><p>${message}</p></div>`;
  root.appendChild(el);
}

async function main() {
  const root = document.getElementById('app');
  const caps = detectCapabilities();

  // Fail loudly and helpfully on the two conditions that make Cesium hard-fail,
  // rather than letting the viewer throw an opaque error.
  if (!caps.webgl.supported) {
    showFatal(
      root,
      'WebGL unavailable',
      'This browser is not exposing WebGL, so the 3D globe cannot start. Enable hardware acceleration and reload.',
    );
    return;
  }
  if (caps.webgl.softwareRendering) {
    showFatal(
      root,
      'Hardware acceleration required',
      'The browser is using software rendering, which Cesium refuses to run on. Check <code>chrome://gpu</code>, enable GPU acceleration, and reload.',
    );
    return;
  }

  const shellName = pickShell(caps);
  const { createSplash } = await import('./core/ui/splash.js');
  const splash = createSplash();
  document.body.appendChild(splash.el);
  splash.step(`ARGUS_BOOT : SHELL_${shellName.toUpperCase()}`, 10);

  try {
    const { mountShell } =
      shellName === 'car'
        ? await import('./shell-car/index.js')
        : shellName === 'mobile'
          ? await import('./shell-mobile/index.js')
          : await import('./shell-desktop/index.js');

    // Settings (core/settings/store.js) shape the boot: tier, frame rate,
    // resolution and globe detail. Everything else applies once it is up.
    const { createSettingsStore, profileOverrides } =
      await import('./core/settings/store.js');
    let storage = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    const settings = createSettingsStore(storage);
    const app = await mountShell(root, {
      tier: settings.get('tier'),
      profile: profileOverrides(settings.all(), window.devicePixelRatio || 1),
    });
    app.settings = settings;
    // The user's own position (core/geo/selfPosition.js): one model for every
    // shell. Shells and the Android app feed it, GEO and navigation read it;
    // it draws the marker except in the car, which draws its own (same icon).
    const { createSelfPosition } = await import('./core/geo/selfPosition.js');
    app.selfPosition = createSelfPosition(app.viewer, {
      settings,
      render: shellName !== 'car',
      fps: app.profile?.animationFps,
      onIcon: app.setSelfIcon,
      log: (entry) => app.logs?.add?.(entry),
    });
    if (import.meta.env.DEV) {
      // Expose for console poking during development only; never in a build.
      window.__argus = { shell: shellName, ...app };
      console.info(
        `[argus] booted ${shellName} shell, tier=${app.tier}`,
        app.capabilities,
      );
    }

    splash.step(`GLOBE_ONLINE : TIER_${String(app.tier).toUpperCase()}`, 30);
    await setupScene(app, splash);
    splash.done();
  } catch (err) {
    splash.el.remove();
    console.error('[argus] boot failed', err);
    showFatal(
      root,
      'Globe failed to start',
      'The 3D scene could not initialize. If you are on Linux, confirm hardware acceleration in <code>chrome://gpu</code>.',
    );
  }
}

// Set up the scene: register the available layers, wire presets + toggle UI and
// the interaction spine, then apply the default state. Data comes from the proxy
// (VITE_PROXY_BASE_URL, or the app's own origin when the proxy serves it or the
// dev server forwards to it), otherwise from dev mocks; with neither (a
// production build that cannot reach a proxy) no layers register.
async function setupScene(app, splash) {
  const dev = import.meta.env.DEV;
  const { discoverProxy, feedConfigured } = await import('./core/net/discoverProxy.js');
  // A proxy chosen in SETUP (e.g. a home machine, from a phone browser) wins
  // over the build-time one and the page's own origin.
  let chosenProxy = null;
  try {
    chosenProxy = localStorage.getItem('argus.proxyBase');
  } catch {
    chosenProxy = null;
  }
  const { base: proxyBase, health } = await discoverProxy({
    explicit: chosenProxy || import.meta.env.VITE_PROXY_BASE_URL || null,
    origin: location.origin,
  });
  splash?.step(
    proxyBase ? 'LOG_STREAM_CONNECTED : PROXY' : 'LOG_STREAM_MISSING : DEMO',
    45,
  );

  // LOGS (core/ui/logs.js): feed, network and layer failures go to this store,
  // shown collapsed at the end of SETUP, never as popups; only the genuinely
  // critical still pops up (no proxy at all, the GPU dropping the globe). The
  // console hears each distinct failure once, not every poll.
  const [{ createNotifier }, { createLogStore }] = await Promise.all([
    import('./core/ui/hud/notify.js'),
    import('./core/ui/logs.js'),
  ]);
  const logs = createLogStore();
  app.logs = logs;
  const log = (entry) => {
    const e = logs.add(entry);
    if (e.count === 1 && e.level !== 'info')
      console.warn(
        `[argus] ${e.source ? `${e.source}: ` : ''}${e.title} ${e.body}`.trim(),
      );
    return e;
  };
  const notifier = createNotifier({ log });
  app.mount('notify', notifier.el);
  const glCanvas = app.viewer.scene.canvas;
  glCanvas.addEventListener('webglcontextlost', () => {
    log({ level: 'error', source: 'gpu', title: 'GRAPHICS CONTEXT LOST' });
    notifier.push({
      title: 'GRAPHICS RESET',
      body: 'The GPU dropped the globe; it is being restored.',
      level: 'critical',
      key: 'gl',
      kind: 'notice',
    });
  });
  glCanvas.addEventListener('webglcontextrestored', () => {
    log({ level: 'info', source: 'gpu', title: 'GRAPHICS CONTEXT RESTORED' });
    notifier.clear('gl');
  });

  // A production build with no proxy has no data source (mocks are dev-only), so
  // no layers can load. Say so plainly instead of leaving a bare globe with no UI.
  if (!proxyBase && !dev) {
    notifier.push({
      title: 'NO PROXY REACHABLE',
      body: 'Run "npm start" (it serves this app and its proxy together) or set VITE_PROXY_BASE_URL.',
      level: 'critical',
    });
    return;
  }

  const [
    { createLayerManager },
    { createCameraControls },
    { PRESETS, DEFAULT_LAYERS, applyPreset },
    { createGeocoder },
    { createSearch },
    { createLookup },
    { createCorrelator },
    { createOsintPlotter },
    { createSceneClock },
  ] = await Promise.all([
    import('./core/scene/layerManager.js'),
    import('./core/scene/cameraControls.js'),
    import('./core/presets.js'),
    import('./core/search/geocoder.js'),
    import('./core/search/search.js'),
    import('./core/osint/lookup.js'),
    import('./core/osint/correlate.js'),
    import('./core/osint/plotter.js'),
    import('./core/scene/clock.js'),
  ]);

  let proxyClient = null;
  if (proxyBase) {
    const { createProxyClient } = await import('./core/net/proxyClient.js');
    proxyClient = createProxyClient({ baseUrl: proxyBase });
  }
  // Websocket URLs for the push feeds (http->ws, https->wss).
  const wsBase = proxyBase ? proxyBase.replace(/^http/, 'ws').replace(/\/+$/, '') : null;
  const wsUrl = wsBase ? `${wsBase}/ws/ais` : null;
  const wsBgpUrl = wsBase ? `${wsBase}/ws/bgp` : null;
  const wsCtUrl = wsBase ? `${wsBase}/ws/ct` : null;

  // Scene clock (Phase 17): the shared "now" the SDK positions movers against, so
  // the time scrubber can rewind them all together. A scrub must render at once.
  const clock = createSceneClock();
  clock.subscribe(() => app.viewer.scene.requestRender());

  // The car (Android Auto) shares this code and this origin's saved settings
  // with the phone app, but draws on a second screen from the same phone GPU:
  // it keeps its own fixed, light look (no saved imagery, relief, sun, stars),
  // and draws aircraft on their ground track, since its camera looks down from
  // below cruise altitude (shell-car/index.js).
  const car = app.shell === 'car';
  const manager = createLayerManager(app.viewer, {
    readout: app.readout,
    clock,
    animationFps: app.profile?.animationFps,
    groundClamp: car,
  });
  const camera = createCameraControls(app.viewer);
  const desktop = app.shell === 'desktop';
  // Gestures and merge nearby (every shell, the car's included): a pinch that
  // follows the fingers, the trackpad pinch and the zoom envelope
  // (core/interaction/cameraInput.js; double and triple tap are the picker's),
  // and the scene's cluster policy (core/layers/sdk/cluster.js), on unless
  // switched off in VIEW > CONTACTS.
  const [{ tuneCameraInput }, { clusterPolicy }] = await Promise.all([
    import('./core/interaction/cameraInput.js'),
    import('./core/layers/sdk/cluster.js'),
  ]);
  tuneCameraInput(app.viewer, camera);
  const merge = clusterPolicy(app.viewer.scene);
  merge.set({ merge: app.settings?.get('merge') ?? true });
  // Icon size and variants (SETTINGS > ICONS, core/ui/iconPrefs.js): the scene's
  // icon policy follows the saved settings in every shell, the car's included,
  // so layers draw with the chosen size, variant and scale-with-zoom from the
  // start and restyle live on a change.
  const { iconPolicy, bindIconSettings } = await import('./core/ui/iconPrefs.js');
  if (app.settings) bindIconSettings(iconPolicy(app.viewer.scene), app.settings);

  // Each registration: how to load the (Cesium-heavy) definition and how to
  // build a source. The DEV-guarded mock import lets production drop the mock
  // chunk entirely; only the proxy source ships.
  // Shared by the timed weather overlays: one observation clock, so radar,
  // clouds and lightning step through history together (the VIEW strip).
  const { createWeatherTimeline } = await import('./core/layers/weather/timeline.js');
  const weatherTimeline = createWeatherTimeline();
  const timedWeather = (productId) => async (c) => {
    const { createTimedWeatherSource } =
      await import('./core/layers/weather/timedSource.js');
    return createTimedWeatherSource({
      productId,
      proxyClient: c,
      timeline: weatherTimeline,
      maximumLevel: app.tier === 'full' ? undefined : 5,
    });
  };
  // Starlink dense mode (VIEW > SATELLITES), read by the constellation source.
  let starlinkDense = false;
  // Recent imagery (NASA HLS / VIIRS): the catalogue the VIEW tool searches and
  // the layer shows from.
  const { createImageryCatalogue } = await import('./core/layers/imagery/catalog.js');
  const imageryCatalogue = proxyClient
    ? createImageryCatalogue({ buildUrl: proxyClient.buildUrl })
    : null;
  const cycloneForecastSource = async (c) => {
    const { createCycloneForecastSource } =
      await import('./core/layers/cyclonecones/source.js');
    return createCycloneForecastSource({ proxyClient: c });
  };
  const cycloneForecastMock = () =>
    import.meta.env.DEV
      ? import('./core/layers/cyclonecones/mockSource.js').then((m) =>
          m.createCycloneForecastMockSource(),
        )
      : Promise.resolve(null);

  // The user's saved places (core/places/saved.js), on this device only: a
  // map layer, TOOLS > MY PLACES, and search.
  const { createPlacesStore, placeToNormalized } = await import('./core/places/saved.js');
  let placesStorage = null;
  try {
    placesStorage = window.localStorage;
  } catch {
    placesStorage = null;
  }
  const placesStore = createPlacesStore(placesStorage);
  const placesSource = async () => placesStore.list().map(placeToNormalized);

  // Keyed sources inside a layer (Windy, NPS, WSDOT, 511 states): offered only
  // when the proxy reports the feed configured (its key is set).
  const keyed = (id) => Boolean(health && feedConfigured(health, id));

  // OSM map objects (surveillance, traffic lights, landmarks): fetched once per
  // tile and kept for hours (core/layers/overpass/tiles.js). "Nearest" counts
  // from your own position while the view follows you (the car's follow view,
  // or a shell that reports app.followingSelf()), else from the ground in the
  // middle of the view. RELOAD (VIEW > SURVEILLANCE) fetches the areas again.
  const [{ computeViewportQuery }, { windowToLatLon }, { createLandmarksLoader }] =
    await Promise.all([
      import('./core/layers/sdk/viewport.js'),
      import('./core/scene/sketch.js'),
      import('./core/layers/landmarks/parse.js'),
    ]);
  const followFix = () => {
    const car = app.shell === 'car' ? window.argusCar?.state?.() : null;
    if (car?.following && car.fix) return { lat: car.fix.lat, lon: car.fix.lon };
    const f = app.followingSelf?.() ? app.selfPosition?.get?.() : null;
    return f ? { lat: f.lat, lon: f.lon } : null;
  };
  const osm = {
    sources: {},
    // One tile loader for the Landmarks layer and TOOLS > LANDMARKS.
    landmarks: proxyClient ? createLandmarksLoader({ proxyClient }) : null,
    middle: () => {
      const cv = app.viewer.scene.canvas;
      return windowToLatLon(app.viewer, {
        x: cv.clientWidth / 2,
        y: cv.clientHeight / 2,
      });
    },
    anchor: () => followFix() ?? osm.middle(),
    view: () => computeViewportQuery(app.viewer).bbox,
    scope: (key) => ({
      mode: () =>
        key === 'surveillance' ? (app.settings?.get('survScope') ?? 'nearest') : 'all',
      anchor: osm.anchor,
      view: osm.view,
    }),
    keep: (key, source) => (osm.sources[key] = source),
    refresh: (key) => manager.getLayer(key)?.refresh?.(),
    reload() {
      osm.landmarks?.reload();
      for (const [key, source] of Object.entries(osm.sources)) {
        source.reload?.();
        osm.refresh(key);
      }
    },
  };
  // Following yourself never settles the camera (no moveEnd): re-pick the
  // nearest surveillance every few seconds once you have moved 150 m.
  let lastFollow = null;
  setInterval(() => {
    if (document.hidden || !manager.isEnabled('surveillance')) return;
    const f = followFix();
    if (!f || app.settings?.get('survScope') === 'all') return;
    const k = Math.cos((f.lat * Math.PI) / 180);
    const moved = lastFollow
      ? Math.hypot((f.lon - lastFollow.lon) * k, f.lat - lastFollow.lat) * 111_000
      : Infinity;
    if (moved < 150) return;
    lastFollow = f;
    osm.refresh('surveillance');
  }, 4000);

  const registrations = [
    {
      key: 'flights',
      group: 'Air & space',
      label: 'Flights',
      loadDef: () =>
        import('./core/layers/flights/definition.js').then((m) => m.flightsDefinition),
      // OpenSky when its OAuth2 client is configured on the proxy; otherwise the
      // keyless adsb.lol feed, so the default-on layer works with zero keys. An
      // unreachable explicit proxy (no health report) keeps the OpenSky path so
      // the readout shows the honest error.
      proxy: async (c) => {
        const { adsbPointPath, openSkyParams } =
          await import('./core/layers/flights/parse.js');
        if (!health || feedConfigured(health, 'opensky')) {
          return (q, s) =>
            c.getJson('opensky', '/states/all', {
              params: openSkyParams(q.bbox),
              signal: s,
            });
        }
        return (q, s) => c.getJson('adsblol', adsbPointPath(q.bbox), { signal: s });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/flights/mockSource.js').then((m) =>
              m.createMockSource(),
            )
          : Promise.resolve(null),
    },
    {
      key: 'military',
      group: 'Air & space',
      label: 'Military air',
      loadDef: () =>
        import('./core/layers/military/definition.js').then((m) => m.militaryDefinition),
      // adsb.lol's global list of aircraft flagged military (keyless).
      proxy: async (c) => {
        const { ADSB_MILITARY_PATH } = await import('./core/layers/flights/parse.js');
        return (_q, s) => c.getJson('adsblol', ADSB_MILITARY_PATH, { signal: s });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/military/mockSource.js').then((m) =>
              m.createMilitaryMockSource(),
            )
          : Promise.resolve(null),
    },
    {
      key: 'localadsb',
      group: 'Air & space',
      label: 'My receiver',
      // Only offered when the proxy knows your receiver: a 1090 MHz feed
      // (LOCAL_ADSB_URL), a 978 MHz UAT feed (LOCAL_UAT_URL), or both.
      requires: ['local-adsb', 'local-uat'],
      loadDef: () =>
        import('./core/layers/localadsb/definition.js').then(
          (m) => m.localAdsbDefinition,
        ),
      proxy: async (c) => {
        const { createLocalReceiverSource, LOCAL_RECEIVER_FEEDS } =
          await import('./core/layers/localadsb/source.js');
        const feeds = health
          ? LOCAL_RECEIVER_FEEDS.filter((f) => feedConfigured(health, f.feed))
          : LOCAL_RECEIVER_FEEDS;
        return createLocalReceiverSource({ proxyClient: c, feeds });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/localadsb/mockSource.js').then((m) =>
              m.createLocalAdsbMockSource({ viewer: app.viewer }),
            )
          : Promise.resolve(null),
    },
    {
      key: 'satellites',
      group: 'Air & space',
      label: 'Satellites',
      loadDef: () =>
        import('./core/layers/satellites/definition.js').then(
          (m) => m.satellitesDefinition,
        ),
      proxy: (c) => (_q, s) =>
        c.getText('celestrak', '/gp.php', {
          params: { GROUP: 'stations', FORMAT: 'tle' },
          signal: s,
        }),
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/satellites/mockSource.js').then((m) =>
              m.createSatMockSource(),
            )
          : Promise.resolve(null),
    },
    {
      key: 'constellations',
      group: 'Air & space',
      label: 'Nav, GEO & visual sats',
      loadDef: () =>
        import('./core/layers/constellations/definition.js').then(
          (m) => m.constellationsDefinition,
        ),
      // Starlink "dense" (thousands of points) only on the full tier, and only
      // when switched on in VIEW; read on every fetch.
      proxy: async (c) => {
        const { createConstellationSource, denseAllowedForTier } =
          await import('./core/layers/constellations/groups.js');
        return createConstellationSource({
          proxyClient: c,
          dense: () => starlinkDense && denseAllowedForTier(app.tier),
        });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/satellites/mockSource.js').then((m) => {
              const tle = m.createSatMockSource({ count: 12 });
              return async () => [{ group: 'gps-ops', text: await tle() }];
            })
          : Promise.resolve(null),
    },
    {
      key: 'launches',
      group: 'Air & space',
      label: 'Launches',
      loadDef: () =>
        import('./core/layers/launches/definition.js').then((m) => m.launchesDefinition),
      proxy: async (c) => {
        const { launchQuery } = await import('./core/layers/launches/parse.js');
        return (_q, s) =>
          c.getJson('ll2', '/launches/', { params: launchQuery(), signal: s });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/launches/mockSource.js').then((m) =>
              m.createLaunchMockSource(),
            )
          : Promise.resolve(null),
    },
    {
      key: 'transit',
      group: 'Ground & sea',
      label: 'Transit',
      loadDef: () =>
        import('./core/layers/transit/definition.js').then((m) => m.transitDefinition),
      // GTFS-RT vehicle positions for the covered agencies in view (keyless).
      proxy: async (c) => {
        const { createTransitSource } = await import('./core/layers/transit/source.js');
        return createTransitSource({ proxyClient: c });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/transit/mockSource.js').then((m) =>
              m.createTransitMockSource(),
            )
          : Promise.resolve(null),
    },
    {
      key: 'bikeshare',
      group: 'Ground & sea',
      label: 'Bikeshare',
      loadDef: () =>
        import('./core/layers/bikeshare/definition.js').then(
          (m) => m.bikeshareDefinition,
        ),
      // GBFS stations for the covered systems in view (keyless).
      proxy: async (c) => {
        const { createBikeshareSource } =
          await import('./core/layers/bikeshare/systems.js');
        return createBikeshareSource({ proxyClient: c });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/bikeshare/mockSource.js').then((m) =>
              m.createBikeshareMockSource({ viewer: app.viewer }),
            )
          : Promise.resolve(null),
    },
    {
      key: 'signals',
      group: 'Ground & sea',
      label: 'Traffic lights',
      loadDef: () =>
        import('./core/layers/signals/definition.js').then((m) =>
          m.createSignalsDefinition({ tier: app.tier, scope: osm.scope('signals') }),
        ),
      // OSM traffic signals, only in views about 20 km across or less, each
      // tile fetched once and kept for a day.
      proxy: async (c) => {
        const { createSignalsSource } = await import('./core/layers/signals/parse.js');
        return osm.keep(
          'signals',
          createSignalsSource({
            proxyClient: c,
            anchor: osm.anchor,
            onUpdate: () => osm.refresh('signals'),
          }),
        );
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/signals/mockSource.js').then((m) =>
              m.createSignalsMockSource({ viewer: app.viewer }),
            )
          : Promise.resolve(null),
    },
    {
      key: 'trafficflow',
      group: 'Ground & sea',
      label: 'Traffic flow',
      // Hidden until the proxy has a TomTom key (TOMTOM_API_KEY).
      requires: 'tomtom-flow',
      loadDef: () =>
        import('./core/layers/trafficflow/definition.js').then(
          (m) => m.trafficFlowDefinition,
        ),
      proxy: async (c) => {
        const { trafficFlowSpec } = await import('./core/layers/trafficflow/spec.js');
        return async () => trafficFlowSpec(c.buildUrl);
      },
      mock: () => Promise.resolve(null),
    },
    {
      key: 'incidents',
      group: 'Ground & sea',
      label: 'Traffic incidents',
      // Hidden until the proxy has a TomTom key (TOMTOM_API_KEY, same as flow).
      requires: 'tomtom-incidents',
      loadDef: () =>
        import('./core/layers/incidents/definition.js').then(
          (m) => m.incidentsDefinition,
        ),
      proxy: async (c) => {
        const { createIncidentSource } =
          await import('./core/layers/incidents/source.js');
        return createIncidentSource({ proxyClient: c });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/incidents/source.js').then((m) =>
              m.createIncidentMockSource(),
            )
          : Promise.resolve(null),
    },
    {
      key: 'chp',
      group: 'Ground & sea',
      label: 'CHP incidents (CA)',
      loadDef: () =>
        import('./core/layers/chp/definition.js').then((m) => m.chpDefinition),
      // The public statewide CHP CAD list (keyless XML).
      proxy: (c) => (_q, sig) => c.getText('chp-cad', '/sa.xml', { signal: sig }),
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/chp/mockSource.js').then((m) => m.createChpMockSource())
          : Promise.resolve(null),
    },
    {
      key: 'waze',
      group: 'Ground & sea',
      label: 'Waze alerts (unofficial)',
      loadDef: () =>
        import('./core/layers/waze/definition.js').then((m) => m.wazeDefinition),
      // Waze's live map (unofficial, personal use), or your own waze-server when
      // the proxy has LOCAL_WAZE_URL. Road alerts and jams only.
      proxy: async (c) => {
        const { createWazeSource } = await import('./core/layers/waze/source.js');
        return createWazeSource({
          proxyClient: c,
          local: Boolean(health && feedConfigured(health, 'waze-local')),
          log, // one entry when Waze refuses (403), then 30 min of quiet
        });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/waze/source.js').then((m) => m.createWazeMockSource())
          : Promise.resolve(null),
    },
    {
      key: 'borderwaits',
      group: 'Ground & sea',
      label: 'Border waits',
      loadDef: () =>
        import('./core/layers/borderwaits/definition.js').then(
          (m) => m.borderWaitsDefinition,
        ),
      // CBP (into the US) and CBSA (into Canada) wait times at the bundled ports,
      // each card linked to the nearest published traffic cameras when zoomed in.
      proxy: async (c) => {
        const [{ createBorderWaitSource }, { createTrafficCamSource }] =
          await Promise.all([
            import('./core/layers/borderwaits/source.js'),
            import('./core/layers/trafficcams/sources.js'),
          ]);
        return createBorderWaitSource({
          proxyClient: c,
          cameraSource: createTrafficCamSource({ proxyClient: c, isConfigured: keyed }),
        });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/borderwaits/mockSource.js').then((m) =>
              m.createBorderWaitMockSource(),
            )
          : Promise.resolve(null),
    },
    {
      key: 'simtraffic',
      group: 'Ground & sea',
      label: 'Traffic (simulated)',
      loadDef: () =>
        import('./core/layers/simtraffic/definition.js').then((m) =>
          m.createSimTrafficDefinition({ tier: app.tier }),
        ),
      // SIMULATED vehicles on OSM roads (Overpass) below 8 km, at TomTom's
      // live flow speeds when the proxy has TOMTOM_API_KEY, free-flow otherwise.
      proxy: async (c) => {
        const [{ createSimTrafficSource }, { simTrafficView }] = await Promise.all([
          import('./core/layers/simtraffic/source.js'),
          import('./core/layers/simtraffic/view.js'),
        ]);
        return createSimTrafficSource({
          proxyClient: c,
          getView: () => simTrafficView(app.viewer),
          flow: keyed('tomtom-flowseg'),
          tier: app.tier,
        });
      },
      mock: () =>
        import.meta.env.DEV
          ? Promise.all([
              import('./core/layers/simtraffic/mockSource.js'),
              import('./core/layers/simtraffic/view.js'),
            ]).then(([m, v]) => {
              const src = m.createSimTrafficMockSource({
                getView: () => v.simTrafficView(app.viewer),
                tier: app.tier,
              });
              if (window.__argus) window.__argus.simTraffic = src.model;
              return src;
            })
          : Promise.resolve(null),
    },
    {
      key: 'streetphotos',
      group: 'Ground & sea',
      label: 'Street photos',
      // Hidden until the proxy has a Mapillary token (MAPILLARY_TOKEN).
      requires: 'mapillary',
      loadDef: () =>
        import('./core/layers/streetphotos/definition.js').then(
          (m) => m.streetPhotosDefinition,
        ),
      proxy: async (c) => {
        const { createStreetPhotoSource } =
          await import('./core/layers/streetphotos/source.js');
        return createStreetPhotoSource({ proxyClient: c });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/streetphotos/mockSource.js').then((m) =>
              m.createStreetPhotoMockSource(),
            )
          : Promise.resolve(null),
    },
    {
      key: 'ships',
      group: 'Ground & sea',
      label: 'Ships',
      loadDef: () =>
        import('./core/layers/ships/definition.js').then((m) => m.shipsDefinition),
      // Push source: a websocket to the proxy (or a synthetic stream in dev).
      proxy: async () => {
        const { createAisSource } = await import('./core/layers/ships/aisSource.js');
        return createAisSource({ wsUrl, viewer: app.viewer });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/ships/mockSource.js').then((m) =>
              m.createShipMockSource({ viewer: app.viewer }),
            )
          : Promise.resolve(null),
    },
    {
      key: 'quakes',
      group: 'Earth & weather',
      label: 'Earthquakes',
      loadDef: () =>
        import('./core/layers/earthquakes/definition.js').then(
          (m) => m.earthquakesDefinition,
        ),
      proxy: (c) => (_q, s) =>
        c.getJson('usgs-quakes', '/all_day.geojson', { signal: s }),
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/earthquakes/mockSource.js').then((m) =>
              m.createQuakeMockSource({ viewer: app.viewer }),
            )
          : Promise.resolve(null),
    },
    {
      key: 'fires',
      group: 'Earth & weather',
      label: 'Fires',
      // NASA FIRMS needs its free MAP_KEY on the proxy (FIRMS_MAP_KEY): hidden
      // until it is set, rather than an error every poll.
      requires: 'firms',
      loadDef: () =>
        import('./core/layers/fires/definition.js').then((m) => m.firesDefinition),
      proxy: (c) => (q, s) =>
        c.getText(
          'firms',
          `/VIIRS_SNPP_NRT/${q.bbox.lomin},${q.bbox.lamin},${q.bbox.lomax},${q.bbox.lamax}/1`,
          { signal: s },
        ),
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/fires/mockSource.js').then((m) =>
              m.createFireMockSource(),
            )
          : Promise.resolve(null),
    },
    {
      key: 'cyclones',
      group: 'Earth & weather',
      label: 'Cyclones',
      loadDef: () =>
        import('./core/layers/cyclones/definition.js').then((m) => m.cyclonesDefinition),
      proxy: (c) => (_q, s) => c.getJson('nhc', '/CurrentStorms.json', { signal: s }),
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/cyclones/mockSource.js').then((m) =>
              m.createCycloneMockSource(),
            )
          : Promise.resolve(null),
    },
    {
      key: 'clouds',
      group: 'Earth & weather',
      label: 'IR clouds',
      loadDef: () =>
        import('./core/layers/weather/definition.js').then((m) => m.cloudsDefinition),
      // NOAA nowCOAST imagery via the proxy, timed: the source follows the
      // weather timeline (latest by default, or a past observation).
      proxy: timedWeather('clouds'),
      // Imagery needs the real service; there is no offline stand-in.
      mock: () => Promise.resolve(null),
    },
    {
      key: 'radar',
      group: 'Earth & weather',
      label: 'Radar (US)',
      loadDef: () =>
        import('./core/layers/weather/definition.js').then((m) => m.radarDefinition),
      // NOAA nowCOAST imagery via the proxy, timed: the source follows the
      // weather timeline (latest by default, or a past observation).
      proxy: timedWeather('radar'),
      // Imagery needs the real service; there is no offline stand-in.
      mock: () => Promise.resolve(null),
    },
    {
      key: 'lightning',
      group: 'Earth & weather',
      label: 'Lightning',
      loadDef: () =>
        import('./core/layers/weather/definition.js').then((m) => m.lightningDefinition),
      // NOAA nowCOAST imagery via the proxy, timed: the source follows the
      // weather timeline (latest by default, or a past observation).
      proxy: timedWeather('lightning'),
      // Imagery needs the real service; there is no offline stand-in.
      mock: () => Promise.resolve(null),
    },
    {
      key: 'goes',
      group: 'Earth & weather',
      label: 'IR clouds (GOES)',
      loadDef: () =>
        import('./core/layers/weather/definition.js').then((m) => m.goesDefinition),
      proxy: timedWeather('goes'),
      mock: () => Promise.resolve(null),
    },
    {
      key: 'wind',
      group: 'Earth & weather',
      label: 'Wind',
      loadDef: () =>
        import('./core/layers/wind/definition.js').then((m) => m.windDefinition),
      // The current 10 m wind over a grid of the view (Open-Meteo, keyless).
      proxy: async (c) => {
        const { createWindSource } = await import('./core/layers/wind/source.js');
        return createWindSource({ proxyClient: c });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/wind/source.js').then((m) => m.createWindMockSource())
          : Promise.resolve(null),
    },
    {
      key: 'aurora',
      group: 'Earth & weather',
      label: 'Aurora',
      loadDef: () =>
        import('./core/layers/aurora/definition.js').then((m) => m.auroraDefinition),
      // NOAA SWPC OVATION nowcast + planetary K index (keyless).
      proxy: async (c) => {
        const { createAuroraSource } = await import('./core/layers/aurora/source.js');
        return createAuroraSource({ proxyClient: c });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/aurora/source.js').then((m) =>
              m.createAuroraMockSource(),
            )
          : Promise.resolve(null),
    },
    {
      key: 'airquality',
      group: 'Earth & weather',
      label: 'Air quality',
      loadDef: () =>
        import('./core/layers/airquality/definition.js').then(
          (m) => m.airQualityDefinition,
        ),
      // Current AQI and pollutants over a grid of the view (Open-Meteo / CAMS, keyless).
      proxy: async (c) => {
        const { createAirQualitySource } =
          await import('./core/layers/airquality/source.js');
        return createAirQualitySource({ proxyClient: c });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/airquality/source.js').then((m) =>
              m.createAirQualityMockSource(),
            )
          : Promise.resolve(null),
    },
    {
      key: 'terminator',
      group: 'Earth & weather',
      label: 'Day / night',
      loadDef: () =>
        import('./core/layers/terminator/definition.js').then(
          (m) => m.terminatorDefinition,
        ),
      // Computed from the sun's position; the proxy adds NASA Black Marble
      // city lights on the night side (one cached image).
      proxy: async (c) => {
        const [{ createTerminatorSource }, { terminatorWidth }] = await Promise.all([
          import('./core/layers/terminator/source.js'),
          import('./core/layers/terminator/night.js'),
        ]);
        return createTerminatorSource({
          proxyClient: c,
          width: terminatorWidth(app.profile?.animationFps ?? 30),
        });
      },
      // Computed, so it works with no proxy too (shade and line, no lights).
      mock: () =>
        import('./core/layers/terminator/source.js').then((m) =>
          m.createTerminatorSource(),
        ),
    },
    {
      key: 'cyclonecones',
      group: 'Earth & weather',
      label: 'Storm cones',
      loadDef: () =>
        import('./core/layers/cyclonecones/definition.js').then(
          (m) => m.cycloneConesDefinition,
        ),
      proxy: cycloneForecastSource,
      mock: cycloneForecastMock,
    },
    {
      key: 'cyclonetracks',
      group: 'Earth & weather',
      label: 'Storm tracks',
      loadDef: () =>
        import('./core/layers/cyclonecones/definition.js').then(
          (m) => m.cycloneTracksDefinition,
        ),
      proxy: cycloneForecastSource,
      mock: cycloneForecastMock,
    },
    {
      key: 'perimeters',
      group: 'Earth & weather',
      label: 'Fire perimeters',
      loadDef: () =>
        import('./core/layers/perimeters/definition.js').then(
          (m) => m.perimetersDefinition,
        ),
      proxy: async (c) => {
        const { createPerimeterSource } =
          await import('./core/layers/perimeters/source.js');
        return createPerimeterSource({ proxyClient: c });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/perimeters/mockSource.js').then((m) =>
              m.createPerimeterMockSource(),
            )
          : Promise.resolve(null),
    },
    {
      key: 'imagery',
      group: 'Earth & weather',
      label: 'Recent imagery',
      loadDef: () =>
        import('./core/layers/imagery/definition.js').then(
          (m) => m.recentImageryDefinition,
        ),
      // Shows the day picked in VIEW > RECENT IMAGERY (NASA HLS / VIIRS).
      proxy: async () => imageryCatalogue?.rasterSource ?? null,
      mock: () => Promise.resolve(null),
    },
    {
      key: 'surveillance',
      group: 'Infrastructure',
      label: 'Surveillance',
      loadDef: () =>
        import('./core/layers/surveillance/definition.js').then((m) =>
          m.createSurveillanceDefinition({
            tier: app.tier,
            scope: osm.scope('surveillance'),
          }),
        ),
      // OSM cameras, ALPR readers (DeFlock's mapping), acoustic sensors, guard
      // posts, speed and red-light cameras; each tile fetched once, kept 12 h.
      proxy: async (c) => {
        const {
          createSurveillanceSource,
          SURVEILLANCE_VIEW_TILES: SURV_VIEW_TILES,
          SURVEILLANCE_NEAREST_TILES: SURV_NEAR_TILES,
        } = await import('./core/layers/surveillance/source.js');
        return osm.keep(
          'surveillance',
          createSurveillanceSource({
            proxyClient: c,
            anchor: osm.anchor,
            onUpdate: () => osm.refresh('surveillance'),
            // NEAREST needs only the tiles around the anchor; ALL IN VIEW more.
            viewTiles: () =>
              app.settings?.get('survScope') === 'all'
                ? SURV_VIEW_TILES
                : SURV_NEAR_TILES,
          }),
        );
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/surveillance/mockSource.js').then((m) =>
              m.createSurveillanceMockSource({ viewer: app.viewer }),
            )
          : Promise.resolve(null),
    },
    {
      key: 'landmarks',
      group: 'Infrastructure',
      label: 'Landmarks',
      loadDef: () =>
        import('./core/layers/landmarks/definition.js').then(
          (m) => m.landmarksDefinition,
        ),
      // Named OSM landmarks; the same tiles as TOOLS > LANDMARKS (NEARBY).
      proxy: async () => {
        if (!osm.landmarks) return null;
        const { createLandmarksSource } =
          await import('./core/layers/landmarks/parse.js');
        return osm.keep(
          'landmarks',
          createLandmarksSource(osm.landmarks, {
            anchor: osm.anchor,
            onUpdate: () => osm.refresh('landmarks'),
          }),
        );
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/landmarks/mockSource.js').then((m) =>
              m.createLandmarkMockSource({ viewer: app.viewer }),
            )
          : Promise.resolve(null),
    },
    {
      key: 'cctv',
      group: 'Infrastructure',
      label: 'CCTV',
      loadDef: () =>
        import('./core/layers/cctv/definition.js').then((m) => m.cctvDefinition),
      // No generic real CCTV feed yet (each city differs); dev uses mock cameras.
      proxy: () => Promise.resolve(null),
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/cctv/mockSource.js').then((m) =>
              m.createCctvMockSource(),
            )
          : Promise.resolve(null),
    },
    {
      key: 'trafficcams',
      group: 'Infrastructure',
      label: 'Traffic cams',
      loadDef: () =>
        import('./core/layers/trafficcams/definition.js').then(
          (m) => m.trafficCamsDefinition,
        ),
      // Public DOT cameras in view (keyless networks, plus WSDOT and the 511
      // states when their keys are set); stills on demand.
      proxy: async (c) => {
        const { createTrafficCamSource } =
          await import('./core/layers/trafficcams/sources.js');
        return createTrafficCamSource({ proxyClient: c, isConfigured: keyed });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/trafficcams/mockSource.js').then((m) =>
              m.createTrafficCamMockSource({ viewer: app.viewer }),
            )
          : Promise.resolve(null),
    },
    {
      key: 'webcams',
      group: 'Infrastructure',
      label: 'Public webcams',
      loadDef: () =>
        import('./core/layers/webcams/definition.js').then((m) => m.webcamsDefinition),
      // NASA EPIC and the observatory stills (keyless); Windy (WINDY_WEBCAMS_KEY)
      // and NPS (NPS_API_KEY) when the proxy has their keys. Stills on demand.
      proxy: async (c) => {
        const { createWebcamSource } = await import('./core/layers/webcams/sources.js');
        return createWebcamSource({ proxyClient: c, isConfigured: keyed });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/webcams/mockSource.js').then((m) =>
              m.createWebcamMockSource({ viewer: app.viewer }),
            )
          : Promise.resolve(null),
    },
    {
      key: 'datacenters',
      group: 'Infrastructure',
      label: 'Data centres',
      loadDef: () =>
        import('./core/layers/infrastructure/definition.js').then(
          (m) => m.datacentersDefinition,
        ),
      proxy: async (c) => {
        const [{ createOverpassSource }, f] = await Promise.all([
          import('./core/layers/overpass/client.js'),
          import('./core/layers/infrastructure/format.js'),
        ]);
        return createOverpassSource({
          proxyClient: c,
          filters: f.DATACENTER_FILTERS,
          maxAreaDeg: f.DATACENTER_MAX_DEG,
        });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/infrastructure/mockSource.js').then((m) =>
              m.createInfraMockSource({ viewer: app.viewer, kind: 'datacenters' }),
            )
          : Promise.resolve(null),
    },
    {
      key: 'dams',
      group: 'Infrastructure',
      label: 'Dams',
      loadDef: () =>
        import('./core/layers/dams/definition.js').then((m) => m.damsDefinition),
      proxy: async (c) => {
        const [{ createOverpassSource }, f] = await Promise.all([
          import('./core/layers/overpass/client.js'),
          import('./core/layers/dams/format.js'),
        ]);
        return createOverpassSource({
          proxyClient: c,
          filters: f.DAM_FILTERS,
          maxAreaDeg: f.DAM_MAX_DEG,
        });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/dams/mockSource.js').then((m) =>
              m.createDamMockSource({ viewer: app.viewer }),
            )
          : Promise.resolve(null),
    },
    {
      key: 'cables',
      group: 'Infrastructure',
      label: 'Sea cables',
      loadDef: () =>
        import('./core/layers/cables/definition.js').then((m) => m.cablesDefinition),
      proxy: (c) => (_q, s) =>
        c.getJson('cables', '/cable/cable-geo.json', { signal: s }),
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/cables/mockSource.js').then((m) =>
              m.createCableMockSource(),
            )
          : Promise.resolve(null),
    },
    {
      key: 'installations',
      group: 'Infrastructure',
      label: 'Installations',
      loadDef: () =>
        import('./core/layers/infrastructure/definition.js').then(
          (m) => m.installationsDefinition,
        ),
      proxy: async (c) => {
        const [{ createOverpassSource }, f] = await Promise.all([
          import('./core/layers/overpass/client.js'),
          import('./core/layers/infrastructure/format.js'),
        ]);
        return createOverpassSource({
          proxyClient: c,
          filters: f.INSTALLATION_FILTERS,
          maxAreaDeg: f.INSTALLATION_MAX_DEG,
        });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/infrastructure/mockSource.js').then((m) =>
              m.createInfraMockSource({ viewer: app.viewer, kind: 'installations' }),
            )
          : Promise.resolve(null),
    },
    {
      key: 'radio',
      group: 'Signals',
      label: 'Radio',
      loadDef: () =>
        import('./core/layers/radio/definition.js').then((m) => m.radioDefinition),
      proxy: async (c) => {
        const { radioQuery } = await import('./core/layers/radio/parse.js');
        return (_q, s) =>
          c.getJson('radiobrowser', '/json/stations/search', {
            params: radioQuery(),
            signal: s,
          });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/radio/mockSource.js').then((m) =>
              m.createRadioMockSource(),
            )
          : Promise.resolve(null),
    },
    {
      key: 'shodan',
      group: 'Signals',
      label: 'Shodan',
      // Hidden until the proxy has a Shodan key (SHODAN_API_KEY).
      requires: 'shodan',
      loadDef: () =>
        import('./core/layers/shodan/definition.js').then((m) => m.shodanDefinition),
      // A curated snapshot (VIEW > SHODAN) via the credit-free count endpoint,
      // plus the opt-in host sample: awareness-only, never search-on-pan.
      proxy: async (c) => {
        const { createShodanSource } = await import('./core/layers/shodan/source.js');
        return createShodanSource({
          proxyClient: c,
          getSnapshot: () => app.settings?.get('shodanSnapshot'),
          getSample: () => Boolean(app.settings?.get('shodanSample')),
        });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/shodan/mockSource.js').then((m) =>
              m.createShodanMockSource({
                getSnapshot: () => app.settings?.get('shodanSnapshot'),
                getSample: () => Boolean(app.settings?.get('shodanSample')),
              }),
            )
          : Promise.resolve(null),
    },
    {
      key: 'threats',
      group: 'Signals',
      label: 'Threats',
      loadDef: () =>
        import('./core/layers/threats/definition.js').then((m) => m.threatsDefinition),
      // Threat-map arcs. Real source->target feeds (GreyNoise, honeypots) are
      // keyed and unverified; dev drives it with a synthetic ambient stream.
      proxy: () => Promise.resolve(null),
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/threats/mockSource.js').then((m) =>
              m.createThreatMockSource(),
            )
          : Promise.resolve(null),
    },
    {
      key: 'bgp',
      group: 'Signals',
      label: 'BGP',
      loadDef: () =>
        import('./core/layers/bgp/definition.js').then((m) => m.bgpDefinition),
      // Live RIPE RIS Live firehose (public, no key) via the proxy's /ws/bgp.
      proxy: async () => {
        const { createRisSource } = await import('./core/layers/bgp/risSource.js');
        return createRisSource({ wsUrl: wsBgpUrl });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/bgp/mockSource.js').then((m) => m.createBgpMockSource())
          : Promise.resolve(null),
    },
    {
      key: 'tor',
      group: 'Signals',
      label: 'Tor relays',
      loadDef: () =>
        import('./core/layers/tor/definition.js').then((m) => m.torDefinition),
      // Onionoo running-relay list (keyless, hourly).
      proxy: async (c) => {
        const { onionooQuery, ONIONOO_PATH } = await import('./core/layers/tor/parse.js');
        return (_q, sig) =>
          c.getJson('onionoo', ONIONOO_PATH, { params: onionooQuery(), signal: sig });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/tor/mockSource.js').then((m) => m.createTorMockSource())
          : Promise.resolve(null),
    },
    {
      key: 'gdelt',
      group: 'Signals',
      label: 'News events',
      loadDef: () =>
        import('./core/layers/gdelt/definition.js').then((m) => m.gdeltDefinition),
      // GDELT GEO 2.0, three fixed theme queries only (never free text).
      proxy: async (c) => {
        const { createGdeltSource } = await import('./core/layers/gdelt/source.js');
        return createGdeltSource({ proxyClient: c });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/gdelt/source.js').then((m) => m.createGdeltMockSource())
          : Promise.resolve(null),
    },
    {
      key: 'myplaces',
      group: 'Mine',
      label: 'My places',
      loadDef: () =>
        import('./core/layers/myplaces/definition.js').then((m) => m.myPlacesDefinition),
      // Local, no network: the same source with or without a proxy.
      proxy: async () => placesSource,
      mock: async () => placesSource,
    },
  ];

  // Layers with no verified real feed. They are always synthetic, so they are
  // labelled "demo" in the UI and fall back to the mock even when a proxy is set
  // (rather than becoming a dead toggle), never masquerading as real.
  const noRealFeed = new Set(['cctv', 'threats']);

  // STALE: each layer gets its own view of the proxy client, so an answer the
  // proxy served from its last good copy (x-argus-stale) marks that layer's
  // next status STALE with the age, instead of the layer failing.
  const staleSeen = new Map(); // layer key -> { age, partial }
  const trackedClient = (key) =>
    proxyClient.tracked((m) => {
      if (m.stale === null && !m.partial) return;
      const cur = staleSeen.get(key) ?? { age: 0, partial: false };
      cur.age = Math.max(cur.age, m.stale ?? 0);
      cur.partial ||= m.partial;
      staleSeen.set(key, cur);
    });
  const markStale = (key, s) => {
    const m = staleSeen.get(key);
    staleSeen.delete(key);
    if (!m || s?.state !== 'ok') return s;
    const age =
      m.age >= 3600 ? `${Math.round(m.age / 3600)}H` : `${Math.ceil(m.age / 60)}M`;
    const why = m.partial
      ? 'the feed sent an incomplete copy'
      : `the feed is not answering, showing its last good data (${age} old)`;
    return {
      ...s,
      stale: m.age,
      note: [`STALE: ${why}`, s.note].filter(Boolean).join('; '),
    };
  };

  for (const r of registrations) {
    // The sourceless layers can only be driven by the dev mock; outside dev they
    // have nothing to show, so do not register them (no dead chips in production).
    if (noRealFeed.has(r.key) && !dev) continue;
    // Layers that exist only with local equipment (your own receiver) are listed
    // only when the proxy has it configured, so no one sees a dead chip.
    // (In a dev session with no proxy, the labelled mock stands in instead.)
    if (
      r.requires &&
      proxyClient &&
      ![].concat(r.requires).some((id) => health && feedConfigured(health, id))
    )
      continue;
    manager.register(r.key, {
      label: r.label,
      group: r.group,
      loadDef: r.loadDef,
      // With a proxy, use the real feed; if this layer has none (proxy source is
      // null), fall back to the labelled mock instead of failing to enable.
      makeSource: async () => {
        if (proxyClient) return (await r.proxy(trackedClient(r.key))) ?? r.mock();
        return r.mock();
      },
      decorateStatus: (s) => markStale(r.key, s),
      demo: noRealFeed.has(r.key),
    });
  }

  splash?.step('WL_OUTPUT_FOUND : LAYERS', 60);

  const [
    { createTrackingOverlay },
    { createTargetPanel },
    { createLayerMenu },
    { createLauncher },
    { createSegment, createCells },
    readouts,
    { section, createChoice, createSwitch },
    { CITIES },
    { h },
  ] = await Promise.all([
    import('./core/scene/trackingOverlay.js'),
    import('./core/ui/targetPanel.js'),
    import('./core/ui/layerMenu.js'),
    import('./core/ui/hud/launcher.js'),
    import('./core/ui/hud/bar.js'),
    import('./core/ui/hud/readouts.js'),
    import('./core/ui/controls.js'),
    import('./core/search/places.js'),
    import('./core/ui/dom.js'),
  ]);

  // OSINT query-console outputs are plotted here (query outputs, not a toggleable
  // feed layer), and resolved by the interaction spine as an extra resolver.
  const osintPlotter = createOsintPlotter(app.viewer);

  // The tracking overlay (blob tracking boxes, hub lock, city names) and the
  // target panel it drives. Labels for boxes and contacts come from each
  // contact's own card, via the same resolver the panel uses.
  let labelFor = () => null;
  const overlay = createTrackingOverlay(app.viewer, {
    getLayers: () => manager.active(),
    places: CITIES,
    labelFor: (t) => labelFor(t),
  });
  app.attachOverlay?.(overlay);

  let tracker = null;
  const panel = createTargetPanel({
    prefs: app.settings,
    onClose: () => tracker?.deselect(),
    onPickContact: (c) => tracker?.select(c.target),
    // Pointing at a contact (panel row or widget node) marks it on the map.
    onHoverContact: (c) => overlay.highlight(c?.target ?? null),
  });
  app.mount('target', panel.el);

  // Closest-approach alerts: a contact on a conflicting pass with the target
  // (core/geo/cpa.js) raises one notice per contact every two minutes.
  const alerted = new Map(); // contact id -> time of the last notice
  overlay.subscribe((sum) => {
    const now = Date.now();
    for (const c of sum.conflicts ?? []) {
      if (now - (alerted.get(c.id) ?? 0) < 120_000) continue;
      alerted.set(c.id, now);
      notifier.push({
        title: `CLOSING ${String(c.id).padStart(2, '0')} ${c.label ?? c.key.toUpperCase()}`,
        body: `Closest approach ${Math.round((c.cpaM ?? 0) / 100) / 10} km in ${Math.round((c.tcpaS ?? 0) / 6) / 10} min.`,
        key: `cpa-${c.id}`,
        level: 'normal',
        action: { label: 'SELECT', onClick: () => tracker?.select(c.target) },
      });
    }
  });

  const objMeter = readouts.createObjMeter();
  overlay.subscribe((s) => {
    const hub = s.hub;
    panel.setSummary(s, {
      quality: hub?.history ? Math.min(0.99, 0.62 + hub.history() * 0.03) : 0,
      hubPos: hub?.visible
        ? [hub.x / window.innerWidth, hub.y / window.innerHeight]
        : [0.5, 0.5],
    });
    objMeter.update(s.total);
  });

  const notify = (n) => notifier.push(n);

  // Map-tap mode for tools: while a tool is armed, a tap on the globe goes to
  // it (a route point, a drawing vertex, an imagery area) instead of selecting.
  const sketchMod = await import('./core/scene/sketch.js');
  const sketch = sketchMod.createSketch(app.viewer);
  let tapOwner = null; // { fn, repeat }
  const disarm = () => {
    tapOwner = null;
    notifier.clear('tap');
  };
  const armTap = (fn, label, { repeat = false } = {}) => {
    tapOwner = { fn, repeat };
    notifier.push({ title: label, body: 'Esc cancels.', key: 'tap', timeoutMs: 20_000 });
  };
  // Navigation hooks (set in the navigation block below): a tap that ends a
  // long press or right click on the map is not a pick; ROUTE HERE on cards.
  const navHooks = { swallowTap: () => false, cardAction: () => null };
  const interceptTap = (pos) => {
    if (navHooks.swallowTap()) return true;
    if (!tapOwner || !pos) return false;
    const ll = sketchMod.windowToLatLon(app.viewer, pos);
    if (!ll) return true; // a tap on the sky: ignore, stay armed
    const owner = tapOwner;
    if (!owner.repeat) disarm();
    owner.fn(ll);
    return true;
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tapOwner) disarm();
  });

  // Per-layer extras on the target card: trace, enrichment, passes, replay,
  // nearest camera (core/interaction/targetExtras.js).
  const [{ createTargetExtras }, { createReplayView }] = await Promise.all([
    import('./core/interaction/targetExtras.js'),
    import('./core/layers/launches/replayView.js'),
  ]);
  const replay = createReplayView(app.viewer, {
    proxyClient,
    mount: (el) => app.mount('float', el),
    notify,
    onChange: () => tracker?.refresh(),
  });
  // Card extras from the street photo, Shodan and OSINT modules: STREET PHOTO,
  // InternetDB exposure, LOOK UP AS on BGP cards, Shodan country facets.
  const { createCardPlugins } = await import('./core/ui/cardPlugins.js');
  const cardPlugins = await createCardPlugins({
    proxyClient,
    keyed,
    dev,
    manager,
    settings: app.settings,
    plot: (r) => osintPlotter.plot(r),
    select: (t) => tracker?.select(t),
    getCorrelate: () => correlate,
    time: () => app.viewer.clock.currentTime,
  });
  const extras = createTargetExtras({
    proxyClient,
    manager,
    notify,
    replay,
    plugins: cardPlugins,
    select: (t) => tracker?.select(t),
    getObserver: async () => {
      const fix = await app.observer?.();
      if (fix) return fix;
      // Desktop: the ground point in the middle of the view (the point under
      // the camera when the middle is sky).
      const cv = app.viewer.scene.canvas;
      const mid = sketchMod.windowToLatLon(app.viewer, {
        x: cv.clientWidth / 2,
        y: cv.clientHeight / 2,
      });
      if (mid) return { latitude: mid.lat, longitude: mid.lon };
      const c = app.viewer.camera.positionCartographic;
      return {
        latitude: (c.latitude * 180) / Math.PI,
        longitude: (c.longitude * 180) / Math.PI,
      };
    },
  });
  const tracking = await attachTracking(app, manager, {
    extraResolvers: [osintPlotter],
    panel,
    overlay,
    notify,
    extras,
    interceptTap,
    proxyClient,
    moreActions: (t, rec) => navHooks.cardAction(t, rec),
    camera,
    merge,
  });
  extras.setRefresh(() => tracking.tracker.refresh());
  tracker = tracking.tracker;
  labelFor = tracking.labelFor;

  // Global search / fly-to (P15) + OSINT query console (P16): query active layers
  // (contacts) and place names (geocoder); a query that parses as a network asset
  // (IP/ASN/domain) is passively looked up, geolocated, enriched, and plotted.
  // Place search leans towards the user (core/search/rank.js): their position
  // (a recent fix, else the last known one), else the middle of the view.
  const searchNear = () => {
    const f = app.selfPosition?.get?.() ?? app.selfPosition?.lastKnown?.();
    return f ? { lat: f.lat, lon: f.lon } : osm.middle();
  };
  const geocode = proxyClient
    ? createGeocoder(proxyClient, { near: searchNear })
    : dev
      ? (await import('./core/search/mockGeocoder.js')).createMockGeocoder()
      : null;
  const lookup = proxyClient
    ? createLookup(proxyClient)
    : dev
      ? (await import('./core/osint/mockLookup.js')).createMockLookup()
      : null;
  const correlate = proxyClient
    ? createCorrelator({ proxyClient })
    : dev
      ? (await import('./core/osint/mockLookup.js')).createMockCorrelator()
      : null;
  const searchCtl = createSearch({
    manager,
    geocode,
    camera,
    onSelectEntity: (entity) => tracker.select(entity),
    lookup,
    correlate,
    plot: (result) => osintPlotter.plot(result),
    savedPlaces: placesStore,
  });
  const launcher = createLauncher({
    onQuery: (q) => searchCtl.search(q),
    onSelect: (r) => searchCtl.select(r),
  });
  app.mount('overlay', launcher.el);

  // ------------------------------------------------------------------ bar
  let activePreset = null;
  let before = null; // { layers: Set, view } from the free view (presets)
  let staged = null; // the layer set the preset put on
  let cells = null;
  const setPreset = (id) => {
    // No preset any more (left, or the view was replaced by a scene): nothing
    // to give back later.
    if (id === null) before = staged = null;
    activePreset = id;
    cells?.setActive(id);
    layerMenu?.setActivePreset(id);
  };
  // Presets stage a picture and give the exact view back when you leave, as
  // the reference's Global Context does: entering one from a free view keeps
  // the camera and layers; pressing the active preset again restores them,
  // keeping any layer you switched on or off by hand in between.
  const enabledKeys = () => new Set(manager.active().map((a) => a.key));
  const runPreset = async (preset, { initial = false } = {}) => {
    // Around Me pressed again re-centres on you; any other active preset
    // pressed again leaves it.
    if (activePreset === preset.id && before && !preset.geolocate) return leavePreset();
    if (!before && !initial) before = { layers: enabledKeys(), view: camera.getView() };
    setPreset(preset.id);
    await applyPreset(manager, preset);
    staged = enabledKeys();
    if (preset.geolocate) app.aroundMe?.(camera);
  };
  async function leavePreset() {
    const now = enabledKeys();
    // A second press before the preset finished applying: nothing staged yet.
    const prev = staged ?? now;
    const added = [...now].filter((k) => !prev.has(k));
    const removed = new Set([...prev].filter((k) => !now.has(k)));
    const want = new Set([...before.layers, ...added].filter((k) => !removed.has(k)));
    const { view } = before;
    before = null;
    staged = null;
    setPreset(null);
    await applyPreset(manager, { layers: [...want] });
    camera.flyToView(view, 1.2);
  }
  if (desktop) {
    const CODES = {
      'around-me': 'NEAR',
      sky: 'SKY',
      surveillance: 'WATCH',
      disaster: 'HAZ',
      environment: 'ENV',
      internet: 'NET',
    };
    cells = createCells({
      items: PRESETS.map((p) => ({
        id: p.id,
        code: CODES[p.id] ?? p.label.slice(0, 4).toUpperCase(),
        title: p.label,
      })),
      onSelect: (id) => runPreset(PRESETS.find((p) => p.id === id)),
    });
    app.mount('bar', cells);
    app.mount(
      'bar',
      readouts.createFpsMeter(app.viewer, { target: app.profile?.animationFps || 30 }),
    );
    app.mount('bar', objMeter);
  }
  app.mount(
    'barEnd',
    createSegment({
      label: '»',
      value: desktop ? 'SEARCH  /' : 'SEARCH',
      title: 'Search contacts, places and network assets (/ or Ctrl+K)',
      onClick: () => launcher.toggle(),
    }),
  );
  app.mount(
    'barEnd',
    readouts.createFeedSegment({
      live: Boolean(proxyClient),
      onClick: () => app.showTab?.('view'),
    }),
  );
  if (desktop) app.mount('barEnd', readouts.createStatusSegment({ prefs: app.settings }));

  // ------------------------------------------------------------- layer menu
  const layerMenu = createLayerMenu({
    manager,
    presets: desktop ? [] : PRESETS,
    onPreset: runPreset,
    // A layer switched by hand: the preset stays (and its exit keeps the
    // change); only a preset-free view clears the highlight.
    onManualToggle: () => !before && setPreset(null),
  });
  app.mount('layers', layerMenu.el);
  setPreset(activePreset);

  // Feed failures go to LOGS, never a popup (the menu row turns ERR or STALE
  // too), kept light (core/ui/feedLog.js): an error every time (repeats fold
  // into a count), a busy source or a stale copy once, and a recovery only
  // after one of those and only on a real answer.
  const { feedLogEntry } = await import('./core/ui/feedLog.js');
  const feedState = new Map(); // layer key -> the state last logged
  manager.subscribeStatus((key, s) => {
    const label = (manager.list().find((l) => l.key === key)?.label ?? key).toUpperCase();
    const { state, entry } = feedLogEntry(feedState.get(key), s, label, key);
    feedState.set(key, state);
    if (entry) log(entry);
  });

  // ------------------------------------------------------------- view menu
  // Base imagery, map labels, the tracking overlay, terrain and sensor modes.
  const [
    { createImageryController, IMAGERY_SOURCES },
    { createLabelsController },
    { createTerrainController, TERRAIN_SOURCES, defaultTerrainId },
  ] = await Promise.all([
    import('./core/scene/imagery.js'),
    import('./core/scene/labels.js'),
    import('./core/scene/terrain.js'),
  ]);

  const metered = Boolean(app.capabilities?.network?.metered);
  const capable = app.tier !== 'minimal' && !metered;

  // The ctOS vector basemap (core/scene/vector/): "dark" and the label
  // overlays drawn from OpenStreetMap vector tiles through the proxy, sharp to
  // street level with buildings. Without it (no proxy, or the tile set cannot
  // be reached) they fall back to the Esri dark canvas and reference labels.
  let vectorFailed = null; // set once imagery and labels exist
  if (proxyClient && (!health || feedConfigured(health, 'openfreemap-tiles'))) {
    const [{ createVectorBasemap }, { VectorTileImageryProvider }, { setVectorBasemap }] =
      await Promise.all([
        import('./core/scene/vector/client.js'),
        import('./core/scene/vector/provider.js'),
        import('./core/scene/imagery.js'),
      ]);
    const basemap = createVectorBasemap({ proxyClient });
    setVectorBasemap(basemap, VectorTileImageryProvider);
    app.basemap = basemap;
    basemap.ready.catch((err) => {
      log({
        level: 'warn',
        source: 'basemap',
        title: 'DARK MAP UNAVAILABLE',
        body: `${err?.message || err}; using the Esri dark canvas instead`,
      });
      setVectorBasemap(null);
      vectorFailed?.();
    });
  }

  // Capable, unmetered devices start on the dark canvas (the ctOS look, and
  // light on tiles); metered or minimal devices keep the offline relief.
  const imagery = createImageryController(app.viewer, { mono: true });
  const settings = app.settings;
  const savedImagery = settings?.get('imagery') ?? 'auto';
  if (car) imagery.set('dark');
  else if (savedImagery !== 'auto') imagery.set(savedImagery);
  else if (capable) imagery.set('dark');
  const labels = createLabelsController(app.viewer, { imagery });
  vectorFailed = () => {
    if (imagery.current() === 'dark') imagery.reload();
    labels.refresh();
  };

  const terrain = createTerrainController(app.viewer, {
    proxyBase: proxyBase || null,
    tilesetCache: app.profile?.tilesetCache ?? null,
    onStatus: (s) => {
      if (!s.ok && s.message)
        log({ level: 'warn', source: 'terrain', title: 'TERRAIN', body: s.message });
    },
  });
  const chosenTerrain = settings?.get('terrain') ?? 'auto';
  const defTerrain =
    chosenTerrain !== 'auto'
      ? chosenTerrain
      : defaultTerrainId({ tier: app.tier, metered });
  if (!car && defTerrain !== 'flat') terrain.set(defTerrain);
  const terrainChoice = createChoice({
    caption: 'Terrain',
    options: TERRAIN_SOURCES,
    current: defTerrain,
    onSelect: async (id) => {
      const applied = await terrain.set(id);
      settings?.set('terrain', applied ?? id);
      return applied;
    },
  });

  const view = [];
  const imageryChoice = createChoice({
    label: 'Base imagery',
    options: IMAGERY_SOURCES,
    current: imagery.current(),
    onSelect: (id) => {
      imagery.set(id);
      settings?.set('imagery', id);
    },
  });
  // The label switches, kept so a share link can repaint them.
  const labelSwitches = {
    cities: createSwitch({
      label: 'City names',
      on: true,
      title: 'Bundled city names (works offline)',
      onToggle: (on) => overlay.setOptions({ cities: on }),
    }),
    places: createSwitch({
      label: 'Places + borders',
      title: 'Country, region and place names from map tiles',
      onToggle: (on) => labels.set('places', on),
    }),
    roads: createSwitch({
      label: 'Street names',
      title: 'Roads and street names from map tiles',
      onToggle: (on) => labels.set('roads', on),
    }),
  };
  view.push(
    section(
      'BASEMAP',
      imageryChoice.el,
      createSwitch({
        label: 'Mono imagery',
        on: imagery.mono(),
        title: 'Grayscale, dimmed imagery so the data reads first',
        onToggle: (on) => imagery.setMono(on),
      }).el,
    ),
  );
  view.push(
    section(
      'LABELS',
      labelSwitches.cities.el,
      labelSwitches.places.el,
      labelSwitches.roads.el,
    ),
  );
  const DENSITIES = ['off', 'low', 'med', 'high'];
  const densityChoice = createChoice({
    label: 'Tracking boxes',
    options: DENSITIES.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })),
    current: app.tier === 'minimal' ? 'low' : 'med',
    onSelect: (density) => overlay.setOptions({ density }),
  });
  view.push(
    section(
      'TRACKING',
      densityChoice.el,
      createSwitch({
        label: 'Viewport frame',
        on: true,
        title: 'Corner brackets and readouts around the view',
        onToggle: (on) => overlay.setOptions({ frame: on }),
      }).el,
    ),
  );
  if (app.tier === 'minimal') overlay.setOptions({ density: 'low' });

  // MERGE NEARBY: contacts close together on screen as one counted marker
  // while zoomed out (the Layer SDK's clustering; the setting key 'merge').
  const mergeSwitch = createSwitch({
    label: 'Merge nearby',
    on: merge.merge,
    title:
      'Group contacts that sit close together into one counted marker until you zoom in (far lighter zoomed out)',
    onToggle: (on) => {
      merge.set({ merge: on });
      settings?.set('merge', on);
    },
  });
  settings?.subscribe((key, value) => {
    if (key !== 'merge') return;
    merge.set({ merge: value });
    mergeSwitch.set(value);
  });
  view.push(
    section(
      'CONTACTS',
      mergeSwitch.el,
      h(
        'div.ct-section__note',
        {},
        'Tap a group to fly to it. Below 3 km every contact is drawn.',
      ),
    ),
  );

  // 3D aircraft close to the camera (glTF models per class), desktop default.
  const { createModelLod } = await import('./core/scene/modelLod.js');
  const models = createModelLod(app.viewer, {
    getLayers: () => manager.active(),
    tier: app.tier,
  });
  if (!desktop) models.setEnabled(false);
  if (models.supported) {
    view.push(
      section(
        '3D MODELS',
        createSwitch({
          label: 'Aircraft models',
          on: models.enabled,
          title: 'Close aircraft as 3D models of their class (below 800 km)',
          onToggle: (on) => models.setEnabled(on),
        }).el,
        h(
          'div.ct-section__note',
          {},
          'Nearest aircraft within 150 km. Models: CC BY 4.0.',
        ),
      ),
    );
  }
  // EARTH: terrain, relief exaggeration, detail, and the sun, atmosphere and
  // stars (core/scene/earth.js). Every choice is remembered (SETTINGS).
  const { createEarthController } = await import('./core/scene/earth.js');
  const earth = createEarthController(app.viewer, { tier: app.tier });
  const earthSetting = (key, apply) => (value) => {
    apply(value);
    settings?.set(key, value);
  };
  earth.setLighting(!car && (settings?.get('lighting') ?? false));
  earth.setAtmosphere(!car && (settings?.get('atmosphere') ?? true));
  earth.setStars(!car && (settings?.get('stars') ?? true));
  earth.setExaggeration(car ? 1 : (settings?.get('exaggeration') ?? 1));
  view.push(
    section(
      'EARTH',
      terrainChoice.el,
      createChoice({
        caption: 'Relief',
        options: [1, 1.5, 2, 3].map((k) => ({ id: k, label: `${k}X` })),
        current: earth.state().exaggeration,
        onSelect: earthSetting('exaggeration', (k) => earth.setExaggeration(k)),
      }).el,
      createChoice({
        caption: 'Detail',
        options: [
          { id: 'low', label: 'Low' },
          { id: 'standard', label: 'Std' },
          { id: 'high', label: 'High' },
        ],
        current: settings?.get('detail') ?? 'standard',
        onSelect: earthSetting('detail', (d) => earth.setDetail(d)),
      }).el,
      createSwitch({
        label: 'Sun lighting',
        on: earth.state().lighting,
        title: 'The real day and night terminator at the scene time',
        onToggle: earthSetting('lighting', (on) => earth.setLighting(on)),
      }).el,
      createSwitch({
        label: 'Atmosphere',
        on: earth.state().atmosphere,
        title: 'Sky limb, ground haze and fog',
        onToggle: earthSetting('atmosphere', (on) => earth.setAtmosphere(on)),
      }).el,
      createSwitch({
        label: 'Stars, sun, moon',
        on: earth.state().stars,
        onToggle: earthSetting('stars', (on) => earth.setStars(on)),
      }).el,
    ),
  );

  // Satellites: Starlink dense mode (thousands of points), full tier only.
  const { denseAllowedForTier } = await import('./core/layers/constellations/groups.js');
  if (denseAllowedForTier(app.tier)) {
    view.push(
      section(
        'SATELLITES',
        createSwitch({
          label: 'Starlink dense',
          title: 'Add the Starlink constellation to Nav, GEO & visual sats (heavy)',
          onToggle: async (on) => {
            starlinkDense = on;
            // The constellation source reads the flag on its next fetch: reload.
            if (manager.isEnabled('constellations')) {
              manager.disable('constellations');
              await manager.enable('constellations');
            } else if (on) await manager.enable('constellations');
          },
        }).el,
      ),
    );
  }

  // Webcam categories and traffic-camera kinds: the chips set each layer's
  // shared filter; refresh() redraws from data the source already holds (no new
  // request). A layer that is off picks the filter up when enabled.
  const { createWebcamFilter, createCameraKindFilter } =
    await import('./core/layers/webcams/filter.js');
  view.push(
    section(
      'WEBCAMS',
      createWebcamFilter({ onChange: () => manager.getLayer('webcams')?.refresh?.() }).el,
    ),
  );
  view.push(
    section(
      'TRAFFIC CAMS',
      createCameraKindFilter({
        onChange: () => manager.getLayer('trafficcams')?.refresh?.(),
      }).el,
    ),
  );
  // ROAD FLOW (the TomTom readout at the view centre) and SHODAN (the
  // snapshot and host sample), each only when the proxy has its key.
  if (proxyClient && keyed('tomtom-flowseg')) {
    const [{ mountRoadFlow }, { simTrafficView }] = await Promise.all([
      import('./core/ui/roadFlow.js'),
      import('./core/layers/simtraffic/view.js'),
    ]);
    view.push(
      mountRoadFlow({
        viewer: app.viewer,
        proxyClient,
        settings: app.settings,
        mount: (slot, el) => app.mount(slot, el),
        ui: { section, createSwitch, createSegment, h },
        getView: () => simTrafficView(app.viewer),
      }),
    );
  }
  if (keyed('shodan') || (dev && !proxyClient)) {
    const { createShodanSection } = await import('./core/layers/shodan/controls.js');
    view.push(
      createShodanSection({
        settings: app.settings,
        manager,
        ui: { section, createChoice, createSwitch, h },
      }),
    );
  }

  // SURVEILLANCE: the nearest 60 (to the middle of the view, or to you while
  // the view follows you) or everything in view, re-picked from the tiles
  // already held; RELOAD OSM fetches the OSM layers' areas again.
  // CAMERA PREVIEWS: stills beside the nearest traffic cameras and webcams when
  // zoomed in (core/ui/cameraPreviews.js); off in the car (driver distraction).
  const [{ createCameraPreviews }, { loadStill: loadPreviewStill }] = await Promise.all([
    import('./core/ui/cameraPreviews.js'),
    import('./core/layers/trafficcams/still.js'),
  ]);
  view.push(
    section(
      'SURVEILLANCE',
      createChoice({
        label: 'Surveillance shows',
        options: [
          {
            id: 'nearest',
            label: 'Nearest 60',
            title: 'The 60 nearest the middle of the view',
          },
          { id: 'all', label: 'All in view', title: 'Every mapped device in view' },
        ],
        current: settings?.get('survScope') ?? 'nearest',
        onSelect: (id) => {
          settings?.set('survScope', id);
          osm.refresh('surveillance');
        },
      }).el,
      h(
        'button.ct-btn',
        {
          type: 'button',
          title: 'Fetch the surveillance, traffic light and landmark areas again',
          onclick: () => {
            osm.reload();
            notify({ title: 'OSM LAYERS RELOADING', level: 'low', timeoutMs: 2000 });
          },
        },
        'RELOAD OSM',
      ),
      h(
        'div.ct-section__note',
        {},
        'OpenStreetMap and DeFlock mapping: locations only. Each area is fetched once and kept for 12 to 24 h.',
      ),
    ),
  );
  let hubAt = null;
  overlay.subscribe((sum) => (hubAt = sum.hub?.visible ? sum.hub : null));
  const previews = createCameraPreviews(app.viewer, {
    getLayers: () => manager.active(),
    loadStill: loadPreviewStill,
    getInsets: () => overlay.geometry().insets,
    idFor: (t) => overlay.idFor(t),
    onSelect: (t) => tracker?.select(t),
    isBusy: () => Boolean(tracking?.cockpit?.isActive?.()),
    // Keep clear of the selected target's name on the map.
    avoid: () => (hubAt ? [{ x: hubAt.x - 24, y: hubAt.y - 26, w: 280, h: 52 }] : []),
    enabled: app.shell !== 'car' && settings?.get('camPreviews') !== false,
    count: settings?.get('camPreviewCount') ?? 4,
  });
  app.cameraPreviews = previews;
  view.push(
    section(
      'CAMERA PREVIEWS',
      createSwitch({
        label: 'Show stills',
        on: previews.enabled,
        title: 'Stills beside the nearest traffic cameras and webcams when zoomed in',
        onToggle: (on) => {
          settings?.set('camPreviews', on);
          previews.setEnabled(on);
        },
      }).el,
      createChoice({
        caption: 'Previews',
        options: [2, 4, 6, 8].map((n) => ({ id: n, label: String(n) })),
        current: settings?.get('camPreviewCount') ?? 4,
        onSelect: (n) => {
          settings?.set('camPreviewCount', n);
          previews.setCount(n);
        },
      }).el,
      h(
        'div.ct-section__note',
        {},
        'Under 15 km across. Each still refreshes at most once a minute while its layer is on. Display only.',
      ),
    ),
  );

  // Weather history: step the timed overlays (radar, clouds, lightning) back
  // through the last day of observations. Shown once a product reports times.
  const { createWeatherStrip } = await import('./core/ui/weatherStrip.js');
  const weatherStrip = createWeatherStrip({ timeline: weatherTimeline });
  view.push(section('WEATHER HISTORY', weatherStrip.el));

  // Sensor shaders (NVG/FLIR/CRT...): desktop-favored, mobile-gated. Not on the
  // weakest tier at all; balanced renders reduced-resolution single-pass; full
  // gets full resolution plus the stackable CRT overlay.
  let shaders = null;
  let onLookChange = null; // set once the Intel HUD exists (it follows the look)
  let syncLookOptions = () => {};
  let sensorChoice = null;
  let crtSwitch = null;
  if (app.tier !== 'minimal') {
    const { createSensorShaders } = await import('./core/shaders/sensorShaders.js');
    shaders = createSensorShaders(app.viewer, { tier: app.tier });
    const modes = (shaders.modes ?? ['none', 'nvg', 'flir']).map((id) => ({
      id,
      label: shaders.labels?.[id] ?? id.toUpperCase(),
    }));
    // Per-look settings, shown only for their look: the FLIR palette and the
    // NVG intensifier gain (uniforms: switching costs no shader rebuild).
    const flirChoice = createChoice({
      caption: 'Thermal palette',
      options: (shaders.FLIR_PALETTES ?? []).map((p) => ({ id: p.id, label: p.label })),
      current: shaders.flirPalette ?? 'white',
      onSelect: (id) => shaders.setFlirPalette(id),
    });
    const gainChoice = createChoice({
      caption: 'NVG gain',
      options: (shaders.NVG_GAINS ?? []).map((g) => ({ id: g.id, label: g.label })),
      current: shaders.nvgGain ?? 'med',
      onSelect: (id) => shaders.setNvgGain(id),
    });
    syncLookOptions = () => {
      flirChoice.el.hidden = shaders.sensor !== 'flir';
      gainChoice.el.hidden = shaders.sensor !== 'nvg';
    };
    sensorChoice = createChoice({
      label: 'Sensor mode',
      options: modes,
      current: shaders.sensor ?? 'none',
      onSelect: (id) => {
        shaders.setSensor(id);
        syncLookOptions();
        onLookChange?.(shaders.sensor);
        return shaders.sensor;
      },
    });
    syncLookOptions();
    const items = [sensorChoice.el, gainChoice.el, flirChoice.el];
    if (shaders.crtSupported) {
      crtSwitch = createSwitch({
        label: 'CRT overlay',
        on: Boolean(shaders.crt),
        onToggle: (on) => shaders.setCrt(on),
      });
      items.push(crtSwitch.el);
    }
    if (shaders.sharpenSupported) {
      items.push(
        createSwitch({ label: 'Sharpen', onToggle: (on) => shaders.setSharpen(on) }).el,
      );
    }
    if (shaders.bloomSupported) {
      items.push(
        createSwitch({ label: 'Bloom', onToggle: (on) => shaders.setBloom(on) }).el,
      );
    }
    view.push(section('SENSOR', ...items));
    if (dev && window.__argus) window.__argus.shaders = shaders;
  }
  const syncSensorUi = () => {
    sensorChoice?.paint(shaders?.sensor ?? 'none');
    crtSwitch?.set(Boolean(shaders?.crt));
    syncLookOptions();
    onLookChange?.(shaders?.sensor ?? 'none');
  };
  // Display: clean view (the interface hides) and orbit (the camera circles
  // the middle of the view). Both also on the keyboard: V and O.
  const { createOrbit } = await import('./core/scene/orbit.js');
  let cleanOn = false;
  const setClean = (on) => {
    cleanOn = Boolean(on);
    app.setClean?.(cleanOn);
    cleanSwitch.set(cleanOn);
  };
  const cleanSwitch = createSwitch({
    label: 'Clean view',
    title: 'Hide the interface, keep the globe and tracking (V)',
    onToggle: (on) => setClean(on),
  });
  const cleanExit = h(
    'button.ct-btn.ct-clean-exit',
    { type: 'button', title: 'Show the interface (V)', onclick: () => setClean(false) },
    'UI',
  );
  app.mount('overlay', cleanExit);
  const orbitSwitch = createSwitch({
    label: 'Orbit',
    title: 'Circle the middle of the view; any press stops it (O)',
    onToggle: (on) => (on ? orbit.start() : (orbit.stop(), false)),
  });
  const orbit = createOrbit(app.viewer, {
    fps: app.profile?.animationFps || 30,
    isBusy: () => Boolean(tracking?.cockpit?.isActive()),
    onChange: (on) => orbitSwitch.set(on),
  });
  // Intel HUD (H): ISR-style telemetry over the globe (MGRS, GSD and NIIRS,
  // sun elevation, off-nadir angle, the nearest place). It sits in the same
  // free area as the tracking overlay, so it follows the overlay's insets.
  const { createIntelHud } = await import('./core/ui/intelHud.js');
  const intelHud = createIntelHud(app.viewer, {
    places: CITIES,
    tier: app.tier,
    getMode: () =>
      String(
        shaders ? (shaders.labels?.[shaders.sensor] ?? shaders.sensor) : 'normal',
      ).toUpperCase(),
  });
  app.viewer.container.appendChild(intelHud.el);
  intelHud.setVisible(false);
  const overlayInsets = overlay.setInsets;
  overlay.setInsets = (i) => {
    overlayInsets(i);
    intelHud.setInsets(i);
  };
  intelHud.setInsets(overlay.geometry().insets);
  // As in the reference, NVG and FLIR bring the HUD up (and Normal takes it
  // down again) unless the HUD was switched by hand.
  let hudByHand = false;
  const setHud = (on, { byHand = true } = {}) => {
    if (byHand) hudByHand = true;
    intelHud.setVisible(on);
    hudSwitch.set(on);
  };
  const hudSwitch = createSwitch({
    label: 'Intel HUD',
    title: 'MGRS, GSD and NIIRS, sun elevation, off-nadir angle (H)',
    onToggle: (on) => {
      hudByHand = true;
      intelHud.setVisible(on);
    },
  });
  onLookChange = (look) => {
    if (!hudByHand) setHud(look === 'nvg' || look === 'flir', { byHand: false });
  };
  camera.beforeMove(() => orbit.stop());
  view.push(section('DISPLAY', hudSwitch.el, cleanSwitch.el, orbitSwitch.el));

  // Contact cycling (N / P, and the arrows on the target panel): walk the
  // contacts the overlay lists, from a snapshot taken when the walk starts, so
  // stepping to a contact (which re-centres the list on it) does not just
  // bounce back to the previous one.
  let lastSummary = null;
  overlay.subscribe((sum) => (lastSummary = sum));
  let walk = { list: [], i: -1, at: 0 };
  const alive = (t) =>
    manager.active().some((a) => a.layer.getRecord(t.id)?.entity === t);
  const stepContact = (d) => {
    const now = Date.now();
    if (!walk.list.length || now - walk.at > 15_000) {
      const list = (lastSummary?.contacts ?? []).map((c) => c.target);
      const hubT = lastSummary?.hub?.target;
      // From the target (index 0) when there is one, else from before the
      // first contact, so N starts at the first and P at the last.
      walk = { list: hubT ? [hubT, ...list] : list, i: hubT ? 0 : -1, at: now };
    }
    const n = walk.list.length;
    // Skip contacts that left their layer since the walk began.
    for (let tries = 0; tries < n; tries += 1) {
      walk.i = walk.i < 0 ? (d > 0 ? 0 : n - 1) : (walk.i + d + n) % n;
      if (alive(walk.list[walk.i])) {
        walk.at = now;
        tracker.select(walk.list[walk.i]);
        return;
      }
    }
  };
  panel.setStepper?.(stepContact);

  // SETTINGS (a dialog: the bar's SET cell, SETUP, or the comma key) and the
  // SETUP tab. Settings apply live where they can; the tier needs a reload.
  const [
    { createSettingsPanel },
    { createSetupTab },
    { qualityProfileForTier, resolutionScaleFor },
  ] = await Promise.all([
    import('./core/ui/settingsPanel.js'),
    import('./core/ui/setupTab.js'),
    import('./core/capability/profile.js'),
  ]);
  const settingsPanel = createSettingsPanel({
    settings: app.settings,
    tier: app.tier,
    notify,
    layers: () => manager.list(), // SETTINGS > ICONS lists them in menu order
  });
  app.mount('overlay', settingsPanel.el);
  const tierProfile = qualityProfileForTier(app.tier, app.capabilities);
  const hudRoot = document.querySelector('.argus-hud');
  const applySetting = (key, value) => {
    const v = app.viewer;
    if (key === 'fps') {
      v.targetFrameRate = value === 'auto' ? tierProfile.targetFrameRate : value;
    } else if (key === 'resolution') {
      v.resolutionScale =
        value === 'auto'
          ? tierProfile.resolutionScale
          : resolutionScaleFor(value, window.devicePixelRatio || 1);
    } else if (key === 'detail') {
      earth.setDetail(value);
    } else if (key === 'uiScale') {
      if (hudRoot) hudRoot.style.zoom = value === 100 ? '' : String(value / 100);
    } else if (key === 'reducedMotion') {
      document.documentElement.dataset.reducedMotion = String(Boolean(value));
    } else if (key === 'tier') {
      notifier.push({
        title: 'QUALITY CHANGED',
        body: 'Reload to rebuild the globe at the new quality.',
        key: 'tier',
        timeoutMs: 0,
        action: { label: 'RELOAD', onClick: () => location.reload() },
      });
    } else if (key === 'units' || key === 'coords') {
      app.viewer.scene.requestRender();
    }
    v.scene.requestRender();
  };
  app.settings.subscribe(applySetting);
  applySetting('uiScale', app.settings.get('uiScale'));
  applySetting('reducedMotion', app.settings.get('reducedMotion'));
  if (desktop) {
    app.mount(
      'barEnd',
      createSegment({
        label: 'SET',
        value: '⚙',
        title: 'Settings (,)',
        onClick: () => settingsPanel.toggle(),
      }).el,
    );
  }
  const setup = createSetupTab({
    proxyBase,
    health,
    tier: app.tier,
    capabilities: app.capabilities,
    notify,
    openSettings: () => settingsPanel.open(),
    openKeys: () => keyHelpRef?.open(),
    logs,
  });
  app.mount('setup', setup.el);
  let keyHelpRef = null;

  // Keyboard shortcuts and the "?" list (core/ui/shortcuts.js).
  const shortcuts = await import('./core/ui/shortcuts.js');
  const keyHelp = shortcuts.createShortcutHelp({ desktop });
  keyHelpRef = keyHelp;
  app.mount('overlay', keyHelp.el);
  document.addEventListener('keydown', (e) => {
    if (e.key !== ',' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    e.preventDefault();
    settingsPanel.toggle();
  });
  shortcuts.bindShortcuts({
    help: () => keyHelp.toggle(),
    hud: () => setHud(!intelHud.visible()),
    clean: () => setClean(!cleanOn),
    orbit: () => orbit.toggle(),
    density: () => {
      const cur = overlay.options().density;
      const next = DENSITIES[(DENSITIES.indexOf(cur) + 1) % DENSITIES.length];
      overlay.setOptions({ density: next });
      densityChoice.paint(next);
      notifier.push({
        title: `TRACKING BOXES ${next.toUpperCase()}`,
        key: 'density',
        level: 'low',
        timeoutMs: 1500,
      });
    },
    next: () => stepContact(1),
    prev: () => stepContact(-1),
    preset: (i) => PRESETS[i] && runPreset(PRESETS[i]),
  });

  view.push(section('SYSTEM', app.readout.el));
  for (const el of view) app.mount('view', el);

  // ------------------------------------------------------------------ intel
  // Certificate Transparency firehose (P16 CT/BGP stage): a live issuance list,
  // off by default. Toggling it connects the /ws/ct feed (dev: a synthetic
  // stream), so the upstream socket is only held while the user is watching.
  const makeCtSource = proxyClient
    ? () =>
        import('./core/osint/ct/ctSource.js').then((m) =>
          m.createCtSource({ wsUrl: wsCtUrl }),
        )
    : dev
      ? () =>
          import('./core/osint/ct/mockCtSource.js').then((m) => m.createCtMockSource())
      : null;

  // In-app terminal (P16 final): a command palette that drives the app and runs
  // the passive lookups already built. It commands the app and reads public
  // indexes only, never sending traffic at a host (query/correlate reuse the same
  // passive search path).
  const [{ createTerminal }, { createCommands }, { classifyAsset }] = await Promise.all([
    import('./core/ui/terminal.js'),
    import('./core/osint/terminal/commands.js'),
    import('./core/osint/asset.js'),
  ]);
  const termCommands = createCommands({
    listLayers: () => manager.list().map((l) => ({ key: l.key, on: l.enabled })),
    setLayer: (key, action) => {
      if (!manager.keys().includes(key)) return false;
      if (action === 'on') manager.enable(key);
      else if (action === 'off') manager.disable(key);
      else manager.toggle(key);
      return true;
    },
    track: (q) => {
      for (const layer of manager.activeLayers()) {
        const hits = layer.search(q, 1);
        if (hits.length) {
          tracker.select(hits[0].entity);
          return hits[0].label;
        }
      }
      return null;
    },
    goto: ({ latitude, longitude, altitude }) =>
      camera.flyTo({ latitude, longitude, altitude: altitude ?? 1_000_000 }),
    geocode,
    query: async (str) => {
      const asset = classifyAsset(str);
      if (!asset) return { error: 'not a valid asset (expected ip/domain/asn)' };
      const r = await searchCtl.select({ kind: 'asset', asset });
      return r?.position
        ? { kind: asset.kind, value: asset.value }
        : { error: 'lookup unavailable or no location' };
    },
    correlate: async (str) => {
      const asset = classifyAsset(str);
      if (!asset) return { error: 'not a valid asset (expected ip/domain/asn)' };
      const r = await searchCtl.select({ kind: 'correlate', asset });
      return r?.position
        ? { kind: asset.kind, value: asset.value }
        : { error: 'correlation unavailable or no location' };
    },
    listPresets: () => PRESETS.map((p) => ({ id: p.id, label: p.label })),
    applyPreset: (id) => {
      const p = PRESETS.find(
        (x) => x.id === id || x.label.toLowerCase() === id.toLowerCase(),
      );
      if (!p) return false;
      runPreset(p);
      return true;
    },
  });
  const terminal = createTerminal({ run: (line) => termCommands.run(line) });
  app.mount('float', terminal.el);

  // ------------------------------------------------------------- navigation
  // WHERE TO, the route preview and turn-by-turn (core/nav, core/ui/navPanel.js).
  // The navigator is app.nav in every shell (the car drives it too) and its
  // routes are drawn on the globe everywhere (app.navView); the panels are for
  // the desktop and the phone. With no proxy, a dev session plans on the
  // labelled demo routes. TOOLS > ROUTE is the same trip from the menu.
  const { alongRoute } = await import('./core/route/osrm.js');
  const [{ createNavigator }, { createNavView }, { createFixSource }, navMock] =
    await Promise.all([
      import('./core/nav/navigator.js'),
      import('./core/nav/view.js'),
      import('./core/nav/fixSource.js'),
      !proxyClient && dev ? import('./core/nav/mockProxy.js') : null,
    ]);
  app.nav = createNavigator({
    proxyClient: proxyClient ?? navMock?.createNavMockProxy() ?? null,
    hasFeed: (id) => Boolean(proxyClient && feedConfigured(health, id)),
    log: (e) => {
      console.warn(`[argus] nav: ${e.title}${e.body ? `: ${e.body}` : ''}`);
      app.logs?.add?.(e);
    },
  });
  let navUi = null;
  // The car draws its own route (shell-car/routeView.js: framed beside Android
  // Auto's lists, looking ahead along the road) and feeds the navigator its
  // fixes: it takes the navigator, and no second route view.
  if (app.shell === 'car') app.setNavigator?.(app.nav);
  app.navView =
    app.shell === 'car'
      ? null
      : createNavView(app.viewer, app.nav, {
          follow: true,
          fps: app.profile?.animationFps || 30,
          // The self-position marker shows you; the puck stands in without it (and
          // for a simulated drive, which is not where you are).
          showPuck: () => !app.selfPosition || Boolean(navUi?.simulating),
          onFollowStart: () => {
            tracker.unfollow?.();
            orbit.stop();
          },
          onFollowChange: (on) => navUi?.setFollowing(on),
        });
  const navFlyAlong = (coords) => {
    tracker.unfollow?.();
    app.navView.setFollow(false);
    sketchMod.flyAlongPath(app.viewer, alongRoute(coords));
  };
  const navTarget = () => {
    const t = tracker.trackedEntity;
    const p = sketchMod.targetLatLon(app.viewer, t);
    return p ? { ...p, name: tracking.labelFor(t) ?? 'TARGET' } : null;
  };
  if (app.shell === 'desktop' || app.shell === 'mobile') {
    const { createNavPanel } = await import('./core/ui/navPanel.js');
    const cv = app.viewer.scene.canvas;
    navUi = createNavPanel({
      nav: app.nav,
      view: app.navView,
      fixes: createFixSource({ selfPosition: () => app.selfPosition ?? null }),
      shell: app.shell,
      settings: app.settings,
      near: searchNear,
      armTap,
      targetPoint: navTarget,
      flyAlong: navFlyAlong,
      notify,
      canvas: cv,
      pick: (pos) => sketchMod.windowToLatLon(app.viewer, pos),
      demo: !proxyClient,
      // On the phone the sheet makes way for the preview and the drive.
      onActive: () => app.collapseSheet?.(),
    });
    app.mount('navTop', navUi.top);
    app.mount('navBottom', navUi.bottom);
    document.body.appendChild(navUi.ctx);
    navHooks.swallowTap = () => navUi.swallowTap();
    // ROUTE HERE on the card of anything on the ground (not satellites).
    navHooks.cardAction = (target, rec) =>
      (rec?.normalized?.position?.altitude ?? 0) > 100_000
        ? null
        : {
            label: 'ROUTE HERE',
            title: 'Plan a route to this target',
            onClick: () => {
              const p = sketchMod.targetLatLon(app.viewer, target);
              if (p)
                navUi.routeHere({
                  ...p,
                  name: String(rec.metadata?.title ?? 'TARGET'),
                  kind: rec.key,
                });
            },
          };
  }
  if (dev && window.__argus)
    Object.assign(window.__argus, { nav: app.nav, navView: app.navView, navUi });

  const intel = [];
  const tools = await import('./core/ui/toolsMenu.js');
  intel.push(
    navUi?.menuSection(),
    tools.createDrawTool({ sketch, armTap, disarm }).el,
    tools.createImageryTool({ catalogue: imageryCatalogue, armTap, manager, notify }).el,
    tools.createShareTool({ encode: () => encodeView(), notify }).el,
  );

  // Scenes: views captured as shots and played back as a tour (fly, then
  // hold), saved on this device or exported as JSON. Nothing is uploaded.
  const [{ createScenesTool }, { createSceneCamera }, { createPoiTool }] =
    await Promise.all([
      import('./core/ui/scenesTool.js'),
      import('./core/scene/sceneCamera.js'),
      import('./core/ui/poiTool.js'),
    ]);
  const sceneCam = createSceneCamera(app.viewer);
  const layerKeyOf = (t) =>
    manager.active().find((a) => a.layer.getRecord(t.id)?.entity === t)?.key ?? null;
  const scenes = createScenesTool({
    capture: () => {
      const t = tracker.trackedEntity;
      const tk = t && layerKeyOf(t);
      return {
        camera: sceneCam.read(),
        layers: manager.active().map((a) => a.key),
        look: shaders?.sensor ?? 'none',
        target: tk ? { layer: tk, id: String(t.id) } : undefined,
      };
    },
    apply: async (shot) => {
      orbit.stop();
      setPreset(null);
      await applyPreset(manager, { layers: shot.layers ?? [] });
      if (shot.look && shaders) {
        shaders.setSensor(shot.look);
        syncSensorUi();
      }
      const rec = shot.target
        ? manager.getLayer(shot.target.layer)?.getRecord(shot.target.id)
        : null;
      if (rec?.entity) tracker.select(rec.entity);
      else tracker.deselect();
    },
    flyTo: (cam, ms, signal) => {
      orbit.stop();
      tracker.unfollow?.();
      return sceneCam.flyTo(cam, ms, signal);
    },
    notify,
    canvas: app.viewer.scene.canvas,
  });
  intel.push(scenes.el);

  // My places: the user's own locations and landmarks.
  const { createPlacesTool } = await import('./core/ui/placesTool.js');
  intel.push(
    createPlacesTool({
      store: placesStore,
      centre: () => {
        const cv = app.viewer.scene.canvas;
        return sketchMod.windowToLatLon(app.viewer, {
          x: cv.clientWidth / 2,
          y: cv.clientHeight / 2,
        });
      },
      view: () => {
        const v = camera.getView();
        return {
          lat: v.latitude,
          lon: v.longitude,
          alt: v.height,
          heading: v.heading,
          pitch: v.pitch,
        };
      },
      flyTo: (p) => {
        orbit.stop();
        tracker.unfollow?.();
        if (p.view)
          camera.flyToView({
            longitude: p.view.lon,
            latitude: p.view.lat,
            height: p.view.alt,
            heading: p.view.heading,
            pitch: p.view.pitch,
          });
        else
          camera.flyAround({
            longitude: p.lon,
            latitude: p.lat,
            range: 2500,
            pitch: -45,
          });
        if (!manager.isEnabled('myplaces')) manager.enable('myplaces');
      },
      pick: (onPoint) => armTap(onPoint, 'TAP THE PLACE TO SAVE'),
      notify,
      onChange: () => manager.getLayer('myplaces')?.refresh?.(),
    }).el,
  );

  // WATCH AREAS: proximity alerts for moving contacts (core/geo/geofence.js).
  const [{ createGeofences }, { createWatchTool }, { createTourTool }] =
    await Promise.all([
      import('./core/geo/geofence.js'),
      import('./core/ui/watchTool.js'),
      import('./core/ui/tourTool.js'),
    ]);
  const MOVERS = ['flights', 'military', 'localadsb', 'ships', 'transit'];
  let watchTool = null;
  const fences = createGeofences({
    onEnter: (area, c) =>
      notifier.push({
        title: `ENTERED ${area.name.toUpperCase()}`,
        body: `${c.label} (${c.key})`,
        key: `fence-${area.id}-${c.key}-${c.id}`,
        level: 'normal',
        action: c.target
          ? { label: 'SELECT', onClick: () => tracker.select(c.target) }
          : undefined,
      }),
    onExit: (area, k) =>
      notifier.push({
        title: `LEFT ${area.name.toUpperCase()}`,
        body: k.split(':').slice(1).join(':'),
        key: `fence-out-${area.id}-${k}`,
        level: 'low',
      }),
  });
  setInterval(() => {
    if (!fences.size || document.hidden) return;
    const contacts = [];
    for (const { key, layer } of manager.active()) {
      if (!MOVERS.includes(key)) continue;
      layer.forEachRecord?.((target, n) =>
        contacts.push({
          key,
          id: String(n.id),
          lat: n.position.latitude,
          lon: n.position.longitude,
          label: String(n.meta?.callsign || n.meta?.name || n.id).trim(),
          target,
        }),
      );
    }
    fences.check(contacts);
    watchTool?.render();
  }, 5000);
  const viewCentre = () => {
    const cv = app.viewer.scene.canvas;
    return sketchMod.windowToLatLon(app.viewer, {
      x: cv.clientWidth / 2,
      y: cv.clientHeight / 2,
    });
  };
  watchTool = createWatchTool({
    fences,
    sketch,
    centre: viewCentre,
    pick: (fn) => armTap(fn, 'TAP THE CENTRE OF THE AREA'),
    flyTo: (a) =>
      camera.flyAround({
        longitude: a.lon,
        latitude: a.lat,
        range: a.radiusM * 3.2,
        pitch: -60,
      }),
    notify,
  });
  intel.push(watchTool.el);

  // SITUATION TOUR: the ambient mode, round the hotspots of the layers on.
  const tour = createTourTool({
    getEntries: () => {
      const out = [];
      for (const { key, layer } of manager.active()) {
        let n = 0;
        layer.forEachRecord?.((_t, rec) => {
          if (n++ < 3000) out.push({ key, n: rec });
        });
      }
      return out;
    },
    flyTo: (spot) =>
      camera.flyAround({
        longitude: spot.lon,
        latitude: spot.lat,
        range: spot.range,
        pitch: -40,
        heading: Math.random() * 360,
        duration: 3,
      }),
    onArrive: () => orbit.start(),
    select: (spot) => {
      const rec = manager.getLayer(spot.key)?.getRecord(spot.id);
      if (rec?.entity) tracking.selectQuiet(rec.entity);
    },
    stopMotion: () => orbit.stop(),
    notify,
    canvas: app.viewer.scene.canvas,
  });
  intel.push(tour.el);

  // LANDMARKS: the named landmarks nearby the middle of the view, from OSM
  // (the Landmarks layer's tiles, fetched once); fly there or SAVE to MY PLACES.
  const [landmarkParse, { categoryLabel }, { loadAround, viewSizeKm }, unitsFmt] =
    await Promise.all([
      import('./core/layers/landmarks/parse.js'),
      import('./core/layers/landmarks/format.js'),
      import('./core/layers/overpass/tiles.js'),
      import('./core/settings/store.js'),
    ]);
  intel.push(
    createPoiTool({
      nearby: async (at, radiusKm) => {
        if (osm.landmarks) {
          const r = await loadAround(osm.landmarks, at, radiusKm);
          if (!r.items.length && r.failed) throw new Error('the OSM areas did not load');
          return r.items;
        }
        if (!dev) return [];
        const { mockLandmarksAround } =
          await import('./core/layers/landmarks/mockSource.js');
        return landmarkParse.parseLandmarks(mockLandmarksAround(at, radiusKm));
      },
      centre: () => osm.middle(),
      viewKm: () => viewSizeKm(osm.view()).w,
      from: () => {
        const g = camera.groundPosition();
        return { lat: g.latitude, lon: g.longitude };
      },
      flyTo: (v) => {
        orbit.stop();
        tracker.unfollow?.();
        camera.flyAround({
          longitude: v.lon,
          latitude: v.lat,
          height: v.height,
          range: v.range,
          heading: v.heading,
          pitch: v.pitch,
        });
      },
      save: (n) =>
        placesStore.add({
          name: n.meta.name,
          lat: n.position.latitude,
          lon: n.position.longitude,
          kind: 'landmark',
          note: `${categoryLabel(n.meta.category)} (OpenStreetMap)`,
        }),
      notify,
      formatDistance: (m) => unitsFmt.formatDistance(m, settings?.get('units')),
    }).el,
  );
  const { createRadioTuner } = await import('./core/ui/radioTuner.js');
  intel.push(
    createRadioTuner({
      manager,
      proxyClient,
      notify,
      select: (t) => tracking.selectQuiet(t),
    }).el,
  );
  intel.push(
    section(
      'CONSOLE',
      h(
        'div.ct-section__note',
        {},
        'Passive lookups and app commands. Toggle with ` (backtick).',
      ),
      h(
        'button.ct-btn',
        { type: 'button', onclick: () => terminal.toggle() },
        'OPEN TERMINAL',
      ),
    ),
  );
  if (makeCtSource) {
    const { createCtTicker } = await import('./core/ui/ctTicker.js');
    let ctStop = null;
    const ctTicker = createCtTicker({
      onToggle: async (on) => {
        if (on) {
          const source = await makeCtSource();
          ctStop = source((certs) => ctTicker.push(certs));
        } else {
          ctStop?.();
          ctStop = null;
        }
      },
    });
    intel.push(section('CERTIFICATE TRANSPARENCY', ctTicker.el));
  }

  const { formatWind: windFormat } = await import('./core/layers/wind/field.js');

  // Time scrubber (Phase 17): rewind the scene through the ring-buffer history.
  const { createTimeScrubber } = await import('./core/ui/timeScrubber.js');
  const scrubber = createTimeScrubber({ clock });

  if (desktop) {
    for (const seg of readouts.createCameraReadout(app.viewer, { prefs: app.settings }))
      app.mount('strip', seg);
    // The field layers' readings at the middle of the view, each shown while
    // its layer is on: WIND, AIR (US AQI) and AURORA (chance and Kp).
    const [{ formatAirQuality }, { formatAurora }] = await Promise.all([
      import('./core/layers/airquality/field.js'),
      import('./core/layers/aurora/parse.js'),
    ]);
    const fieldReadouts = [
      ['wind', 'WIND', 'Wind at the view centre', windFormat],
      ['airquality', 'AIR', 'Air quality (US AQI) at the view centre', formatAirQuality],
      ['aurora', 'AURORA', 'Chance of visible aurora here, and Kp', formatAurora],
    ].map(([key, label, title, format]) => {
      const seg = createSegment({ label, value: '--', title });
      seg.el.hidden = true;
      app.mount('strip', seg);
      return { key, seg, format };
    });
    let fieldT = 0;
    app.viewer.scene.postRender.addEventListener(() => {
      const now = performance.now();
      if (now - fieldT < 500) return;
      fieldT = now;
      const c = app.viewer.camera.positionCartographic;
      const lon = (c.longitude * 180) / Math.PI;
      const lat = (c.latitude * 180) / Math.PI;
      for (const r of fieldReadouts) {
        const l = manager.isEnabled(r.key) ? manager.getLayer(r.key) : null;
        r.seg.el.hidden = !l;
        if (l) r.seg.set(r.format(l.sample?.(lon, lat) ?? null) ?? '--');
      }
    });
    const timeSeg = createSegment({ label: 'T' });
    timeSeg.el.querySelector('.ct-seg__value').replaceWith(scrubber.el);
    app.mount('stripEnd', timeSeg);
    app.mount(
      'stripEnd',
      createSegment({
        label: '❯',
        value: 'TERM',
        title: 'Terminal (`)',
        onClick: () => terminal.toggle(),
      }),
    );
  } else {
    intel.push(section('TIMELINE', scrubber.el));
  }
  intel.push(
    tools.createCreditsView({
      manager,
      activeKeys: () =>
        manager
          .list()
          .filter((l) => l.enabled)
          .map((l) => l.key)
          .concat(models.enabled ? ['models'] : []),
    }).el,
  );
  for (const el of intel) app.mount('intel', el);

  // ------------------------------------------------------------ view stack
  const { createZoomControls } = await import('./core/ui/zoomControls.js');
  app.mount(
    'stack',
    createZoomControls({
      camera,
      // GEO: centre on me, again to follow (core/geo/geoControl.js).
      geo: app.geo?.(camera, {
        beforeFollow: () => tracker?.unfollow?.(),
        log: (entry) => app.logs?.add?.(entry),
        units: () => app.settings?.get('units'),
      }),
    }).el,
  );

  // Thermal budget ladder (CLAUDE.md): Android has no thermal API, so a rising
  // frame-time trend is the signal. Quality is given up one rung at a time, each
  // reversible once the device has stayed comfortable for a while:
  // post-processing off -> lower resolutionScale -> flat (free) terrain.
  // Phones and weak devices only: on a full-tier desktop a heavier scene the
  // user chose (photoreal, stacked shaders) is not heat, and must not be undone.
  const { attachThermalLadder } = await import('./core/scene/thermal.js');
  let savedSensor = null;
  let savedTerrain = null;
  if (app.tier !== 'full') {
    const rungs = [];
    // Post-processing is only a rung where shaders exist (not on the minimal tier).
    if (shaders) {
      rungs.push({
        label: 'post-processing off',
        down: () => {
          savedSensor = { sensor: shaders.sensor, crt: shaders.crt };
          shaders.setSensor('none');
          shaders.setCrt(false);
          syncSensorUi();
        },
        up: () => {
          if (!savedSensor) return;
          shaders.setSensor(savedSensor.sensor);
          shaders.setCrt(savedSensor.crt);
          savedSensor = null;
          syncSensorUi();
        },
      });
    }
    rungs.push(
      {
        label: 'reduced resolution',
        down: () => {
          // Never below 0.6 rendered pixels per CSS pixel. The floor is in CSS
          // pixels, not a bare scale: the car budgets its pixels below 0.6 on a
          // dense display, and this step must still lower it, never raise it.
          app.viewer.resolutionScale = Math.max(
            0.6 / (window.devicePixelRatio || 1),
            app.profile.resolutionScale * 0.7,
          );
        },
        up: () => {
          app.viewer.resolutionScale = app.profile.resolutionScale;
        },
      },
      {
        label: 'flat terrain',
        down: () => {
          savedTerrain = terrain.current();
          if (savedTerrain !== 'flat') terrainChoice.set('flat');
        },
        up: () => {
          if (savedTerrain && savedTerrain !== 'flat') terrainChoice.set(savedTerrain);
          savedTerrain = null;
        },
      },
    );
    attachThermalLadder(app.viewer, {
      rungs,
      onChange: (level, label) => {
        app.readout.setThermal?.(label, level);
        console.info(`[argus] thermal ladder: ${label}`);
        notifier.push({
          title: level > 0 ? 'THERMAL BUDGET' : 'THERMAL RECOVERED',
          body: level > 0 ? `Heat rising: ${label}.` : 'Back to full quality.',
          key: 'thermal',
          level: 'low',
        });
      },
    });
  }

  // No proxy at all means every layer is simulated. Say so up front so mock data
  // is never mistaken for live feeds.
  if (!proxyClient) {
    notifier.push({
      title: 'DEMO DATA',
      body: 'No proxy reachable: every layer is simulated. Run "npm run proxy" alongside the dev server for live feeds.',
      level: 'low',
      timeoutMs: 9000,
      key: 'demo',
      kind: 'notice', // critical to know: never folded into the log
    });
  }

  // Point-at-sky mode (mobile only). The shell owns the sensor + reticle; main
  // supplies how to identify the aimed contact and how to lock onto it.
  if (app.enableCompass) {
    const { createCenterPicker } = await import('./core/interaction/centerPicker.js');
    const centerPicker = createCenterPicker(app.viewer);
    app.enableCompass({
      cameraControls: camera,
      pickCenter: () => {
        const entity = centerPicker.pick();
        return entity ? { entity, label: labelFor(entity) } : null;
      },
      onLock: (entity) => tracker.select(entity),
    });
  }

  // ------------------------------------------------------------ share link
  // The address bar always holds this view (camera, layers, looks, labels,
  // target), so a reload or a copied link reopens it. Local only: nothing is
  // sent anywhere. core/share/state.js fails closed on anything malformed.
  const share = await import('./core/share/state.js');
  const deg = (r) => (r * 180) / Math.PI;
  const keyOf = (target) =>
    manager.active().find((a) => a.layer.getRecord(target.id)?.entity === target)?.key ??
    null;
  function encodeView() {
    const cam = app.viewer.camera;
    const pc = cam.positionCartographic;
    const t = tracker.trackedEntity;
    const tk = t && keyOf(t);
    return share.encodeShareHash({
      camera: {
        lat: deg(pc.latitude),
        lon: deg(pc.longitude),
        alt: pc.height,
        heading: deg(cam.heading),
        pitch: deg(cam.pitch),
      },
      layers: manager
        .list()
        .filter((l) => l.enabled)
        .map((l) => l.key),
      sensor: shaders?.sensor ?? 'none',
      imagery: imagery.current(),
      terrain: terrain.current?.(),
      labels: {
        cities: overlay.options().cities,
        places: labels.get('places'),
        roads: labels.get('roads'),
      },
      track: tk ? { layer: tk, id: String(t.id) } : undefined,
    });
  }
  // ---------------------------------------------------- session memory (W4)
  // The app reopens as it was left (SETTINGS > Start in: where I left, the
  // default): the view as a share hash, the VIEW display controls that have
  // no setting of their own, the camera filter chips and the preset, in one
  // record on this device (core/share/session.js). Saved on every change
  // (debounced) and at once when the page is hidden or closed, since the
  // Android WebView can be killed in the background without an unload. The
  // car shares this origin and storage but keeps its own state: it never
  // reads or writes the record.
  const sessionMod = await import('./core/share/session.js');
  const viewState = await import('./core/ui/viewState.js');
  const [{ webcamFilter }, { trafficCamKindFilter }] = await Promise.all([
    import('./core/layers/webcams/categories.js'),
    import('./core/layers/trafficcams/kinds.js'),
  ]);
  const chipFilters = { webcams: webcamFilter, trafficcams: trafficCamKindFilter };
  const controlAllow = {
    switches: sessionMod.SESSION_SWITCHES,
    choices: sessionMod.SESSION_CHOICES,
  };
  let sessionStore = null;
  try {
    sessionStore = window.localStorage;
  } catch {
    sessionStore = null;
  }
  const keepsSession = app.shell !== 'car';
  const sessionSaver = keepsSession
    ? sessionMod.createSessionSaver({
        storage: sessionStore,
        collect: () => ({
          hash: encodeView(),
          controls: viewState.readControls(view, controlAllow),
          filters: Object.fromEntries(
            Object.entries(chipFilters).map(([k, f]) => [k, [...f.selected()]]),
          ),
          preset: activePreset
            ? {
                id: activePreset,
                before: before ? { layers: [...before.layers], view: before.view } : null,
                staged: staged ? [...staged] : null,
              }
            : null,
        }),
      })
    : null;
  let hashTimer = null;
  const writeHash = () => {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => history.replaceState(null, '', encodeView()), 800);
    sessionSaver?.schedule();
  };

  const startView = app.settings?.get('startView') ?? 'last';
  const stored = keepsSession
    ? sessionMod.readSession(sessionStore, {
        presetIds: PRESETS.map((p) => p.id),
        layerKeys: manager.keys(),
      })
    : { session: null, legacyView: null };
  const plan = sessionMod.startPlan({
    shell: app.shell,
    hash: location.hash,
    startView,
    session: stored.session,
    legacyView: stored.legacyView,
  });
  const shared = plan.hash
    ? share.decodeShareHash(plan.hash, {
        layerKeys: manager.keys(),
        imageryIds: IMAGERY_SOURCES.map((x) => x.id),
        terrainIds: TERRAIN_SOURCES.map((x) => x.id),
        labelKeys: ['cities', 'places', 'roads'],
        sensorModes: shaders?.modes ?? ['none'],
      })
    : null;

  // Default state (master plan 8): flights + earthquakes + transit on. The
  // mobile shell's first launch goes into the "Around Me" preset itself
  // (geolocation, and its layer set, so the highlighted preset matches what
  // is on); desktop starts at the world view with the defaults. A shared link
  // wins over everything, then the saved session.
  splash?.step('GREETER_UI_INITIALIZING', 85);
  const aroundMe =
    plan.kind === 'aroundme' && app.aroundMe && PRESETS.find((p) => p.id === 'around-me');
  if (shared) {
    if (shared.camera) {
      camera.lookFrom({
        longitude: shared.camera.lon,
        latitude: shared.camera.lat,
        height: shared.camera.alt,
        heading: shared.camera.heading ?? 0,
        pitch: shared.camera.pitch ?? -90,
      });
    }
    if (shared.imagery) {
      imagery.set(shared.imagery);
      imageryChoice.paint(shared.imagery);
    }
    // Terrain is a setting of its own: a resumed session leaves it to SETTINGS.
    if (shared.terrain && plan.kind === 'link') terrainChoice.set(shared.terrain);
    if (shared.sensor && shaders) {
      shaders.setSensor(shared.sensor);
      syncSensorUi();
    }
    for (const [k, on] of Object.entries(shared.labels ?? {})) {
      if (k === 'cities') overlay.setOptions({ cities: on });
      else labels.set(k, on);
      labelSwitches[k]?.set(on);
    }
    for (const key of shared.layers ?? DEFAULT_LAYERS) await manager.enable(key);
    // The target appears once its layer has data: wait for it (up to 30 s).
    if (shared.track) {
      const { layer: lk, id } = shared.track;
      const until = Date.now() + 30_000;
      const tryTrack = () => {
        const rec = manager.getLayer(lk)?.getRecord(id);
        if (rec?.entity) tracker.select(rec.entity);
        else if (Date.now() < until) setTimeout(tryTrack, 1000);
      };
      tryTrack();
    }
  } else if (aroundMe) {
    runPreset(aroundMe, { initial: true });
  } else {
    for (const key of DEFAULT_LAYERS) await manager.enable(key);
  }
  // The rest of a resumed session: display controls (pressed as a person
  // would), the camera filter chips, and the preset with the view it gives back.
  const resumed = plan.kind === 'session' ? plan.session : null;
  if (resumed) {
    for (const [k, f] of Object.entries(chipFilters))
      if (resumed.filters[k]) f.set(resumed.filters[k]);
    viewState.applyControls(view, resumed.controls, controlAllow);
    if (resumed.preset) {
      setPreset(resumed.preset.id);
      const b = resumed.preset.before;
      before = b ? { layers: new Set(b.layers), view: b.view } : null;
      staged = before ? new Set(resumed.preset.staged ?? enabledKeys()) : null;
    }
  }
  app.viewer.camera.moveEnd.addEventListener(writeHash);
  manager.subscribe(writeHash);
  let lastHub = null;
  overlay.subscribe((sum) => {
    const t = sum.hub?.target ?? null;
    if (t !== lastHub) {
      lastHub = t;
      writeHash();
    }
  });
  if (sessionSaver) {
    // Any press in the interface may change what is remembered (a switch, a
    // chip, a preset): save soon after. Hidden or closing: save now.
    document.addEventListener('click', () => sessionSaver.schedule(), true);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') sessionSaver.flush();
    });
    window.addEventListener('pagehide', () => sessionSaver.flush());
    document.addEventListener('freeze', () => sessionSaver.flush());
    // The state this launch settled into is itself worth keeping.
    sessionSaver.schedule();
    if (dev && window.__argus) window.__argus.session = sessionSaver;
  }

  if (dev && window.__argus)
    Object.assign(window.__argus, {
      manager,
      camera,
      overlay,
      panel,
      launcher,
      notifier,
      logs,
      setup,
      imagery,
      labels,
      cameraPreviews: previews,
    });
}

// The interaction spine: tap/click a contact to make it the target (overlay
// lock, trail, target panel; the camera stays put unless asked to FOLLOW).
// Layer-agnostic: it resolves a picked target by asking each active layer.
async function attachTracking(
  app,
  manager,
  {
    extraResolvers = [],
    panel,
    overlay,
    notify,
    extras,
    interceptTap,
    proxyClient,
    moreActions,
    camera,
    merge,
  },
) {
  const [
    { createPicker },
    { createTracker },
    { createCockpit },
    { createPoseGizmo },
    { nudgeIntoView },
  ] = await Promise.all([
    import('./core/interaction/picker.js'),
    import('./core/interaction/tracker.js'),
    import('./core/interaction/cockpit.js'),
    import('./core/layers/cctv/gizmo.js'),
    import('./core/scene/nudge.js'),
  ]);

  const resolve = (target) => {
    // Active feed layers first, then extra resolvers (e.g. the OSINT plotter,
    // whose markers are query outputs rather than a toggleable layer).
    const sources = [
      ...manager.active().map((a) => ({ ...a, demo: isDemo(a.key) })),
      ...extraResolvers.map((layer) => ({ key: 'osint', label: 'OSINT', layer })),
    ];
    for (const { key, label, layer, demo } of sources) {
      const rec = layer.getRecord(target.id);
      // Ids are only unique within a layer (flights, military and your own
      // receiver all key aircraft by ICAO hex), so the record must be for this
      // very target, not a namesake in another layer.
      if (rec && rec.cardModel && (!rec.entity || rec.entity === target)) {
        const metadata = decorate(rec.cardModel, rec.normalized, { label, demo });
        const more = extras?.rows(key, rec.normalized) ?? [];
        if (more.length) metadata.rows = [...(metadata.rows || []), ...more];
        return {
          key,
          normalized: rec.normalized,
          metadata,
          getHistoryFixes: rec.getHistoryFixes,
          mover: rec.mover,
        };
      }
    }
    return null;
  };
  const isDemo = (key) => Boolean(manager.list().find((l) => l.key === key)?.demo);

  let tracker;
  let quiet = false; // see selectQuiet below
  // Cockpit briefing strip (desktop): live signals, regional news, local info.
  const [{ createBriefingStrip }, { targetLatLon }] = await Promise.all([
    import('./core/ui/briefingStrip.js'),
    import('./core/scene/sketch.js'),
  ]);
  let wx = null; // cockpit weather, below
  const briefing =
    app.shell === 'desktop'
      ? createBriefingStrip({
          proxyClient,
          getSubject: () => {
            const p = targetLatLon(app.viewer, cockpitTarget);
            return p && { latitude: p.lat, longitude: p.lon };
          },
          getContacts: () => {
            const out = [];
            for (const { key, layer } of manager.active()) {
              layer.forEachVisible?.((t, _w, n) => {
                if (t === cockpitTarget || out.length > 2000 || !n?.position) return;
                out.push({
                  id: t.id,
                  layer: key,
                  latitude: n.position.latitude,
                  longitude: n.position.longitude,
                  label: n.meta?.callsign || n.meta?.name || t.id,
                  kind: key,
                });
              });
            }
            return out;
          },
          onBrief: (b) => wx?.setWeather(b?.weather ?? null),
          onPickContact: (l) => {
            const rec = manager.getLayer(l.target.layer)?.getRecord(l.target.id);
            if (rec?.entity) tracker.select(rec.entity);
          },
        })
      : null;
  if (briefing) app.mount('float', briefing.el);
  // Cockpit weather (desktop): the observed weather below, drawn over the view.
  wx = briefing
    ? (await import('./core/ui/cockpitWeather.js')).createCockpitWeather(app.viewer)
    : null;
  let cockpitTarget = null;
  const cockpit = createCockpit(app.viewer, {
    onEnter: (t) => {
      cockpitTarget = t;
      briefing?.show();
      wx?.show();
      merge?.set({ hold: true }); // riding along: every contact drawn
    },
    onExit: () => {
      cockpitTarget = null;
      briefing?.hide();
      wx?.hide();
      merge?.set({ hold: false });
      tracker?.resume();
    },
  });
  const cockpitEnabled = app.tier !== 'minimal';

  // CCTV pose gizmo: shown when a camera is the target, edits its pose live.
  let calibrating = null; // { layer, id } (CCTV) or { projection: true }
  const gizmo = createPoseGizmo({
    onChange: (pose) => {
      if (calibrating?.projection) {
        projection.setPose(pose);
        return;
      }
      const rec = calibrating?.layer.getRecord(calibrating.id);
      if (rec) {
        rec.normalized.meta.pose = pose;
        app.viewer.scene.requestRender();
      }
    },
  });
  app.mount('target', gizmo.el);

  // PROJECT (traffic cameras): the camera's published still placed in 3D
  // where it looks, as a frustum and a picture at its far end, its pose
  // editable with the gizmo. Display only: nothing reads the pixels.
  const [{ createCamProjection }, { loadStill }] = await Promise.all([
    import('./core/layers/trafficcams/projection.js'),
    import('./core/layers/trafficcams/still.js'),
  ]);
  const projection = createCamProjection(app.viewer);
  let still = null;
  let projecting = 0;
  const projectedId = () => projection.active()?.id ?? null;
  function unproject() {
    projecting += 1;
    projection.hide();
    still?.revoke();
    still = null;
    if (calibrating?.projection) {
      calibrating = null;
      gizmo.hide();
    }
  }
  async function project(rec) {
    const id = String(rec.normalized.id);
    if (projectedId() === id) {
      unproject();
      tracker.refresh();
      return;
    }
    unproject();
    const token = projecting;
    let loaded = null;
    try {
      loaded = rec.metadata.image ? await loadStill(rec.metadata.image) : null;
    } catch (err) {
      notify({ title: 'NO STILL', body: String(err.message || err), level: 'low' });
    }
    // STOP, another PROJECT, or another selection while the still loaded.
    if (token !== projecting || String(tracker.trackedEntity?.id ?? '') !== id)
      return loaded?.revoke();
    still = loaded;
    if (!projection.show(rec.normalized, still?.url ?? null)) return;
    tracker.unfollow();
    projection.flyToView();
    calibrating = { projection: true };
    gizmo.show(projection.active().pose, rec.metadata.title);
    tracker.refresh();
  }
  const projectAction = (rec) => {
    const on = projectedId() === String(rec.normalized.id);
    return {
      label: on ? 'UNPROJECT' : 'PROJECT',
      pressed: on,
      title: 'Place the published still in 3D where the camera looks',
      onClick: () => project(rec),
    };
  };

  // COMPARE: PIN on a card puts the contact in a tray of up to three.
  const [{ createCompareTray }, unitFmt] = await Promise.all([
    import('./core/ui/compareTray.js'),
    import('./core/settings/store.js'),
  ]);
  const compare = createCompareTray({
    resolve,
    onSelect: (t) => tracker.select(t),
    formatDistance: (m) => unitFmt.formatDistance(m, app.settings?.get('units')),
    formatAltitude: (m) => unitFmt.formatAltitude(m, app.settings?.get('units')),
  });
  app.mount('float', compare.el);
  const pinAction = (target, rec) =>
    rec.mover
      ? {
          label: compare.has(target) ? 'UNPIN' : 'PIN',
          pressed: compare.has(target),
          title: 'Compare side by side (up to three)',
          onClick: () => {
            compare.toggle(target);
            tracker.refresh();
          },
        }
      : null;

  tracker = createTracker(app.viewer, {
    resolve,
    panel,
    overlay,
    notify,
    groundClamp: app.shell === 'car',
    onCockpit: cockpitEnabled ? (target) => cockpit.enter(target) : undefined,
    extraActions: (target, rec) =>
      [
        ...(extras?.actions(target, rec) ?? []),
        rec.key === 'trafficcams' ? projectAction(rec) : null,
        pinAction(target, rec),
        moreActions?.(target, rec),
      ].filter(Boolean),
    onChange: (target, rec) => {
      if (!quiet) app.focusTarget?.(Boolean(target));
      merge?.set({ pinned: target ?? null }); // the target never hides in a group
      if (target && rec) extras?.onSelect(rec.key, rec.normalized);
      // On the phone the card covers the lower half: glide the target into
      // the free area above it (sideways only, never a zoom).
      if (target && app.shell === 'mobile') {
        setTimeout(() => {
          const p = target.position.getValue(app.viewer.clock.currentTime);
          nudgeIntoView(app.viewer, p, overlay.geometry().insets);
        }, 360);
      }
      // A projection belongs to its camera: another selection takes it down.
      if (projectedId() && (!target || String(target.id) !== projectedId())) unproject();
      if (calibrating?.projection) return;
      const cctv = manager.getLayer('cctv');
      const cam = target && cctv ? cctv.getRecord(target.id) : null;
      if (cam?.normalized?.meta?.pose) {
        calibrating = { layer: cctv, id: target.id };
        gizmo.show(cam.normalized.meta.pose, cam.cardModel.title);
      } else {
        calibrating = null;
        gizmo.hide();
      }
    },
  });
  // Taps: one selects (contacts before lines before areas), two zoom in about
  // the point, three zoom out; an armed tool takes every tap instead.
  createPicker(app.viewer, {
    accept: (target) => Boolean(resolve(target)),
    intercept: interceptTap,
    onZoom: camera ? (factor, pos, opts) => camera.zoomAt(pos, factor, opts) : undefined,
    onPick: (target) => {
      // A group of merged contacts: fly to fit them (they come apart on arrival).
      if (target?.argusCluster) {
        const box = target.bounds?.();
        if (box) camera?.fitBounds(box);
        return;
      }
      tracker.select(target);
    },
  });

  // C rides along with the target (movers only), as in the reference.
  document.addEventListener('keydown', (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && cockpitEnabled) {
      const t = tracker.trackedEntity;
      if (t && resolve(t)?.mover) cockpit.enter(t);
    }
  });

  if (import.meta.env.DEV && window.__argus)
    Object.assign(window.__argus, { tracker, cockpit });

  // The label of a contact, for tracking boxes, contacts and the sky HUD.
  const labelFor = (target) => {
    const t = resolve(target)?.metadata?.title;
    return t ? String(t).toUpperCase().slice(0, 18) : null;
  };
  // Select without bringing the target panel forward (the phone's radio
  // tuner lives in TOOLS: stepping the dial must not switch the sheet away).
  const selectQuiet = (target) => {
    quiet = true;
    try {
      tracker.select(target);
    } finally {
      quiet = false;
    }
  };
  return { tracker, labelFor, selectQuiet, cockpit };
}

// The card model plus what the panel shows around it: tags for the layer and
// for simulated data, and the one-line readout under the hub's name on the map
// (altitude, speed, heading where the contact has them).
function decorate(model, n, { label, demo }) {
  const tags = [{ text: label }];
  if (demo || /demo|simulated/i.test(String(n?.meta?.source ?? '')))
    tags.push({ text: 'DEMO' });
  else tags.push({ text: 'LIVE', kind: 'ok' });
  return { ...model, tags, readout: readoutFor(n) };
}

function readoutFor(n) {
  if (!n) return null;
  const parts = [];
  const alt = n.position?.altitude;
  if (n.type === 'aircraft' && Number.isFinite(alt)) {
    parts.push(
      n.meta?.onGround
        ? 'GND'
        : `FL${String(Math.round((alt * 3.28084) / 100)).padStart(3, '0')}`,
    );
  } else if (Number.isFinite(alt) && alt > 10_000) {
    parts.push(`${Math.round(alt / 1000)}KM`);
  }
  const v = n.velocity;
  if (Number.isFinite(v?.speed)) {
    const kt = n.type === 'ship' ? v.speed : v.speed * 1.94384;
    parts.push(`${Math.round(kt)}KT`);
  }
  const hdg = v?.heading ?? v?.course;
  if (Number.isFinite(hdg))
    parts.push(`${String(Math.round(hdg) % 360).padStart(3, '0')}°`);
  return parts.join(' ') || null;
}

// Service worker (production only): caches the app shell and Cesium's static
// assets for fast repeat starts on the phone, never live data (see public/sw.js).
// Browsers only allow it in a secure context (HTTPS, or localhost).
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
      console.info('[argus] service worker not registered', err?.message || err);
    });
  });
}

// Guard the pre-try setup (capability probe, shell pick) too: any unexpected
// throw there should still surface the fatal overlay, never a blank page.
main().catch((err) => {
  console.error('[argus] fatal during startup', err);
  const root = document.getElementById('app');
  if (root) {
    showFatal(
      root,
      'Argus failed to start',
      'Something went wrong initializing the app. Reload, and if it persists check the browser console.',
    );
  }
});

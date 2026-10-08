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
      shellName === 'mobile'
        ? await import('./shell-mobile/index.js')
        : await import('./shell-desktop/index.js');

    const app = await mountShell(root);
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
  const { base: proxyBase, health } = await discoverProxy({
    explicit: import.meta.env.VITE_PROXY_BASE_URL || null,
    origin: location.origin,
  });
  splash?.step(
    proxyBase ? 'LOG_STREAM_CONNECTED : PROXY' : 'LOG_STREAM_MISSING : DEMO',
    45,
  );

  const { createNotifier } = await import('./core/ui/hud/notify.js');
  const notifier = createNotifier();
  app.mount('notify', notifier.el);

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

  const manager = createLayerManager(app.viewer, {
    readout: app.readout,
    clock,
    animationFps: app.profile?.animationFps,
  });
  const camera = createCameraControls(app.viewer);
  const desktop = app.shell === 'desktop';

  // Each registration: how to load the (Cesium-heavy) definition and how to
  // build a source. The DEV-guarded mock import lets production drop the mock
  // chunk entirely; only the proxy source ships.
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
      // Only offered when the proxy knows your receiver (LOCAL_ADSB_URL).
      requires: 'local-adsb',
      loadDef: () =>
        import('./core/layers/localadsb/definition.js').then(
          (m) => m.localAdsbDefinition,
        ),
      proxy: (c) => (_q, s) => c.getJson('local-adsb', '/aircraft.json', { signal: s }),
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
      label: 'Nav & GEO sats',
      loadDef: () =>
        import('./core/layers/constellations/definition.js').then(
          (m) => m.constellationsDefinition,
        ),
      proxy: async (c) => {
        const { createConstellationSource } =
          await import('./core/layers/constellations/groups.js');
        return createConstellationSource({ proxyClient: c });
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
      // NOAA nowCOAST imagery via the proxy; the source returns a raster spec.
      proxy: async (c) => {
        const { weatherSpec } = await import('./core/layers/weather/products.js');
        return async () => weatherSpec('clouds', c.buildUrl);
      },
      // Imagery needs the real service; there is no offline stand-in.
      mock: () => Promise.resolve(null),
    },
    {
      key: 'radar',
      group: 'Earth & weather',
      label: 'Radar (US)',
      loadDef: () =>
        import('./core/layers/weather/definition.js').then((m) => m.radarDefinition),
      // NOAA nowCOAST imagery via the proxy; the source returns a raster spec.
      proxy: async (c) => {
        const { weatherSpec } = await import('./core/layers/weather/products.js');
        return async () => weatherSpec('radar', c.buildUrl);
      },
      // Imagery needs the real service; there is no offline stand-in.
      mock: () => Promise.resolve(null),
    },
    {
      key: 'lightning',
      group: 'Earth & weather',
      label: 'Lightning',
      loadDef: () =>
        import('./core/layers/weather/definition.js').then((m) => m.lightningDefinition),
      // NOAA nowCOAST imagery via the proxy; the source returns a raster spec.
      proxy: async (c) => {
        const { weatherSpec } = await import('./core/layers/weather/products.js');
        return async () => weatherSpec('lightning', c.buildUrl);
      },
      // Imagery needs the real service; there is no offline stand-in.
      mock: () => Promise.resolve(null),
    },
    {
      key: 'surveillance',
      group: 'Infrastructure',
      label: 'Surveillance',
      loadDef: () =>
        import('./core/layers/surveillance/definition.js').then(
          (m) => m.surveillanceDefinition,
        ),
      proxy: async (c) => {
        const { createOverpassSource } = await import('./core/layers/overpass/client.js');
        return createOverpassSource({
          proxyClient: c,
          filters: ['node["man_made"="surveillance"]', 'way["man_made"="surveillance"]'],
        });
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
      proxy: async (c) => {
        const { createOverpassSource } = await import('./core/layers/overpass/client.js');
        return createOverpassSource({
          proxyClient: c,
          filters: ['node["tourism"]', 'node["historic"]'],
        });
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
      // Public DOT cameras (Caltrans, TfL, Statens vegvesen) in view; stills on demand.
      proxy: async (c) => {
        const { createTrafficCamSource } =
          await import('./core/layers/trafficcams/sources.js');
        return createTrafficCamSource({ proxyClient: c });
      },
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/trafficcams/mockSource.js').then((m) =>
              m.createTrafficCamMockSource({ viewer: app.viewer }),
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
      loadDef: () =>
        import('./core/layers/shodan/definition.js').then((m) => m.shodanDefinition),
      // Snapshot via the credit-free count endpoint (awareness-only, no search-on-pan).
      proxy: (c) => () =>
        c.getJson('shodan', '/shodan/host/count', {
          params: { query: 'product:Apache httpd', facets: 'country:200' },
        }),
      mock: () =>
        import.meta.env.DEV
          ? import('./core/layers/shodan/mockSource.js').then((m) =>
              m.createShodanMockSource(),
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
  ];

  // Layers with no verified real feed. They are always synthetic, so they are
  // labelled "demo" in the UI and fall back to the mock even when a proxy is set
  // (rather than becoming a dead toggle), never masquerading as real.
  const noRealFeed = new Set(['cctv', 'threats']);

  for (const r of registrations) {
    // The sourceless layers can only be driven by the dev mock; outside dev they
    // have nothing to show, so do not register them (no dead chips in production).
    if (noRealFeed.has(r.key) && !dev) continue;
    // Layers that exist only with local equipment (your own receiver) are listed
    // only when the proxy has it configured, so no one sees a dead chip.
    // (In a dev session with no proxy, the labelled mock stands in instead.)
    if (r.requires && proxyClient && !(health && feedConfigured(health, r.requires)))
      continue;
    manager.register(r.key, {
      label: r.label,
      group: r.group,
      loadDef: r.loadDef,
      // With a proxy, use the real feed; if this layer has none (proxy source is
      // null), fall back to the labelled mock instead of failing to enable.
      makeSource: async () => {
        if (proxyClient) return (await r.proxy(proxyClient)) ?? r.mock();
        return r.mock();
      },
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
    onClose: () => tracker?.deselect(),
    onPickContact: (c) => tracker?.select(c.target),
  });
  app.mount('target', panel.el);

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
  const tracking = await attachTracking(app, manager, {
    extraResolvers: [osintPlotter],
    panel,
    overlay,
    notify,
  });
  tracker = tracking.tracker;
  labelFor = tracking.labelFor;

  // Global search / fly-to (P15) + OSINT query console (P16): query active layers
  // (contacts) and place names (geocoder); a query that parses as a network asset
  // (IP/ASN/domain) is passively looked up, geolocated, enriched, and plotted.
  const geocode = proxyClient
    ? createGeocoder(proxyClient)
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
  });
  const launcher = createLauncher({
    onQuery: (q) => searchCtl.search(q),
    onSelect: (r) => searchCtl.select(r),
  });
  app.mount('overlay', launcher.el);

  // ------------------------------------------------------------------ bar
  let activePreset = null;
  let cells = null;
  const setPreset = (id) => {
    activePreset = id;
    cells?.setActive(id);
    layerMenu?.setActivePreset(id);
  };
  const runPreset = (preset) => {
    setPreset(preset.id);
    applyPreset(manager, preset);
    if (preset.geolocate) app.aroundMe?.(camera);
  };
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
  if (desktop) app.mount('barEnd', readouts.createStatusSegment());

  // ------------------------------------------------------------- layer menu
  const layerMenu = createLayerMenu({
    manager,
    presets: desktop ? [] : PRESETS,
    onPreset: runPreset,
    onManualToggle: () => setPreset(null),
  });
  app.mount('layers', layerMenu.el);
  setPreset(activePreset);

  // Feed failures surface once as a notification (the menu row turns ERR too).
  manager.subscribeStatus((key, s) => {
    if (s?.state !== 'error') return;
    const label = manager.list().find((l) => l.key === key)?.label ?? key;
    notifier.push({
      title: `${label} FEED ERROR`,
      body: s.message || `The ${label.toLowerCase()} feed did not answer.`,
      key: `err:${key}`,
    });
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

  // Capable, unmetered devices start on the dark canvas (the ctOS look, and
  // light on tiles); metered or minimal devices keep the offline relief.
  const imagery = createImageryController(app.viewer, { mono: true });
  if (capable) imagery.set('dark');
  const labels = createLabelsController(app.viewer, { imagery });

  const terrain = createTerrainController(app.viewer, {
    proxyBase: proxyBase || null,
    tilesetCache: app.profile?.tilesetCache ?? null,
    onStatus: (s) => {
      if (!s.ok && s.message) {
        console.warn(`[argus] terrain: ${s.message}`);
        notifier.push({
          title: 'TERRAIN',
          body: s.message,
          key: 'terrain',
          level: 'low',
        });
      }
    },
  });
  const defTerrain = defaultTerrainId({ tier: app.tier, metered });
  if (defTerrain !== 'flat') terrain.set(defTerrain);
  const terrainChoice = createChoice({
    label: 'Terrain',
    options: TERRAIN_SOURCES,
    current: defTerrain,
    onSelect: (id) => terrain.set(id),
  });

  const view = [];
  view.push(
    section(
      'BASEMAP',
      createChoice({
        label: 'Base imagery',
        options: IMAGERY_SOURCES,
        current: imagery.current(),
        onSelect: (id) => imagery.set(id),
      }).el,
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
      createSwitch({
        label: 'City names',
        on: true,
        title: 'Bundled city names (works offline)',
        onToggle: (on) => overlay.setOptions({ cities: on }),
      }).el,
      createSwitch({
        label: 'Places + borders',
        title: 'Country, region and place names from map tiles',
        onToggle: (on) => labels.set('places', on),
      }).el,
      createSwitch({
        label: 'Street names',
        title: 'Roads and street names from map tiles',
        onToggle: (on) => labels.set('roads', on),
      }).el,
    ),
  );
  view.push(
    section(
      'TRACKING',
      createChoice({
        label: 'Tracking boxes',
        options: [
          { id: 'off', label: 'Off' },
          { id: 'low', label: 'Low' },
          { id: 'med', label: 'Med' },
          { id: 'high', label: 'High' },
        ],
        current: app.tier === 'minimal' ? 'low' : 'med',
        onSelect: (density) => overlay.setOptions({ density }),
      }).el,
      createSwitch({
        label: 'Viewport frame',
        on: true,
        title: 'Corner brackets and readouts around the view',
        onToggle: (on) => overlay.setOptions({ frame: on }),
      }).el,
    ),
  );
  if (app.tier === 'minimal') overlay.setOptions({ density: 'low' });
  view.push(section('TERRAIN', terrainChoice.el));

  // Sensor shaders (NVG/FLIR/CRT...): desktop-favored, mobile-gated. Not on the
  // weakest tier at all; balanced renders reduced-resolution single-pass; full
  // gets full resolution plus the stackable CRT overlay.
  let shaders = null;
  let sensorChoice = null;
  let crtSwitch = null;
  if (app.tier !== 'minimal') {
    const { createSensorShaders } = await import('./core/shaders/sensorShaders.js');
    shaders = createSensorShaders(app.viewer, { tier: app.tier });
    const modes = shaders.modes ?? [
      { id: 'none', label: 'Normal' },
      { id: 'nvg', label: 'NVG' },
      { id: 'flir', label: 'FLIR' },
    ];
    sensorChoice = createChoice({
      label: 'Sensor mode',
      options: modes.map((m) => ({ id: m.id, label: m.label })),
      current: shaders.sensor ?? 'none',
      onSelect: (id) => {
        shaders.setSensor(id);
        return shaders.sensor;
      },
    });
    const items = [sensorChoice.el];
    if (shaders.crtSupported) {
      crtSwitch = createSwitch({
        label: 'CRT overlay',
        on: Boolean(shaders.crt),
        onToggle: (on) => shaders.setCrt(on),
      });
      items.push(crtSwitch.el);
    }
    view.push(section('SENSOR', ...items));
    if (dev && window.__argus) window.__argus.shaders = shaders;
  }
  const syncSensorUi = () => {
    sensorChoice?.paint(shaders?.sensor ?? 'none');
    crtSwitch?.set(Boolean(shaders?.crt));
  };
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

  const intel = [];
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

  // Time scrubber (Phase 17): rewind the scene through the ring-buffer history.
  const { createTimeScrubber } = await import('./core/ui/timeScrubber.js');
  const scrubber = createTimeScrubber({ clock });

  if (desktop) {
    for (const seg of readouts.createCameraReadout(app.viewer)) app.mount('strip', seg);
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
  for (const el of intel) app.mount('intel', el);

  // ------------------------------------------------------------ view stack
  const { createZoomControls } = await import('./core/ui/zoomControls.js');
  app.mount(
    'stack',
    createZoomControls({
      camera,
      onLocate: app.locate ? (report) => app.locate(camera, report) : undefined,
      onNotify: notify,
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
          app.viewer.resolutionScale = Math.max(0.6, app.profile.resolutionScale * 0.7);
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

  // Default state (master plan 8): flights + earthquakes + transit on. The
  // mobile shell launches into the "Around Me" preset itself (geolocation, and
  // its layer set, so the highlighted preset matches what is on); desktop starts
  // at the world view with the defaults.
  splash?.step('GREETER_UI_INITIALIZING', 85);
  const aroundMe = !desktop && app.aroundMe && PRESETS.find((p) => p.id === 'around-me');
  if (aroundMe) {
    runPreset(aroundMe);
  } else {
    for (const key of DEFAULT_LAYERS) await manager.enable(key);
  }

  if (dev && window.__argus)
    Object.assign(window.__argus, {
      manager,
      camera,
      overlay,
      panel,
      launcher,
      notifier,
      imagery,
      labels,
    });
}

// The interaction spine: tap/click a contact to make it the target (overlay
// lock, trail, target panel; the camera stays put unless asked to FOLLOW).
// Layer-agnostic: it resolves a picked target by asking each active layer.
async function attachTracking(
  app,
  manager,
  { extraResolvers = [], panel, overlay, notify },
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
        return {
          key,
          metadata: decorate(rec.cardModel, rec.normalized, { label, demo }),
          getHistoryFixes: rec.getHistoryFixes,
          mover: rec.mover,
        };
      }
    }
    return null;
  };
  const isDemo = (key) => Boolean(manager.list().find((l) => l.key === key)?.demo);

  let tracker;
  const cockpit = createCockpit(app.viewer, {
    onExit: () => tracker?.resume(),
  });
  const cockpitEnabled = app.tier !== 'minimal';

  // CCTV pose gizmo: shown when a camera is the target, edits its pose live.
  let calibrating = null; // { layer, id }
  const gizmo = createPoseGizmo({
    onChange: (pose) => {
      const rec = calibrating?.layer.getRecord(calibrating.id);
      if (rec) {
        rec.normalized.meta.pose = pose;
        app.viewer.scene.requestRender();
      }
    },
  });
  app.mount('target', gizmo.el);

  tracker = createTracker(app.viewer, {
    resolve,
    panel,
    overlay,
    notify,
    onCockpit: cockpitEnabled ? (target) => cockpit.enter(target) : undefined,
    onChange: (target) => {
      app.focusTarget?.(Boolean(target));
      // On the phone the card covers the lower half: glide the target into
      // the free area above it (sideways only, never a zoom).
      if (target && app.shell === 'mobile') {
        setTimeout(() => {
          const p = target.position.getValue(app.viewer.clock.currentTime);
          nudgeIntoView(app.viewer, p, overlay.geometry().insets);
        }, 360);
      }
      const cctv = manager.getLayer('cctv');
      const rec = target && cctv ? cctv.getRecord(target.id) : null;
      if (rec?.normalized?.meta?.pose) {
        calibrating = { layer: cctv, id: target.id };
        gizmo.show(rec.normalized.meta.pose, rec.cardModel.title);
      } else {
        calibrating = null;
        gizmo.hide();
      }
    },
  });
  createPicker(app.viewer, { onPick: (target) => tracker.select(target) });

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
  return { tracker, labelFor };
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

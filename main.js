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
  el.innerHTML = `<h1>${title}</h1><p>${message}</p>`;
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

    await setupScene(app);
  } catch (err) {
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
async function setupScene(app) {
  const dev = import.meta.env.DEV;
  const { discoverProxy, feedConfigured } = await import('./core/net/discoverProxy.js');
  const { base: proxyBase, health } = await discoverProxy({
    explicit: import.meta.env.VITE_PROXY_BASE_URL || null,
    origin: location.origin,
  });
  // A production build with no proxy has no data source (mocks are dev-only), so
  // no layers can load. Say so plainly instead of leaving a bare globe with no UI.
  if (!proxyBase && !dev) {
    const notice = document.createElement('div');
    notice.className = 'argus-demo-banner';
    notice.textContent =
      'No proxy reachable. Run "npm start" (it serves this app and its proxy together) or set VITE_PROXY_BASE_URL.';
    app.mountControls?.({ notice });
    return;
  }

  const [
    { createLayerManager },
    { createCameraControls },
    { PRESETS, DEFAULT_LAYERS, applyPreset },
    { createPresetBar },
    { createLayerToggles },
    { createGeocoder },
    { createSearch },
    { createSearchBox },
    { createLookup },
    { createCorrelator },
    { createOsintPlotter },
    { createSceneClock },
  ] = await Promise.all([
    import('./core/scene/layerManager.js'),
    import('./core/scene/cameraControls.js'),
    import('./core/presets.js'),
    import('./core/ui/presetBar.js'),
    import('./core/ui/layerToggles.js'),
    import('./core/search/geocoder.js'),
    import('./core/search/search.js'),
    import('./core/ui/searchBox.js'),
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

  const manager = createLayerManager(app.viewer, { readout: app.readout, clock });
  const camera = createCameraControls(app.viewer);

  // On-screen zoom stepper: a dependable zoom on trackpads and touch, where
  // wheel/pinch gestures are unreliable. Floats over the globe via the shell.
  const { createZoomControls } = await import('./core/ui/zoomControls.js');
  app.mountOverlay?.(createZoomControls({ camera }).el);

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

  // OSINT query-console outputs are plotted here (query outputs, not a toggleable
  // feed layer), and resolved by the interaction spine as an extra resolver.
  const osintPlotter = createOsintPlotter(app.viewer);

  const { tracker, labelFor } = await attachTracking(app, manager, {
    extraResolvers: [osintPlotter],
  });

  // Global search / fly-to (P15) + OSINT query console (P16): query active layers
  // (entities) and place names (geocoder); a query that parses as a network asset
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
  const searchBox = createSearchBox({
    onQuery: (q) => searchCtl.search(q),
    onSelect: (r) => searchCtl.select(r),
  });

  const presetBar = createPresetBar({
    presets: PRESETS,
    onSelect: (preset) => {
      applyPreset(manager, preset);
      if (preset.geolocate) app.aroundMe?.(camera);
    },
  });
  const layerToggles = createLayerToggles({
    manager,
    onManualToggle: () => presetBar.setActive(null),
  });

  // Sensor shaders (NVG/FLIR/CRT): desktop-favored, mobile-gated. Not on the
  // weakest tier at all; balanced renders reduced-resolution single-pass; full
  // gets full resolution plus the stackable CRT overlay.
  let sensorControls = null;
  let shaders = null;
  let sensorUi = null;
  if (app.tier !== 'minimal') {
    const [{ createSensorShaders }, { createSensorControls }] = await Promise.all([
      import('./core/shaders/sensorShaders.js'),
      import('./core/ui/sensorControls.js'),
    ]);
    shaders = createSensorShaders(app.viewer, { tier: app.tier });
    sensorUi = createSensorControls({ shaders });
    sensorControls = sensorUi.el;
    if (dev && window.__argus) window.__argus.shaders = shaders;
  }

  // Certificate Transparency firehose ticker (P16 CT/BGP stage): a live issuance
  // list, off by default. Toggling it connects the /ws/ct feed (dev: a synthetic
  // stream), so the upstream socket is only held while the user is watching. The
  // public CertStream upstream is often silent, so live data may not flow without
  // a working aggregator configured (CT_STREAM_URL on the proxy).
  let ctTickerEl = null;
  const makeCtSource = proxyClient
    ? () =>
        import('./core/osint/ct/ctSource.js').then((m) =>
          m.createCtSource({ wsUrl: wsCtUrl }),
        )
    : dev
      ? () =>
          import('./core/osint/ct/mockCtSource.js').then((m) => m.createCtMockSource())
      : null;
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
    ctTickerEl = ctTicker.el;
  }

  // In-app terminal (P16 final): a command palette that drives the app and runs
  // the passive lookups already built. It commands the app and reads public
  // indexes only, never sending traffic at a host (query/correlate reuse the same
  // passive search path). Off by default.
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
      applyPreset(manager, p);
      if (p.geolocate) app.aroundMe?.(camera);
      return true;
    },
  });
  const terminal = createTerminal({ run: (line) => termCommands.run(line) });

  // Time scrubber (Phase 17): rewind the scene through the ring-buffer history.
  const { createTimeScrubber } = await import('./core/ui/timeScrubber.js');
  const scrubber = createTimeScrubber({ clock });

  // Base-imagery + terrain switchers. Imagery: the offline Relief baseline, or
  // higher-resolution Satellite / Streets so zooming in shows the roads a
  // surveillance camera sits on. Terrain: flat, real 3D relief (keyless), or
  // opt-in photoreal. On capable, non-metered devices both default to the richer
  // option so the globe is street-usable out of the box; metered / minimal keep
  // the cellular-friendly baseline.
  const [
    { createImageryController, IMAGERY_SOURCES },
    { createTerrainController, TERRAIN_SOURCES, defaultTerrainId },
    { createImagerySwitcher, createTerrainSwitcher },
    { createLocateButton },
  ] = await Promise.all([
    import('./core/scene/imagery.js'),
    import('./core/scene/terrain.js'),
    import('./core/ui/imagerySwitcher.js'),
    import('./core/ui/locateButton.js'),
  ]);

  const metered = Boolean(app.capabilities?.network?.metered);
  const capable = app.tier !== 'minimal' && !metered;

  const imagery = createImageryController(app.viewer);
  if (capable) imagery.set('satellite');
  const imagerySwitcher = createImagerySwitcher({
    sources: IMAGERY_SOURCES,
    current: imagery.current(),
    onSelect: (id) => imagery.set(id),
  });

  const terrain = createTerrainController(app.viewer, {
    proxyBase: proxyBase || null,
    tilesetCache: app.profile?.tilesetCache ?? null,
    onStatus: (s) => {
      if (!s.ok && s.message) console.warn(`[argus] terrain: ${s.message}`);
    },
  });
  const defTerrain = defaultTerrainId({ tier: app.tier, metered });
  if (defTerrain !== 'flat') terrain.set(defTerrain);
  const terrainSwitcher = createTerrainSwitcher({
    sources: TERRAIN_SOURCES,
    current: defTerrain,
    onSelect: (id) => terrain.set(id),
  });

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
          sensorUi?.sync();
        },
        up: () => {
          if (!savedSensor) return;
          shaders.setSensor(savedSensor.sensor);
          shaders.setCrt(savedSensor.crt);
          savedSensor = null;
          sensorUi?.sync();
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
          if (savedTerrain !== 'flat') terrainSwitcher.setActive('flat');
        },
        up: () => {
          if (savedTerrain && savedTerrain !== 'flat')
            terrainSwitcher.setActive(savedTerrain);
          savedTerrain = null;
        },
      },
    );
    attachThermalLadder(app.viewer, {
      rungs,
      onChange: (level, label) => {
        app.readout.setThermal?.(label, level);
        console.info(`[argus] thermal ladder: ${label}`);
      },
    });
  }

  // "Center on my location": flies the camera to the device position. The shell
  // owns the sensor read (both shells provide `locate`); this is just the button.
  const locateButton = app.locate
    ? createLocateButton({ onLocate: (report) => app.locate(camera, report) })
    : null;

  // No proxy at all means every layer is simulated. Say so up front so mock data
  // is never mistaken for live feeds.
  let demoBanner = null;
  if (!proxyClient) {
    demoBanner = document.createElement('div');
    demoBanner.className = 'argus-demo-banner';
    demoBanner.textContent =
      'DEMO DATA: no proxy reachable, every layer is simulated. Run "npm run proxy" alongside the dev server for live feeds.';
  }

  app.mountControls?.({
    demoBanner,
    search: searchBox.el,
    locate: locateButton?.el,
    imagery: imagerySwitcher.el,
    terrain: terrainSwitcher.el,
    presetBar: presetBar.el,
    layerToggles: layerToggles.el,
    sensorControls,
    ct: ctTickerEl,
    terminal: terminal.el,
    scrubber: scrubber.el,
  });

  // Point-at-sky mode (mobile only). The shell owns the sensor + reticle; main
  // supplies how to identify the aimed entity and how to lock onto it.
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
  // its layer set, so the highlighted chip matches what is on); desktop stays at
  // the world view with the defaults.
  const aroundMe = app.aroundMe && PRESETS.find((p) => p.id === 'around-me');
  if (aroundMe) {
    await applyPreset(manager, aroundMe);
    presetBar.setActive('around-me');
    app.aroundMe(camera);
  } else {
    for (const key of DEFAULT_LAYERS) await manager.enable(key);
  }

  if (dev && window.__argus) Object.assign(window.__argus, { manager, camera });
}

// The interaction spine: tap/click an entity to track it (camera follows, trail,
// highlight, metadata card). Layer-agnostic: it resolves a picked entity by
// asking each active layer (via getLayers, so toggling layers is reflected).
async function attachTracking(app, manager, { extraResolvers = [] } = {}) {
  const [
    { createPicker },
    { createTracker },
    { createMetadataCard },
    { createCockpit },
    { createPoseGizmo },
  ] = await Promise.all([
    import('./core/interaction/picker.js'),
    import('./core/interaction/tracker.js'),
    import('./core/ui/metadataCard.js'),
    import('./core/interaction/cockpit.js'),
    import('./core/layers/cctv/gizmo.js'),
  ]);

  const resolve = (entity) => {
    // Active feed layers first, then extra resolvers (e.g. the OSINT plotter,
    // whose markers are query outputs rather than a toggleable layer).
    const sources = [...manager.activeLayers(), ...extraResolvers];
    for (const layer of sources) {
      const rec = layer.getRecord(entity.id);
      // Ids are only unique within a layer (flights, military and your own
      // receiver all key aircraft by ICAO hex), so the record must be for this
      // very entity, not a namesake in another layer.
      if (rec && rec.cardModel && (!rec.entity || rec.entity === entity)) {
        return {
          metadata: rec.cardModel,
          getHistoryFixes: rec.getHistoryFixes,
          mover: rec.mover,
        };
      }
    }
    return null;
  };

  let tracker;
  const cockpit = createCockpit(app.viewer, {
    onExit: () => {
      if (tracker?.trackedEntity) app.viewer.trackedEntity = tracker.trackedEntity;
    },
  });
  const cockpitEnabled = app.tier !== 'minimal';

  // CCTV pose gizmo: shown when a camera is tracked, edits its pose live.
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

  const card = createMetadataCard({ onClose: () => tracker?.deselect() });
  app.mountUi?.(card.el);
  app.mountUi?.(gizmo.el);

  tracker = createTracker(app.viewer, {
    resolve,
    card,
    onCockpit: cockpitEnabled ? (entity) => cockpit.enter(entity) : undefined,
    onChange: (entity) => {
      const cctv = manager.getLayer('cctv');
      const rec = entity && cctv ? cctv.getRecord(entity.id) : null;
      if (rec?.normalized?.meta?.pose) {
        calibrating = { layer: cctv, id: entity.id };
        gizmo.show(rec.normalized.meta.pose, rec.cardModel.title);
      } else {
        calibrating = null;
        gizmo.hide();
      }
    },
  });
  createPicker(app.viewer, { onPick: (entity) => tracker.select(entity) });

  if (import.meta.env.DEV && window.__argus)
    Object.assign(window.__argus, { tracker, cockpit });

  // The label of a picked entity, for the point-at-sky HUD.
  const labelFor = (entity) => resolve(entity)?.metadata?.title ?? null;
  return { tracker, labelFor };
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

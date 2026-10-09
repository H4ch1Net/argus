// Target-card extras brought by the street photos, Shodan and OSINT modules
// (core/interaction/targetExtras.js plugins), assembled here so main.js wires
// them in one place. Each works through the proxy's pinned feeds when the
// proxy has the key, falls back to the labelled dev stand-ins in a dev session
// with no proxy, and is simply absent otherwise.
//
//   STREET PHOTO   any ground target: the nearest Mapillary photo
//   InternetDB     any record naming an IP (the Shodan host sample)
//   LOOK UP AS     BGP events: the origin AS through the OSINT correlator
//   Facets         Shodan country squares: top ports, operators, products

/**
 * @param {{ proxyClient: object|null, keyed: (feed: string) => boolean, dev: boolean,
 *   manager: object, settings: object|null, plot: (r: object) => object,
 *   select: (t: object) => void, getCorrelate: () => Function|null,
 *   time?: () => object }} deps
 */
export async function createCardPlugins({
  proxyClient,
  keyed,
  dev,
  manager,
  settings,
  plot,
  select,
  getCorrelate,
  time,
}) {
  const demo = dev && !proxyClient;
  const [photos, photoSource, osint, internetDb, shodan, shodanSource, shodanFormat] =
    await Promise.all([
      import('../layers/streetphotos/extras.js'),
      import('../layers/streetphotos/source.js'),
      import('../osint/cardExtras.js'),
      import('../osint/internetdb.js'),
      import('../layers/shodan/extras.js'),
      import('../layers/shodan/source.js'),
      import('../layers/shodan/format.js'),
    ]);

  let tiles = null;
  if (proxyClient && keyed('mapillary')) {
    tiles = photoSource.createStreetPhotoTiles({ proxyClient });
  } else if (demo) {
    tiles = (
      await import('../layers/streetphotos/mockSource.js')
    ).createStreetPhotoMockTiles();
  }

  let fetchFacets = null;
  if (proxyClient && keyed('shodan')) {
    fetchFacets = (id, cc) => shodanSource.fetchCountryFacets(proxyClient, id, cc);
  } else if (demo) {
    const mock = await import('../layers/shodan/mockSource.js');
    fetchFacets = async (_id, cc) => ({
      rows: shodanFormat.shodanFacetRows(mock.mockCountryFacets(cc)),
    });
  }

  return [
    photos.createStreetPhotoExtras({ tiles, manager, plot, select, time }),
    osint.createInternetDbExtras({
      lookup: proxyClient ? internetDb.createInternetDbLookup(proxyClient) : null,
    }),
    osint.createAsLookupExtras({ getCorrelate, plot, select }),
    shodan.createShodanExtras({
      fetchFacets,
      getSnapshot: () => settings?.get('shodanSnapshot') ?? 'web',
    }),
  ];
}

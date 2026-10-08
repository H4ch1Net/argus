// Recent imagery as a Layer SDK definition with renderType 'raster': the source
// returns an 'xyz' spec for the selected product-day (catalog.js
// imageryRasterSpec), clipped to the selected box, and the engine keeps one
// imagery layer above the basemap. No entities, nothing to pick.
//
// The source is the catalogue controller's rasterSource (catalog.js
// createImageryCatalogue): it carries subscribe(), so the engine reloads the
// moment the UI selects another day or box, and it returns an 'empty' spec
// (overlay cleared) while nothing is selected.

/** @type {import('../sdk/createLayer.js').LayerDefinition} */
export const recentImageryDefinition = {
  id: 'recent-imagery',
  // Past days never change; selections arrive through subscribe, not the poll.
  fetch: { mode: 'poll', intervalMs: 60 * 60 * 1000 },
  render: { renderType: 'raster', alpha: 1 },
};

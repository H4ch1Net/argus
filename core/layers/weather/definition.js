import { WEATHER_PRODUCTS } from './products.js';

// Weather overlays as Layer SDK definitions with renderType 'raster': the source
// returns a WMS spec (products.js) and the engine keeps one imagery layer above
// the basemap, refreshed on the product's interval. No entities, nothing to pick.
// A source from timedSource.js also follows the weather timeline (timeline.js):
// the engine reloads the overlay whenever the timeline moves this product to
// another frame.

const rasterDefinition = (id) => ({
  id: `weather-${id}`,
  fetch: { mode: 'poll', intervalMs: WEATHER_PRODUCTS[id].refreshMs },
  render: { renderType: 'raster', alpha: WEATHER_PRODUCTS[id].alpha },
});

export const cloudsDefinition = rasterDefinition('clouds');
export const goesDefinition = rasterDefinition('goes');
export const radarDefinition = rasterDefinition('radar');
export const lightningDefinition = rasterDefinition('lightning');

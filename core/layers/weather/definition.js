import { WEATHER_PRODUCTS } from './products.js';

// Weather overlays as Layer SDK definitions with renderType 'raster': the source
// returns a WMS spec (products.js) and the engine keeps one imagery layer above
// the basemap, refreshed on the product's interval. No entities, nothing to pick.

const rasterDefinition = (id) => ({
  id: `weather-${id}`,
  fetch: { mode: 'poll', intervalMs: WEATHER_PRODUCTS[id].refreshMs },
  render: { renderType: 'raster', alpha: WEATHER_PRODUCTS[id].alpha },
});

export const cloudsDefinition = rasterDefinition('clouds');
export const radarDefinition = rasterDefinition('radar');

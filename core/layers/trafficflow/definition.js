import { TRAFFIC_FLOW_REFRESH_MS } from './spec.js';

// Traffic flow as a Layer SDK definition with renderType 'raster': the source
// returns an 'xyz' spec (spec.js trafficFlowSpec) for TomTom's flow tiles through
// the proxy, and the engine keeps one imagery layer above the basemap, reloaded
// once per refresh interval. No entities, nothing to pick. Needs TOMTOM_API_KEY
// on the proxy; register it with `requires: 'tomtom-flow'` so the chip only
// appears when the key is set.

/** @type {import('../sdk/createLayer.js').LayerDefinition} */
export const trafficFlowDefinition = {
  id: 'traffic-flow',
  fetch: { mode: 'poll', intervalMs: TRAFFIC_FLOW_REFRESH_MS },
  render: { renderType: 'raster', alpha: 0.85 },
};

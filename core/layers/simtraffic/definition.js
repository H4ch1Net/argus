import { createSimTrafficRenderer } from './renderer.js';
import { simTrafficNote } from './format.js';

// Simulated traffic as a Layer SDK 'field' layer (core/layers/sdk/fieldLayer.js):
// the source returns the traffic model (source.js), one object that keeps
// loading roads and congestion in the background, and the renderer animates a
// SIMULATED fleet on it below 8 km. Moves are tracked by the renderer itself
// (once a second, so a car view that never settles still loads its roads);
// the 30 s interval re-runs the source so TomTom flow refreshes on a still
// view. Nothing here is a real vehicle: the layer label and every note say so.

/** @param {{ tier?: string }} [opts] */
export function createSimTrafficDefinition({ tier = 'balanced' } = {}) {
  return {
    id: 'simtraffic',
    fetch: { mode: 'viewport', intervalMs: 30_000 },
    // Camera stops need no poll: the renderer re-points the model itself.
    covers: (field) => Boolean(field),
    normalize: (model) => model,
    statusNote: (_q, model) => simTrafficNote(model, model?.vehicles ?? 0),
    render: {
      renderType: 'field',
      create: (viewer, ctx) => createSimTrafficRenderer(viewer, ctx, { tier }),
    },
  };
}

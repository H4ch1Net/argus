import { createWindRenderer } from './renderer.js';
import { fieldCovers, padBbox, parseWind, sampleWind, windGrid } from './field.js';

// Wind as a Layer SDK 'field' layer: the source fetches the 10 m wind at a grid
// over the view (core/layers/wind/source.js), normalize turns it into a u/v
// field, and the renderer animates streaks over it. Refreshed every 15 min and
// when the view leaves the fetched field (or zooms well inside it).

export const windDefinition = {
  id: 'wind',
  fetch: { mode: 'viewport', intervalMs: 15 * 60_000 },
  fieldKey: (query) => {
    const g = query.bbox ? windGrid(padBbox(query.bbox)) : null;
    return g ? `${g.west},${g.east},${g.south},${g.north}` : 'none';
  },
  // A pan inside the fetched field costs no request (Open-Meteo counts every
  // grid point against its daily allowance).
  covers: (field, query) => fieldCovers(field, query.bbox),
  normalize: (raw) => {
    const field = raw?.grid ? parseWind(raw.payload, raw.grid) : null;
    return field && { ...field, count: field.nx * field.ny };
  },
  sample: sampleWind,
  statusNote: (_q, field) => (field?.time ? `obs ${field.time.slice(11, 16)}Z` : ''),
  render: {
    renderType: 'field',
    create: (viewer, ctx) => createWindRenderer(viewer, { fps: ctx?.animationFps ?? 30 }),
  },
};

import { layerInk } from '../sdk/colors.js';
import { describePlace } from '../../places/saved.js';

// My places: the user's saved places and landmarks (core/places/saved.js) as a
// map layer, read from this device's storage. Fetched once and again whenever
// the list changes (layer.refresh()); no network at all.

export const myPlacesDefinition = {
  id: 'myplaces',
  fetch: { mode: 'once' },
  interpolate: false,
  maxEntities: 500,
  normalize: (list) => list ?? [],
  render: {
    renderType: 'point',
    style: (n) => ({
      glyph: n.meta.kind === 'camera' ? 'bracket' : 'diamond',
      pixelSize: 13,
      color: layerInk('myplaces'),
    }),
  },
  describe: (n) => describePlace(n),
  searchText: (n) => `${n.meta.name} ${n.meta.note} saved place`,
};

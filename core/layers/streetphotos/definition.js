import { streetPhotoToNormalized } from './parse.js';
import { describeStreetPhoto, streetPhotoSearchText } from './format.js';
import { layerInk } from '../sdk/colors.js';

// Street photos (Mapillary) as a Layer SDK definition: a camera-pin glyph per
// image, its tick turned to the compass angle the photo was taken at, loaded
// only for a zoomed-in view (the source returns nothing wider than about 4 km,
// and the status says "zoom in"). The card shows the photo itself.

export const streetPhotosDefinition = {
  id: 'streetphotos',
  fetch: { mode: 'viewport' },
  interpolate: false,
  maxEntities: 600,
  normalize: (raw) => (raw?.images ?? []).map(streetPhotoToNormalized),
  statusNote: (_q, raw) => (raw?.tooWide ? 'zoom in to load' : ''),
  render: {
    renderType: 'point',
    // Small pins that read as a trail of captures; heading-up on the compass.
    style: (n) => ({
      glyph: 'photo',
      pixelSize: n.meta.pano ? 15 : 13,
      headingDeg: Number.isFinite(n.meta.compass) ? n.meta.compass : undefined,
      color: layerInk('streetphotos', 0.95),
    }),
  },
  describe: (n) => describeStreetPhoto(n),
  searchText: streetPhotoSearchText,
};

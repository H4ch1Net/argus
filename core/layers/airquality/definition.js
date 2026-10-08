import { createCanvasImagery, pixelsToCanvas } from '../aurora/canvasImagery.js';
import { windGrid, padBbox } from '../wind/field.js';
import {
  AQ_CREDIT,
  aqFieldCovers,
  airQualityPixels,
  parseAirQuality,
  sampleAirQuality,
} from './field.js';

// Air quality as a Layer SDK 'field' layer: the current US / European AQI and
// pollutants at a coarse grid over the view (Open-Meteo, CAMS data), drawn as
// one soft translucent texture coloured by AQI category (the EPA legend
// colours). sample(lon, lat) feeds a readout at the view centre
// (formatAirQuality in field.js). Refreshed every 30 minutes (the data is
// hourly) and when the view leaves the fetched grid; a pan inside it costs no
// request.

const WIDTH = 128;
const HEIGHT = 96;

export const airQualityDefinition = {
  id: 'airquality',
  fetch: { mode: 'viewport', intervalMs: 30 * 60_000 },
  fieldKey: (query) => {
    const g = query.bbox ? windGrid(padBbox(query.bbox)) : null;
    return g ? `aq ${g.west},${g.east},${g.south},${g.north}` : 'none';
  },
  covers: (field, query) => aqFieldCovers(field, query.bbox),
  normalize: (raw) => (raw?.grid ? parseAirQuality(raw.payload, raw.grid) : null),
  sample: sampleAirQuality,
  statusNote: (_q, field) =>
    field?.time ? `obs ${String(field.time).slice(11, 16)}Z` : '',
  render: {
    renderType: 'field',
    create: (viewer) => {
      const overlay = createCanvasImagery(viewer, { alpha: 0.7, credit: AQ_CREDIT });
      return {
        setField(field) {
          if (!field) {
            overlay.clear();
            return;
          }
          const canvas = pixelsToCanvas(airQualityPixels(field, WIDTH, HEIGHT), WIDTH, HEIGHT);
          overlay.show(canvas, [field.west, field.south, field.east, field.north]);
        },
        setVisible: (on) => overlay.setVisible(on),
        destroy: () => overlay.destroy(),
      };
    },
  },
};

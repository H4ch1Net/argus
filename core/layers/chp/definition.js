import { ink } from '../sdk/colors.js';
import { parseChpXml } from './parse.js';
import { describeChp, chpSearchText } from './format.js';
import {
  incidentGlyph,
  incidentInkName,
  incidentPixelSize,
} from '../incidents/format.js';

// California Highway Patrol dispatch incidents (keyless public CAD feed) as a
// Layer SDK point layer: type, place and time per incident, glyph by kind and
// red only when critical. The statewide list is small (a few hundred), so it
// is fetched whole every 2 minutes (the proxy caches it a minute for every
// client) and Cesium culls what is off screen. GUARDRAIL: the incident list,
// never the dispatcher narrative (core/layers/chp/parse.js drops it).

export const chpDefinition = {
  id: 'chp',
  fetch: { mode: 'poll', intervalMs: 2 * 60_000, viewportBounded: false },
  interpolate: false,
  maxEntities: 2000,
  normalize: (xml) => parseChpXml(xml),
  statusNote: (_q, xml) =>
    typeof xml === 'string' && !/<Log\s/.test(xml) ? 'no incidents listed' : '',
  render: {
    renderType: 'point',
    style: (n) => ({
      glyph: incidentGlyph(n.meta.kind),
      pixelSize: incidentPixelSize(n.meta.severity),
      color: ink(incidentInkName(n.meta.severity)),
    }),
  },
  describe: (n) => describeChp(n),
  searchText: chpSearchText,
};

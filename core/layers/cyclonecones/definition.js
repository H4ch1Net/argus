import { ink } from '../sdk/colors.js';
import { createRingMemo } from '../sdk/rings.js';
import {
  cycloneConeEntities,
  cycloneTrackEntities,
  forecastStatusNote,
} from './parse.js';
import {
  describeCone,
  describeTrack,
  forecastInkName,
  forecastSearchText,
} from './format.js';

// NHC forecast cones and centre tracks as two Layer SDK layers over one source
// (source.js): a translucent ground polygon per cone, a clamped line per track.
// Only geometry from the storm's current advisory is drawn (the coherence gate
// in ../cyclones/forecast.js). Red for a major hurricane, white otherwise, as
// the storm markers are.

const FETCH = { mode: 'poll', intervalMs: 5 * 60 * 1000, viewportBounded: false };
const statusNote = (_q, raw) => forecastStatusNote(raw);

export const cycloneConesDefinition = {
  id: 'cyclonecones',
  fetch: FETCH,
  interpolate: false,
  maxEntities: 64,
  normalize: (() => {
    const memo = createRingMemo();
    return (raw) => memo(cycloneConeEntities(raw));
  })(),
  statusNote,
  render: {
    renderType: 'polygon',
    width: 1.5,
    style: (n) => {
      const name = forecastInkName(n.meta.windKt);
      return { color: ink(name), fillAlpha: 0.16, outlineColor: ink(name, 0.55) };
    },
  },
  describe: (n) => describeCone(n),
  searchText: forecastSearchText,
};

export const cycloneTracksDefinition = {
  id: 'cyclonetracks',
  fetch: FETCH,
  interpolate: false,
  maxEntities: 64,
  normalize: (raw) => cycloneTrackEntities(raw),
  statusNote,
  render: {
    renderType: 'polyline',
    width: 2.5,
    style: (n) => ({ color: ink(forecastInkName(n.meta.windKt), 0.95), width: 2.5 }),
  },
  describe: (n) => describeTrack(n),
  searchText: forecastSearchText,
};

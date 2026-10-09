import { congestionLevel } from './flow.js';

// Styling and readouts for the simulated traffic layer. Pure (no Cesium):
// colours are CSS strings the renderer wraps, and the terminal draws with the
// same ones.

/**
 * Road tint by congestion, ctOS state colours muted: green flowing, amber
 * slow, red jammed or closed. Measured roads draw stronger than roads that
 * only inherit their class's median (inferred).
 */
export const CONGESTION_COLORS = Object.freeze({
  free: '#00fa9a', // ctOS success
  slow: '#e3a857', // amber (the palette's warning step)
  jam: '#fc3e38', // ctOS error
  closed: '#fc3e38',
});

/** Simulated vehicles: ctOS gray, amber when crawling in a queue. */
export const VEHICLE_COLORS = Object.freeze({ moving: '#d9d9d9', crawling: '#e3a857' });
/** Below this speed (m/s) a vehicle draws as crawling. */
export const CRAWL_MPS = 2.5;

const WIDTH_BY_RANK = [4, 3.5, 3, 2.5, 2, 1.6, 1.4];

/**
 * The ground line for an edge, or null when it is not drawn: only roads with
 * congestion known (measured or inferred), and the small classes only when
 * measured, so a dense street grid never turns into a wall of lines.
 * @param {{ rank: number }} edge
 * @param {{ ratio: number, measured: boolean, closed?: boolean }|null} flow
 * @returns {{ color: string, alpha: number, width: number, level: string }|null}
 */
export function roadLineStyle(edge, flow) {
  if (!flow || !Number.isFinite(flow.ratio)) return null;
  if (edge.rank > 4 && !flow.measured) return null;
  const level = flow.closed ? 'closed' : congestionLevel(flow.ratio);
  if (!level) return null;
  const width = WIDTH_BY_RANK[Math.min(edge.rank, WIDTH_BY_RANK.length - 1)];
  // Inferred roads are a faint hint; only a measurement draws at full weight.
  return {
    color: CONGESTION_COLORS[level],
    alpha: flow.measured ? 0.72 : 0.25,
    width: flow.measured ? width : Math.max(1.2, width * 0.7),
    level,
  };
}

/** The layer menu note: fleet size and where the speeds come from. */
export function simTrafficNote(model, vehicles) {
  if (!model) return '';
  const note = model.note();
  if (!model.active) return note;
  return vehicles ? `${vehicles} veh, ${note}` : note;
}

/** Legend rows for the layer (UI and terminal). */
export const SIMTRAFFIC_LEGEND = [
  ['SIMULATED VEHICLES', 'not real vehicles: a model driven by road data'],
  ['GREEN', 'flowing (75%+ of free-flow)'],
  ['AMBER', 'slow (45 to 75%)'],
  ['RED', 'jammed or closed'],
];

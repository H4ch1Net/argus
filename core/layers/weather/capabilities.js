// Time discovery for the observed-weather timeline: read a WMS 1.3.0
// GetCapabilities document for one layer's advertised observation times, pick
// each product's frame for a target time, and merge products into one
// timeline. Pure: no Cesium, no DOM (the terminal shell can use it too).
//
// Adapted from gods-eye-view server/providers/weather.js (MIT):
// parseWeatherCapabilities and observationTime, and selectFor and the
// timeline union from src/layers/weather/clock.js. The XML is scanned with
// bounded regular expressions, never handed to an XML parser, and a document
// carrying a DOCTYPE or ENTITY declaration is refused outright, so no entity
// is ever expanded.

export const CAPABILITIES_MAX_BYTES = 512 * 1024;
/** GetCapabilities query parameters (the proxy pins exactly these). */
export const CAPABILITIES_PARAMS = Object.freeze({
  service: 'WMS',
  version: '1.3.0',
  request: 'GetCapabilities',
});

const HOUR = 3_600_000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function invalid(reason) {
  return new Error(`invalid WMS capabilities: ${reason}`);
}

/**
 * An explicit UTC instant in canonical form ('2026-10-08T12:00:00.000Z'), or
 * null. Intervals, periods, offsets and impossible dates are refused.
 */
export function isoInstant(value) {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const canonical = date.toISOString();
  return canonical.replace('.000Z', 'Z') === value.replace('.000Z', 'Z')
    ? canonical
    : null;
}

const NS = '(?:[\\w.-]+:)?';
const tagValue = (xml, tag) =>
  xml.match(new RegExp(`<${NS}${tag}\\s*>([^<]+)</${NS}${tag}>`))?.[1]?.trim();

// The leaf <Layer> (no nested Layer) whose <Name> is the product's layer.
function findLeaf(xml, layerName) {
  const stack = [];
  let leaf = null;
  let tags = 0;
  for (const match of xml.matchAll(new RegExp(`</?${NS}Layer\\b[^>]*>`, 'g'))) {
    if (++tags > 4096) throw invalid('too many layers');
    if (!match[0].startsWith('</')) {
      if (stack.length) stack[stack.length - 1].nested = true;
      if (stack.length >= 16 || match[0].endsWith('/>')) throw invalid('layer nesting');
      stack.push({ start: match.index + match[0].length, nested: false });
    } else {
      const opened = stack.pop();
      if (!opened) throw invalid('unbalanced layers');
      if (opened.nested) continue;
      const body = xml.slice(opened.start, match.index);
      const name = tagValue(body, 'Name');
      if (name === layerName || name?.endsWith(`:${layerName}`)) {
        if (leaf !== null) throw invalid('layer listed twice');
        leaf = body;
      }
    }
  }
  if (stack.length) throw invalid('unbalanced layers');
  if (leaf === null) throw invalid(`no layer ${layerName}`);
  return leaf;
}

/**
 * @param {string} xml   the GetCapabilities document
 * @param {string} layerName  e.g. 'conus_base_reflectivity_mosaic'
 * @param {{ nowMs?: number, windowMs?: number, frames?: number, allowed?: number }} [opts]
 * @returns {{ bounds: { west: number, south: number, east: number, north: number },
 *   times: string[], allowedTimes: string[], defaultTime: string }}
 *   times: the newest `frames` (13) instants in the last `windowMs` (24 h),
 *   oldest first; allowedTimes: up to `allowed` (26) of them.
 */
export function parseWmsCapabilities(
  xml,
  layerName,
  { nowMs = Date.now(), windowMs = 24 * HOUR, frames = 13, allowed = 26 } = {},
) {
  if (typeof xml !== 'string' || xml.length > CAPABILITIES_MAX_BYTES)
    throw invalid('missing or oversized');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw invalid('DOCTYPE or ENTITY declaration');
  const leaf = findLeaf(xml, layerName);

  const box = leaf.match(
    new RegExp(
      `<${NS}EX_GeographicBoundingBox\\s*>([\\s\\S]*?)</${NS}EX_GeographicBoundingBox>`,
    ),
  )?.[1];
  const read = (tag) => {
    const v = box ? tagValue(box, tag) : null;
    return v ? Number(v) : NaN;
  };
  const bounds = {
    west: read('westBoundLongitude'),
    south: read('southBoundLatitude'),
    east: read('eastBoundLongitude'),
    north: read('northBoundLatitude'),
  };
  if (
    !Object.values(bounds).every(Number.isFinite) ||
    bounds.west < -180 ||
    bounds.east > 180 ||
    bounds.south < -90 ||
    bounds.north > 90 ||
    bounds.west >= bounds.east ||
    bounds.south >= bounds.north
  )
    throw invalid('bounding box');

  const dims = [
    ...leaf.matchAll(
      new RegExp(`<${NS}Dimension\\b([^>]*)>([^<]*)</${NS}Dimension>`, 'g'),
    ),
  ].filter((d) => /\bname\s*=\s*["']time["']/i.test(d[1]));
  if (dims.length !== 1 || !/\bunits\s*=\s*["']ISO8601["']/.test(dims[0][1]))
    throw invalid('time dimension');
  const raw = dims[0][2].trim().split(',');
  if (!raw.length || raw.length > 4096) throw invalid('time list');
  const times = raw.map((v) => isoInstant(v.trim()));
  if (times.some((t) => !t || Date.parse(t) > nowMs + 5 * 60_000))
    throw invalid('time list (intervals or future times)');
  const defaultTime = isoInstant(
    dims[0][1].match(/\bdefault\s*=\s*["']([^"']+)["']/)?.[1],
  );
  if (!defaultTime || !times.includes(defaultTime)) throw invalid('default time');

  const recent = [...new Set(times)]
    .filter((t) => nowMs - Date.parse(t) <= windowMs)
    .sort()
    .slice(-allowed);
  if (!recent.length) throw invalid('no observation in the window');
  return { bounds, times: recent.slice(-frames), allowedTimes: recent, defaultTime };
}

/**
 * The frame a product shows at `target`: its newest time at or before the
 * target and no more than `maxGapMs` older, else null (nothing near enough).
 */
export function selectFrame(times, target, maxGapMs) {
  const at = typeof target === 'number' ? target : Date.parse(target);
  if (!Number.isFinite(at) || !Array.isArray(times)) return null;
  let best = null;
  let bestMs = -Infinity;
  for (const t of times) {
    const ms = Date.parse(t);
    const age = at - ms;
    if (Number.isFinite(ms) && age >= 0 && age <= maxGapMs && ms > bestMs) {
      best = t;
      bestMs = ms;
    }
  }
  return best;
}

/** Every product's times as one sorted, de-duplicated list of instants. */
export function unionTimeline(lists) {
  const all = new Set();
  for (const list of lists || [])
    for (const t of list || []) {
      const c = isoInstant(t);
      if (c) all.add(c);
    }
  return [...all].sort((a, b) => Date.parse(a) - Date.parse(b));
}

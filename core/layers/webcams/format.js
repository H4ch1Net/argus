// Public webcam entities and their card. Pure (shared with the terminal shell).
//
// GUARDRAIL: the card shows a published still as published, loaded through the
// proxy only when the card opens. Nothing here analyses it.

import { categoryInfo } from './categories.js';

/** Source result -> normalized entities (type 'webcam'). */
export function parseWebcams(result) {
  return (result?.webcams ?? []).map((c) => ({
    id: `wc:${c.id}`,
    type: 'webcam',
    position: { longitude: c.lon, latitude: c.lat, altitude: 0 },
    meta: {
      name: c.name,
      source: c.source,
      category: c.category ?? 'other',
      tags: c.tags ?? [],
      place: c.place ?? null,
      provider: c.provider,
      operator: c.operator ?? null,
      imageUrl: c.imageUrl ?? null,
      fullImageUrl: c.fullImageUrl ?? null,
      imageKind: c.imageKind ?? 'live',
      pageUrl: c.pageUrl ?? null,
      pageLabel: c.pageLabel ?? null,
      extraLinks: c.extraLinks ?? [],
      updated: c.updated ?? null,
      description: c.description ?? null,
      streaming: c.streaming ?? null,
      license: c.license ?? '',
      licenseUrl: c.licenseUrl ?? null,
      credit: c.credit ?? null,
      demo: Boolean(c.demo),
    },
  }));
}

/** Entities in the chosen categories only (filter: { has(id) }). */
export const filterWebcams = (entities, filter) =>
  filter ? entities.filter((n) => filter.has(n.meta.category)) : entities;

/**
 * The hint beside the layer's count: zoom in for Windy, partial failures, and
 * how many the category filter is hiding.
 */
export function webcamNote(result, filter = null) {
  if (!result) return '';
  const parts = [];
  if (result.tooWide) parts.push('zoom in to load webcams');
  if (result.failed) parts.push(`${result.failed} source(s) failed`);
  if (filter) {
    const hidden = (result.webcams ?? []).filter((c) => !filter.has(c.category)).length;
    if (hidden) parts.push(`${hidden} hidden by filter`);
  }
  return parts.join(' · ');
}

const IMAGE_NOTES = {
  live: 'Latest published still',
  reference: 'Image as published with the listing (may be a reference photo)',
  archive: 'Published archive image',
};

function sourceLine(m) {
  if (m.demo) return 'demo (simulated)';
  return `${m.provider} (public listing, still via the proxy)`;
}

/** "2026-10-08T09:12:00Z" -> "2026-10-08 09:12 UTC"; anything else as given. */
function when(iso) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return iso || null;
  return `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function describeWebcam(n) {
  const m = n.meta;
  const cat = categoryInfo(m.category);
  const updated = when(m.updated);
  const image = m.imageUrl
    ? { url: m.imageUrl, alt: `${IMAGE_NOTES[m.imageKind] ?? 'Still'}: ${m.name}` }
    : null;
  const links = [];
  if (m.pageUrl) links.push({ label: m.pageLabel || 'Webcam page', url: m.pageUrl });
  if (m.fullImageUrl) links.push({ label: 'Full-size image', url: m.fullImageUrl });
  for (const l of m.extraLinks) if (l?.url) links.push(l);
  if (m.licenseUrl && m.licenseUrl !== m.pageUrl)
    links.push({ label: 'Licence and terms', url: m.licenseUrl });
  return {
    id: n.id,
    title: m.name,
    subtitle: [cat.label, m.place].filter(Boolean).join(' · '),
    rows: [
      ['Category', cat.label],
      ...(m.place ? [['Place', m.place]] : []),
      [
        'Coordinates',
        `${n.position.latitude.toFixed(4)}, ${n.position.longitude.toFixed(4)}`,
      ],
      ...(updated ? [['Updated', updated]] : []),
      ...(m.streaming ? [['Live stream', 'on the webcam page']] : []),
      ...(m.description ? [['About', m.description]] : []),
      ['Source', sourceLine(m)],
      ...(m.demo ? [] : [['Licence', m.license]]),
      ...(m.credit && m.credit !== m.license ? [['Image credit', m.credit]] : []),
      ['Image', IMAGE_NOTES[m.imageKind] ?? 'Still'],
      ['Note', 'Published still only; nothing here analyses it'],
    ],
    // The still loads only when this card opens, through the proxy.
    image,
    credit: m.demo ? null : m.credit || m.license,
    links,
  };
}

export const webcamSearchText = (n) =>
  `${n.meta.name} ${n.meta.place ?? ''} ${categoryInfo(n.meta.category).label} ${n.meta.tags.join(' ')} ${n.meta.provider} webcam`;

/** Terminal colours per category (hex, the ctOS teals and grays). */
const CATEGORY_HEX = {
  traffic: '#66b2b2',
  space: '#a6ffc9',
  observatory: '#a6ffc9',
  wildlife: '#deeeed',
  beach: '#49c4c4',
  harbor: '#49c4c4',
};
export const webcamColorHex = (category) => CATEGORY_HEX[category] ?? '#d9d9d9';

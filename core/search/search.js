import { classifyAsset } from '../osint/asset.js';

// Global search: query active layers (via their per-layer search adapters) and,
// for longer queries, place names (via the geocoder). It also seeds the OSINT
// query console (Pillar 3): a query that parses as a network asset (IP, ASN,
// domain) offers a passive-lookup result that geolocates + enriches + plots it.
// Selecting an entity tracks it; a place flies there; an asset is looked up,
// plotted, and tracked. GUARDRAIL: assets only, never people; lookups are passive.

/**
 * @param {{
 *   manager: object,
 *   geocode?: Function,
 *   camera: object,
 *   onSelectEntity: (entity: object) => void,
 *   lookup?: (asset: { kind: string, value: string }) => Promise<object|null>,
 *   correlate?: (asset: { kind: string, value: string }) => Promise<object|null>,
 *   plot?: (result: object) => object,
 * }} deps
 */
export function createSearch({
  manager,
  geocode,
  camera,
  onSelectEntity,
  lookup,
  correlate,
  plot,
}) {
  return {
    async search(query) {
      const q = String(query).trim();
      if (!q) return [];
      const results = [];

      // OSINT asset lookup offer (first, when the query parses as an asset).
      const asset = lookup || correlate ? classifyAsset(q) : null;
      if (asset && lookup) {
        results.push({
          kind: 'asset',
          label: `Query ${asset.value}`,
          sub: asset.kind,
          asset,
        });
      }
      if (asset && correlate) {
        results.push({
          kind: 'correlate',
          label: `Correlate ${asset.value}`,
          sub: 'multi-source',
          asset,
        });
      }

      for (const layer of manager.activeLayers()) {
        for (const hit of layer.search(q, 5)) {
          results.push({
            kind: 'entity',
            label: hit.label,
            sub: layer.id,
            entity: hit.entity,
          });
        }
      }

      if (q.length >= 3 && geocode) {
        try {
          const places = await geocode(q);
          for (const p of places.slice(0, 4)) {
            results.push({
              kind: 'place',
              label: p.name,
              sub: 'place',
              longitude: p.longitude,
              latitude: p.latitude,
            });
          }
        } catch {
          // geocoding failed (offline / rate-limited): other results still stand
        }
      }

      return results.slice(0, 10);
    },

    async select(result) {
      if (result.kind === 'entity') {
        onSelectEntity(result.entity);
      } else if (result.kind === 'place') {
        camera.flyTo({
          longitude: result.longitude,
          latitude: result.latitude,
          altitude: 150_000,
        });
      } else if (result.kind === 'asset' && lookup && plot) {
        const enriched = await lookup(result.asset);
        if (enriched?.position) onSelectEntity(plot(enriched));
        return enriched;
      } else if (result.kind === 'correlate' && correlate && plot) {
        const composite = await correlate(result.asset);
        if (composite?.position) onSelectEntity(plot(composite));
        return composite;
      }
      return null;
    },
  };
}

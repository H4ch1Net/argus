import { internetDbRows, ipOf } from './internetdb.js';
import { classifyAsset } from './asset.js';

// Target-card extras for network assets (core/interaction/targetExtras.js
// plugins). Pure: no Cesium, no DOM.
//
//   InternetDB   any contact whose record names an IP (Shodan's host sample,
//                anything with meta.ip): its open ports, CVE count, tags and
//                hostnames, looked up once when it is selected.
//   AS LOOKUP    a BGP event's origin AS: the OSINT correlation of the AS
//                (RIPEstat routing and registry), plotted and selected.
//
// GUARDRAIL: both read public indexes; nothing is sent to any host.

/** @param {{ lookup: Function & { peek: Function } }} deps  an InternetDB lookup */
export function createInternetDbExtras({ lookup }) {
  const busy = new Set();
  const failed = new Set();
  return {
    rows(_key, n) {
      const ip = ipOf(n?.meta);
      if (!ip || !lookup) return [];
      const v = lookup.peek(ip);
      if (v !== undefined) return internetDbRows(v);
      if (busy.has(ip)) return [['InternetDB', 'looking up']];
      return failed.has(ip) ? [['InternetDB', 'unavailable']] : [];
    },
    async onSelect(_key, n, ctx) {
      const ip = ipOf(n?.meta);
      if (!ip || !lookup || lookup.peek(ip) !== undefined || busy.has(ip)) return;
      busy.add(ip);
      failed.delete(ip);
      ctx.refresh();
      try {
        await lookup(ip);
      } catch (err) {
        failed.add(ip);
        console.warn(`[argus] internetdb ${ip}: ${err?.message || err}`);
      } finally {
        busy.delete(ip);
        ctx.refresh();
      }
    },
  };
}

/**
 * @param {{ getCorrelate: () => Function|null, plot: (r: object) => object,
 *   select: (t: object) => void }} deps
 */
export function createAsLookupExtras({ getCorrelate, plot, select }) {
  const busy = new Set();
  const failed = new Map();
  return {
    rows(key, n) {
      const asn = key === 'bgp' ? n?.meta?.asn : null;
      return asn != null && failed.has(asn) ? [['AS lookup', failed.get(asn)]] : [];
    },
    actions(_target, rec, ctx) {
      const asn = rec.key === 'bgp' ? rec.normalized?.meta?.asn : null;
      const correlate = getCorrelate();
      const asset = asn != null ? classifyAsset(`AS${asn}`) : null;
      if (!asset || !correlate) return [];
      const on = busy.has(asn);
      return [
        {
          label: on ? 'LOOKING UP...' : 'LOOK UP AS',
          title: `Correlate AS${asn} across public routing and registry data`,
          pressed: on,
          onClick: async () => {
            if (on) return;
            busy.add(asn);
            failed.delete(asn);
            ctx.refresh();
            try {
              const r = await correlate(asset);
              if (r?.position) select(plot(r));
              else failed.set(asn, 'nothing to place on the map');
            } catch (err) {
              failed.set(asn, 'unavailable');
              console.warn(`[argus] AS${asn} lookup: ${err?.message || err}`);
            } finally {
              busy.delete(asn);
              ctx.refresh();
            }
          },
        },
      ];
    },
  };
}

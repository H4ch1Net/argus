// California Highway Patrol dispatch incidents (the public CHP CAD "sa.xml"
// feed: media.chp.ca.gov/sa_xml/sa.xml), pure: a small regex reader for that
// one document shape, no DOM and no XML library, so the terminal shares it.
// Per the reference implementation of public CHP scrapers, not live-tested
// here.
//
// Shape: <State><Center ID="LACC"><Dispatch ID="LACC"><Log ID="...">
//   <LogTime>"Oct 8 2026  9:15AM"</LogTime> <LogType>"1183-Trfc Collision-Unkn Inj"</LogType>
//   <Location>"..."</Location> <LocationDesc>"..."</LocationDesc> <Area>"..."</Area>
//   <LATLON>"34052235:118243683"</LATLON> <LogDetails>...</LogDetails>
// </Log>...; values are wrapped in double quotes, LATLON is micro-degrees with
// the longitude's sign dropped (California is west: it is negated here), and
// times are Pacific local time.
//
// GUARDRAIL: only the incident type, place, area and time are read. The
// dispatcher narrative (LogDetails: units, free-text notes that can name
// vehicles or people) is never parsed, kept or shown.

const MAX_XML_CHARS = 8 * 1024 * 1024;
const MAX_LOGS = 2000;

// California, generously: anything outside is a bad coordinate.
const CA_BOX = { lomin: -125, lamin: 32, lomax: -113.5, lamax: 42.5 };

export const CHP_CENTERS = {
  BCCC: 'Border',
  BFCC: 'Bakersfield',
  BSCC: 'Barstow',
  CCCC: 'Capitol',
  CHCC: 'Chico',
  ECCC: 'El Centro',
  FRCC: 'Fresno',
  GGCC: 'Golden Gate',
  HMCC: 'Humboldt',
  ICCC: 'Indio',
  INCC: 'Inland',
  LACC: 'Los Angeles',
  MRCC: 'Merced',
  MYCC: 'Monterey',
  OCCC: 'Orange',
  RDCC: 'Redding',
  SACC: 'Sacramento',
  SKCCSTCC: 'Stockton',
  SLCC: 'San Luis Obispo',
  TKCC: 'Truckee',
  UKCC: 'Ukiah',
  VTCC: 'Ventura',
  YKCC: 'Yreka',
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Element text: CDATA unwrapped, the five XML entities and numeric refs decoded once, quotes and tags stripped. */
export function chpText(raw, n = 120) {
  return String(raw ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:#(\d{1,6})|#x([0-9a-fA-F]{1,5})|(amp|lt|gt|quot|apos));/g, (_, d, h, e) => {
      if (e) return ENTITIES[e];
      const c = d ? Number(d) : parseInt(h, 16);
      return c > 31 && c <= 0x10ffff && !(c >= 0xd800 && c <= 0xdfff)
        ? String.fromCodePoint(c)
        : ' ';
    })
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .trim()
    .slice(0, n);
}

const field = (body, tag) => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(body);
  return m ? chpText(m[1]) : '';
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Day of month of the nth Sunday (n >= 1) of a month, or the first when n = 1. */
function nthSunday(year, month, n) {
  const dow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + ((7 - dow) % 7) + 7 * (n - 1);
}

/**
 * Pacific wall-clock time -> UTC ms, with US daylight saving (second Sunday
 * of March 02:00 to first Sunday of November 02:00 local).
 */
export function pacificToUtcMs(year, month, day, hour, minute) {
  const wall = Date.UTC(year, month, day, hour, minute);
  const start = Date.UTC(year, 2, nthSunday(year, 2, 2), 2, 0);
  const end = Date.UTC(year, 10, nthSunday(year, 10, 1), 2, 0);
  const offsetH = wall >= start && wall < end ? 7 : 8;
  return wall + offsetH * 3_600_000;
}

/** "Oct 8 2026  9:15AM" (Pacific) -> UTC ms, or null. */
export function parseChpTime(s) {
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(
    String(s ?? '').trim(),
  );
  if (!m) return null;
  const month = MONTHS.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
  const day = Number(m[2]);
  let hour = Number(m[4]);
  const minute = Number(m[5]);
  if (month < 0 || day < 1 || day > 31 || hour < 1 || hour > 12 || minute > 59) return null;
  if (/pm/i.test(m[6]) && hour !== 12) hour += 12;
  if (/am/i.test(m[6]) && hour === 12) hour = 0;
  return pacificToUtcMs(Number(m[3]), month, day, hour, minute);
}

/** "34052235:118243683" -> [lon, lat] in California, or null. */
export function parseChpLatLon(s) {
  const m = /^(\d{7,9}):(\d{7,10})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const lat = Number(m[1]) / 1e6;
  const lon = -Number(m[2]) / 1e6;
  if (lon < CA_BOX.lomin || lon > CA_BOX.lomax || lat < CA_BOX.lamin || lat > CA_BOX.lamax)
    return null;
  return [lon, lat];
}

/** Incident kind from the CHP log type text. */
export function chpKind(type) {
  const t = String(type || '').toLowerCase();
  if (/collision|hit and run|crash|\b11(79|80|81|82|83)\b|\b20001\b|\b20002\b/.test(t))
    return 'accident';
  if (/closure|closed|road clos/.test(t)) return 'closure';
  if (/construction|maintenance|road ?work|caltrans/.test(t)) return 'roadworks';
  if (/weather|flood|fog|snow|wind|\bice\b|chain control|rain/.test(t)) return 'weather';
  if (/sig ?alert|traffic advisory|traffic break|congestion|traffic control|\b1184\b/.test(t))
    return 'jam';
  return 'hazard';
}

/** 'critical' | 'notable' | 'minor' from the log type text. */
export function chpSeverity(type) {
  const t = String(type || '').toLowerCase();
  if (
    /\b(1179|1180|1183)\b|major inj|fatal|sig ?alert|closure|wrong way|hazardous mat|hazmat/.test(
      t,
    )
  )
    return 'critical';
  if (/collision|hit and run|fire|\b(1181|1182|1125)\b|pedestrian/.test(t)) return 'notable';
  return 'minor';
}

/**
 * The CHP sa.xml document -> normalized incident entities. A document that
 * declares a DOCTYPE or an ENTITY (the only routes to entity expansion) is
 * refused outright, as is anything oversized; nothing here expands anything.
 */
export function parseChpXml(xml) {
  if (typeof xml !== 'string' || xml.length > MAX_XML_CHARS) return [];
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) return [];
  // Centre boundaries, so each log knows its dispatch centre.
  const centers = [...xml.matchAll(/<Center\s+ID="([A-Za-z0-9]{1,12})"/g)].map((m) => ({
    at: m.index,
    id: m[1],
  }));
  const out = [];
  const seen = new Set();
  let c = -1;
  for (const m of xml.matchAll(/<Log\s+ID="([^"<>]{1,40})"\s*>([\s\S]*?)<\/Log>/g)) {
    while (c + 1 < centers.length && centers[c + 1].at < m.index) c += 1;
    const center = c >= 0 ? centers[c].id : '';
    // Only the header fields: the narrative in LogDetails is never read.
    const body = m[2].replace(/<LogDetails\b[\s\S]*?<\/LogDetails>/g, '');
    const at = parseChpLatLon(field(body, 'LATLON'));
    if (!at) continue;
    const id = `chp/${center || 'x'}/${chpText(m[1], 40)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const type = field(body, 'LogType');
    out.push({
      id,
      type: 'incident',
      position: { longitude: at[0], latitude: at[1], altitude: 0 },
      meta: {
        source: 'chp',
        kind: chpKind(type),
        severity: chpSeverity(type),
        logType: type,
        location: field(body, 'Location'),
        locationDesc: field(body, 'LocationDesc'),
        area: field(body, 'Area'),
        center,
        centerName: CHP_CENTERS[center] ?? center,
        timeMs: parseChpTime(field(body, 'LogTime')),
        demo: /\(simulated\)/.test(field(body, 'Area')),
      },
    });
    if (out.length >= MAX_LOGS) break;
  }
  return out;
}

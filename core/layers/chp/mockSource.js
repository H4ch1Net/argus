// Dev / demo stand-in for the CHP CAD feed: a small sa.xml-shaped document with
// a handful of incidents around Los Angeles and Sacramento, in the real feed's
// quoting and LATLON format, so the parser path is the same as live.

const LOGS = [
  ['LACC', '1183-Trfc Collision-Unkn Inj', 'I5 N / Los Feliz Blvd', 34126000, 118274000],
  ['LACC', '1125-Traffic Hazard', 'I10 W / La Brea Ave', 34036000, 118344000],
  ['LACC', 'SIG Alert', 'US101 S / Vermont Ave', 34085000, 118291000],
  ['SACC', 'Construction', 'I80 E / Madison Ave', 38660000, 121340000],
  ['SACC', 'Road/Weather Conditions', 'US50 E / Pollock Pines', 38760000, 120590000],
  ['GGCC', 'CLOSURE of a Road', 'SR1 S / Devils Slide', 37574000, 122516000],
];

function stamp(ms) {
  // Pacific-ish wall time is close enough for a demo.
  const d = new Date(ms - 7 * 3_600_000);
  const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
  let h = d.getUTCHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()} ${h}:${String(d.getUTCMinutes()).padStart(2, '0')}${ampm}`;
}

export function demoChpXml(now = Date.now()) {
  const byCenter = new Map();
  LOGS.forEach(([center, type, loc, lat, lon], i) => {
    const log = `<Log ID="DEMO${String(i).padStart(4, '0')}"><LogTime>"${stamp(now - i * 600_000)}"</LogTime><LogType>"${type}"</LogType><Location>"${loc}"</Location><LocationDesc>""</LocationDesc><Area>"Demo area (simulated)"</Area><LATLON>"${lat}:${lon}"</LATLON><LogDetails><details><IncidentDetail>"never read"</IncidentDetail></details></LogDetails></Log>`;
    byCenter.set(center, (byCenter.get(center) ?? '') + log);
  });
  const centers = [...byCenter]
    .map(([id, logs]) => `<Center ID="${id}"><Dispatch ID="${id}">${logs}</Dispatch></Center>`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?><State ID="STATE">${centers}</State>`;
}

export function createChpMockSource() {
  return async () => demoChpXml();
}

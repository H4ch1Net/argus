// Land border waits: the CBP and CBSA parsers on realistic payloads, the join
// onto the bundled ports table, the source (partial failures, nearest traffic
// cameras) and the card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PORTS } from './data/ports.js';
import {
  parseCbp,
  parseCbsa,
  parseCsv,
  cbsaDelay,
  cbpLane,
  joinPorts,
  portForCbp,
  normName,
} from './parse.js';
import { createBorderWaitSource, nearestCameras } from './source.js';
import {
  parseBorderWaits,
  describeBorderWait,
  borderWaitNote,
  borderWaitSearchText,
  laneText,
  borderWaitColorHex,
} from './format.js';
import { createBorderWaitMockSource } from './mockSource.js';

const lane = (status, delay = '', open = '', updated = 'At 11:00 am PDT') => ({
  update_time: updated,
  operational_status: status,
  delay_minutes: delay,
  lanes_open: open,
});
const NA = lane('N/A');

/** One CBP record, shaped like bwt.cbp.gov/api/bwtnew. */
const cbp = (number, border, port, crossing, over = {}) => ({
  port_number: number,
  border,
  port_name: port,
  crossing_name: crossing,
  hours: '24 hrs/day',
  date: '10/8/2026',
  time: '11:00:00',
  port_status: 'Open',
  commercial_automation_type: 'Manual',
  passenger_automation_type: 'Manual',
  pedestrain_automation_type: 'Manual',
  commercial_vehicle_lanes: {
    maximum_lanes: 'N/A',
    standard_lanes: NA,
    FAST_lanes: NA,
  },
  passenger_vehicle_lanes: {
    maximum_lanes: '26',
    standard_lanes: lane('delay', '45', '12'),
    NEXUS_SENTRI_lanes: lane('delay', '10', '4'),
    ready_lanes: lane('no delay', '0', '6'),
  },
  pedestrian_lanes: {
    maximum_lanes: '12',
    standard_lanes: lane('delay', '20', '5'),
    ready_lanes: NA,
  },
  construction_notice: '',
  ...over,
});

const MX = 'Mexican Border';
const CA = 'Canadian Border';
const CBP = [
  cbp('250401', MX, 'San Ysidro', ''),
  cbp('250409', MX, 'San Ysidro', 'PedWest'),
  cbp('250601', MX, 'Otay Mesa', 'Passenger', {
    commercial_vehicle_lanes: {
      maximum_lanes: '14',
      standard_lanes: lane('delay', '30', '8'),
      FAST_lanes: lane('no delay', '0', '2'),
    },
  }),
  cbp('240201', MX, 'El Paso', 'Bridge of the Americas (BOTA)'),
  cbp('240202', MX, 'El Paso', 'Paso Del Norte (PDN)'),
  cbp('230401', MX, 'Laredo', 'Bridge I'),
  cbp('230402', MX, 'Laredo', 'Bridge II'),
  cbp('230501', MX, 'Hidalgo/Pharr', 'Hidalgo'),
  cbp('230502', MX, 'Hidalgo/Pharr', 'Pharr'),
  cbp('230503', MX, 'Hidalgo/Pharr', 'Anzalduas'),
  cbp('230101', MX, 'Brownsville', 'B&M'),
  cbp('230302', MX, 'Eagle Pass', 'Bridge II'),
  cbp('240401', MX, 'Tornillo', 'Marcelino Serna'),
  cbp('300401', CA, 'Blaine', 'Peace Arch'),
  cbp('300402', CA, 'Blaine', 'Pacific Highway'),
  cbp('301701', CA, 'Blaine', 'Point Roberts'),
  cbp('380001', CA, 'Detroit', 'Ambassador Bridge', {
    passenger_vehicle_lanes: {
      maximum_lanes: '10',
      standard_lanes: lane('Lanes Closed'),
      NEXUS_SENTRI_lanes: lane('Update Pending'),
      ready_lanes: NA,
    },
  }),
  cbp('380002', CA, 'Detroit', 'Windsor Tunnel'),
  cbp('090101', CA, 'Buffalo/Niagara Falls', 'Peace Bridge'),
  cbp('090104', CA, 'Buffalo/Niagara Falls', 'Rainbow Bridge'),
  cbp('090103', CA, 'Buffalo/Niagara Falls', 'Lewiston Bridge'),
  cbp('090103', CA, 'Buffalo/Niagara Falls', 'Lewiston Bridge'), // duplicate
];

const CBSA = [
  '﻿"CBSA Office","Location","Updated","Commercial Flow","Travellers Flow"',
  '"Douglas","Surrey, BC","2026-10-08 09:30 PDT","Not applicable","15 minutes"',
  '"Pacific Highway","Surrey, BC","2026-10-08 09:30 PDT","No delay","1 hour 5 minutes"',
  '"Ambassador Bridge","Windsor, ON","2026-10-08 12:30 EDT","No delay","No delay"',
  '"Lacolle: Autoroute 15","Saint-Bernard-de-Lacolle, QC","2026-10-08 12:30 EDT","Closed","5 minutes"',
  '"Stanstead: Route 143","Stanstead, QC","2026-10-08 12:30 EDT","Not applicable","No delay"',
  '"Peace Bridge","Fort Erie, ON","2026-10-08 12:30 EDT","10 minutes","""Missed entry"""',
].join('\r\n');

test('the bundled ports: 58 crossings, sane positions, each with a CBP matcher', () => {
  assert.equal(PORTS.length, 58);
  assert.equal(new Set(PORTS.map((p) => p.id)).size, PORTS.length);
  for (const p of PORTS) {
    assert.ok(p.cbp.length, `${p.id} has a CBP matcher`);
    assert.ok(['high', 'medium'].includes(p.confidence), p.id);
    if (p.border === 'mx') {
      // The US-Mexico border runs between about 25.8 and 32.8 N.
      assert.ok(p.lat > 25.8 && p.lat < 32.8 && p.lon > -117.2 && p.lon < -97.3, p.id);
    } else {
      assert.ok(p.lat > 42 && p.lat < 49.01 && p.lon > -123.1 && p.lon < -67.7, p.id);
      assert.ok(p.cbsa instanceof RegExp, `${p.id} names its Canadian side`);
    }
  }
  assert.equal(PORTS.filter((p) => p.border === 'mx').length, 36);
  assert.equal(PORTS.filter((p) => p.confidence === 'high').length, 28);
});

test('CBP: one record per crossing, lanes that exist, closed and pending states', () => {
  const rows = parseCbp(CBP);
  assert.equal(rows.length, CBP.length - 1, 'the duplicate port number is dropped');
  const sy = rows[0];
  assert.equal(sy.border, 'mx');
  assert.equal(sy.updated, '10/8/2026 11:00:00');
  assert.deepEqual(
    sy.lanes.map((l) => [l.label, l.delay, l.open]),
    [
      ['Passenger', 45, 12],
      ['SENTRI / NEXUS', 10, 4],
      ['Ready Lane', 0, 6],
      ['Pedestrian', 20, 5],
    ],
  );
  const amb = rows.find((r) => r.crossing === 'Ambassador Bridge');
  assert.equal(amb.border, 'ca');
  assert.deepEqual(
    amb.lanes.filter((l) => l.kind === 'passenger_vehicle_lanes').map((l) => [l.closed, l.pending]),
    [
      [true, false],
      [false, true],
    ],
  );
  assert.equal(cbpLane(NA), null);
  assert.equal(cbpLane(null), null);
  assert.deepEqual(parseCbp({ port: CBP.slice(0, 1) }).length, 1);
  assert.deepEqual(parseCbp('nope'), []);
});

test('CBP crossings land on the right bundled port; the rest are counted, not guessed', () => {
  const { ports, unplaced } = joinPorts(parseCbp(CBP));
  const at = (id) => ports.find((p) => p.id === id);
  assert.equal(at('san-ysidro').cbp.length, 2);
  assert.equal(at('el-paso-bota').cbp[0].crossing, 'Bridge of the Americas (BOTA)');
  assert.equal(at('el-paso-pdn').cbp[0].crossing, 'Paso Del Norte (PDN)');
  assert.equal(at('laredo-1').cbp[0].crossing, 'Bridge I');
  assert.equal(at('laredo-2').cbp[0].crossing, 'Bridge II');
  assert.equal(at('hidalgo').cbp[0].crossing, 'Hidalgo');
  assert.equal(at('pharr').cbp[0].crossing, 'Pharr');
  assert.equal(at('anzalduas').cbp[0].crossing, 'Anzalduas');
  assert.equal(at('brownsville-bm').cbp[0].crossing, 'B&M');
  assert.equal(at('point-roberts').cbp[0].crossing, 'Point Roberts');
  assert.equal(at('detroit-tunnel').cbp[0].crossing, 'Windsor Tunnel');
  assert.equal(at('lewiston-bridge').cbp.length, 1);
  assert.deepEqual(
    unplaced.map((r) => r.port).sort(),
    ['Eagle Pass', 'Tornillo'],
  );
  assert.equal(normName('B&M Bridge'), 'b and m bridge');
  assert.equal(portForCbp({ port: 'Calexico', crossing: 'East' }).id, 'calexico-east');
  assert.equal(portForCbp({ port: 'Calexico', crossing: 'West' }).id, 'calexico-west');
  assert.equal(portForCbp({ port: 'San Luis', crossing: 'San Luis II' }), null);
});

test('CBSA: CSV with a BOM, quotes and CRLF; delays in words; joined to the US side', () => {
  assert.deepEqual(parseCsv('a,"b ""c"", d"\r\n1,2'), [
    ['a', 'b "c", d'],
    ['1', '2'],
  ]);
  const rows = parseCbsa(CBSA);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[0].travellers, { delay: 15, text: '15 minutes', closed: false });
  assert.equal(rows[0].commercial, null);
  assert.equal(rows[1].travellers.delay, 65);
  assert.equal(rows[3].commercial.closed, true);
  assert.equal(rows[5].travellers.delay, null);
  assert.equal(cbsaDelay('Aucun délai').delay, 0);
  assert.equal(cbsaDelay('2 hours').delay, 120);
  assert.equal(cbsaDelay(''), null);
  assert.deepEqual(parseCbsa('just,a,header'), []);

  const { ports } = joinPorts(parseCbp(CBP), rows);
  const at = (id) => ports.find((p) => p.id === id);
  assert.equal(at('blaine-peace-arch').cbsa.office, 'Douglas');
  assert.equal(at('blaine-pacific').cbsa.office, 'Pacific Highway');
  assert.equal(at('detroit-ambassador').cbsa.office, 'Ambassador Bridge');
  assert.equal(at('peace-bridge').cbsa.office, 'Peace Bridge');
  // A CBSA office with no US record still places its crossing (CBSA only).
  assert.equal(at('champlain').cbp.length, 0);
  assert.equal(at('champlain').cbsa.office, 'Lacolle: Autoroute 15');
  // Stanstead Route 143 is not the I-91 crossing.
  assert.equal(at('derby-line'), undefined);
});

test('the source: both feeds through the proxy, partial failure, nearest cameras', async () => {
  const asked = [];
  const proxyClient = (fail = {}) => ({
    getJson: async (feedId, path) => {
      asked.push(`${feedId}${path}`);
      if (fail[feedId]) throw new Error(`${feedId} down`);
      return CBP;
    },
    getText: async (feedId, path) => {
      asked.push(`${feedId}${path}`);
      if (fail[feedId]) throw new Error(`${feedId} down`);
      return CBSA;
    },
  });
  const cams = [
    { id: 'cam-1', name: 'I-5 at San Ysidro POE', provider: 'Caltrans', lat: 32.545, lon: -117.03, imageUrl: 'https://proxy.test/feed/caltrans-img/a.jpg', imageFormat: null },
    { id: 'cam-2', name: 'I-805 at Otay', provider: 'Caltrans', lat: 32.56, lon: -117.0, imageUrl: 'https://proxy.test/feed/caltrans-img/b.jpg', imageFormat: null },
    { id: 'cam-3', name: 'Far away', provider: 'Caltrans', lat: 33.0, lon: -117.3, imageUrl: 'https://proxy.test/feed/caltrans-img/c.jpg', imageFormat: null },
    { id: 'cam-4', name: 'TxDOT style', provider: 'TxDOT', lat: 32.5425, lon: -117.0299, imageUrl: 'https://proxy.test/feed/txdot-img/x', imageFormat: 'json-base64-jpeg' },
  ];
  const cameraQueries = [];
  const cameraSource = async (q) => {
    cameraQueries.push(q.bbox);
    return { cameras: cams };
  };
  const sanDiego = { lamin: 32.4, lamax: 32.8, lomin: -117.3, lomax: -116.8 };
  const r = await createBorderWaitSource({ proxyClient: proxyClient(), cameraSource })({
    bbox: sanDiego,
  });
  assert.deepEqual(asked, ['cbp-bwt/bwtnew', 'cbsa-bwt/bwt-eng.csv']);
  assert.equal(r.failed, 0);
  assert.equal(r.unplaced, 2);
  assert.equal(r.camerasLinked, true);
  assert.equal(cameraQueries.length, 1);
  const sy = r.ports.find((p) => p.id === 'san-ysidro');
  assert.deepEqual(
    sy.cameras.map((c) => [c.id, c.imageUrl !== null]),
    [
      ['cam-4', false], // a JSON still gets no link
      ['cam-1', true],
    ],
  );
  // Ports outside the view are not linked.
  assert.equal(r.ports.find((p) => p.id === 'peace-bridge').cameras, undefined);

  // Zoomed out: no camera lookup at all.
  cameraQueries.length = 0;
  await createBorderWaitSource({ proxyClient: proxyClient(), cameraSource })({
    bbox: { lamin: 20, lamax: 50, lomin: -125, lomax: -65 },
  });
  assert.equal(cameraQueries.length, 0);

  const partial = await createBorderWaitSource({
    proxyClient: proxyClient({ 'cbsa-bwt': true }),
  })({});
  assert.equal(partial.failed, 1);
  assert.match(borderWaitNote(partial), /1 feed\(s\) failed · 2 crossing\(s\) not on the map/);
  await assert.rejects(
    createBorderWaitSource({
      proxyClient: proxyClient({ 'cbp-bwt': true, 'cbsa-bwt': true }),
    })({}),
    /cbp-bwt down/,
  );
  assert.deepEqual(nearestCameras(cams, { lat: 0, lon: 0 }), []);
});

test('the card: lanes into the US and Canada, nearby camera stills, honest position', async () => {
  const r = await createBorderWaitSource({
    proxyClient: { getJson: async () => CBP, getText: async () => CBSA },
    cameraSource: async () => ({
      cameras: [
        { id: 'c1', name: 'Peace Arch', provider: 'DriveBC', lat: 49.0, lon: -122.757, imageUrl: 'https://proxy.test/feed/drivebc-img/1.jpg' },
      ],
    }),
  })({ bbox: { lamin: 48.9, lamax: 49.1, lomin: -122.9, lomax: -122.6 } });
  const ents = parseBorderWaits(r);
  const arch = ents.find((n) => n.id === 'bw:blaine-peace-arch');
  assert.equal(arch.type, 'borderwait');
  assert.equal(arch.meta.maxDelay, 45);
  const card = describeBorderWait(arch);
  const row = (k) => card.rows.find(([key]) => key === k)?.[1];
  assert.equal(card.title, 'Blaine, Peace Arch');
  assert.equal(card.subtitle, 'US-Canada border · WA · 45 min');
  assert.equal(row('Into US: Passenger'), '45 min (12 lanes open)');
  assert.equal(row('Into US: Ready Lane'), 'no delay (6 lanes open)');
  assert.equal(row('Into Canada: Travellers'), '15 min');
  assert.equal(row('Nearby camera'), 'Peace Arch (DriveBC, 0.2 km)');
  assert.ok(card.links.some((l) => l.url === 'https://proxy.test/feed/drivebc-img/1.jpg'));
  assert.match(row('Coordinates'), /within a few hundred metres/);
  assert.equal(row('Source'), 'CBP Border Wait Times + CBSA Border Wait Times');
  assert.match(card.credit, /Open Government Licence - Canada/);
  assert.match(borderWaitSearchText(arch), /Peace Arch.*Douglas.*port of entry/);

  const amb = describeBorderWait(ents.find((n) => n.id === 'bw:detroit-ambassador'));
  assert.equal(amb.rows.find(([k]) => k === 'Into US: Passenger')[1], 'lanes closed');
  assert.equal(amb.rows.find(([k]) => k === 'Into US: SENTRI / NEXUS')[1], 'update pending');
  assert.match(amb.rows.find(([k]) => k === 'Nearby camera')[1], /zoom in/);
  const sy = describeBorderWait(ents.find((n) => n.id === 'bw:san-ysidro'));
  assert.ok(sy.rows.filter(([k]) => k === 'Crossing').length === 2);
  assert.equal(laneText({ delay: 5, open: 1, closed: false }), '5 min (1 lane open)');
  assert.equal(borderWaitColorHex({ closed: true }), '#7a7a7a');
  assert.equal(borderWaitColorHex({ closed: false, maxDelay: 120 }), '#ffffff');
});

test('the demo source: real crossings, simulated waits, labelled', async () => {
  const r = await createBorderWaitMockSource()({});
  assert.equal(r.ports.length, 6);
  const card = describeBorderWait(parseBorderWaits(r)[0]);
  assert.equal(card.rows.find(([k]) => k === 'Source')[1], 'demo (simulated)');
  assert.equal(card.credit, null);
});

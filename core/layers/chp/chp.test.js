import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChpXml,
  parseChpTime,
  parseChpLatLon,
  pacificToUtcMs,
  chpKind,
  chpSeverity,
  chpText,
} from './parse.js';
import { describeChp, chpTypeLabel, chpSearchText } from './format.js';
import { demoChpXml } from './mockSource.js';

const SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<State ID="STATE">
  <Center ID="LACC">
    <Dispatch ID="LACC">
      <Log ID="261008LA00101">
        <LogTime>"Oct 8 2026  9:15AM"</LogTime>
        <LogType>"1183-Trfc Collision-Unkn Inj"</LogType>
        <Location>"I5 N / Los Feliz Blvd"</Location>
        <LocationDesc>"I5 N JNO LOS FELIZ"</LocationDesc>
        <Area>"Central LA"</Area>
        <ThomasBrothers>"594 6A"</ThomasBrothers>
        <TBXY>"6491234:1867890"</TBXY>
        <LATLON>"34126000:118274000"</LATLON>
        <LogDetails>
          <details><DetailTime>"Oct 8 2026  9:16AM"</DetailTime><IncidentDetail>"[1] WHI SEDAN PLATE 7ABC123 &amp; DRIVER NAME"</IncidentDetail></details>
          <units><unitTime>"Oct 8 2026  9:17AM"</unitTime><unitDetail>"Unit Enroute"</unitDetail></units>
        </LogDetails>
      </Log>
      <Log ID="261008LA00102">
        <LogTime>"Oct 8 2026 12:05PM"</LogTime>
        <LogType>"Construction"</LogType>
        <Location>"I10 W &amp; La Brea"</Location>
        <LocationDesc>""</LocationDesc>
        <Area>"West LA"</Area>
        <LATLON>"34036000:118344000"</LATLON>
      </Log>
      <Log ID="261008LA00103">
        <LogTime>"Oct 8 2026 12:10PM"</LogTime>
        <LogType>"1125-Traffic Hazard"</LogType>
        <Location>"Somewhere"</Location>
        <LATLON>"0:0"</LATLON>
      </Log>
    </Dispatch>
  </Center>
  <Center ID="SACC">
    <Dispatch ID="SACC">
      <Log ID="261008SA00007">
        <LogTime>"Jan 3 2026 12:30AM"</LogTime>
        <LogType>"SIG Alert"</LogType>
        <Location>"US50 E / Howe Ave"</Location>
        <Area>"Sacramento"</Area>
        <LATLON>"38560000:121420000"</LATLON>
      </Log>
    </Dispatch>
  </Center>
</State>`;

test('the CHP list parses into incidents per dispatch centre', () => {
  const list = parseChpXml(SAMPLE);
  assert.equal(list.length, 3, 'the log without coordinates is skipped');
  const [crash, works, sig] = list;
  assert.equal(crash.id, 'chp/LACC/261008LA00101');
  assert.equal(crash.meta.center, 'LACC');
  assert.equal(crash.meta.centerName, 'Los Angeles');
  assert.equal(crash.meta.kind, 'accident');
  assert.equal(crash.meta.severity, 'critical');
  assert.equal(crash.position.latitude, 34.126);
  assert.equal(crash.position.longitude, -118.274);
  assert.equal(works.meta.kind, 'roadworks');
  assert.equal(works.meta.location, 'I10 W & La Brea', 'entities decoded once');
  assert.equal(sig.meta.center, 'SACC');
  assert.equal(sig.meta.kind, 'jam');
  assert.equal(sig.meta.severity, 'critical');
});

test('the dispatcher narrative never leaves the parser', () => {
  const text = JSON.stringify(parseChpXml(SAMPLE));
  assert.equal(text.includes('7ABC123'), false);
  assert.equal(text.includes('DRIVER'), false);
  assert.equal(text.includes('Unit Enroute'), false);
  assert.equal(text.includes('6491234'), false, 'nothing beyond the header fields');
});

test('hostile or oversized documents are refused', () => {
  assert.deepEqual(parseChpXml(`<!DOCTYPE x [<!ENTITY a "b">]>${SAMPLE}`), []);
  assert.deepEqual(parseChpXml(null), []);
  assert.deepEqual(parseChpXml('x'.repeat(9 * 1024 * 1024)), []);
  // A coordinate outside California is a bad one.
  assert.equal(parseChpLatLon('51500000:120000'), null);
  assert.deepEqual(parseChpLatLon('34000000:118000000'), [-118, 34]);
  assert.deepEqual(parseChpLatLon('34000000:-118000000'), [-118, 34]);
  assert.equal(parseChpLatLon('-1:2'), null);
  assert.equal(chpText('"a &#60;b&#62; &#0; c"'), 'a <b> c');
});

test('Pacific times convert with daylight saving', () => {
  // October: PDT (UTC-7).
  assert.equal(
    new Date(parseChpTime('Oct 8 2026  9:15AM')).toISOString(),
    '2026-10-08T16:15:00.000Z',
  );
  // January: PST (UTC-8); 12:30AM is just after midnight.
  assert.equal(
    new Date(parseChpTime('Jan 3 2026 12:30AM')).toISOString(),
    '2026-01-03T08:30:00.000Z',
  );
  assert.equal(
    new Date(parseChpTime('Jul 4 2026 12:00PM')).toISOString(),
    '2026-07-04T19:00:00.000Z',
  );
  // 2026: DST from 8 March 02:00 to 1 November 02:00 local.
  assert.equal(pacificToUtcMs(2026, 2, 8, 1, 59), Date.UTC(2026, 2, 8, 9, 59));
  assert.equal(pacificToUtcMs(2026, 2, 8, 3, 0), Date.UTC(2026, 2, 8, 10, 0));
  assert.equal(pacificToUtcMs(2026, 10, 1, 2, 30), Date.UTC(2026, 10, 1, 10, 30));
  assert.equal(parseChpTime('yesterday'), null);
  assert.equal(parseChpTime('Foo 8 2026 9:15AM'), null);
});

test('kinds and severity from the log type', () => {
  assert.equal(chpKind('1182-Trfc Collision-No Inj'), 'accident');
  assert.equal(chpSeverity('1182-Trfc Collision-No Inj'), 'notable');
  assert.equal(chpKind('20002-Hit and Run No Injuries'), 'accident');
  assert.equal(chpKind('CLOSURE of a Road'), 'closure');
  assert.equal(chpSeverity('CLOSURE of a Road'), 'critical');
  assert.equal(chpKind('Road/Weather Conditions'), 'weather');
  assert.equal(chpKind('Maintenance'), 'roadworks');
  assert.equal(chpKind('Animal Hazard'), 'hazard');
  assert.equal(chpSeverity('Animal Hazard'), 'minor');
  assert.equal(chpSeverity('Wrong Way Driver'), 'critical');
});

test('the card and the demo document', () => {
  const [crash] = parseChpXml(SAMPLE);
  const card = describeChp(crash, Date.parse('2026-10-08T17:15:00Z'));
  assert.equal(card.title, 'Trfc Collision-Unkn Inj (1183)');
  const rows = Object.fromEntries(card.rows);
  assert.equal(rows.Dispatch, 'CHP Los Angeles');
  assert.equal(rows.Logged, '2026-10-08 16:15 UTC (1h ago)');
  assert.equal(rows.Detail, 'I5 N JNO LOS FELIZ');
  assert.equal(chpTypeLabel('SIG Alert'), 'SIG Alert');
  assert.match(chpSearchText(crash), /Los Feliz/);
  const demo = parseChpXml(demoChpXml(Date.parse('2026-10-08T17:00:00Z')));
  assert.equal(demo.length, 6);
  assert.ok(demo.every((n) => n.meta.demo && n.meta.timeMs > 0));
  assert.equal(describeChp(demo[0]).rows.at(-1)[1], 'demo (simulated)');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeShareHash, decodeShareHash, SHARE_MAX_LENGTH } from './state.js';

const FULL = {
  camera: { lat: 48.856614, lon: 2.3522219, alt: 150000.4, heading: 12.54, pitch: -35 },
  layers: ['flights', 'quakes'],
  sensor: 'nvg',
  imagery: 'satellite',
  terrain: 'flat',
  labels: { places: true, entities: false },
  track: { layer: 'radio', id: 'radio:9617a958-0601-11e8-ae97-52543be04c81' },
};

test('encodes a terse v=1 hash and decodes it back', () => {
  const hash = encodeShareHash(FULL);
  assert.equal(
    hash,
    '#v=1&lat=48.85661&lon=2.35222&alt=150000&heading=12.5&pitch=-35' +
      '&layers=flights,quakes&sensor=nvg&imagery=satellite&terrain=flat' +
      '&labels=places.1,entities.0&track=radio:radio:9617a958-0601-11e8-ae97-52543be04c81',
  );
  assert.deepEqual(decodeShareHash(hash), {
    version: 1,
    camera: { lat: 48.85661, lon: 2.35222, alt: 150000, heading: 12.5, pitch: -35 },
    layers: ['flights', 'quakes'],
    sensor: 'nvg',
    imagery: 'satellite',
    terrain: 'flat',
    labels: { places: true, entities: false },
    track: { layer: 'radio', id: 'radio:9617a958-0601-11e8-ae97-52543be04c81' },
  });
  // Without the leading '#', and percent-encoded by a messenger app, it still reads.
  assert.deepEqual(
    decodeShareHash('v=1&layers=flights%2Cquakes&track=flights%3A3c6444'),
    {
      version: 1,
      layers: ['flights', 'quakes'],
      track: { layer: 'flights', id: '3c6444' },
    },
  );
});

test('absent fields stay absent; empty lists mean none', () => {
  assert.deepEqual(decodeShareHash('#v=1'), { version: 1 });
  assert.deepEqual(decodeShareHash('#v=1&layers=&labels='), {
    version: 1,
    layers: [],
    labels: {},
  });
  assert.equal(encodeShareHash({}), '#v=1');
  assert.equal(encodeShareHash({ layers: [] }), '#v=1&layers=');
});

test('the encoder clamps, wraps and drops what does not fit its grammar', () => {
  const h = encodeShareHash({
    camera: { lat: 91, lon: 190, alt: 0, heading: -10, pitch: -120 },
    layers: ['flights', 'flights', 'Bad Key', 'quakes'],
    sensor: '<script>',
    track: { layer: 'flights', id: 'has space' },
  });
  assert.equal(
    h,
    '#v=1&lat=90&lon=-170&alt=1&heading=350&pitch=-90&layers=flights,quakes',
  );
  assert.ok(decodeShareHash(h));
  assert.equal(
    encodeShareHash({ camera: { lat: 1, lon: 2, alt: 3, heading: 359.97 } }).includes(
      'heading=0',
    ),
    true,
  );
  assert.equal(encodeShareHash({ camera: { lat: NaN, lon: 2, alt: 3 } }), '#v=1');
});

test('decoding fails closed on anything malformed', () => {
  const bad = [
    '',
    '#',
    '#lat=1&lon=2&alt=3', // no version
    '#v=2&lat=1&lon=2&alt=3', // unknown version
    '#v=1&v=1', // repeated key
    '#v=1&zoom=3', // unknown key
    '#v=1&lat', // no '='
    '#v=1&=x',
    '#v=1&lat=1&lon=2', // incomplete camera
    '#v=1&heading=10', // angle without a position
    '#v=1&lat=91&lon=0&alt=10',
    '#v=1&lat=1&lon=-181&alt=10',
    '#v=1&lat=1&lon=2&alt=0',
    '#v=1&lat=1e1&lon=2&alt=10', // exponent
    '#v=1&lat=Infinity&lon=2&alt=10',
    '#v=1&lat=0x10&lon=2&alt=10',
    '#v=1&lat=+1&lon=2&alt=10',
    '#v=1&lat=1&lon=2&alt=10&pitch=-91',
    '#v=1&lat=1&lon=2&alt=10&heading=361',
    '#v=1&layers=flights,flights',
    '#v=1&layers=Flights',
    '#v=1&layers=flights,,quakes',
    '#v=1&sensor=NVG',
    '#v=1&imagery=a b',
    '#v=1&labels=places',
    '#v=1&labels=places.2',
    '#v=1&labels=places.1,places.0',
    '#v=1&track=flights',
    '#v=1&track=:abc',
    '#v=1&track=flights:',
    '#v=1&track=flights:ab cd',
    '#v=1&track=flights:-abc',
    '#v=1&track=flights:%E0%A4%A', // broken percent-encoding
    `#v=1&layers=${'a'.repeat(SHARE_MAX_LENGTH)}`,
  ];
  for (const h of bad) assert.equal(decodeShareHash(h), null, h);
  assert.equal(decodeShareHash(null), null);
  assert.equal(
    decodeShareHash(
      `#v=1&layers=${Array.from({ length: 65 }, (_, i) => `l${i}`).join(',')}`,
    ),
    null,
  );
});

test('optional allowlists reject values the shell does not know', () => {
  const allow = {
    layerKeys: ['flights', 'quakes'],
    sensorModes: ['none', 'nvg', 'flir'],
    imageryIds: ['base', 'satellite', 'streets'],
    terrainIds: ['flat', 'terrain', 'photoreal'],
    labelKeys: ['places', 'entities'],
  };
  assert.ok(decodeShareHash(encodeShareHash({ ...FULL, track: undefined }), allow));
  assert.equal(decodeShareHash('#v=1&layers=flights,ufo', allow), null);
  assert.equal(decodeShareHash('#v=1&sensor=crt', allow), null);
  assert.equal(decodeShareHash('#v=1&imagery=google', allow), null);
  assert.equal(decodeShareHash('#v=1&terrain=lunar', allow), null);
  assert.equal(decodeShareHash('#v=1&labels=roads.1', allow), null);
  assert.equal(decodeShareHash('#v=1&track=ships:123', allow), null);
  assert.deepEqual(decodeShareHash('#v=1&track=flights:~a1b2c3', allow).track, {
    layer: 'flights',
    id: '~a1b2c3',
  });
});

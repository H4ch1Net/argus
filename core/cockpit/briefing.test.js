import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPEN_METEO_CURRENT,
  openMeteoQuery,
  reverseQuery,
  gnewsQuery,
  gdeltQuery,
  newsTerm,
  normalizePlace,
  parseRss,
  parseGdeltArtlist,
  normalizeWeather,
  weatherCodeText,
  windCardinal,
  weatherEffectProfile,
  weatherAltitudeFactors,
  distanceM,
  nearestContacts,
  formatDistance,
  needsRefresh,
  briefingPages,
  fetchNews,
  fetchBriefing,
  BRIEF_REFRESH_MS,
} from './briefing.js';

const SF = { latitude: 37.774929, longitude: -122.419416 };

test('query builders round coordinates and pin every parameter', () => {
  assert.deepEqual(openMeteoQuery(SF), {
    latitude: '37.77',
    longitude: '-122.42',
    current: OPEN_METEO_CURRENT,
    timezone: 'UTC',
  });
  assert.deepEqual(reverseQuery(SF), {
    format: 'jsonv2',
    lat: '37.77',
    lon: '-122.42',
    zoom: '10',
    addressdetails: '1',
    'accept-language': 'en',
  });
  // A camera past the antimeridian still asks for a valid longitude.
  assert.equal(openMeteoQuery({ latitude: 0, longitude: 190 }).longitude, '-170');
  assert.throws(() => openMeteoQuery({ latitude: 95, longitude: 0 }));
  assert.throws(() => reverseQuery({ latitude: NaN, longitude: 0 }));
  assert.deepEqual(gnewsQuery('Oakland'), {
    q: 'Oakland',
    hl: 'en-US',
    gl: 'US',
    ceid: 'US:en',
  });
  assert.deepEqual(gdeltQuery('Oakland'), {
    query: '"Oakland"',
    mode: 'artlist',
    format: 'json',
    maxrecords: '5',
    sort: 'datedesc',
    timespan: '48h',
  });
});

test('place: Nominatim reverse to a short label and a clean news term', () => {
  const place = normalizePlace({
    display_name: 'San Francisco, California, United States',
    address: {
      city: 'San Francisco',
      state: 'California',
      country: 'United States',
      country_code: 'us',
    },
  });
  assert.deepEqual(place, {
    label: 'San Francisco, California',
    locality: 'San Francisco',
    region: 'California',
    country: 'United States',
    countryCode: 'US',
  });
  assert.equal(newsTerm(place), 'San Francisco');
  assert.equal(normalizePlace({ address: { country: 'Iceland' } }).label, 'Iceland');
  assert.equal(normalizePlace({ error: 'Unable to geocode' }), null);
  // Quotes, backslashes and control characters never reach the news query.
  assert.equal(newsTerm({ locality: 'Bad "Town"\\\u0007 X' }), 'Bad Town X');
  assert.equal(newsTerm(null), null);
});

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>"Oakland" - Google News</title>
<item><title>Port of Oakland reopens berth - Example Times</title>
<link>https://news.google.com/rss/articles/abc?oc=5</link>
<pubDate>Wed, 07 Oct 2026 12:00:00 GMT</pubDate>
<source url="https://www.example-times.com">Example Times</source></item>
<item><title><![CDATA[Bay &amp; Bridge <b>traffic</b> &#169; update]]></title>
<link>https://news.google.com/rss/articles/def</link>
<pubDate>not a date</pubDate></item>
<item><title>Duplicate - Example Times</title><link>javascript:alert(1)</link></item>
<item><title>Port of Oakland reopens berth - Example Times</title>
<link>https://news.google.com/rss/articles/abc2</link>
<source url="https://www.example-times.com">Example Times</source></item>
</channel></rss>`;

test('RSS: titles, links, sources and dates; unsafe links and duplicates dropped', () => {
  const items = parseRss(RSS);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    title: 'Port of Oakland reopens berth - Example Times',
    url: 'https://news.google.com/rss/articles/abc?oc=5',
    domain: 'Example Times',
    publishedAt: '2026-10-07T12:00:00.000Z',
  });
  // CDATA unwrapped, entities decoded once, markup dropped.
  assert.equal(items[1].title, 'Bay & Bridge traffic \u00a9 update');
  assert.equal(items[1].domain, 'news.google.com');
  assert.equal(items[1].publishedAt, null);
  assert.equal(parseRss(RSS, 1).length, 1);
  assert.deepEqual(parseRss(''), []);
});

test('RSS: DOCTYPE and ENTITY declarations are refused, not expanded', () => {
  const bomb = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "aaaaaaaa"><!ENTITY b "&a;&a;&a;">]>
<rss><channel><item><title>&b;</title><link>https://x.example/</link></item></channel></rss>`;
  assert.throws(() => parseRss(bomb), /DOCTYPE\/ENTITY/);
  assert.throws(() => parseRss('<rss><!ENTITY x SYSTEM "file:///etc/passwd"></rss>'));
  assert.throws(() => parseRss('<rss><! doctype x></rss>'));
  // An undeclared entity reference is left as text, never resolved.
  const [item] = parseRss(
    '<rss><item><title>a &secret; b &#0; c</title><link>https://x.example/</link></item></rss>',
  );
  assert.equal(item.title, 'a &secret; b c');
  assert.throws(() => parseRss('x'.repeat(2 * 1024 * 1024 + 1)), /too large/);
});

test('GDELT artlist: compact dates, dedupe, plain-text errors', () => {
  const payload = {
    articles: [
      {
        url: 'https://www.example.org/a',
        title: '  Storm   nears coast ',
        seendate: '20261007T153000Z',
        domain: 'example.org',
        sourcecountry: 'United States',
      },
      { url: 'https://example.org/b', title: 'Storm nears coast', domain: 'example.org' },
      { url: 'ftp://example.org/c', title: 'Bad scheme' },
      { url: 'https://example.net/d', title: 'Other', seendate: '2026-10-06T01:00:00Z' },
    ],
  };
  const a = parseGdeltArtlist(JSON.stringify(payload));
  assert.equal(a.length, 2);
  assert.deepEqual(a[0], {
    title: 'Storm nears coast',
    url: 'https://www.example.org/a',
    domain: 'example.org',
    publishedAt: '2026-10-07T15:30:00Z',
    sourceCountry: 'United States',
  });
  assert.equal(a[1].publishedAt, '2026-10-06T01:00:00.000Z');
  assert.deepEqual(parseGdeltArtlist('Your query was too short or too long.'), []);
  assert.deepEqual(parseGdeltArtlist(null), []);
});

test('Open-Meteo current conditions normalize, with zone-less times read as UTC', () => {
  const w = normalizeWeather({
    current: {
      time: '2026-10-08T14:45',
      temperature_2m: 17.4,
      apparent_temperature: 14.9,
      precipitation: 0,
      weather_code: 2,
      cloud_cover: 40,
      wind_speed_10m: 22.3,
      wind_direction_10m: 300,
      visibility: 24140,
    },
  });
  assert.deepEqual(w, {
    observedAt: '2026-10-08T14:45:00.000Z',
    temperatureC: 17.4,
    apparentTemperatureC: 14.9,
    precipitationMm: 0,
    cloudCoverPct: 40,
    windKph: 22.3,
    windDirectionDeg: 300,
    visibilityM: 24140,
    weatherCode: 2,
    summary: 'PARTLY CLOUDY',
  });
  assert.equal(normalizeWeather({ current: { temperature_2m: null } }), null);
  assert.equal(normalizeWeather(null), null);
});

test('WMO codes as terse uppercase text', () => {
  assert.equal(weatherCodeText(0), 'CLEAR');
  assert.equal(weatherCodeText(45), 'FOG');
  assert.equal(weatherCodeText(65), 'HEAVY RAIN');
  assert.equal(weatherCodeText(99), 'THUNDERSTORM, HEAVY HAIL');
  assert.equal(weatherCodeText(52), 'DRIZZLE'); // not in the table: its family
  assert.equal(weatherCodeText(42), 'MIXED CONDITIONS');
  assert.equal(weatherCodeText(null), 'CONDITIONS UNKNOWN');
  assert.equal(weatherCodeText('x'), 'CONDITIONS UNKNOWN');
  for (let c = 0; c <= 99; c += 1) assert.match(weatherCodeText(c), /^[A-Z ,]+$/);
  assert.equal(windCardinal(300), 'NW');
  assert.equal(windCardinal(-10), 'N');
  assert.equal(windCardinal(null), '');
});

test('weather effect profile: the code picks the family, numbers set strength', () => {
  const none = weatherEffectProfile(null);
  assert.equal(none.available, false);
  assert.equal(none.rain, 0);
  const storm = weatherEffectProfile({
    weatherCode: 95,
    cloudCoverPct: 30,
    precipitationMm: 0,
    windKph: 47,
    visibilityM: 20000,
    windDirectionDeg: -90,
  });
  assert.equal(storm.available, true);
  assert.equal(storm.cloud, 0.92);
  assert.equal(storm.rain, 0.68);
  assert.equal(storm.storm, 0.55);
  assert.equal(storm.windDirectionDeg, 270);
  assert.ok(storm.wind > 0.4 && storm.wind < 0.6);
  const fog = weatherEffectProfile({ weatherCode: 45, visibilityM: 200 });
  assert.ok(fog.fog > 0.9);
  assert.equal(fog.rain, 0);
  const snow = weatherEffectProfile({ weatherCode: 73, precipitationMm: 8 });
  assert.equal(snow.snow, 1);
  const clear = weatherEffectProfile({ weatherCode: 0, cloudCoverPct: 0 });
  assert.equal(clear.cloud, 0);
  for (const v of Object.values(storm))
    if (typeof v === 'number' && v <= 1) assert.ok(v >= 0);
  assert.deepEqual(weatherAltitudeFactors(0), { precipitation: 1, cloud: 1, haze: 1 });
  assert.deepEqual(weatherAltitudeFactors(30000), {
    precipitation: 0,
    cloud: 0,
    haze: 0,
  });
  assert.equal(weatherAltitudeFactors(10000).precipitation, 0.5);
});

test('nearest contacts: sorted, capped, subject and far ones left out', () => {
  const subject = { id: 'me', position: { latitude: 37.6, longitude: -122.4 } };
  const recs = [
    { id: 'far', position: { latitude: 40, longitude: -122.4 } },
    { id: 'me', position: { latitude: 37.6, longitude: -122.4 } },
    { id: 'b', position: { latitude: 37.65, longitude: -122.4 } },
    { id: 'a', latitude: 37.61, longitude: -122.4 },
    { id: 'nopos' },
  ];
  const near = nearestContacts(subject, recs, { excludeId: 'me', maxDistanceM: 100_000 });
  assert.deepEqual(
    near.map((c) => c.id),
    ['a', 'b'],
  );
  assert.ok(Math.abs(near[0].distanceM - 1112) < 5);
  assert.equal(nearestContacts(subject, recs, { limit: 1, excludeId: 'me' }).length, 1);
  assert.deepEqual(nearestContacts({}, recs), []);
  assert.equal(formatDistance(4230), '4.2 KM');
  assert.equal(formatDistance(12_400), '12 KM');
  assert.equal(formatDistance(Infinity), 'DISTANCE UNKNOWN');
  assert.ok(
    Math.abs(distanceM(SF, { latitude: 34.0522, longitude: -118.2437 }) - 559_000) < 2000,
  );
});

test('refresh after 5 minutes or 25 km', () => {
  const last = { at: 0, point: SF };
  assert.equal(needsRefresh(null, SF, 0), true);
  assert.equal(needsRefresh(last, SF, BRIEF_REFRESH_MS - 1), false);
  assert.equal(needsRefresh(last, SF, BRIEF_REFRESH_MS), true);
  assert.equal(needsRefresh(last, { latitude: 38, longitude: -122.42 }, 1000), true);
});

test('briefing pages: plain lines with credits and selectable contacts', () => {
  const pages = briefingPages({
    place: { label: 'San Francisco, California' },
    weather: normalizeWeather({
      current: {
        temperature_2m: 17.4,
        apparent_temperature: 14.9,
        weather_code: 2,
        wind_speed_10m: 22.3,
        wind_direction_10m: 300,
        visibility: 24140,
        cloud_cover: 40,
      },
    }),
    news: {
      source: 'gdelt',
      articles: [
        {
          title: 'Storm nears coast',
          domain: 'example.org',
          url: 'https://example.org/a',
        },
      ],
    },
    contacts: [
      {
        id: 'abc123',
        layer: 'military',
        label: 'rch123',
        kind: 'Military',
        distanceM: 4230,
      },
    ],
  });
  assert.deepEqual(
    pages.map((p) => p.title),
    ['LIVE SIGNALS', 'REGIONAL NEWS', 'LOCAL INFO'],
  );
  assert.deepEqual(pages[0].lines[0], {
    text: 'RCH123',
    detail: 'MILITARY · 4.2 KM',
    target: { layer: 'military', id: 'abc123' },
  });
  assert.equal(pages[1].credit.text, 'GDELT Project');
  assert.deepEqual(
    pages[2].lines.map((l) => l.text),
    [
      'SAN FRANCISCO, CALIFORNIA',
      '17°C · PARTLY CLOUDY · FEELS 15°C',
      'WIND 22 KM/H NW · VIS 24 KM · CLOUD 40%',
    ],
  );
  assert.equal(pages[2].credit.text, 'Weather data by Open-Meteo.com');
  const empty = briefingPages({});
  assert.equal(empty[0].lines[0].text, 'NO CONTACTS NEARBY');
  assert.equal(empty[2].credit, null);
});

// A fake proxy client recording every call.
function fakeClient(answers) {
  const calls = [];
  const answer = async (feed, path, opts) => {
    calls.push({ feed, path, params: opts?.params });
    const a = answers[feed];
    if (a instanceof Error) throw a;
    if (a === undefined) throw new Error(`proxy ${feed} responded 404`);
    return typeof a === 'function' ? a(opts) : a;
  };
  return { calls, getJson: answer, getText: answer };
}

const REVERSE = {
  address: { city: 'Oakland', state: 'California', country: 'United States' },
};
const METEO = { current: { temperature_2m: 20, weather_code: 0 } };

test('fetchBriefing: place and weather, then Google News for the place', async () => {
  const c = fakeClient({ nominatim: REVERSE, openmeteo: METEO, gnews: RSS });
  const b = await fetchBriefing({
    proxyClient: c,
    ...SF,
    now: () => Date.parse('2026-10-08T00:00:00Z'),
  });
  assert.equal(b.status, 'ready');
  assert.equal(b.place.label, 'Oakland, California');
  assert.equal(b.weather.summary, 'CLEAR');
  assert.equal(b.news.source, 'gnews');
  assert.equal(b.news.articles.length, 2);
  assert.equal(b.retrievedAt, '2026-10-08T00:00:00.000Z');
  assert.deepEqual(
    c.calls.map((x) => `${x.feed}${x.path}`),
    ['nominatim/reverse', 'openmeteo/forecast', 'gnews/search'],
  );
  assert.equal(c.calls[2].params.q, 'Oakland');
});

test('news falls back to GDELT when Google News fails, is empty, or is switched off', async () => {
  const gdelt = JSON.stringify({ articles: [{ url: 'https://e.org/a', title: 'T' }] });
  const place = normalizePlace(REVERSE);
  const failed = await fetchNews({
    proxyClient: fakeClient({ gnews: new Error('502'), gdelt }),
    place,
  });
  assert.equal(failed.source, 'gdelt');
  assert.equal(failed.status, 'ready');
  const refused = await fetchNews({
    proxyClient: fakeClient({ gnews: '<!DOCTYPE x><rss></rss>', gdelt }),
    place,
  });
  assert.equal(refused.source, 'gdelt');
  const off = fakeClient({ gnews: RSS, gdelt });
  const r = await fetchNews({ proxyClient: off, place, sources: ['gdelt'] });
  assert.equal(r.source, 'gdelt');
  assert.deepEqual(
    off.calls.map((x) => x.feed),
    ['gdelt'],
  );
  const none = await fetchNews({ proxyClient: fakeClient({}), place: null });
  assert.equal(none.status, 'unavailable');
  const down = await fetchNews({ proxyClient: fakeClient({}), place });
  assert.equal(down.status, 'unavailable');
});

test('fetchBriefing is partial when a source fails, throws when none answer, honours abort', async () => {
  const partial = await fetchBriefing({
    proxyClient: fakeClient({ openmeteo: METEO }),
    ...SF,
  });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.place, null);
  assert.equal(partial.news.status, 'unavailable');
  await assert.rejects(
    fetchBriefing({ proxyClient: fakeClient({}), ...SF }),
    /no briefing/,
  );
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    fetchBriefing({
      proxyClient: fakeClient({ openmeteo: METEO }),
      ...SF,
      signal: ac.signal,
    }),
    { name: 'AbortError' },
  );
});

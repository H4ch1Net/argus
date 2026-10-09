import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickPreviews,
  placeCards,
  stillDue,
  ageLabel,
  shortName,
  PREVIEW_MAX,
  PREVIEW_REFRESH_MS,
} from './cameraPreviewsModel.js';

test('the k cameras nearest the middle, keeping those already shown', () => {
  const cands = [
    { id: 'a', x: 500, y: 300 },
    { id: 'b', x: 520, y: 300 },
    { id: 'c', x: 524, y: 300 },
    { id: 'd', x: 900, y: 300 },
  ];
  const ids = (l) => l.map((c) => c.id);
  assert.deepEqual(ids(pickPreviews(cands, { cx: 500, cy: 300, k: 2 })), ['a', 'b']);
  // c is shown already and only a little farther than b: it stays.
  assert.deepEqual(
    ids(pickPreviews(cands, { cx: 500, cy: 300, k: 2, current: new Set(['c']) })),
    ['a', 'c'],
  );
  // ... but not when much farther.
  assert.deepEqual(
    ids(pickPreviews(cands, { cx: 500, cy: 300, k: 2, current: new Set(['d']) })),
    ['a', 'b'],
  );
  assert.equal(pickPreviews(cands, { cx: 0, cy: 0, k: 0 }).length, 0);
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `${i}`, x: i, y: 0 }));
  assert.equal(pickPreviews(many, { cx: 0, cy: 0, k: 50 }).length, PREVIEW_MAX);
});

const area = { left: 0, top: 40, right: 1000, bottom: 700 };
const W = 128;
const H = 92;
const overlap = (a, b) =>
  a.x < b.x + W && b.x < a.x + W && a.y < b.y + H && b.y < a.y + H;

test('cards sit beside their icons, apart, inside the free area, with a leader corner', () => {
  const pts = [
    { id: 'a', x: 500, y: 350 },
    { id: 'b', x: 520, y: 360 },
    { id: 'c', x: 480, y: 340 },
    { id: 'd', x: 510, y: 330 },
  ];
  const cards = placeCards(pts, { w: W, h: H, area });
  assert.equal(cards.length, 4);
  for (let i = 0; i < cards.length; i += 1) {
    const c = cards[i];
    assert.ok(
      c.x >= area.left &&
        c.x + W <= area.right &&
        c.y >= area.top &&
        c.y + H <= area.bottom,
    );
    for (let j = 0; j < i; j += 1)
      assert.ok(!overlap(c, cards[j]), `${c.id} vs ${cards[j].id}`);
    // The leader leaves from a corner of the card.
    assert.ok(c.lx === c.x || c.lx === c.x + W);
    assert.ok(c.ly === c.y || c.ly === c.y + H);
  }
  assert.equal(
    new Set(cards.map((c) => c.slot)).size,
    4,
    'one slot each around the cluster',
  );
  // The first prefers up-right.
  assert.equal(placeCards([pts[0]], { w: W, h: H, area })[0].slot, 'ne');
});

test('a card keeps its slot while it fits; near an edge it flips inside', () => {
  const prev = new Map([['a', 'sw']]);
  assert.equal(
    placeCards([{ id: 'a', x: 500, y: 300 }], { w: W, h: H, area, prev })[0].slot,
    'sw',
  );
  // Against the top right corner: up-right does not fit, down-left does.
  const c = placeCards([{ id: 'e', x: 990, y: 50 }], { w: W, h: H, area })[0];
  assert.equal(c.slot, 'sw');
  assert.ok(c.x + W <= area.right && c.y >= area.top);
});

test('stills refresh at most once a minute, failures wait too', () => {
  assert.equal(stillDue({}, 0), true);
  assert.equal(stillDue({ loadedAt: 1000 }, 1000 + PREVIEW_REFRESH_MS - 1), false);
  assert.equal(stillDue({ loadedAt: 1000 }, 1000 + PREVIEW_REFRESH_MS), true);
  assert.equal(stillDue({ failedAt: 5000 }, 6000), false);
  assert.equal(stillDue({ loading: true }, 1e9), false);
  assert.equal(stillDue(null, 0), false);
  assert.equal(ageLabel(12_400), '12S');
  assert.equal(ageLabel(180_000), '3M');
  assert.equal(ageLabel(NaN), '--');
  assert.equal(shortName('  i-80 at   powell street westbound  '), 'I-80 AT POWELL ST…');
  assert.equal(shortName('I-80 : 6th Street'), 'I-80 6TH STREET');
  assert.equal(shortName(null), 'CAMERA');
});

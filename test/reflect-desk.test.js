'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { pendingReflectProposals, countAcceptsAfter, DAY } = require('../lib/reflect-desk');

const now = Date.UTC(2026, 6, 14); // 2026-07-14, fixed

function reflectLine(partial) {
  return {
    date: '2026-07-12',
    overrides_read: 6,
    outcomes_read: 9,
    proposals: 2,
    parallel_tracks: 1,
    ...partial,
  };
}

test('no metrics → no proposals, zero accepts (silent desk)', () => {
  const out = pendingReflectProposals({ metrics: {}, specs: [], now });
  assert.deepStrictEqual(out, { proposals: [], acceptsSinceLatest: 0 });
});

test('missing / non-array reflect-log tolerated', () => {
  const out = pendingReflectProposals({ metrics: { 'reflect-log': 'nope' }, specs: [], now });
  assert.strictEqual(out.proposals.length, 0);
});

test('recent entry with proposals > 0 surfaces with path + counts', () => {
  const out = pendingReflectProposals({
    metrics: { 'reflect-log': [reflectLine({ date: '2026-07-12' })] },
    now,
  });
  assert.strictEqual(out.proposals.length, 1);
  const p = out.proposals[0];
  assert.strictEqual(p.date, '2026-07-12');
  assert.strictEqual(p.path, '_metrics/reflect-2026-07-12.md');
  assert.strictEqual(p.proposals, 2);
  assert.strictEqual(p.parallelTracks, 1);
  assert.strictEqual(p.overridesRead, 6);
  assert.strictEqual(p.outcomesRead, 9);
});

test('zero-proposal runs stay silent (reflect ran, proposed nothing)', () => {
  const out = pendingReflectProposals({
    metrics: { 'reflect-log': [reflectLine({ proposals: 0 })] },
    now,
  });
  assert.strictEqual(out.proposals.length, 0);
});

test('entries older than the window are stale', () => {
  const metrics = {
    'reflect-log': [
      reflectLine({ date: '2026-06-20' }), // 24 days old
      reflectLine({ date: '2026-07-10' }), // 4 days old
    ],
  };
  const out = pendingReflectProposals({ metrics, now });
  assert.deepStrictEqual(out.proposals.map(p => p.date), ['2026-07-10']);
});

test('windowDays override widens the freshness window', () => {
  const metrics = { 'reflect-log': [reflectLine({ date: '2026-06-20' })] };
  assert.strictEqual(pendingReflectProposals({ metrics, now }).proposals.length, 0);
  assert.strictEqual(pendingReflectProposals({ metrics, now, windowDays: 30 }).proposals.length, 1);
});

test('append-only dedupe: last line for a date wins', () => {
  const metrics = {
    'reflect-log': [
      reflectLine({ date: '2026-07-12', proposals: 1 }),
      reflectLine({ date: '2026-07-12', proposals: 3 }),
    ],
  };
  const out = pendingReflectProposals({ metrics, now });
  assert.strictEqual(out.proposals.length, 1);
  assert.strictEqual(out.proposals[0].proposals, 3);
});

test('a later zero-proposal rerun for the same date silences the earlier line', () => {
  const metrics = {
    'reflect-log': [
      reflectLine({ date: '2026-07-12', proposals: 2 }),
      reflectLine({ date: '2026-07-12', proposals: 0 }),
    ],
  };
  assert.strictEqual(pendingReflectProposals({ metrics, now }).proposals.length, 0);
});

test('multiple pending proposals sort newest first', () => {
  const metrics = {
    'reflect-log': [
      reflectLine({ date: '2026-07-05' }),
      reflectLine({ date: '2026-07-12' }),
    ],
  };
  const out = pendingReflectProposals({ metrics, now });
  assert.deepStrictEqual(out.proposals.map(p => p.date), ['2026-07-12', '2026-07-05']);
});

test('bad or missing dates are skipped, not crashed on', () => {
  const metrics = {
    'reflect-log': [
      reflectLine({ date: 'not-a-date' }),
      reflectLine({ date: '' }),
      null,
      'garbage',
      reflectLine({ date: '2026-07-12' }),
    ],
  };
  const out = pendingReflectProposals({ metrics, now });
  assert.deepStrictEqual(out.proposals.map(p => p.date), ['2026-07-12']);
});

test('acceptsSinceLatest counts review-log accepts after the proposal day', () => {
  const metrics = {
    'reflect-log': [reflectLine({ date: '2026-07-10' })],
    'review-log': [
      { date: '2026-07-09T10:00:00Z', action: 'accepted' },  // before → no
      { date: '2026-07-10T22:00:00Z', action: 'accepted' },  // same day → fed the proposal
      { date: '2026-07-13T09:00:00Z', action: 'accepted' },  // after → yes
      { date: '2026-07-13T10:00:00Z', action: 'kicked-back' }, // not an accept
    ],
  };
  const out = pendingReflectProposals({ metrics, now });
  assert.strictEqual(out.acceptsSinceLatest, 1);
});

test('acceptsSinceLatest falls back to done specs stamped accepted_at (max, not sum)', () => {
  const metrics = {
    'reflect-log': [reflectLine({ date: '2026-07-10' })],
    'review-log': [{ date: '2026-07-13T09:00:00Z', action: 'accepted' }],
  };
  const specs = [
    { stage: 'done', meta: { accepted_at: '2026-07-13T09:00:00Z' } }, // same accept, both views
    { stage: 'done', meta: { accepted_at: '2026-07-13T11:00:00Z' } },
    { stage: 'done', meta: {} },              // historical unstamped accept
    { stage: 'in-review', meta: { accepted_at: '2026-07-13T12:00:00Z' } }, // not done
  ];
  const out = pendingReflectProposals({ metrics, specs, now });
  assert.strictEqual(out.acceptsSinceLatest, 2); // max(1 from log, 2 from specs)
});

test('countAcceptsAfter is exported and cutoff-inclusive', () => {
  const n = countAcceptsAfter({
    metrics: { 'review-log': [{ date: '2026-07-11T00:00:00Z', action: 'accepted' }] },
    cutoff: Date.UTC(2026, 6, 11),
  });
  assert.strictEqual(n, 1);
});

test('DAY constant exported for callers', () => {
  assert.strictEqual(DAY, 86400000);
});

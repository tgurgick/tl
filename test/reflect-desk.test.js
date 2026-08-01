'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  pendingReflectProposals, countAcceptsAfter, DAY,
  proposalIdFromRecord, normalizeProposalId,
  recordReflectProposalDecision, REFLECT_REVIEW_LOG,
} = require('../lib/reflect-desk');

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

test('unread: recent entry with proposals > 0 surfaces with stable id + path + counts', () => {
  const out = pendingReflectProposals({
    metrics: { 'reflect-log': [reflectLine({ date: '2026-07-12' })] },
    now,
  });
  assert.strictEqual(out.proposals.length, 1);
  const p = out.proposals[0];
  assert.strictEqual(p.id, 'reflect-2026-07-12');
  assert.strictEqual(p.date, '2026-07-12');
  assert.strictEqual(p.path, '_metrics/reflect-2026-07-12.md');
  assert.strictEqual(p.proposals, 2);
  assert.strictEqual(p.parallelTracks, 1);
  assert.strictEqual(p.overridesRead, 6);
  assert.strictEqual(p.outcomesRead, 9);
  assert.strictEqual(p.reviewStatus, 'unread');
});

test('proposalIdFromRecord / normalizeProposalId are stable from date or path', () => {
  assert.strictEqual(proposalIdFromRecord({ date: '2026-07-12' }), 'reflect-2026-07-12');
  assert.strictEqual(proposalIdFromRecord({ path: '_metrics/reflect-2026-07-01.md' }), 'reflect-2026-07-01');
  assert.strictEqual(normalizeProposalId('2026-07-12'), 'reflect-2026-07-12');
  assert.strictEqual(normalizeProposalId('reflect-2026-07-12'), 'reflect-2026-07-12');
  assert.strictEqual(normalizeProposalId('nope'), null);
});

test('zero-proposal runs stay silent (reflect ran, proposed nothing)', () => {
  const out = pendingReflectProposals({
    metrics: { 'reflect-log': [reflectLine({ proposals: 0 })] },
    now,
  });
  assert.strictEqual(out.proposals.length, 0);
});

test('legacy unmarked proposals older than the window are stale', () => {
  const metrics = {
    'reflect-log': [
      reflectLine({ date: '2026-06-20' }), // 24 days old, no review marker
      reflectLine({ date: '2026-07-10' }), // 4 days old
    ],
  };
  const out = pendingReflectProposals({ metrics, now });
  assert.deepStrictEqual(out.proposals.map(p => p.date), ['2026-07-10']);
});

test('windowDays override widens the legacy freshness window', () => {
  const metrics = { 'reflect-log': [reflectLine({ date: '2026-06-20' })] };
  assert.strictEqual(pendingReflectProposals({ metrics, now }).proposals.length, 0);
  assert.strictEqual(pendingReflectProposals({ metrics, now, windowDays: 30 }).proposals.length, 1);
});

test('append-only dedupe: last reflect-log line for a date wins', () => {
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
      { date: '2026-07-09T10:00:00Z', action: 'accepted' },
      { date: '2026-07-10T22:00:00Z', action: 'accepted' },
      { date: '2026-07-13T09:00:00Z', action: 'accepted' },
      { date: '2026-07-13T10:00:00Z', action: 'kicked-back' },
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
    { stage: 'done', meta: { accepted_at: '2026-07-13T09:00:00Z' } },
    { stage: 'done', meta: { accepted_at: '2026-07-13T11:00:00Z' } },
    { stage: 'done', meta: {} },
    { stage: 'in-review', meta: { accepted_at: '2026-07-13T12:00:00Z' } },
  ];
  const out = pendingReflectProposals({ metrics, specs, now });
  assert.strictEqual(out.acceptsSinceLatest, 2);
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

// ---------- review markers ----------

test('reviewed / dismissed / applied clear the desk regardless of age', () => {
  for (const action of ['reviewed', 'dismissed', 'applied']) {
    const metrics = {
      'reflect-log': [reflectLine({ date: '2026-07-12' })],
      'reflect-review-log': [{
        date: '2026-07-13T10:00:00.000Z',
        proposal_id: 'reflect-2026-07-12',
        proposal_date: '2026-07-12',
        path: '_metrics/reflect-2026-07-12.md',
        action,
        actor: 'human-cli',
        via: 'cli',
      }],
    };
    const out = pendingReflectProposals({ metrics, now });
    assert.strictEqual(out.proposals.length, 0, action);
  }
});

test('viewing alone (no review-log row) does not dismiss — proposal stays unread', () => {
  const metrics = {
    'reflect-log': [reflectLine({ date: '2026-07-12' })],
    'reflect-review-log': [],
  };
  assert.strictEqual(pendingReflectProposals({ metrics, now }).proposals.length, 1);
});

test('legacy: unmarked proposal past window degrades; marked old proposal stays cleared', () => {
  const metrics = {
    'reflect-log': [
      reflectLine({ date: '2026-06-01' }), // ancient, unmarked → hidden by window
      reflectLine({ date: '2026-06-05' }), // ancient but dismissed → cleared by marker
    ],
    'reflect-review-log': [{
      date: '2026-06-06T00:00:00.000Z',
      proposal_id: 'reflect-2026-06-05',
      action: 'dismissed',
      actor: 'human-cli',
      via: 'cli',
    }],
  };
  assert.strictEqual(pendingReflectProposals({ metrics, now }).proposals.length, 0);
});

test('recordReflectProposalDecision appends; duplicate action never rewrites history', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-reflect-review-'));
  try {
    const a = recordReflectProposalDecision(ws, {
      proposalId: '2026-07-12', action: 'reviewed', actor: 'trevor', via: 'cli',
      now: new Date('2026-07-14T10:00:00.000Z'),
    });
    assert.equal(a.ok, true);
    assert.equal(a.row.proposal_id, 'reflect-2026-07-12');
    assert.equal(a.row.action, 'reviewed');
    assert.equal(a.path, '_metrics/' + REFLECT_REVIEW_LOG);

    const b = recordReflectProposalDecision(ws, {
      proposalId: 'reflect-2026-07-12', action: 'reviewed', actor: 'trevor', via: 'cli',
      now: new Date('2026-07-14T11:00:00.000Z'), note: 'looked again',
    });
    assert.equal(b.ok, true);

    const file = path.join(ws, '_metrics', REFLECT_REVIEW_LOG);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2); // append-only — never rewritten
    const rows = lines.map(JSON.parse);
    assert.equal(rows[0].note, undefined);
    assert.equal(rows[1].note, 'looked again');
    assert.equal(rows[0].date, '2026-07-14T10:00:00.000Z');
    assert.equal(rows[1].date, '2026-07-14T11:00:00.000Z');

    // Desk still treats as handled (last line wins)
    const metrics = {
      'reflect-log': [reflectLine({ date: '2026-07-12' })],
      'reflect-review-log': rows,
    };
    assert.equal(pendingReflectProposals({ metrics, now }).proposals.length, 0);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('recordReflectProposalDecision refuses bad action / id', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-reflect-bad-'));
  try {
    assert.throws(() => recordReflectProposalDecision(ws, { proposalId: 'x', action: 'reviewed' }), /proposal id/);
    assert.throws(() => recordReflectProposalDecision(ws, { proposalId: '2026-07-12', action: 'noop' }), /action must/);
    assert.equal(fs.existsSync(path.join(ws, '_metrics', REFLECT_REVIEW_LOG)), false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('last review action wins when history has multiple dispositions', () => {
  const metrics = {
    'reflect-log': [reflectLine({ date: '2026-07-12' })],
    'reflect-review-log': [
      { proposal_id: 'reflect-2026-07-12', action: 'reviewed', date: '2026-07-13T10:00:00Z' },
      { proposal_id: 'reflect-2026-07-12', action: 'dismissed', date: '2026-07-13T11:00:00Z' },
    ],
  };
  assert.equal(pendingReflectProposals({ metrics, now }).proposals.length, 0);
});

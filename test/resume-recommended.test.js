'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  chooseRecommendedNext,
  collectOpenLoops,
  rankOpenLoops,
  isGoalStarving,
  isIntentStarving,
} = require('../lib/resume-recommended');

const DAY = 86400000;
const now = Date.UTC(2026, 6, 14); // fixed

function spec(partial) {
  return {
    title: partial.title || partial.path || 'spec',
    path: partial.path || 'specs/x/',
    stage: partial.stage || 'ready',
    mtime: partial.mtime != null ? partial.mtime : now,
    notes: partial.notes,
    feedback: partial.feedback,
    meta: {
      priority: 'p2',
      status: 'ready',
      intent: '',
      type: 'feature',
      ...(partial.meta || {}),
    },
  };
}

function thread(partial) {
  return {
    title: partial.title || 'thread',
    path: partial.path || 'threads/t.md',
    mtime: partial.mtime != null ? partial.mtime : now,
    meta: {
      type: 'question',
      status: 'open',
      linked_spec: '',
      ...(partial.meta || {}),
    },
  };
}

function intent(partial) {
  return {
    title: partial.title || 'intent',
    path: partial.path || 'intents/i.md',
    meta: {
      status: 'approved',
      goals: [],
      ...(partial.meta || {}),
    },
  };
}

// ── chooseRecommendedNext ─────────────────────────────────────────────

test('recommended-next: blocking open thread outranks top ready backlog', () => {
  const ready = spec({
    title: 'Ship feature',
    path: 'specs/ship-feature/',
    stage: 'ready',
    meta: { priority: 'p0' },
  });
  const blocker = thread({
    title: 'Which API?',
    path: 'threads/2026-07-01-which-api.md',
    meta: { type: 'question', status: 'open', linked_spec: 'specs/ship-feature/' },
  });
  const r = chooseRecommendedNext({
    specs: [ready],
    threads: [blocker],
    goals: [{ id: 'g1', weight: 1, description: 'Ship' }],
    intents: [],
  });
  assert.equal(r.kind, 'blocking-thread');
  assert.equal(r.item.path, blocker.path);
});

test('recommended-next: open risk blocking top spec also outranks backlog', () => {
  const ready = spec({ path: 'specs/hot/', meta: { priority: 'p1' } });
  const risk = thread({
    meta: { type: 'risk', status: 'open', linked_spec: 'in-progress/hot/' }, // slug match
  });
  // linked_spec slug matches ready spec slug "hot"
  const r = chooseRecommendedNext({ specs: [ready], threads: [risk], goals: [], intents: [] });
  assert.equal(r.kind, 'blocking-thread');
});

test('recommended-next: top-weighted goal with zero active specs → starving-goal', () => {
  const goals = [
    { id: 'alpha', weight: 0.7, description: 'Primary' },
    { id: 'beta', weight: 0.3, description: 'Secondary' },
  ];
  const intents = [intent({ path: 'intents/primary.md', meta: { status: 'approved', goals: ['alpha'] } })];
  // only a ready spec under beta — alpha has nothing
  const specs = [spec({ path: 'specs/beta-work/', meta: { intent: 'intents/primary-beta.md', priority: 'p0' } })];
  const r = chooseRecommendedNext({ specs, threads: [], goals, intents });
  assert.equal(r.kind, 'starving-goal');
  assert.equal(r.item.id, 'alpha');
});

test('recommended-next: all-done intent/goal is NOT starving — falls through to empty/clear', () => {
  const goals = [{ id: 'alpha', weight: 1, description: 'Primary' }];
  const intents = [intent({ path: 'intents/primary.md', meta: { status: 'decomposed', goals: ['alpha'] } })];
  const specs = [
    spec({ path: 'done/one/', stage: 'done', feedback: true, meta: { intent: 'intents/primary.md' } }),
    spec({ path: 'done/two/', stage: 'done', feedback: true, meta: { intent: 'intents/primary.md' } }),
  ];
  assert.equal(isGoalStarving(goals[0], { specs, intents }), false);
  assert.equal(isIntentStarving(intents[0], specs), false);
  const r = chooseRecommendedNext({ specs, threads: [], goals, intents });
  assert.equal(r.kind, 'empty');
});

test('recommended-next: longest-idle in-progress with NOTES.md surfaces as kickback before ready', () => {
  const ready = spec({
    path: 'specs/new-work/',
    meta: { priority: 'p0', intent: 'intents/i.md' },
  });
  const stalled = spec({
    title: 'Kicked work',
    path: 'in-progress/kicked-work/',
    stage: 'in-progress',
    mtime: now - 3 * DAY,
    notes: '## 2026-07-10 — kicked back\nFix the acceptance criteria.\n',
    meta: { status: 'in-progress', intent: 'intents/i.md' },
  });
  const newerNotes = spec({
    path: 'in-progress/newer-notes/',
    stage: 'in-progress',
    mtime: now - 1 * DAY,
    notes: '## 2026-07-13 — note\nMinor tweak\n',
    meta: { status: 'in-progress', intent: 'intents/i.md' },
  });
  const r = chooseRecommendedNext({
    specs: [ready, stalled, newerNotes],
    threads: [],
    goals: [{ id: 'g', weight: 1, description: 'G' }],
    intents: [intent({ path: 'intents/i.md', meta: { goals: ['g'], status: 'approved' } })],
  });
  assert.equal(r.kind, 'kickback');
  assert.equal(r.item.path, 'in-progress/kicked-work/'); // longest idle among NOTES
  assert.match(r.reason, /kickback/i);
});

test('recommended-next: ordinary ready wins when no blockers, starve, or NOTES', () => {
  const ready = spec({ path: 'specs/ship/', meta: { priority: 'p1' } });
  const inprog = spec({
    path: 'in-progress/fine/',
    stage: 'in-progress',
    mtime: now - 1 * DAY,
    meta: { status: 'in-progress' },
  });
  const goals = [{ id: 'g', weight: 1 }];
  const intents = [intent({ path: 'intents/i.md', meta: { goals: ['g'], status: 'approved' } })];
  ready.meta.intent = 'intents/i.md';
  const r = chooseRecommendedNext({ specs: [ready, inprog], threads: [], goals, intents });
  assert.equal(r.kind, 'spec');
  assert.equal(r.item.path, 'specs/ship/');
});

// ── open loops: NOTES before idle; blocking + starve ranking ──────────

test('open loops: in-progress with NOTES.md ranks before ordinary idle', () => {
  const withNotes = spec({
    path: 'in-progress/noted/',
    stage: 'in-progress',
    mtime: now - 2 * DAY,
    notes: '## 2026-07-12 — kicked back\nRedo tests\n',
  });
  const idle = spec({
    path: 'in-progress/stale/',
    stage: 'in-progress',
    mtime: now - 20 * DAY,
  });
  const loops = collectOpenLoops({ specs: [withNotes, idle], now });
  const kinds = loops.map(l => l.kind);
  assert.ok(kinds.includes('notes'));
  assert.ok(kinds.includes('idle'));
  const ranked = rankOpenLoops(loops, {});
  assert.equal(ranked[0].kind, 'notes');
  assert.ok(ranked.findIndex(l => l.kind === 'notes') < ranked.findIndex(l => l.kind === 'idle'));
});

test('open loops: blocking thread of focus outranks generic backlog loops', () => {
  const focus = spec({ path: 'specs/top/', meta: { priority: 'p0' } });
  const blocking = thread({
    path: 'threads/block.md',
    meta: { type: 'decision', status: 'open', linked_spec: 'specs/top/' },
    mtime: now - 1,
  });
  const oldQuestion = thread({
    path: 'threads/old.md',
    meta: { type: 'question', status: 'open' },
    mtime: now - 30 * DAY,
  });
  const loops = collectOpenLoops({ specs: [focus], threads: [blocking, oldQuestion], now });
  const ranked = rankOpenLoops(loops, { focusItem: focus });
  assert.equal(ranked[0].item.path, 'threads/block.md');
});

test('open loops: does not flag all-done intent as starving', () => {
  const intents = [intent({ path: 'intents/done-intent.md', meta: { status: 'decomposed', goals: ['g'] } })];
  const specs = [
    spec({ path: 'done/a/', stage: 'done', feedback: true, meta: { intent: 'intents/done-intent.md' } }),
  ];
  const goals = [{ id: 'g', weight: 1, description: 'Done goal' }];
  const loops = collectOpenLoops({ specs, threads: [], intents, goals, now });
  assert.equal(loops.filter(l => l.kind === 'starving').length, 0);
});

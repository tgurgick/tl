'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  filesToTouch, isReadOnly, specSlug, dependencySatisfied, activeConflicts, selectBatch,
} = require('../lib/batch');

// build a spec object shaped like readStage produces
function mk(slug, { priority = 'p2', type = 'feature', deps, files, mtime = 0, readonlyBody, stage = 'ready' } = {}) {
  let body = '';
  if (readonlyBody) body = '## Objective\ndo a thing\n';
  else if (files !== undefined) {
    body = '## Scope\n\n### Files to touch\n' + files.map(f => `- \`${f}\``).join('\n') + '\n';
  } else {
    body = '## Scope\n\n### Files to touch\n';   // declared but empty
  }
  const folder = stage === 'ready' ? 'specs' : stage;
  return { path: `${folder}/${slug}/`, stage, meta: { priority, type, depends_on: deps }, body, mtime };
}

test('specSlug normalizes across stages', () => {
  assert.equal(specSlug('specs/foo/'), 'foo');
  assert.equal(specSlug('done/foo/'), 'foo');
  assert.equal(specSlug('in-progress/foo/SPEC.md'), 'foo');
  assert.equal(specSlug('foo'), 'foo');
});

test('dependencySatisfied: specs/foo/ is satisfied by a done foo (by slug)', () => {
  const done = new Set(['foo']);   // slug set, as cmdRun builds it from done paths
  assert.equal(dependencySatisfied('specs/foo/', done), true);
  assert.equal(dependencySatisfied('specs/bar/', done), false);
});

test('isReadOnly: research yes; code no; empty-scope code no; no-scope yes', () => {
  assert.equal(isReadOnly(mk('r', { type: 'research', readonlyBody: true })), true);
  assert.equal(isReadOnly(mk('c', { files: ['a.js'] })), false);
  assert.equal(isReadOnly(mk('empty', { files: undefined })), false);   // heading present, no bullets
  assert.equal(isReadOnly(mk('plain', { type: 'feature', readonlyBody: true })), true); // no scope section
});

test('filesToTouch parses backtick bullets incl. comma lists', () => {
  const s = mk('x', { files: ['a.js', 'b.js, c.js'] });
  assert.deepEqual(filesToTouch(s), ['a.js', 'b.js', 'c.js']);
});

test('selectBatch: disjoint code specs batch together', () => {
  const { batch, held } = selectBatch([
    mk('a', { files: ['a.js'] }),
    mk('b', { files: ['b.js'] }),
  ], new Set());
  assert.equal(batch.length, 2);
  assert.equal(held.length, 0);
});

test('selectBatch: overlapping files hold the second', () => {
  const { batch, held } = selectBatch([
    mk('a', { files: ['shared.js'], mtime: 1 }),
    mk('b', { files: ['shared.js'], mtime: 2 }),
  ], new Set());
  assert.equal(batch.length, 1);
  assert.equal(held.length, 1);
  assert.match(held[0].holdReason, /file conflict/);
});

test('selectBatch: unmet dependency is blocked', () => {
  const { batch, held } = selectBatch([
    mk('needsdep', { files: ['a.js'], deps: ['specs/missing/'] }),
  ], new Set());          // nothing done
  assert.equal(batch.length, 0);
  assert.match(held[0].holdReason, /blocked on/);
});

test('selectBatch: met dependency (by slug) lets the spec run', () => {
  const { batch } = selectBatch([
    mk('needsdep', { files: ['a.js'], deps: ['specs/dep/'] }),
  ], new Set(['dep']));   // dep is done
  assert.equal(batch.length, 1);
});

test('selectBatch: caps at 4, holds the overflow', () => {
  const specs = ['a', 'b', 'c', 'd', 'e'].map((s, i) => mk(s, { files: [s + '.js'], mtime: i }));
  const { batch, held } = selectBatch(specs, new Set());
  assert.equal(batch.length, 4);
  assert.equal(held.length, 1);
  assert.match(held[0].holdReason, /capped/);
});

test('selectBatch: undeclared scope conflicts with other code specs', () => {
  const undeclared = { path: 'specs/u/', meta: { priority: 'p2', type: 'feature' }, body: '## Objective\nx\n', mtime: 5 };
  // note: no "Files to touch" section at all → treated read-only, so it does NOT conflict.
  // an undeclared *code* spec is one with the section but no parseable files:
  const { batch, held } = selectBatch([
    mk('code', { files: ['a.js'], mtime: 1 }),
    mk('empty', { files: undefined, mtime: 2 }),   // has heading, no files → code, undeclared
  ], new Set());
  assert.equal(batch.length, 1);
  assert.match(held[0].holdReason, /undeclared scope/);
  void undeclared;
});

// ---------- active-work conflict guard ----------

test('activeConflicts: maps locked files to their stage/slug source, skips read-only', () => {
  const active = activeConflicts([
    mk('inprog', { stage: 'in-progress', files: ['bin/tl.js'] }),
    mk('research', { stage: 'in-progress', type: 'research', readonlyBody: true }), // read-only locks nothing
  ]);
  assert.equal(active.files.get('bin/tl.js'), 'in-progress/inprog');
  assert.equal(active.codeActive, true);
  assert.equal(active.files.has('anything-else.js'), false);
});

test('activeConflicts: dirty git paths lock files under a "dirty git" label', () => {
  const active = activeConflicts([], ['lib/foo.js', '']);
  assert.equal(active.files.get('lib/foo.js'), 'dirty git');
  assert.equal(active.codeActive, true);
  assert.equal(active.files.size, 1);   // blank path skipped
});

test('selectBatch: holds a ready spec that conflicts with an in-progress spec', () => {
  const active = activeConflicts([mk('foo', { stage: 'in-progress', files: ['bin/tl.js'] })]);
  const { batch, held } = selectBatch([mk('r', { files: ['bin/tl.js'] })], new Set(), { active });
  assert.equal(batch.length, 0);
  assert.match(held[0].holdReason, /conflicts with in-progress\/foo on bin\/tl\.js/);
});

test('selectBatch: holds a ready spec that conflicts with a tests-stage spec', () => {
  const active = activeConflicts([mk('foo', { stage: 'tests', files: ['a.js'] })]);
  const { batch, held } = selectBatch([mk('r', { files: ['a.js'] })], new Set(), { active });
  assert.equal(batch.length, 0);
  assert.match(held[0].holdReason, /conflicts with tests\/foo on a\.js/);
});

test('selectBatch: holds a ready spec that conflicts with an in-review spec', () => {
  const active = activeConflicts([mk('foo', { stage: 'in-review', files: ['a.js'] })]);
  const { batch, held } = selectBatch([mk('r', { files: ['a.js'] })], new Set(), { active });
  assert.equal(batch.length, 0);
  assert.match(held[0].holdReason, /conflicts with in-review\/foo on a\.js/);
});

test('selectBatch: holds a ready spec that conflicts with a dirty git path', () => {
  const active = activeConflicts([], ['bin/tl.js']);
  const { batch, held } = selectBatch([mk('r', { files: ['bin/tl.js'] })], new Set(), { active });
  assert.equal(batch.length, 0);
  assert.match(held[0].holdReason, /conflicts with dirty git on bin\/tl\.js/);
});

test('selectBatch: read-only ready spec never conflicts with active work', () => {
  const active = activeConflicts([mk('foo', { stage: 'in-progress', files: ['a.js'] })], ['b.js']);
  const { batch, held } = selectBatch([mk('r', { type: 'research', readonlyBody: true })], new Set(), { active });
  assert.equal(batch.length, 1);
  assert.equal(held.length, 0);
});

test('selectBatch: undeclared-scope code spec is held when any code work is active', () => {
  const active = activeConflicts([mk('foo', { stage: 'in-progress', files: ['unrelated.js'] })]);
  const { batch, held } = selectBatch([mk('empty', { files: undefined })], new Set(), { active });
  assert.equal(batch.length, 0);
  assert.match(held[0].holdReason, /undeclared scope — conflicts with active code work/);
});

test('selectBatch: a non-overlapping ready spec still runs alongside active work', () => {
  const active = activeConflicts([mk('foo', { stage: 'in-progress', files: ['locked.js'] })]);
  const { batch, held } = selectBatch([mk('r', { files: ['free.js'] })], new Set(), { active });
  assert.equal(batch.length, 1);
  assert.equal(held.length, 0);
});

test('selectBatch: no active set behaves exactly as before (back-compat)', () => {
  const { batch, held } = selectBatch([
    mk('a', { files: ['a.js'] }),
    mk('b', { files: ['b.js'] }),
  ], new Set());
  assert.equal(batch.length, 2);
  assert.equal(held.length, 0);
});

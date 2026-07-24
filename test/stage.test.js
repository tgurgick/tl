'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EDGES, moveSpec, observedStages } = require('../lib/stage');

function withWs(fn) {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-stage-'));
  for (const stage of ['triage', 'specs', 'in-progress', 'tests', 'in-review', 'done']) {
    fs.mkdirSync(path.join(wsDir, stage), { recursive: true });
  }
  try { return fn(wsDir); }
  finally { fs.rmSync(wsDir, { recursive: true, force: true }); }
}

function writeSpec(wsDir, stage, slug, claimedBy = '') {
  const dir = path.join(wsDir, stage, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SPEC.md'),
    `---\ntitle: "${slug}"\nstatus: "${stage}"\n${claimedBy ? `claimed_by: "${claimedBy}"\n` : ''}---\n`);
  fs.writeFileSync(path.join(dir, 'payload.txt'), 'preserved');
  return dir;
}

test('forward builder move preserves the folder and reports the edge', () => withWs(wsDir => {
  writeSpec(wsDir, 'in-progress', 'alpha', 'codex');
  const got = moveSpec({ wsDir, slug: 'alpha', from: 'in-progress', to: 'tests', actor: 'codex', role: 'builder' });
  assert.deepEqual(got, {
    ok: true, slug: 'alpha', from: 'in-progress', to: 'tests', actor: 'codex', role: 'builder',
    observed_stage: 'in-progress', resulting_stage: 'tests',
    from_path: 'in-progress/alpha/', to_path: 'tests/alpha/',
  });
  assert.equal(fs.readFileSync(path.join(wsDir, 'tests', 'alpha', 'payload.txt'), 'utf8'), 'preserved');
}));

test('stale observed stage refuses and reports the current stage', () => withWs(wsDir => {
  writeSpec(wsDir, 'tests', 'alpha', 'claude');
  const got = moveSpec({ wsDir, slug: 'alpha', from: 'in-progress', to: 'tests', actor: 'claude', role: 'builder' });
  assert.equal(got.reason, 'stale-stage');
  assert.equal(got.observed_stage, 'tests');
}));

test('missing and duplicate slugs refuse as stale board state', () => withWs(wsDir => {
  let got = moveSpec({ wsDir, slug: 'ghost', from: 'specs', to: 'in-progress', actor: 'codex', role: 'builder' });
  assert.equal(got.reason, 'stale-stage');
  assert.deepEqual(got.observed_stages, []);
  writeSpec(wsDir, 'specs', 'dupe');
  writeSpec(wsDir, 'tests', 'dupe');
  assert.deepEqual(observedStages(wsDir, 'dupe'), ['specs', 'tests']);
  got = moveSpec({ wsDir, slug: 'dupe', from: 'specs', to: 'in-progress', actor: 'codex', role: 'builder' });
  assert.equal(got.reason, 'stale-stage');
  assert.deepEqual(got.observed_stages, ['specs', 'tests']);
}));

test('foreign claimant blocks a builder edge without moving anything', () => withWs(wsDir => {
  writeSpec(wsDir, 'in-progress', 'alpha', 'claude');
  const got = moveSpec({ wsDir, slug: 'alpha', from: 'in-progress', to: 'tests', actor: 'codex', role: 'builder' });
  assert.equal(got.reason, 'foreign-claim');
  assert.equal(got.claimed_by, 'claude');
  assert.ok(fs.existsSync(path.join(wsDir, 'in-progress', 'alpha')));
}));

test('illegal role or edge refuses; actor identity is required', () => withWs(wsDir => {
  writeSpec(wsDir, 'specs', 'alpha');
  assert.equal(moveSpec({ wsDir, slug: 'alpha', from: 'specs', to: 'tests', actor: 'codex', role: 'builder' }).reason, 'illegal-transition');
  assert.equal(moveSpec({ wsDir, slug: 'alpha', from: 'specs', to: 'in-progress', actor: 'codex', role: 'verifier' }).reason, 'illegal-transition');
  assert.equal(moveSpec({ wsDir, slug: 'alpha', from: 'specs', to: 'in-progress', role: 'builder' }).reason, 'actor-required');
  assert.equal(moveSpec({ wsDir, slug: '../escape', from: 'specs', to: 'in-progress', actor: 'x', role: 'builder' }).reason, 'illegal-transition');
}));

test('done requires the review role and a named actor', () => withWs(wsDir => {
  writeSpec(wsDir, 'in-review', 'alpha', 'claude');
  assert.equal(moveSpec({ wsDir, slug: 'alpha', from: 'in-review', to: 'done', actor: 'codex', role: 'verifier' }).reason, 'done-requires-review-actor');
  assert.equal(moveSpec({ wsDir, slug: 'alpha', from: 'in-review', to: 'done', role: 'review' }).reason, 'done-requires-review-actor');
  const got = moveSpec({ wsDir, slug: 'alpha', from: 'in-review', to: 'done', actor: 'trevor', role: 'review' });
  assert.equal(got.ok, true);
}));

test('recorded kickback and reclaim edges require their explicit roles', () => withWs(wsDir => {
  writeSpec(wsDir, 'in-review', 'kick', 'claude');
  assert.equal(moveSpec({ wsDir, slug: 'kick', from: 'in-review', to: 'in-progress', actor: 'trevor', role: 'review' }).ok, true);
  writeSpec(wsDir, 'in-progress', 'release', 'claude');
  assert.equal(moveSpec({ wsDir, slug: 'release', from: 'in-progress', to: 'specs', actor: 'trevor', role: 'reclaim' }).ok, true);
  writeSpec(wsDir, 'tests', 'redo', 'claude');
  assert.equal(moveSpec({ wsDir, slug: 'redo', from: 'tests', to: 'in-progress', actor: 'trevor', role: 'review' }).ok, true);
  assert.deepEqual(EDGES['in-review>in-progress'], ['review']);
}));

test('recovery and verifier roles may act beyond the builder claim', () => withWs(wsDir => {
  writeSpec(wsDir, 'in-progress', 'recover', 'claude');
  assert.equal(moveSpec({ wsDir, slug: 'recover', from: 'in-progress', to: 'tests', actor: 'codex', role: 'recovery' }).ok, true);
  const got = moveSpec({ wsDir, slug: 'recover', from: 'tests', to: 'in-review', actor: 'gemini', role: 'verifier' });
  assert.equal(got.ok, true);
}));

test('destination collision refuses without overwriting either folder', () => withWs(wsDir => {
  writeSpec(wsDir, 'in-progress', 'alpha', 'codex');
  writeSpec(wsDir, 'tests', 'alpha', 'codex');
  const got = moveSpec({ wsDir, slug: 'alpha', from: 'in-progress', to: 'tests', actor: 'codex', role: 'builder' });
  assert.equal(got.reason, 'destination-exists');
  assert.deepEqual(got.observed_stages, ['in-progress', 'tests']);
  assert.equal(fs.readFileSync(path.join(wsDir, 'tests', 'alpha', 'payload.txt'), 'utf8'), 'preserved');
}));

test('two attempts are CAS-safe: the loser sees the resulting stage', () => withWs(wsDir => {
  writeSpec(wsDir, 'specs', 'alpha');
  const first = moveSpec({ wsDir, slug: 'alpha', from: 'specs', to: 'in-progress', actor: 'codex', role: 'builder' });
  const second = moveSpec({ wsDir, slug: 'alpha', from: 'specs', to: 'in-progress', actor: 'cursor', role: 'builder' });
  assert.equal(first.ok, true);
  assert.equal(second.reason, 'stale-stage');
  assert.equal(second.observed_stage, 'in-progress');
}));

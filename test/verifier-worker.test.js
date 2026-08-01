'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  RESULT_BEGIN, RESULT_END, scrubEnvironment, normalizePolicy, buildGeminiInvocation,
  parseStructuredResult, runIsolatedVerification, recordVerificationOutcome,
  acquireVerifierLease, heartbeatVerifierLease, releaseVerifierLease,
  verifierLeasePath, verifierLeaseState,
  verifierQueue, verifierEligibility, verifierConcurrency, selectVerifierWork,
  appendVerifierResult, readVerifierResults, manifestParity, runLeasedVerification,
} = require('../lib/verifier-worker');
const { createHandoff } = require('../lib/handoff');
const { moveSpec } = require('../lib/stage');

test('scrubEnvironment removes common credential variables', () => {
  const env = scrubEnvironment({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'x', GEMINI_API_KEY: 'y', JIRA_EMAIL: 'z' });
  assert.deepEqual(env, { PATH: '/bin' });
});

test('policy rejects dangerous bypass and commands in review-only mode', () => {
  assert.throws(() => normalizePolicy({ command: ['agy', '--dangerously-skip-permissions'] }), /forbidden/);
  assert.throws(() => normalizePolicy({ mode: 'review-only', allow_commands: ['npm test'] }), /cannot declare/);
});

test('Gemini invocation forces sandboxed plan mode and keeps -p last', () => {
  const got = buildGeminiInvocation({ command: ['agy'], mode: 'verify' }, 'brief');
  assert.deepEqual(got, { file: 'agy', args: ['--sandbox', '--mode', 'plan', '-p', 'brief'] });
});

test('structured result markers are required and validated', () => {
  const got = parseStructuredResult(`noise\n${RESULT_BEGIN}\n{"verdict":"pass","notes":["ok"],"proposed_mutations":[]}\n${RESULT_END}`);
  assert.equal(got.verdict, 'pass');
  assert.throws(() => parseStructuredResult('{"verdict":"pass"}'), /markers/);
});

function fakeRun(sequence, calls) {
  return (file, args, opts) => {
    calls.push({ file, args, opts });
    const next = sequence.shift();
    if (!next) throw new Error('unexpected spawn: ' + file);
    return next;
  };
}

test('clean pass runs allowlisted checks, writes nothing canonical, and cleans isolation', () => {
  const calls = [], removed = [];
  const spawn = fakeRun([
    { status: 0, stdout: 'tests ok', stderr: '' },
    { status: 0, stdout: `${RESULT_BEGIN}\n{"verdict":"pass","notes":[],"proposed_mutations":[]}\n${RESULT_END}`, stderr: '' },
    { status: 0, stdout: '', stderr: '' },
  ], calls);
  const result = runIsolatedVerification({
    repo: '/canonical', brief: 'check it', policy: { command: ['agy'], allow_commands: ['npm test'] }, spawn,
    createWorktree: () => '/isolated', removeWorktree: (...args) => removed.push(args), env: { PATH: '/bin', GEMINI_API_KEY: 'secret' },
  });
  assert.equal(result.status, 'pass');
  assert.equal(calls[0].file, '/bin/sh');
  assert.equal(calls[1].file, 'agy');
  assert.equal(calls[1].opts.env.GEMINI_API_KEY, undefined);
  assert.equal(removed.length, 1);
});

test('proposed or actual mutation raises to human and never becomes a pass', () => {
  const spawn = fakeRun([
    { status: 0, stdout: `${RESULT_BEGIN}\n{"verdict":"pass","notes":["change it"],"proposed_mutations":[{"file":"a.js","reason":"bug"}]}\n${RESULT_END}`, stderr: '' },
    { status: 0, stdout: ' M b.js\n', stderr: '' },
  ], []);
  const result = runIsolatedVerification({
    repo: '/canonical', brief: 'review', policy: { command: ['agy'], mode: 'review-only' }, spawn,
    createWorktree: () => '/isolated', removeWorktree: () => {}, env: { PATH: '/bin' },
  });
  assert.equal(result.status, 'human-decision-required');
  assert.deepEqual(result.proposed_mutations.map(x => x.file), ['a.js', 'b.js']);
});

test('failed allowlisted check blocks even when model says pass', () => {
  const spawn = fakeRun([
    { status: 1, stdout: '', stderr: 'red' },
    { status: 0, stdout: `${RESULT_BEGIN}\n{"verdict":"pass","notes":[],"proposed_mutations":[]}\n${RESULT_END}`, stderr: '' },
    { status: 0, stdout: '', stderr: '' },
  ], []);
  const result = runIsolatedVerification({
    repo: '/canonical', brief: 'review', policy: { command: ['agy'], allow_commands: ['npm test'] }, spawn,
    createWorktree: () => '/isolated', removeWorktree: () => {}, env: { PATH: '/bin' },
  });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /acceptance command failed/);
});

function workspaceSpec() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-verifier-record-'));
  const dir = path.join(ws, 'tests', 'demo');
  fs.mkdirSync(path.join(dir, 'outcome'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SPEC.md'), '---\ntitle: Demo\ntype: feature\nstatus: tests\nawaiting_verifier: true\n---\n\n# Demo\n');
  return { ws, dir };
}

test('mutation proposal writes notes and stays blocked at tests', t => {
  const { ws, dir } = workspaceSpec(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const got = recordVerificationOutcome({ wsDir: ws, slug: 'demo', builder: 'cursor', verifier: 'gemini', result: {
    status: 'human-decision-required', notes: ['behavior concern'], proposed_mutations: [{ file: 'a.js', reason: 'fix it' }],
  } });
  assert.equal(got.path, 'tests/demo/');
  assert.match(fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8'), /No mutation was applied/);
  assert.match(fs.readFileSync(path.join(dir, 'SPEC.md'), 'utf8'), /status: "blocked"/);
  assert.equal(fs.existsSync(path.join(ws, 'in-review', 'demo')), false);
});

test('clean pass is the only outcome that trusted TL advances', t => {
  const { ws } = workspaceSpec(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const got = recordVerificationOutcome({ wsDir: ws, slug: 'demo', builder: 'cursor', verifier: 'gemini', result: {
    status: 'pass', verdict: 'pass', notes: [], proposed_mutations: [],
  } });
  assert.equal(got.path, 'in-review/demo/');
  const spec = fs.readFileSync(path.join(ws, 'in-review', 'demo', 'SPEC.md'), 'utf8');
  assert.match(spec, /verified_by: "gemini"/);
  assert.match(spec, /verification_type: "independent"/);
});

// ---------- leased, read-only verifier queue ----------

// A workspace with one spec folder at `stage`, claimed by `builder`, carrying
// FEEDBACK + BUILDER.diff. `manifest: true` binds them with a real V1 handoff.
function leaseWorkspace({ slug = 'demo', stage = 'tests', builder = 'cursor', manifest = true, awaiting = false } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-verifier-lease-'));
  const dir = path.join(ws, stage, slug);
  fs.mkdirSync(path.join(dir, 'outcome'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SPEC.md'), [
    '---', 'title: Demo', 'type: feature', `status: ${stage}`,
    `claimed_by: "${builder}"`, `awaiting_verifier: ${awaiting}`, '---', '', '# Demo', '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'outcome', 'FEEDBACK.md'), '# Feedback\n\nbuilt it\n');
  fs.writeFileSync(path.join(dir, 'outcome', 'BUILDER.diff'), 'diff --git a/x b/x\n');
  if (manifest) {
    const made = createHandoff({
      specDir: dir, builder, from_stage: 'in-progress', to_stage: 'tests',
      base_commit: 'abc1234', run_id: 'run-1', tests: [{ command: 'npm test', ok: true }],
    });
    assert.equal(made.ok, true, 'fixture handoff must be valid: ' + JSON.stringify(made));
  }
  return { ws, dir, slug };
}

function ageLease(ws, slug, minutes) {
  const file = verifierLeasePath(ws, slug);
  const past = new Date(Date.now() - minutes * 60000);
  fs.utimesSync(file, past, past);
}

test('queue: tests/ plus a valid manifest is canonical; legacy awaiting_verifier stays eligible; broken manifests do not', t => {
  const { ws } = leaseWorkspace({ slug: 'canonical', manifest: true });
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  // legacy: FEEDBACK + diff + awaiting flag, no manifest
  const legacy = path.join(ws, 'tests', 'legacy-work');
  fs.mkdirSync(path.join(legacy, 'outcome'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'SPEC.md'), '---\ntitle: L\nstatus: tests\nclaimed_by: "codex"\nawaiting_verifier: true\n---\n');
  fs.writeFileSync(path.join(legacy, 'outcome', 'FEEDBACK.md'), 'f\n');
  fs.writeFileSync(path.join(legacy, 'outcome', 'BUILDER.diff'), 'd\n');
  // invalid: manifest whose artifact bytes were tampered with after binding
  const bad = leaseWorkspaceSpecInto(ws, 'tampered');
  fs.writeFileSync(path.join(bad, 'outcome', 'FEEDBACK.md'), 'rewritten after handoff\n');

  const q = verifierQueue(ws);
  const bySlug = Object.fromEntries(q.eligible.map(e => [e.slug, e]));
  assert.equal(bySlug['canonical'].eligibility, 'manifest');
  assert.equal(bySlug['legacy-work'].eligibility, 'legacy');
  assert.equal(bySlug['tampered'], undefined);
  const inel = q.ineligible.find(e => e.slug === 'tampered');
  assert.equal(inel.reason, 'invalid-manifest');
});

// Second manifest-backed spec inside an existing workspace.
function leaseWorkspaceSpecInto(ws, slug, { builder = 'cursor', stage = 'tests' } = {}) {
  const dir = path.join(ws, stage, slug);
  fs.mkdirSync(path.join(dir, 'outcome'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SPEC.md'), `---\ntitle: ${slug}\nstatus: ${stage}\nclaimed_by: "${builder}"\nawaiting_verifier: false\n---\n`);
  fs.writeFileSync(path.join(dir, 'outcome', 'FEEDBACK.md'), `feedback ${slug}\n`);
  fs.writeFileSync(path.join(dir, 'outcome', 'BUILDER.diff'), `diff ${slug}\n`);
  const made = createHandoff({
    specDir: dir, builder, from_stage: 'in-progress', to_stage: 'tests',
    base_commit: 'abc1234', run_id: 'run-' + slug, tests: [{ command: 'npm test', ok: true }],
  });
  assert.equal(made.ok, true);
  return dir;
}

test('queue: a spec already held for a human decision is not re-verifiable work', t => {
  const { ws, dir } = leaseWorkspace({ slug: 'held' });
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  let spec = fs.readFileSync(path.join(dir, 'SPEC.md'), 'utf8');
  spec = spec.replace('status: tests', 'status: tests\nverifier_status: "human-decision-required"');
  fs.writeFileSync(path.join(dir, 'SPEC.md'), spec);
  const q = verifierQueue(ws);
  assert.equal(q.eligible.length, 0);
  assert.equal(q.ineligible[0].reason, 'human-decision-required');
});

test('lease: acquisition is atomic and exclusive — contention loses with a typed refusal', t => {
  const { ws, slug } = leaseWorkspace();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const a = acquireVerifierLease({ wsDir: ws, slug, verifier: 'gemini' });
  assert.equal(a.ok, true);
  assert.equal(a.takeover, false);
  const b = acquireVerifierLease({ wsDir: ws, slug, verifier: 'codex' });
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'lease-held');
  assert.equal(b.holder, 'gemini');
});

test('lease: builder exclusion is enforced at acquisition', t => {
  const { ws, slug } = leaseWorkspace({ builder: 'gemini' });
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const got = acquireVerifierLease({ wsDir: ws, slug, verifier: 'gemini' });
  assert.equal(got.ok, false);
  assert.equal(got.reason, 'builder-exclusion');
  assert.equal(got.builder, 'gemini');
  // a different verifier is fine
  assert.equal(acquireVerifierLease({ wsDir: ws, slug, verifier: 'codex' }).ok, true);
});

test('lease: heartbeat renews only for the holder and reports a lost lease honestly', t => {
  const { ws, slug } = leaseWorkspace();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  assert.equal(acquireVerifierLease({ wsDir: ws, slug, verifier: 'gemini' }).ok, true);
  ageLease(ws, slug, 59); // near expiry
  const hb = heartbeatVerifierLease({ wsDir: ws, slug, verifier: 'gemini' });
  assert.equal(hb.ok, true);
  assert.equal(verifierLeaseState({ wsDir: ws, slug }).state, 'held'); // renewed
  const foreign = heartbeatVerifierLease({ wsDir: ws, slug, verifier: 'codex' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, 'not-lease-holder');
  assert.deepEqual(releaseVerifierLease({ wsDir: ws, slug, verifier: 'gemini' }), { ok: true, released: true });
  const lost = heartbeatVerifierLease({ wsDir: ws, slug, verifier: 'gemini' });
  assert.equal(lost.reason, 'lease-lost');
});

test('lease: stale leases are taken over; fresh ones are not', t => {
  const { ws, slug } = leaseWorkspace();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  assert.equal(acquireVerifierLease({ wsDir: ws, slug, verifier: 'gemini' }).ok, true);
  ageLease(ws, slug, 61); // past the 60m default ttl
  assert.equal(verifierLeaseState({ wsDir: ws, slug }).state, 'stale');
  const takeover = acquireVerifierLease({ wsDir: ws, slug, verifier: 'codex' });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.takeover, true);
  assert.equal(takeover.taken_over_from, 'gemini');
  // the evicted holder can no longer heartbeat or release
  assert.equal(heartbeatVerifierLease({ wsDir: ws, slug, verifier: 'gemini' }).reason, 'not-lease-holder');
  assert.equal(releaseVerifierLease({ wsDir: ws, slug, verifier: 'gemini' }).reason, 'not-lease-holder');
});

test('lease: release is holder-checked and idempotent', t => {
  const { ws, slug } = leaseWorkspace();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  assert.equal(acquireVerifierLease({ wsDir: ws, slug, verifier: 'gemini' }).ok, true);
  assert.equal(releaseVerifierLease({ wsDir: ws, slug, verifier: 'codex' }).reason, 'not-lease-holder');
  assert.deepEqual(releaseVerifierLease({ wsDir: ws, slug, verifier: 'gemini' }), { ok: true, released: true });
  assert.deepEqual(releaseVerifierLease({ wsDir: ws, slug, verifier: 'gemini' }), { ok: true, released: false });
});

test('concurrency: calm cap permits distinct specs while one verifier owns each spec', t => {
  const { ws } = leaseWorkspace({ slug: 'spec-a' });
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  leaseWorkspaceSpecInto(ws, 'spec-b');
  leaseWorkspaceSpecInto(ws, 'spec-c');
  leaseWorkspaceSpecInto(ws, 'mine', { builder: 'gemini' });
  // spec-b is already owned by another verifier
  assert.equal(acquireVerifierLease({ wsDir: ws, slug: 'spec-b', verifier: 'codex' }).ok, true);

  const sel = selectVerifierWork({ wsDir: ws, verifier: 'gemini', cap: 2 });
  assert.equal(sel.active, 1); // codex's live lease counts against the calm cap
  assert.deepEqual(sel.batch.map(e => e.slug).sort(), ['spec-a']); // cap 2 − 1 active = 1 pick
  const reasons = Object.fromEntries(sel.skipped.map(s => [s.slug, s.reason]));
  assert.equal(reasons['spec-b'], 'leased');
  assert.equal(reasons['mine'], 'builder-exclusion');
  assert.equal(reasons['spec-c'], 'concurrency-cap');

  // fallback-on-garbage for the dial
  assert.equal(verifierConcurrency({ verification: { verifier_concurrency: 'lots' } }), 2);
  assert.equal(verifierConcurrency({ verification: { verifier_concurrency: 3 } }), 3);
  assert.equal(verifierConcurrency(null), 2);
});

test('results: VERIFICATIONS.jsonl is append-only and prior rows survive later verdicts', t => {
  const { ws, dir } = leaseWorkspace();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  appendVerifierResult(dir, { verifier: 'gemini', builder: 'cursor', verdict: 'concerns', notes: ['round 1'] });
  appendVerifierResult(dir, { verifier: 'codex', builder: 'cursor', verdict: 'pass' });
  const rows = readVerifierResults(dir);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].verdict, 'concerns');
  assert.deepEqual(rows[0].notes, ['round 1']);
  assert.equal(rows[1].verdict, 'pass');
});

test('parity: handoff bytes changed during verification are a mutation finding, never a pass', t => {
  const { ws, slug, dir } = leaseWorkspace();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const got = runLeasedVerification({
    wsDir: ws, slug, verifier: 'gemini',
    verify: ({ specDir }) => {
      // a misbehaving verifier edits a manifest-bound artifact, then claims pass
      fs.writeFileSync(path.join(specDir, 'outcome', 'FEEDBACK.md'), 'verifier rewrote this\n');
      return { status: 'pass', verdict: 'pass', notes: [], proposed_mutations: [] };
    },
  });
  assert.equal(got.ok, true);
  assert.equal(got.status, 'human-decision-required');
  assert.equal(got.parity, false);
  assert.equal(fs.existsSync(path.join(ws, 'in-review', slug)), false);
  assert.match(fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8'), /human decision required/);
  const rows = readVerifierResults(dir);
  assert.equal(rows[0].verdict, 'human-decision-required');
  assert.ok(rows[0].proposed_mutations.some(m => m.file === 'outcome/FEEDBACK.md'));
  assert.equal(verifierLeaseState({ wsDir: ws, slug }).state, 'free'); // released even on findings
});

test('mutation refusal: interactive proposals record human-decision-required and touch no source', t => {
  const { ws, slug, dir } = leaseWorkspace();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const specBefore = fs.readFileSync(path.join(dir, 'outcome', 'BUILDER.diff'), 'utf8');
  let heartbeats = 0;
  const got = runLeasedVerification({
    wsDir: ws, slug, verifier: 'gemini',
    verify: ({ heartbeat }) => {
      const hb = heartbeat();
      assert.equal(hb.ok, true);
      heartbeats++;
      return {
        status: 'human-decision-required', verdict: 'human-decision-required',
        notes: ['a.js needs a null guard'], proposed_mutations: [{ file: 'a.js', reason: 'null guard' }],
      };
    },
  });
  assert.equal(heartbeats, 1);
  assert.equal(got.status, 'human-decision-required');
  assert.equal(got.path, `tests/${slug}/`);
  assert.equal(fs.readFileSync(path.join(dir, 'outcome', 'BUILDER.diff'), 'utf8'), specBefore);
  assert.match(fs.readFileSync(path.join(dir, 'outcome', 'ALIGNMENT.md'), 'utf8'), /human-decision-required/);
  assert.match(fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8'), /No mutation was applied/);
  assert.match(fs.readFileSync(path.join(dir, 'SPEC.md'), 'utf8'), /status: "blocked"/);
});

test('clean leased pass advances through the guarded verifier edge and stops at in-review', t => {
  const { ws, slug } = leaseWorkspace();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const got = runLeasedVerification({
    wsDir: ws, slug, verifier: 'gemini', runId: 'v-1',
    verify: () => ({ status: 'pass', verdict: 'pass', notes: [], proposed_mutations: [] }),
  });
  assert.equal(got.ok, true);
  assert.equal(got.status, 'in-review');
  assert.equal(got.eligibility, 'manifest');
  const dest = path.join(ws, 'in-review', slug);
  assert.equal(fs.existsSync(dest), true);
  assert.equal(fs.existsSync(path.join(ws, 'done', slug)), false);
  const rows = readVerifierResults(dest);
  assert.equal(rows[0].verdict, 'pass');
  assert.equal(rows[0].eligibility, 'manifest');
  assert.equal(rows[0].run_id, 'v-1');
  assert.equal(verifierLeaseState({ wsDir: ws, slug }).state, 'free');
  // the review ceiling: the verifier role has NO edge into done/
  const ceiling = moveSpec({ wsDir: ws, slug, from: 'in-review', to: 'done', actor: 'gemini', role: 'verifier' });
  assert.equal(ceiling.ok, false);
  assert.equal(ceiling.reason, 'done-requires-review-actor');
});

test('legacy awaiting_verifier work verifies end-to-end during migration', t => {
  const { ws, slug } = leaseWorkspace({ manifest: false, awaiting: true });
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  assert.equal(verifierEligibility(path.join(ws, 'tests', slug), { awaiting_verifier: true }, 'tests').eligibility, 'legacy');
  const got = runLeasedVerification({
    wsDir: ws, slug, verifier: 'gemini',
    verify: () => ({ status: 'pass', verdict: 'pass', notes: [], proposed_mutations: [] }),
  });
  assert.equal(got.ok, true);
  assert.equal(got.status, 'in-review');
  assert.equal(got.eligibility, 'legacy');
  assert.equal(readVerifierResults(path.join(ws, 'in-review', slug))[0].eligibility, 'legacy');
});

test('guarded move: a stale board refuses the advance instead of forcing it', t => {
  const { ws, slug } = leaseWorkspace();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, 'in-review', slug), { recursive: true }); // duplicate slug downstream
  assert.throws(() => recordVerificationOutcome({
    wsDir: ws, slug, builder: 'cursor', verifier: 'gemini',
    result: { status: 'pass', verdict: 'pass', notes: [], proposed_mutations: [] },
  }), /guarded stage move refused/);
  assert.equal(fs.existsSync(path.join(ws, 'tests', slug, 'SPEC.md')), true); // never left tests/
});

test('parity: interactive and headless mutation findings produce the same recorded contract', t => {
  // headless: the isolated runner's human-decision result, recorded
  const headless = workspaceSpec();
  t.after(() => fs.rmSync(headless.ws, { recursive: true, force: true }));
  recordVerificationOutcome({ wsDir: headless.ws, slug: 'demo', builder: 'cursor', verifier: 'gemini', result: {
    status: 'human-decision-required', notes: [], proposed_mutations: [{ file: 'a.js', reason: 'bug' }],
  } });
  // interactive: the leased path with the same proposal
  const interactive = leaseWorkspace({ slug: 'demo' });
  t.after(() => fs.rmSync(interactive.ws, { recursive: true, force: true }));
  runLeasedVerification({
    wsDir: interactive.ws, slug: 'demo', verifier: 'gemini',
    verify: () => ({ status: 'human-decision-required', notes: [], proposed_mutations: [{ file: 'a.js', reason: 'bug' }] }),
  });
  for (const { ws } of [headless, interactive]) {
    const dir = path.join(ws, 'tests', 'demo');
    assert.match(fs.readFileSync(path.join(dir, 'outcome', 'ALIGNMENT.md'), 'utf8'), /verdict: "human-decision-required"/);
    assert.match(fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8'), /No mutation was applied/);
    assert.match(fs.readFileSync(path.join(dir, 'SPEC.md'), 'utf8'), /status: "blocked"/);
    assert.equal(fs.existsSync(path.join(ws, 'in-review', 'demo')), false);
    assert.equal(readVerifierResults(dir)[0].verdict, 'human-decision-required');
  }
});

test('manifestParity: untouched handoffs pass; legacy has no baseline to violate', t => {
  const { ws, dir } = leaseWorkspace();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'outcome', 'HANDOFF.json'), 'utf8'));
  assert.equal(manifestParity(dir, manifest).ok, true);
  assert.deepEqual(manifestParity(dir, null), { ok: true, legacy: true, changed: [] });
  fs.appendFileSync(path.join(dir, 'outcome', 'FEEDBACK.md'), 'tamper\n');
  const broken = manifestParity(dir, manifest);
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, 'artifact-changed');
});

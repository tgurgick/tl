'use strict';
// Canonical lifecycle regression — ready→in-review, recovery, contention, human-only done.
// Fake lanes + injected seams only; no network, credentials, or paid agent CLIs.
// See test/fixtures/canonical-e2e/ and docs/canonical-e2e-path.md § Optional dogfood.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { moveSpec } = require('../lib/stage');
const { setFrontmatterField } = require('../lib/frontmatter');
const { parseFrontmatter } = require('../lib/parse');
const { createHandoff, validateHandoff, classifyHandoff } = require('../lib/handoff');
const { classifyRecovery, recoverPreparedHandoff } = require('../lib/stall');
const {
  acquireBuilderLease, finalizeBuilderHandoff,
  validateVerifierLane, verifierLaneAvailable,
  verifyTick, applyVerifyHumanDecision, builderLeasePath,
} = require('../lib/worker');
const {
  acquireVerifierLease, runLeasedVerification,
  verifierQueue, verifierLeasePath, verifierLeaseState,
} = require('../lib/verifier-worker');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'canonical-e2e');
const HOUR = 3600000;
const NOW = Date.parse('2026-07-31T15:00:00Z');

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-e2e-repo-'));
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'e2e@example.com');
  git(dir, 'config', 'user.name', 'e2e');
  fs.copyFileSync(path.join(FIX, 'repo-seed', 'README.md'), path.join(dir, 'README.md'));
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-m', 'seed');
  return dir;
}

function withFixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-e2e-root-'));
  const name = 'e2e-ws';
  const ws = path.join(root, 'projects', name);
  const repo = mkRepo();
  fs.mkdirSync(ws, { recursive: true });
  for (const s of ['triage', 'specs', 'in-progress', 'tests', 'in-review', 'done', '_metrics', '_dispatch']) {
    fs.mkdirSync(path.join(ws, s), { recursive: true });
  }
  fs.copyFileSync(path.join(FIX, 'TRIAGE.yml'), path.join(ws, 'TRIAGE.yml'));
  const project = fs.readFileSync(path.join(FIX, 'PROJECT.md.template'), 'utf8')
    .replace('{{NAME}}', name)
    .replace('{{REPO}}', repo);
  fs.writeFileSync(path.join(ws, 'PROJECT.md'), project);
  try {
    return fn({ root, name, ws, repo });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

function writeReadySpec(ws, slug, { repo } = {}) {
  const dir = path.join(ws, 'specs', slug);
  fs.mkdirSync(dir, { recursive: true });
  const seed = fs.readFileSync(path.join(FIX, 'specs', 'demo-feature', 'SPEC.md'), 'utf8');
  let body = seed.replace('demo-feature', slug).replace('status: "ready"', 'status: "ready"');
  if (repo) body = body.replace('---\n', `---\nrepo: "${repo}"\n`, 1);
  fs.writeFileSync(path.join(dir, 'SPEC.md'), body);
  return dir;
}

function claim(ws, slug, actor = 'claude') {
  const got = moveSpec({ wsDir: ws, slug, from: 'specs', to: 'in-progress', actor, role: 'builder' });
  assert.equal(got.ok, true, JSON.stringify(got));
  const f = path.join(ws, 'in-progress', slug, 'SPEC.md');
  let t = fs.readFileSync(f, 'utf8');
  t = setFrontmatterField(t, 'status', 'in-progress');
  t = setFrontmatterField(t, 'claimed_by', actor);
  t = setFrontmatterField(t, 'claimed_at', '2026-07-31');
  fs.writeFileSync(f, t);
}

function writeBuilderArtifacts(ws, slug, { builder = 'claude', repo } = {}) {
  const dir = path.join(ws, 'in-progress', slug);
  if (repo) {
    fs.appendFileSync(path.join(repo, 'README.md'), `\n## ${slug}\n`);
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', `build ${slug}`);
  }
  fs.mkdirSync(path.join(dir, 'outcome'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'outcome', 'FEEDBACK.md'), `# Feedback\n\nbuilt ${slug}\n`);
  fs.writeFileSync(path.join(dir, 'outcome', 'BUILDER.diff'),
    repo ? spawnSync('git', ['diff', 'HEAD~1'], { cwd: repo, encoding: 'utf8' }).stdout || 'diff --git a/README.md b/README.md\n'
      : 'diff --git a/README.md b/README.md\n');
  fs.writeFileSync(path.join(dir, 'VERIFY.md'),
    `---\nawaiting_verifier: true\nbuilder: ${builder}\n---\n\nverify ${slug}\n`);
  return dir;
}

function finalize(ws, slug, { actor = 'claude', runId = 'claude-run-1', repo } = {}) {
  const base = repo ? git(repo, 'rev-parse', 'HEAD') : 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const lease = acquireBuilderLease(ws, {
    slug, actor, runId, stage: 'in-progress', ttlMinutes: 60, now: new Date(NOW),
  });
  assert.equal(lease.ok, true, JSON.stringify(lease));
  const r = finalizeBuilderHandoff({
    wsDir: ws, slug, actor, runId, baseCommit: base,
    tests: [{ command: 'npm test', ok: true, exit_code: 0, summary: 'green' }],
    now: new Date(NOW),
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(fs.existsSync(path.join(ws, 'tests', slug, 'outcome', 'HANDOFF.json')));
  return r;
}

function humanAccept(ws, slug, { by = 'human-cli', gate = 'verified' } = {}) {
  const got = moveSpec({
    wsDir: ws, slug, from: 'in-review', to: 'done', actor: by, role: 'review',
  });
  assert.equal(got.ok, true, JSON.stringify(got));
  const f = path.join(ws, 'done', slug, 'SPEC.md');
  let t = fs.readFileSync(f, 'utf8');
  t = setFrontmatterField(t, 'status', 'done');
  t = setFrontmatterField(t, 'accepted_by', by);
  t = setFrontmatterField(t, 'accepted_at', '2026-07-31T15:30:00.000Z');
  t = setFrontmatterField(t, 'gate', gate);
  fs.writeFileSync(f, t);
  const logDir = path.join(ws, '_metrics');
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(path.join(logDir, 'review-log.jsonl'), JSON.stringify({
    date: '2026-07-31T15:30:00.000Z',
    spec: `in-review/${slug}/`,
    action: 'accepted',
    via: by === 'human-cockpit' ? 'cockpit' : 'cli',
    gate,
  }) + '\n');
}

function backdate(dir, atMs) {
  const t = new Date(atMs);
  const walk = d => {
    for (const e of fs.readdirSync(d)) {
      const p = path.join(d, e);
      if (fs.statSync(p).isDirectory()) walk(p);
      else fs.utimesSync(p, t, t);
    }
    fs.utimesSync(d, t, t);
  };
  walk(dir);
}

function writeExpiredLease(ws, slug, { actor = 'claude', runId = 'claude-run-1', now = NOW } = {}) {
  const lf = builderLeasePath(ws, slug);
  fs.mkdirSync(path.dirname(lf), { recursive: true });
  fs.writeFileSync(lf, JSON.stringify({
    slug, actor, run_id: runId, stage: 'in-progress',
    issued_at: new Date(now - 3 * HOUR).toISOString(),
    heartbeat_at: new Date(now - 3 * HOUR).toISOString(),
    expires_at: new Date(now - HOUR).toISOString(),
    ttl_minutes: 60, pid: 1,
  }, null, 2) + '\n');
}

function writeLiveLease(ws, slug, { actor = 'claude', runId = 'claude-run-1', now = NOW } = {}) {
  const lf = builderLeasePath(ws, slug);
  fs.mkdirSync(path.dirname(lf), { recursive: true });
  fs.writeFileSync(lf, JSON.stringify({
    slug, actor, run_id: runId, stage: 'in-progress',
    issued_at: new Date(now).toISOString(),
    heartbeat_at: new Date(now).toISOString(),
    expires_at: new Date(now + HOUR).toISOString(),
    ttl_minutes: 60, pid: 1,
  }, null, 2) + '\n');
}

// ---------- happy path ----------

test('canonical happy path: ready → in-progress → tests → in-review with builder ≠ verifier', () => withFixture(({ ws, repo }) => {
  writeReadySpec(ws, 'demo-feature', { repo });
  claim(ws, 'demo-feature', 'claude');
  writeBuilderArtifacts(ws, 'demo-feature', { builder: 'claude', repo });
  finalize(ws, 'demo-feature', { actor: 'claude', runId: 'claude-run-1', repo });

  const v = runLeasedVerification({
    wsDir: ws, slug: 'demo-feature', verifier: 'codex',
    verify: () => ({ status: 'pass', verdict: 'pass', notes: ['ok'], proposed_mutations: [] }),
  });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.ok(fs.existsSync(path.join(ws, 'in-review', 'demo-feature', 'SPEC.md')));
  assert.ok(!fs.existsSync(path.join(ws, 'tests', 'demo-feature')));
  const { meta } = parseFrontmatter(fs.readFileSync(path.join(ws, 'in-review', 'demo-feature', 'SPEC.md'), 'utf8'));
  assert.equal(meta.claimed_by, 'claude');
  assert.equal(meta.verified_by, 'codex');
  assert.notEqual(meta.claimed_by, meta.verified_by);
  assert.ok(!fs.existsSync(path.join(ws, 'done', 'demo-feature')));
}));

// ---------- failure / recovery / contention ----------

test('manifest write failures: missing artifacts refuse finalize; partial tmp is not recoverable', () => withFixture(({ ws, repo }) => {
  writeReadySpec(ws, 'half', { repo });
  claim(ws, 'half', 'claude');
  // FEEDBACK only — no BUILDER.diff / VERIFY.md
  fs.mkdirSync(path.join(ws, 'in-progress', 'half', 'outcome'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'in-progress', 'half', 'outcome', 'FEEDBACK.md'), 'x\n');
  acquireBuilderLease(ws, { slug: 'half', actor: 'claude', runId: 'r1', stage: 'in-progress', now: new Date(NOW) });
  const missing = finalizeBuilderHandoff({
    wsDir: ws, slug: 'half', actor: 'claude', runId: 'r1',
    baseCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    tests: [{ command: 'npm test', ok: true }],
    now: new Date(NOW),
  });
  assert.equal(missing.ok, false);
  assert.ok(['missing-artifact', 'malformed-manifest'].includes(missing.reason), missing.reason);
  assert.ok(fs.existsSync(path.join(ws, 'in-progress', 'half')));

  // Interrupted write: tmp without committed HANDOFF.json
  writeReadySpec(ws, 'torn', { repo });
  claim(ws, 'torn', 'claude');
  writeBuilderArtifacts(ws, 'torn', { builder: 'claude' });
  fs.writeFileSync(path.join(ws, 'in-progress', 'torn', 'outcome', 'HANDOFF.json.tmp.1'), '{');
  assert.equal(classifyRecovery(ws, 'torn', { now: NOW }).state, 'partial');
}));

/** Stamp finalize frontmatter BEFORE binding the manifest (byte-stable for recovery). */
function stampForHandoff(specDir, { requestedAt = '2026-07-30' } = {}) {
  const f = path.join(specDir, 'SPEC.md');
  let t = fs.readFileSync(f, 'utf8');
  t = setFrontmatterField(t, 'status', 'tests');
  t = setFrontmatterField(t, 'awaiting_verifier', true);
  t = setFrontmatterField(t, 'requested_at', requestedAt);
  fs.writeFileSync(f, t);
}

function commitPreparedHandoff(ws, slug, { builder = 'claude', runId, lease }) {
  writeBuilderArtifacts(ws, slug, { builder });
  const dir = path.join(ws, 'in-progress', slug);
  stampForHandoff(dir);
  assert.equal(createHandoff({
    specDir: dir, builder, from_stage: 'in-progress', to_stage: 'tests',
    base_commit: 'abc', run_id: runId, tests: [{ command: 't', ok: true }],
    artifacts: ['VERIFY.md'],
  }).ok, true);
  if (lease === 'live') writeLiveLease(ws, slug, { actor: builder, runId });
  else if (lease === 'expired') writeExpiredLease(ws, slug, { actor: builder, runId });
  backdate(dir, NOW - 48 * HOUR);
  return dir;
}

test('active-builder refusal vs expired recovery + tampering', () => withFixture(({ ws, repo }) => {
  writeReadySpec(ws, 'live', { repo });
  claim(ws, 'live', 'claude');
  commitPreparedHandoff(ws, 'live', { runId: 'r-live', lease: 'live' });
  const active = classifyRecovery(ws, 'live', { now: NOW });
  assert.equal(active.state, 'active');
  assert.equal(active.reason, 'live-lease');
  const refuse = recoverPreparedHandoff(ws, 'live', {
    by: 'ops', reason: 'should refuse live builder', now: NOW,
  });
  assert.equal(refuse.ok, false);
  assert.equal(refuse.reason, 'live-lease');

  writeReadySpec(ws, 'dead', { repo });
  claim(ws, 'dead', 'claude');
  commitPreparedHandoff(ws, 'dead', { runId: 'r-dead', lease: 'expired' });
  const recovered = recoverPreparedHandoff(ws, 'dead', {
    by: 'ops', reason: 'builder died after manifest', now: NOW,
  });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.ok(fs.existsSync(path.join(ws, 'tests', 'dead', 'outcome', 'HANDOFF.json')));

  writeReadySpec(ws, 'tamper', { repo });
  claim(ws, 'tamper', 'claude');
  const tdir = commitPreparedHandoff(ws, 'tamper', { runId: 'r-tamper', lease: 'expired' });
  fs.writeFileSync(path.join(tdir, 'outcome', 'FEEDBACK.md'), 'rewritten after bind\n');
  const bad = classifyRecovery(ws, 'tamper', { now: NOW });
  assert.equal(bad.state, 'invalid');
  assert.equal(bad.reason, 'artifact-changed');
  assert.equal(validateHandoff({ specDir: tdir }).ok, false);
}));
test('verifier crash/takeover and lease contention', () => withFixture(({ ws, repo }) => {
  writeReadySpec(ws, 'v1', { repo });
  claim(ws, 'v1', 'claude');
  writeBuilderArtifacts(ws, 'v1', { builder: 'claude', repo });
  finalize(ws, 'v1', { actor: 'claude', runId: 'r1', repo });

  const a = acquireVerifierLease({ wsDir: ws, slug: 'v1', verifier: 'gemini' });
  assert.equal(a.ok, true);
  const contended = acquireVerifierLease({ wsDir: ws, slug: 'v1', verifier: 'codex' });
  assert.equal(contended.ok, false);
  assert.equal(contended.reason, 'lease-held');

  // Crash: age the lease past TTL → takeover
  const lf = verifierLeasePath(ws, 'v1');
  const past = new Date(Date.now() - 61 * 60000);
  fs.utimesSync(lf, past, past);
  assert.equal(verifierLeaseState({ wsDir: ws, slug: 'v1' }).state, 'stale');
  const takeover = acquireVerifierLease({ wsDir: ws, slug: 'v1', verifier: 'codex' });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.takeover, true);
  assert.equal(takeover.taken_over_from, 'gemini');
}));

// ---------- mutation / ceiling / Gemini lanes ----------

test('mutation advice leaves NOTES + no source mutation; clean verify stops at in-review', () => withFixture(({ ws, repo }) => {
  writeReadySpec(ws, 'mut', { repo });
  claim(ws, 'mut', 'claude');
  writeBuilderArtifacts(ws, 'mut', { builder: 'claude', repo });
  finalize(ws, 'mut', { actor: 'claude', runId: 'r-mut', repo });
  const beforeDiff = fs.readFileSync(path.join(ws, 'tests', 'mut', 'outcome', 'BUILDER.diff'), 'utf8');
  const beforeReadme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');

  const mut = runLeasedVerification({
    wsDir: ws, slug: 'mut', verifier: 'codex',
    verify: () => ({
      status: 'human-decision-required',
      verdict: 'human-decision-required',
      notes: ['needs null guard'],
      proposed_mutations: [{ file: 'README.md', reason: 'null guard' }],
    }),
  });
  assert.equal(mut.ok, true, JSON.stringify(mut));
  assert.ok(fs.existsSync(path.join(ws, 'tests', 'mut')));
  assert.match(fs.readFileSync(path.join(ws, 'tests', 'mut', 'NOTES.md'), 'utf8'), /No mutation was applied/);
  assert.equal(fs.readFileSync(path.join(ws, 'tests', 'mut', 'outcome', 'BUILDER.diff'), 'utf8'), beforeDiff);
  assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), beforeReadme);
  assert.ok(!fs.existsSync(path.join(ws, 'done', 'mut')));

  applyVerifyHumanDecision(ws, {
    slug: 'mut', action: 'authorize-fix-forward', note: 'fix it', by: 'trevor',
  });
  assert.ok(fs.existsSync(path.join(ws, 'in-progress', 'mut')));
  assert.match(fs.readFileSync(path.join(ws, 'in-progress', 'mut', 'NOTES.md'), 'utf8'), /authorize-fix-forward/);
  // still no auto source mutation
  assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), beforeReadme);

  // Clean path on a sibling
  writeReadySpec(ws, 'clean', { repo });
  claim(ws, 'clean', 'claude');
  writeBuilderArtifacts(ws, 'clean', { builder: 'claude', repo });
  finalize(ws, 'clean', { actor: 'claude', runId: 'r-clean', repo });
  const pass = runLeasedVerification({
    wsDir: ws, slug: 'clean', verifier: 'codex',
    verify: () => ({ status: 'pass', verdict: 'pass', notes: [], proposed_mutations: [] }),
  });
  assert.equal(pass.ok, true, JSON.stringify(pass));
  assert.ok(fs.existsSync(path.join(ws, 'in-review', 'clean')));
  assert.ok(!fs.existsSync(path.join(ws, 'done', 'clean')));
}));

test('unsafe/unavailable Gemini does not block another lane; eligible Gemini can verify', () => withFixture(({ root, ws, repo, name }) => {
  const unsafe = {
    id: 'gemini', agent: 'gemini', mode: 'verify', isolated: true,
    sandbox: 'required', allow_network: true, allow_commands: [], command: ['agy'],
  };
  assert.throws(() => validateVerifierLane(unsafe), /network|unsafe|allow_network/i);
  const missing = {
    id: 'gemini', agent: 'gemini', mode: 'verify', isolated: true,
    sandbox: 'required', allow_network: false, allow_commands: [], command: ['agy'],
  };
  assert.equal(verifierLaneAvailable(missing, { which: () => '' }).ok, false);

  writeReadySpec(ws, 'need', { repo });
  claim(ws, 'need', 'claude');
  writeBuilderArtifacts(ws, 'need', { builder: 'claude', repo });
  finalize(ws, 'need', { actor: 'claude', runId: 'r-need', repo });

  // Unavailable Gemini → typed reason; work stays at tests/
  const unavail = verifyTick({
    root, wsDir: ws, wsName: name,
    preferLane: 'gemini',
    which: () => '',
    runVerify: () => { throw new Error('must not spawn'); },
  });
  assert.equal(unavail.reason, 'verifier_unavailable');
  assert.ok(fs.existsSync(path.join(ws, 'tests', 'need')));

  // Safe codex lane still drains
  const ok = verifyTick({
    root, wsDir: ws, wsName: name,
    preferLane: 'codex',
    which: () => '/bin/true',
    runVerify: () => ({ status: 'pass', verdict: 'pass', notes: [], proposed_mutations: [] }),
  });
  assert.equal(ok.code, 0, JSON.stringify(ok));
  assert.equal(ok.outcome, 'in-review');
  assert.ok(fs.existsSync(path.join(ws, 'in-review', 'need')));

  // Eligible Gemini fixture independently verifies another spec
  writeReadySpec(ws, 'gem', { repo });
  claim(ws, 'gem', 'claude');
  writeBuilderArtifacts(ws, 'gem', { builder: 'claude', repo });
  finalize(ws, 'gem', { actor: 'claude', runId: 'r-gem', repo });
  const gem = verifyTick({
    root, wsDir: ws, wsName: name,
    preferLane: 'gemini',
    which: () => path.join(FIX, 'fake-bins', 'fake-verifier.js'),
    runVerify: () => ({ status: 'pass', verdict: 'pass', notes: ['gemini ok'], proposed_mutations: [] }),
  });
  assert.equal(gem.code, 0, JSON.stringify(gem));
  assert.equal(gem.outcome, 'in-review');
  const { meta } = parseFrontmatter(fs.readFileSync(path.join(ws, 'in-review', 'gem', 'SPEC.md'), 'utf8'));
  assert.equal(meta.verified_by, 'gemini');
  assert.notEqual(meta.claimed_by, meta.verified_by);
}));

// ---------- human-only done + legacy ----------

test('only explicit human review reaches done with acceptance provenance', () => withFixture(({ ws, repo }) => {
  writeReadySpec(ws, 'gate', { repo });
  claim(ws, 'gate', 'claude');
  writeBuilderArtifacts(ws, 'gate', { builder: 'claude', repo });
  finalize(ws, 'gate', { actor: 'claude', runId: 'r-gate', repo });
  assert.equal(runLeasedVerification({
    wsDir: ws, slug: 'gate', verifier: 'codex',
    verify: () => ({ status: 'pass', verdict: 'pass', notes: [], proposed_mutations: [] }),
  }).ok, true);

  const asBuilder = moveSpec({
    wsDir: ws, slug: 'gate', from: 'in-review', to: 'done', actor: 'claude', role: 'builder',
  });
  assert.equal(asBuilder.ok, false);
  assert.equal(asBuilder.reason, 'done-requires-review-actor');

  const asVerifier = moveSpec({
    wsDir: ws, slug: 'gate', from: 'in-review', to: 'done', actor: 'codex', role: 'verifier',
  });
  assert.equal(asVerifier.ok, false);
  assert.equal(asVerifier.reason, 'done-requires-review-actor');

  humanAccept(ws, 'gate', { by: 'human-cli', gate: 'verified' });
  assert.ok(fs.existsSync(path.join(ws, 'done', 'gate', 'SPEC.md')));
  const { meta } = parseFrontmatter(fs.readFileSync(path.join(ws, 'done', 'gate', 'SPEC.md'), 'utf8'));
  assert.equal(meta.status, 'done');
  assert.equal(meta.accepted_by, 'human-cli');
  assert.equal(meta.gate, 'verified');
  assert.ok(meta.accepted_at);
  const log = fs.readFileSync(path.join(ws, '_metrics', 'review-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log[0].action, 'accepted');
  assert.equal(log[0].gate, 'verified');
}));

test('legacy compatibility is separate from canonical writes', () => withFixture(({ ws }) => {
  // Legacy: FEEDBACK + diff + awaiting, no HANDOFF — eligible for grandfathered verify, not recovery
  const legacy = path.join(ws, 'tests', 'legacy-work');
  fs.mkdirSync(path.join(legacy, 'outcome'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'SPEC.md'),
    '---\ntitle: L\nstatus: tests\nclaimed_by: "claude"\nawaiting_verifier: true\n---\n');
  fs.writeFileSync(path.join(legacy, 'outcome', 'FEEDBACK.md'), 'f\n');
  fs.writeFileSync(path.join(legacy, 'outcome', 'BUILDER.diff'), 'd\n');
  assert.equal(classifyHandoff(legacy).kind, 'legacy');
  assert.equal(classifyRecovery(ws, 'legacy-work', { now: NOW }).state, 'not-found'); // already in tests/, not in-progress recovery

  // Canonical write
  const canon = path.join(ws, 'tests', 'canon');
  fs.mkdirSync(path.join(canon, 'outcome'), { recursive: true });
  fs.writeFileSync(path.join(canon, 'SPEC.md'),
    '---\ntitle: C\nstatus: tests\nclaimed_by: "claude"\n---\n');
  fs.writeFileSync(path.join(canon, 'outcome', 'FEEDBACK.md'), 'feedback\n');
  fs.writeFileSync(path.join(canon, 'outcome', 'BUILDER.diff'), 'diff\n');
  assert.equal(createHandoff({
    specDir: canon, builder: 'claude', from_stage: 'in-progress', to_stage: 'tests',
    base_commit: 'abc', run_id: 'r-c', tests: [{ command: 't', ok: true }],
  }).ok, true);
  assert.equal(classifyHandoff(canon).kind, 'v1');

  const q = verifierQueue(ws);
  const by = Object.fromEntries(q.eligible.map(e => [e.slug, e]));
  assert.equal(by['legacy-work'].eligibility, 'legacy');
  assert.equal(by['canon'].eligibility, 'manifest');

  // New finalize still writes V1 (not legacy)
  writeReadySpec(ws, 'fresh');
  claim(ws, 'fresh', 'claude');
  writeBuilderArtifacts(ws, 'fresh', { builder: 'claude' });
  finalize(ws, 'fresh', { actor: 'claude', runId: 'r-fresh' });
  assert.equal(classifyHandoff(path.join(ws, 'tests', 'fresh')).kind, 'v1');
}));

test('suite seams scrub credentials and never require network or dangerous permissions', () => {
  const { scrubEnvironment, normalizePolicy, buildGeminiInvocation } = require('../lib/verifier-worker');
  const env = scrubEnvironment({
    PATH: '/bin', GEMINI_API_KEY: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'x', OPENAI_API_KEY: 'y',
  });
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.throws(() => normalizePolicy({ command: ['agy', '--dangerously-skip-permissions'] }), /forbidden/);
  const inv = buildGeminiInvocation({ command: ['agy'], mode: 'verify' }, 'brief');
  assert.ok(inv.args.includes('--sandbox'));
  assert.ok(!inv.args.includes('--dangerously-skip-permissions'));
});

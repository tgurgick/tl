'use strict';
// test/stall.test.js — stalled in-progress claim detection + guarded reclaim
// (lib/stall.js, `tl reclaim`, resume's STALLED flag).
//
// The rule under test: a claim is stalled only on evidence (folder mtimes +
// claimed_at floor, idle past a >=1h threshold) and never when the spec shows
// a healthy hand-off (awaiting_verifier, blocked, pending continuation).
// Reclaim is explicit, logged in NOTES.md before any move, preserves builder
// attribution on the advance path, and never force-steals a fresh claim.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  DEFAULT_STALL_HOURS, stallThresholdMs, latestActivityMs,
  assessClaim, detectStalledClaims, reclaimStalled, stripFrontmatterFields,
  classifyRecovery, recoverPreparedHandoff,
} = require('../lib/stall');
const { parseFrontmatter } = require('../lib/parse');
const { createHandoff, sha256Hex } = require('../lib/handoff');
const { setFrontmatterField } = require('../lib/frontmatter');
const { readSpecTrace, finalizeBuilderHandoff } = require('../lib/worker');

const REPO_ROOT = path.join(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'tl.js');
const HOUR = 3600000;
const NOW = Date.parse('2026-07-14T12:00:00Z');

// ---------- scaffolding ----------

// Scratch TL_ROOT with one workspace; returns { root, ws } and cleans up in fn's finally.
function withWorkspace(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-stalltest-'));
  const name = 'stall-ws';
  const ws = path.join(root, 'projects', name);
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'PROJECT.md'), `---\nname: "${name}"\nrepo: "${REPO_ROOT}"\n---\n`);
  try { return fn({ root, name, ws }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// Write an in-progress spec folder and backdate every file's mtime to `at` ms.
function writeClaim(ws, slug, { claimedBy = 'claude', claimedAt = '2026-07-12', extraFm = '', files = {}, at = NOW - 48 * HOUR } = {}) {
  const dir = path.join(ws, 'in-progress', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SPEC.md'),
    `---\ntitle: "${slug}"\ntype: "feature"\nstatus: "in-progress"\nclaimed_by: "${claimedBy}"\nclaimed_at: "${claimedAt}"\n${extraFm}---\n\n## Objective\nx\n`);
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  backdate(dir, at);
  return dir;
}

function backdate(dir, atMs) {
  const t = new Date(atMs);
  const walk = d => {
    for (const e of fs.readdirSync(d)) {
      const p = path.join(d, e);
      if (fs.statSync(p).isDirectory()) walk(p);
      fs.utimesSync(p, t, t);
    }
    fs.utimesSync(d, t, t);
  };
  walk(dir);
}

const run = (root, ...a) => spawnSync(process.execPath, [BIN, ...a], {
  encoding: 'utf8', env: { ...process.env, TL_ROOT: root },
});

// ---------- threshold config ----------

test('stallThresholdMs: default is hours, not minutes', () => {
  assert.equal(stallThresholdMs(null), DEFAULT_STALL_HOURS * HOUR);
  assert.equal(stallThresholdMs({}), DEFAULT_STALL_HOURS * HOUR);
  assert.ok(stallThresholdMs(null) >= HOUR);
});

test('stallThresholdMs: TRIAGE.yml stall.idle_hours overrides', () => {
  assert.equal(stallThresholdMs({ stall: { idle_hours: 6 } }), 6 * HOUR);
  assert.equal(stallThresholdMs({ stall: { idle_hours: '48' } }), 48 * HOUR);
});

test('stallThresholdMs: junk / sub-hour configs fall back to the default (never a live-work stealer)', () => {
  for (const bad of [0, 0.2, -5, 'soon', null]) {
    assert.equal(stallThresholdMs({ stall: { idle_hours: bad } }), DEFAULT_STALL_HOURS * HOUR, String(bad));
  }
});

// ---------- pure assessment ----------

const mkSpec = (meta = {}, stage = 'in-progress') => ({
  stage, path: `${stage}/some-spec/`, meta: { status: stage, claimed_by: 'claude', ...meta },
});

test('assessClaim: idle past threshold is stalled; fresh activity is not', () => {
  const opts = { now: NOW, thresholdMs: 24 * HOUR };
  const old = assessClaim(mkSpec(), { ...opts, activityMs: NOW - 48 * HOUR });
  assert.equal(old.stalled, true);
  assert.equal(old.reason, 'idle-past-threshold');
  const fresh = assessClaim(mkSpec(), { ...opts, activityMs: NOW - 2 * HOUR });
  assert.equal(fresh.stalled, false);
  assert.equal(fresh.reason, 'active');
});

test('assessClaim: a fresh claimed_at floors stale file mtimes — never steal a just-claimed spec', () => {
  // files untouched for days, but the claim stamp is recent (e.g. git checkout weirdness)
  const a = assessClaim(mkSpec({ claimed_at: '2026-07-14' }), {
    now: NOW, thresholdMs: 24 * HOUR, activityMs: NOW - 10 * 24 * HOUR,
  });
  assert.equal(a.stalled, false);
});

test('assessClaim: healthy states are never stalled regardless of age', () => {
  const opts = { now: NOW, thresholdMs: HOUR, activityMs: NOW - 100 * HOUR };
  assert.equal(assessClaim(mkSpec({ awaiting_verifier: true }), opts).reason, 'awaiting-verifier');
  assert.equal(assessClaim(mkSpec({ awaiting_verifier: 'true' }), opts).reason, 'awaiting-verifier');
  assert.equal(assessClaim(mkSpec({ status: 'blocked' }), opts).reason, 'blocked');
  const pending = new Set(['some-spec']);
  assert.equal(assessClaim(mkSpec(), { ...opts, pendingContinuationSlugs: pending }).reason, 'continuation-pending');
  assert.equal(assessClaim(mkSpec({}, 'tests'), opts).reason, 'not-in-progress');
});

test('assessClaim: no dateable evidence → not stalled (never guess)', () => {
  const a = assessClaim(mkSpec({ claimed_at: '' }), { now: NOW, thresholdMs: HOUR, activityMs: 0 });
  assert.equal(a.stalled, false);
  assert.equal(a.reason, 'no-evidence');
});

// ---------- fs-aware detection ----------

test('latestActivityMs: newest file anywhere in the folder wins (outcome/ over SPEC.md)', () => withWorkspace(({ ws }) => {
  const dir = writeClaim(ws, 'evidence', { files: { 'outcome/NOTES-RUN.md': 'progress' }, at: NOW - 72 * HOUR });
  const recent = new Date(NOW - 1 * HOUR);
  fs.utimesSync(path.join(dir, 'outcome', 'NOTES-RUN.md'), recent, recent);
  const got = latestActivityMs(dir);
  assert.ok(Math.abs(got - (NOW - HOUR)) < 5000, `expected ~1h ago, got ${new Date(got).toISOString()}`);
}));

test('detectStalledClaims: flags only the idle claim, oldest first, and honors pending continuations', () => withWorkspace(({ ws }) => {
  writeClaim(ws, 'stalled-a', { at: NOW - 48 * HOUR });
  writeClaim(ws, 'stalled-b', { at: NOW - 96 * HOUR });
  writeClaim(ws, 'alive', { at: NOW - 1 * HOUR });
  writeClaim(ws, 'kicked-back', { at: NOW - 48 * HOUR });
  const specs = ['stalled-a', 'stalled-b', 'alive', 'kicked-back'].map(slug => ({
    stage: 'in-progress', path: `in-progress/${slug}/`, dir: path.join(ws, 'in-progress', slug),
    meta: parseFrontmatter(fs.readFileSync(path.join(ws, 'in-progress', slug, 'SPEC.md'), 'utf8')).meta,
  }));
  const conts = { live: [{ spec: { path: 'in-progress/kicked-back/' } }] };
  const got = detectStalledClaims(ws, specs, { now: NOW, thresholdMs: 24 * HOUR, continuations: conts });
  assert.deepEqual(got.map(x => x.slug), ['stalled-b', 'stalled-a']);
  // stalled-b's files are 96h old but claimed_at (2026-07-12, 60h before NOW)
  // floors last-seen — idle reports from the most recent evidence, not the oldest.
  assert.ok(got[0].idleHours >= 59 && got[0].idleHours <= 61, String(got[0].idleHours));
}));

// ---------- reclaim: release path ----------

test('reclaim release: back to specs/ as ready, claim cleared only after NOTES.md records it', () => withWorkspace(({ ws }) => {
  writeClaim(ws, 'orphan', { claimedBy: 'cursor', claimedAt: '2026-07-11', extraFm: 'hold_reason: "old hold"\n', at: NOW - 60 * HOUR });
  const res = reclaimStalled(ws, 'orphan', { by: 'trevor', reason: 'cursor crashed mid-run', now: NOW, thresholdMs: 24 * HOUR });
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'release');
  assert.ok(!fs.existsSync(path.join(ws, 'in-progress', 'orphan')));
  const specFile = path.join(ws, 'specs', 'orphan', 'SPEC.md');
  const { meta } = parseFrontmatter(fs.readFileSync(specFile, 'utf8'));
  assert.equal(meta.status, 'ready');
  assert.equal(meta.claimed_by, undefined);
  assert.equal(meta.claimed_at, undefined);
  assert.equal(meta.hold_reason, undefined); // release contract
  assert.match(String(meta.reclaimed_from), /cursor/); // attribution survives in frontmatter…
  const notes = fs.readFileSync(path.join(ws, 'specs', 'orphan', 'NOTES.md'), 'utf8');
  assert.match(notes, /## Reclaimed /); // …and in the auditable log
  assert.match(notes, /prior claim: cursor \(claimed_at 2026-07-11\)/);
  assert.match(notes, /by: trevor/);
  assert.match(notes, /reason: cursor crashed mid-run/);
  assert.match(notes, /misattributes-builder/); // the attribution rule travels with the spec
}));

// ---------- reclaim: advance path ----------

test('reclaim advance: builder artifacts present → tests/, claimed_by preserved, VERIFY.md names the builder', () => withWorkspace(({ ws }) => {
  writeClaim(ws, 'built-then-died', {
    claimedBy: 'claude', claimedAt: '2026-07-11',
    files: { 'outcome/FEEDBACK.md': '---\nagent_tool: "claude"\n---\nwent well\n' },
    at: NOW - 60 * HOUR,
  });
  const res = reclaimStalled(ws, 'built-then-died', { by: 'cursor', reason: 'host restart orphaned a finished build', now: NOW, thresholdMs: 24 * HOUR });
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'advance');
  const dir = path.join(ws, 'tests', 'built-then-died');
  const { meta } = parseFrontmatter(fs.readFileSync(path.join(dir, 'SPEC.md'), 'utf8'));
  assert.equal(meta.claimed_by, 'claude'); // the builder, NOT the reclaimer
  assert.equal(String(meta.awaiting_verifier), 'true');
  assert.ok(meta.requested_at);
  const verify = fs.readFileSync(path.join(dir, 'VERIFY.md'), 'utf8');
  assert.match(verify, /builder: claude/i);
  assert.match(verify, /reclaim/i);
  const notes = fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8');
  assert.match(notes, /advanced to tests\/built-then-died\//);
  assert.match(notes, /must credit claude/);
}));

// ---------- reclaim: guards ----------

test('reclaim refuses: fresh claim (never force-steal), even with a reason', () => withWorkspace(({ ws }) => {
  writeClaim(ws, 'live-one', { at: NOW - 2 * HOUR, claimedAt: '2026-07-14' });
  const res = reclaimStalled(ws, 'live-one', { by: 'x', reason: 'i want it', now: NOW, thresholdMs: 24 * HOUR });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'active-claim');
  assert.ok(fs.existsSync(path.join(ws, 'in-progress', 'live-one', 'SPEC.md'))); // untouched
}));

test('reclaim refuses: missing reason or reclaimer — stamps change only with a recorded why', () => withWorkspace(({ ws }) => {
  writeClaim(ws, 'orphan', { at: NOW - 60 * HOUR });
  assert.equal(reclaimStalled(ws, 'orphan', { by: 'x', now: NOW }).reason, 'reason-required');
  assert.equal(reclaimStalled(ws, 'orphan', { reason: 'y', now: NOW }).reason, 'by-required');
  assert.ok(fs.existsSync(path.join(ws, 'in-progress', 'orphan', 'SPEC.md')));
}));

test('reclaim refuses: awaiting_verifier, pending continuation, destination collision, not-found', () => withWorkspace(({ ws }) => {
  writeClaim(ws, 'handed-off', { extraFm: 'awaiting_verifier: true\n', at: NOW - 60 * HOUR });
  assert.equal(reclaimStalled(ws, 'handed-off', { by: 'x', reason: 'y', now: NOW }).reason, 'awaiting-verifier');

  writeClaim(ws, 'kicked', { at: NOW - 60 * HOUR });
  const conts = { live: [{ spec: { path: 'in-progress/kicked/' } }] };
  assert.equal(reclaimStalled(ws, 'kicked', { by: 'x', reason: 'y', now: NOW, continuations: conts }).reason, 'continuation-pending');

  writeClaim(ws, 'collide', { at: NOW - 60 * HOUR });
  fs.mkdirSync(path.join(ws, 'specs', 'collide'), { recursive: true });
  assert.equal(reclaimStalled(ws, 'collide', { by: 'x', reason: 'y', now: NOW }).reason, 'destination-exists');

  assert.equal(reclaimStalled(ws, 'ghost', { by: 'x', reason: 'y', now: NOW }).reason, 'not-found');
}));

test('stripFrontmatterFields: removes claim lines from the block, never the body', () => {
  const t = '---\ntitle: "x"\nclaimed_by: "claude"\nclaimed_at: "2026-07-01"\nstatus: "ready"\n---\nbody says claimed_by: someone\n';
  const outText = stripFrontmatterFields(t, ['claimed_by', 'claimed_at']);
  const { meta, body } = parseFrontmatter(outText);
  assert.equal(meta.claimed_by, undefined);
  assert.equal(meta.claimed_at, undefined);
  assert.equal(meta.status, 'ready');
  assert.match(body, /body says claimed_by: someone/);
});

// ---------- CLI surface ----------

test('tl reclaim (no spec): lists candidates, changes nothing', () => withWorkspace(({ root, name, ws }) => {
  writeClaim(ws, 'stalled-x', { claimedBy: 'gemini', at: Date.now() - 60 * HOUR });
  const r = run(root, 'reclaim', name);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RECLAIM CANDIDATES/);
  assert.match(r.stdout, /stalled-x/);
  assert.match(r.stdout, /claimed_by gemini/);
  assert.match(r.stdout, /RELEASE to specs\//);
  assert.ok(fs.existsSync(path.join(ws, 'in-progress', 'stalled-x', 'SPEC.md'))); // listing acted on nothing
}));

test('tl reclaim <spec> --by --reason: performs the release end to end', () => withWorkspace(({ root, name, ws }) => {
  writeClaim(ws, 'stalled-y', { at: Date.now() - 60 * HOUR });
  const r = run(root, 'reclaim', name, 'stalled-y', '--by', 'trevor', '--reason', 'session died');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reclaimed stalled-y: in-progress\/stalled-y\/ → specs\/stalled-y\/ \(release\)/);
  assert.ok(fs.existsSync(path.join(ws, 'specs', 'stalled-y', 'NOTES.md')));
}));

test('tl reclaim <spec> without --reason: non-zero exit, nothing moves', () => withWorkspace(({ root, name, ws }) => {
  writeClaim(ws, 'stalled-z', { at: Date.now() - 60 * HOUR });
  const r = run(root, 'reclaim', name, 'stalled-z', '--by', 'trevor');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /reason/);
  assert.ok(fs.existsSync(path.join(ws, 'in-progress', 'stalled-z', 'SPEC.md')));
}));

test('tl resume: stalled claim carries a STALLED flag; a live claim does not', () => withWorkspace(({ root, name, ws }) => {
  writeClaim(ws, 'old-claim', { claimedBy: 'codex', at: Date.now() - 60 * HOUR });
  writeClaim(ws, 'live-claim', { at: Date.now() - 1 * HOUR, claimedAt: new Date().toISOString().slice(0, 10) });
  const r = run(root, 'resume', name);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /old-claim \(in-progress\/old-claim\/\) — STALLED: claimed_by codex/);
  assert.match(r.stdout, /live-claim \(in-progress\/live-claim\/\)\n/); // no flag
  assert.match(r.stdout, /tl reclaim /);
}));

// ---------- prepared-handoff recovery (classifyRecovery / recoverPreparedHandoff) ----------
//
// The rule under test: recovery finishes ONLY a committed hand-off — a valid
// terminal HANDOFF.json for in-progress → tests with an EXPIRED builder lease
// — by delegating to the worker finalize path (byte-identical manifest reuse,
// stage-CAS move). Live leases, partial writes, invalid/changed manifests, and
// missing manifests refuse with typed reasons; legacy no-lease work needs the
// explicit grace flag plus idleness; the builder keeps attribution and the
// recoverer is logged separately.

// A spec that completed the canonical finalize order up to (but not including)
// the folder move: stamped frontmatter, outcome artifacts, committed manifest,
// and a builder lease in the requested liveness state.
function writeCommittedHandoff(ws, slug, {
  builder = 'claude', runId = 'run-orig-1', at = NOW - 48 * HOUR,
  lease = 'expired', leaseNow = NOW, stamp = true,
  tests = [{ command: 'npm test', ok: true }],
} = {}) {
  const dir = writeClaim(ws, slug, {
    claimedBy: builder,
    files: {
      'outcome/FEEDBACK.md': 'built it; gates green\n',
      'outcome/BUILDER.diff': 'diff --git a/x b/x\n',
      'VERIFY.md': '---\nawaiting_verifier: true\nbuilder: ' + builder + '\n---\n\nverify me\n',
    },
    at,
  });
  if (stamp) {
    // The stamps finalize writes BEFORE the manifest binds SPEC.md bytes —
    // applied via the same setFrontmatterField the worker uses, so a recovery
    // re-stamp is byte-stable.
    const f = path.join(dir, 'SPEC.md');
    let t = fs.readFileSync(f, 'utf8');
    t = setFrontmatterField(t, 'status', 'tests');
    t = setFrontmatterField(t, 'awaiting_verifier', true);
    t = setFrontmatterField(t, 'requested_at', '2026-07-13');
    fs.writeFileSync(f, t);
  }
  const created = createHandoff({
    specDir: dir, builder,
    from_stage: 'in-progress', to_stage: 'tests',
    base_commit: 'abc123', run_id: runId,
    prepared_at: '2026-07-13T10:00:00Z',
    tests, artifacts: ['VERIFY.md'],
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  if (lease !== 'none') {
    const lf = path.join(ws, '_metrics', 'builder-leases', slug + '.json');
    fs.mkdirSync(path.dirname(lf), { recursive: true });
    fs.writeFileSync(lf, JSON.stringify({
      slug, actor: builder, run_id: runId, stage: 'in-progress',
      issued_at: '2026-07-13T09:00:00Z', heartbeat_at: '2026-07-13T10:00:00Z',
      expires_at: new Date(lease === 'live' ? leaseNow + HOUR : leaseNow - HOUR).toISOString(),
      ttl_minutes: 120, pid: 12345,
    }, null, 2) + '\n');
  }
  backdate(dir, at);
  return dir;
}

const manifestSha = dir => sha256Hex(fs.readFileSync(path.join(dir, 'outcome', 'HANDOFF.json')));

// ---------- recovery: classification ----------

test('classifyRecovery: valid manifest + expired lease → recoverable; live lease → active with holder', () => withWorkspace(({ ws }) => {
  writeCommittedHandoff(ws, 'dead-after-commit', { lease: 'expired' });
  const c = classifyRecovery(ws, 'dead-after-commit', { now: NOW });
  assert.equal(c.state, 'recoverable');
  assert.equal(c.builder, 'claude');
  assert.equal(c.run_id, 'run-orig-1');
  assert.ok(c.idleMs > 24 * HOUR);

  writeCommittedHandoff(ws, 'still-building', { lease: 'live' });
  const a = classifyRecovery(ws, 'still-building', { now: NOW });
  assert.equal(a.state, 'active');
  assert.equal(a.reason, 'live-lease');
  assert.equal(a.holder.actor, 'claude');
  assert.equal(a.holder.run_id, 'run-orig-1');
  assert.ok(a.holder.expires_at);
}));

test('classifyRecovery: partial writes, legacy artifacts, and absent handoffs are never recoverable', () => withWorkspace(({ ws }) => {
  // Interrupted manifest write: tmp without HANDOFF.json.
  writeClaim(ws, 'torn-write', { files: { 'outcome/HANDOFF.json.tmp.1-2-abc': '{', 'outcome/FEEDBACK.md': 'x\n' } });
  assert.equal(classifyRecovery(ws, 'torn-write', { now: NOW }).state, 'partial');

  // FEEDBACK alone: partial artifact set.
  writeClaim(ws, 'half-done', { files: { 'outcome/FEEDBACK.md': 'x\n' } });
  const half = classifyRecovery(ws, 'half-done', { now: NOW });
  assert.equal(half.state, 'partial');

  // FEEDBACK + diff without a manifest: legacy — completion is NOT inferred.
  writeClaim(ws, 'pre-manifest', { files: { 'outcome/FEEDBACK.md': 'x\n', 'outcome/BUILDER.diff': 'd\n' } });
  const legacy = classifyRecovery(ws, 'pre-manifest', { now: NOW });
  assert.equal(legacy.state, 'no-manifest');
  assert.equal(legacy.reason, 'legacy-artifacts');

  // Nothing at all.
  writeClaim(ws, 'bare-claim', {});
  assert.equal(classifyRecovery(ws, 'bare-claim', { now: NOW }).state, 'no-manifest');

  assert.equal(classifyRecovery(ws, 'ghost', { now: NOW }).state, 'not-found');
}));

test('classifyRecovery: changed bytes, wrong stage edge, and unstamped SPEC.md are invalid', () => withWorkspace(({ ws }) => {
  // Bytes changed after the manifest committed.
  const dir = writeCommittedHandoff(ws, 'tampered', {});
  fs.writeFileSync(path.join(dir, 'outcome', 'FEEDBACK.md'), 'edited after commit\n');
  const c = classifyRecovery(ws, 'tampered', { now: NOW });
  assert.equal(c.state, 'invalid');
  assert.equal(c.reason, 'artifact-changed');

  // Manifest for a different edge.
  const dir2 = writeClaim(ws, 'wrong-edge', {
    files: { 'outcome/FEEDBACK.md': 'x\n', 'outcome/BUILDER.diff': 'd\n' },
  });
  const made = createHandoff({
    specDir: dir2, builder: 'claude', from_stage: 'in-progress', to_stage: 'in-review',
    base_commit: 'abc', run_id: 'r9', tests: [{ command: 't', ok: true }],
  });
  assert.equal(made.ok, true);
  const e = classifyRecovery(ws, 'wrong-edge', { now: NOW });
  assert.equal(e.state, 'invalid');
  assert.equal(e.reason, 'stage-mismatch');

  // Manifest binds SPEC.md bytes that predate the finalize stamps: delegating
  // would invalidate the committed manifest, so recovery refuses instead.
  writeCommittedHandoff(ws, 'unstamped', { stamp: false });
  const u = classifyRecovery(ws, 'unstamped', { now: NOW });
  assert.equal(u.state, 'invalid');
  assert.equal(u.reason, 'unstamped-spec');
}));

test('classifyRecovery: duplicate board is a conflict; finalized in tests/ is finalized', () => withWorkspace(({ ws }) => {
  writeCommittedHandoff(ws, 'twins', {});
  fs.mkdirSync(path.join(ws, 'tests', 'twins'), { recursive: true });
  assert.equal(classifyRecovery(ws, 'twins', { now: NOW }).state, 'conflict');
}));

// ---------- recovery: the recover path ----------

test('recover: finishes the committed hand-off — byte-identical manifest, builder attribution, recoverer logged, lease released', () => withWorkspace(({ ws }) => {
  const fromDir = writeCommittedHandoff(ws, 'crashed-mid-move', {});
  const shaBefore = manifestSha(fromDir);

  const res = recoverPreparedHandoff(ws, 'crashed-mid-move', {
    by: 'trevor', reason: 'host restart killed the session between manifest and move', now: NOW,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.mode, 'lease-expired');
  assert.equal(res.to, 'tests/crashed-mid-move/');
  assert.equal(res.builder, 'claude');            // the builder, NOT the recoverer
  assert.equal(res.recovered_by, 'trevor');
  assert.equal(res.reused_manifest, true);        // never re-prepared
  assert.equal(res.byte_identical, true);
  assert.equal(res.lease_released, true);

  const toDir = path.join(ws, 'tests', 'crashed-mid-move');
  assert.ok(!fs.existsSync(fromDir));
  assert.equal(manifestSha(toDir), shaBefore);    // byte-identical reuse, proven

  const { meta } = parseFrontmatter(fs.readFileSync(path.join(toDir, 'SPEC.md'), 'utf8'));
  assert.equal(meta.claimed_by, 'claude');        // attribution preserved
  assert.equal(String(meta.awaiting_verifier), 'true');
  assert.equal(meta.status, 'tests');

  // The recoverer is recorded separately: NOTES.md + a `recovery` trace event
  // correlated to the manifest's run_id.
  const notes = fs.readFileSync(path.join(toDir, 'NOTES.md'), 'utf8');
  assert.match(notes, /## Recovered /);
  assert.match(notes, /builder: claude \(run run-orig-1\)/);
  assert.match(notes, /recovered by: trevor/);
  assert.match(notes, /host restart killed the session/);

  const events = readSpecTrace(toDir);
  const handoff = events.find(e => e.type === 'handoff');
  const recovery = events.find(e => e.type === 'recovery');
  assert.ok(handoff, 'finalize handoff event present');
  assert.equal(handoff.actor_id, 'claude');
  assert.ok(recovery, 'recovery provenance event present');
  assert.equal(recovery.actor_id, 'trevor');
  assert.equal(recovery.run_id, 'run-orig-1');
  assert.equal(recovery.recovered_by, 'trevor');

  // The lease is gone — released through the finalize contract.
  assert.ok(!fs.existsSync(path.join(ws, '_metrics', 'builder-leases', 'crashed-mid-move.json')));
}));

test('recover: repeat is idempotent — already finalized returns ok without touching anything', () => withWorkspace(({ ws }) => {
  writeCommittedHandoff(ws, 'twice', {});
  const first = recoverPreparedHandoff(ws, 'twice', { by: 'trevor', reason: 'died', now: NOW });
  assert.equal(first.ok, true);
  const toDir = path.join(ws, 'tests', 'twice');
  const sha = manifestSha(toDir);
  const notesBefore = fs.readFileSync(path.join(toDir, 'NOTES.md'), 'utf8');

  const again = recoverPreparedHandoff(ws, 'twice', { by: 'cursor', reason: 'retry', now: NOW + HOUR });
  assert.equal(again.ok, true);
  assert.equal(again.already_finalized, true);
  assert.equal(manifestSha(toDir), sha);
  assert.equal(fs.readFileSync(path.join(toDir, 'NOTES.md'), 'utf8'), notesBefore); // no second note
}));

test('recover refuses: live lease — never steal a live builder, holder reported', () => withWorkspace(({ ws }) => {
  writeCommittedHandoff(ws, 'alive', { lease: 'live' });
  const res = recoverPreparedHandoff(ws, 'alive', { by: 'trevor', reason: 'impatient', now: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'live-lease');
  assert.equal(res.holder.actor, 'claude');
  assert.equal(res.holder.run_id, 'run-orig-1');
  assert.ok(fs.existsSync(path.join(ws, 'in-progress', 'alive', 'SPEC.md'))); // untouched
}));

test('recover refuses: partial, invalid, no-manifest, missing by/reason, not-found, conflict', () => withWorkspace(({ ws }) => {
  writeClaim(ws, 'torn', { files: { 'outcome/HANDOFF.json.tmp.9-9-ff': '{', 'outcome/FEEDBACK.md': 'x\n' } });
  assert.equal(recoverPreparedHandoff(ws, 'torn', { by: 'x', reason: 'y', now: NOW }).reason, 'partial-handoff');

  const dir = writeCommittedHandoff(ws, 'drifted', {});
  fs.writeFileSync(path.join(dir, 'outcome', 'BUILDER.diff'), 'changed\n');
  const inv = recoverPreparedHandoff(ws, 'drifted', { by: 'x', reason: 'y', now: NOW });
  assert.equal(inv.reason, 'invalid-manifest');
  assert.equal(inv.cause, 'artifact-changed');

  writeClaim(ws, 'legacy-work', { files: { 'outcome/FEEDBACK.md': 'x\n', 'outcome/BUILDER.diff': 'd\n' } });
  assert.equal(recoverPreparedHandoff(ws, 'legacy-work', { by: 'x', reason: 'y', now: NOW }).reason, 'no-manifest');

  writeCommittedHandoff(ws, 'needs-why', {});
  assert.equal(recoverPreparedHandoff(ws, 'needs-why', { by: 'x', now: NOW }).reason, 'reason-required');
  assert.equal(recoverPreparedHandoff(ws, 'needs-why', { reason: 'y', now: NOW }).reason, 'by-required');
  assert.ok(fs.existsSync(path.join(ws, 'in-progress', 'needs-why', 'SPEC.md')));

  assert.equal(recoverPreparedHandoff(ws, 'ghost', { by: 'x', reason: 'y', now: NOW }).reason, 'not-found');

  writeCommittedHandoff(ws, 'doubled', {});
  fs.mkdirSync(path.join(ws, 'tests', 'doubled'), { recursive: true });
  assert.equal(recoverPreparedHandoff(ws, 'doubled', { by: 'x', reason: 'y', now: NOW }).reason, 'destination-exists');
}));

test('recover: legacy no-lease grace is explicit — refuses without the flag, refuses on fresh activity, recovers when idle', () => withWorkspace(({ ws }) => {
  // No lease, no flag: typed refusal that documents the grace path.
  writeCommittedHandoff(ws, 'pre-lease-era', { lease: 'none' });
  const bare = recoverPreparedHandoff(ws, 'pre-lease-era', { by: 'trevor', reason: 'old work', now: NOW, thresholdMs: 24 * HOUR });
  assert.equal(bare.ok, false);
  assert.equal(bare.reason, 'no-lease');
  assert.match(String(bare.detail), /FEEDBACK\.md alone is never completion/);

  // Flag + fresh activity: a builder may be alive without a lease — refuse.
  writeCommittedHandoff(ws, 'maybe-alive', { lease: 'none', at: NOW - 2 * HOUR, claimedAt: '2026-07-14' });
  const fresh = recoverPreparedHandoff(ws, 'maybe-alive', {
    by: 'trevor', reason: 'old work', now: NOW, thresholdMs: 24 * HOUR, allowNoLease: true,
  });
  assert.equal(fresh.ok, false);
  assert.equal(fresh.reason, 'recent-activity');

  // Flag + idle past threshold + valid manifest: the documented grace path.
  const ok = recoverPreparedHandoff(ws, 'pre-lease-era', {
    by: 'trevor', reason: 'legacy work, valid manifest, long idle', now: NOW, thresholdMs: 24 * HOUR, allowNoLease: true,
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.mode, 'no-lease-grace');
  const notes = fs.readFileSync(path.join(ws, 'tests', 'pre-lease-era', 'NOTES.md'), 'utf8');
  assert.match(notes, /legacy grace/);
}));

test('recover: grace never treats FEEDBACK.md alone as completion — no manifest, no recovery, flag or not', () => withWorkspace(({ ws }) => {
  writeClaim(ws, 'smells-done', { files: { 'outcome/FEEDBACK.md': 'looks finished\n', 'outcome/BUILDER.diff': 'd\n' } });
  const res = recoverPreparedHandoff(ws, 'smells-done', {
    by: 'trevor', reason: 'looks done to me', now: NOW, allowNoLease: true, thresholdMs: 24 * HOUR,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-manifest');
  assert.ok(fs.existsSync(path.join(ws, 'in-progress', 'smells-done', 'SPEC.md')));
}));

test('recover: manifest recording a failing test refuses through the finalize gate', () => withWorkspace(({ ws }) => {
  writeCommittedHandoff(ws, 'red-gate', { tests: [{ command: 'npm test', ok: false, exit_code: 1 }] });
  const res = recoverPreparedHandoff(ws, 'red-gate', { by: 'trevor', reason: 'try anyway', now: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'failing-tests');
  assert.ok(fs.existsSync(path.join(ws, 'in-progress', 'red-gate', 'SPEC.md'))); // refused before any move
}));

test('recover race: mutate bound artifact between classify and finalize — no canonical bytes or stage change', () => withWorkspace(({ ws }) => {
  // Deterministic classify→finalize window: classification succeeds, then a
  // bound artifact drifts before reuse_only finalize runs. Prove refuse-before-
  // write: HANDOFF.json bytes unchanged, SPEC.md unchanged, still in-progress/.
  const fromDir = writeCommittedHandoff(ws, 'race-drift', {});
  const c = classifyRecovery(ws, 'race-drift', { now: NOW });
  assert.equal(c.state, 'recoverable');
  const shaBefore = manifestSha(fromDir);
  const specBefore = fs.readFileSync(path.join(fromDir, 'SPEC.md'));
  fs.writeFileSync(path.join(fromDir, 'outcome', 'FEEDBACK.md'), 'tampered between classify and finalize\n');

  const REQUIRED = ['SPEC.md', 'outcome/FEEDBACK.md', 'outcome/BUILDER.diff'];
  const fin = finalizeBuilderHandoff({
    wsDir: ws, slug: 'race-drift',
    actor: c.builder, runId: c.run_id,
    baseCommit: String(c.manifest.base_commit),
    tests: c.manifest.tests,
    artifacts: c.manifest.artifacts.map(a => a.path).filter(p => !REQUIRED.includes(p)),
    initiation: 'human', source: 'recovery',
    reuseOnly: true,
    now: new Date(NOW),
  });
  assert.equal(fin.ok, false, JSON.stringify(fin));
  assert.equal(fin.reason, 'manifest-invalidated');
  assert.equal(fin.cause, 'artifact-changed');
  assert.ok(fs.existsSync(path.join(ws, 'in-progress', 'race-drift', 'SPEC.md')));
  assert.equal(fs.existsSync(path.join(ws, 'tests', 'race-drift')), false);
  assert.equal(manifestSha(fromDir), shaBefore);
  assert.equal(fs.readFileSync(path.join(fromDir, 'SPEC.md')).equals(specBefore), true);

  // Full recover path after the same drift: classify refuses before finalize.
  const res = recoverPreparedHandoff(ws, 'race-drift', { by: 'cursor', reason: 'race probe', now: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid-manifest');
  assert.equal(res.cause, 'artifact-changed');
  assert.equal(manifestSha(fromDir), shaBefore);
  assert.ok(fs.existsSync(path.join(ws, 'in-progress', 'race-drift', 'SPEC.md')));
}));

// ---------- recovery: CLI surface ----------

test('tl recover (no spec): lists typed candidates, changes nothing; plain stalls are routed to reclaim', () => withWorkspace(({ root, name, ws }) => {
  writeCommittedHandoff(ws, 'ready-to-finish', {});
  writeCommittedHandoff(ws, 'builder-alive', { lease: 'live', leaseNow: Date.now(), at: Date.now() - HOUR });
  writeClaim(ws, 'plain-stall', { at: Date.now() - 60 * HOUR });
  const r = run(root, 'recover', name);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RECOVERY CANDIDATES/);
  assert.match(r.stdout, /ready-to-finish.*RECOVERABLE/);
  assert.match(r.stdout, /builder-alive.*ACTIVE — live builder lease \(claude/);
  assert.match(r.stdout, /1 in-progress claim\(s\) without a committed handoff.*tl reclaim/);
  assert.ok(fs.existsSync(path.join(ws, 'in-progress', 'ready-to-finish', 'SPEC.md'))); // listing acted on nothing
  assert.ok(fs.existsSync(path.join(ws, 'in-progress', 'builder-alive', 'SPEC.md')));
}));

test('tl recover <spec> (no flags): read-only inspect distinguishes states', () => withWorkspace(({ root, name, ws }) => {
  writeCommittedHandoff(ws, 'inspect-me', {});
  const r = run(root, 'recover', name, 'inspect-me');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RECOVERY INSPECT/);
  assert.match(r.stdout, /RECOVERABLE — valid HANDOFF\.json \(builder claude, run run-orig-1\)/);
  assert.ok(fs.existsSync(path.join(ws, 'in-progress', 'inspect-me', 'SPEC.md'))); // no writes

  const dir = writeCommittedHandoff(ws, 'inspect-bad', {});
  fs.writeFileSync(path.join(dir, 'outcome', 'FEEDBACK.md'), 'drifted\n');
  const bad = run(root, 'recover', name, 'inspect-bad');
  assert.equal(bad.status, 0, bad.stderr);
  assert.match(bad.stdout, /INVALID — manifest refused \(artifact-changed\)/);
}));

test('tl recover <spec> --by --reason: performs the recovery end to end', () => withWorkspace(({ root, name, ws }) => {
  writeCommittedHandoff(ws, 'finish-line', {});
  const r = run(root, 'recover', name, 'finish-line', '--by', 'trevor', '--reason', 'session died after commit');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /recovered finish-line: in-progress\/finish-line\/ → tests\/finish-line\/ \(lease-expired\)/);
  assert.match(r.stdout, /builder attribution preserved \(claude, run run-orig-1\)/);
  assert.ok(fs.existsSync(path.join(ws, 'tests', 'finish-line', 'outcome', 'HANDOFF.json')));
}));

test('tl recover <spec> --by without --reason: non-zero exit, typed message, nothing moves', () => withWorkspace(({ root, name, ws }) => {
  writeCommittedHandoff(ws, 'no-why', {});
  const r = run(root, 'recover', name, 'no-why', '--by', 'trevor');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--reason/);
  assert.ok(fs.existsSync(path.join(ws, 'in-progress', 'no-why', 'SPEC.md')));
}));

test('tl recover live lease: non-zero exit, never-steal message with holder', () => withWorkspace(({ root, name, ws }) => {
  writeCommittedHandoff(ws, 'mid-build', { lease: 'live', leaseNow: Date.now(), at: Date.now() - HOUR });
  const r = run(root, 'recover', name, 'mid-build', '--by', 'trevor', '--reason', 'want it now');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /live builder lease/);
  assert.match(r.stderr, /holder claude/);
  assert.ok(fs.existsSync(path.join(ws, 'in-progress', 'mid-build', 'SPEC.md')));
}));

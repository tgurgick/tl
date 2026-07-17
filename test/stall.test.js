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
} = require('../lib/stall');
const { parseFrontmatter } = require('../lib/parse');

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

// Isolated verifier runner + the leased, read-only verifier queue. The model is
// an untrusted reviewer: TL runs declared checks in a disposable worktree, gives
// the reviewer their output, and accepts only a structured verdict. Source
// mutations are findings, never patches — a requested mutation is a review
// finding, not permission to edit (done/isolated-verifier-runner).
//
// Queue contract (verifier-queue-leases-readonly):
//   - Eligibility: `tests/` plus a valid outcome/HANDOFF.json manifest is
//     canonical; legacy `awaiting_verifier: true` work without a manifest stays
//     eligible during migration (lib/handoff.js classifyHandoff). Invalid or
//     interrupted manifests are refusals, not verifiable work.
//   - Leases: one exclusive, expiring per-spec lease at
//     `_metrics/verify-locks/<slug>.lock` — the SAME file the scheduled
//     verifyTick (lib/worker.js) locks, so interactive and headless paths
//     contend on one primitive. Atomic acquisition (O_EXCL create), holder-
//     checked heartbeat/release, mtime-based expiry, stale takeover. Builder
//     exclusion is enforced at acquisition, not just selection.
//   - Concurrency: distinct specs may verify in parallel up to a calm,
//     configurable cap (`verification.verifier_concurrency`, default 2);
//     exactly one verifier owns any given spec at a time.
//   - Results are immutable: every verification appends one row to the spec's
//     `outcome/VERIFICATIONS.jsonl`; rows are never rewritten. Mutation desires
//     (proposed or detected) are recorded in ALIGNMENT.md / NOTES.md as
//     human-decision-required — never applied.
//   - Advancement: a clean pass moves tests → in-review through the guarded
//     stage CAS (lib/stage.js moveSpec, role `verifier`) only — never done/.
// Cooperative enforcement, not an OS boundary (same posture as lib/stage.js).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { setFrontmatterField, fmValue } = require('./frontmatter');
const { parseFrontmatter } = require('./parse');
const { safeRead, isDir } = require('./workspace');
const { moveSpec } = require('./stage');
const { classifyHandoff, validateHandoff } = require('./handoff');

const RESULT_BEGIN = 'TL_VERIFIER_RESULT_BEGIN';
const RESULT_END = 'TL_VERIFIER_RESULT_END';
const SECRET_ENV = /^(ANTHROPIC|CLAUDE|OPENAI|GOOGLE|GEMINI|AWS|AZURE|GITHUB|GH|JIRA|SLACK|NPM)_/i;

function scrubEnvironment(source = process.env, keep = {}) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (!SECRET_ENV.test(key)) out[key] = value;
  }
  return { ...out, ...keep };
}

function normalizePolicy(raw = {}) {
  const mode = raw.mode === 'review-only' ? 'review-only' : 'verify';
  const command = Array.isArray(raw.command) ? raw.command.map(String) : [];
  const flags = command.concat(Array.isArray(raw.extra_flags) ? raw.extra_flags.map(String) : []);
  if (flags.includes('--dangerously-skip-permissions')) {
    throw new Error('unsafe verifier configuration: --dangerously-skip-permissions is forbidden');
  }
  const allowCommands = Array.isArray(raw.allow_commands)
    ? raw.allow_commands.map(String).filter(Boolean) : [];
  if (mode === 'review-only' && allowCommands.length) {
    throw new Error('review-only verifier cannot declare acceptance commands');
  }
  return { mode, command, allowCommands, allowNetwork: raw.allow_network === true };
}

function buildGeminiInvocation(policy, prompt) {
  const p = normalizePolicy(policy);
  const base = p.command.length ? p.command : ['agy'];
  return {
    file: base[0],
    args: base.slice(1).concat(['--sandbox', '--mode', 'plan', '-p', String(prompt)]),
  };
}

function parseStructuredResult(stdout) {
  const src = String(stdout || '');
  const start = src.lastIndexOf(RESULT_BEGIN);
  const end = src.lastIndexOf(RESULT_END);
  if (start < 0 || end <= start) throw new Error('verifier output missing structured result markers');
  const raw = src.slice(start + RESULT_BEGIN.length, end).trim();
  const result = JSON.parse(raw);
  if (!['pass', 'concerns', 'human-decision-required'].includes(result.verdict)) {
    throw new Error('invalid verifier verdict');
  }
  result.notes = Array.isArray(result.notes) ? result.notes.map(String) : [];
  result.proposed_mutations = Array.isArray(result.proposed_mutations)
    ? result.proposed_mutations.map(m => ({ file: String(m.file || ''), reason: String(m.reason || '') })) : [];
  return result;
}

function changedFiles(repo, run = spawnSync) {
  const r = run('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('could not inspect verifier worktree');
  return String(r.stdout || '').split('\n').filter(Boolean).map(line => line.slice(3).trim()).filter(Boolean);
}

function runAcceptanceCommands(repo, commands, run = spawnSync, env = process.env) {
  const results = [];
  for (const command of commands) {
    const r = run('/bin/sh', ['-lc', command], {
      cwd: repo, env: scrubEnvironment(env), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    results.push({ command, status: r.status == null ? 1 : r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') });
  }
  return results;
}

function makePrompt({ brief, checks }) {
  return [
    'You are an independent reviewer in a disposable worktree.',
    'Do not edit files, run commands, access the network, or read credentials. TL already ran the allowed checks.',
    'If a mutation is advisable, record it under proposed_mutations; never implement it.',
    'Return JSON between the exact markers below with verdict, notes, and proposed_mutations.',
    RESULT_BEGIN, '{"verdict":"pass|concerns|human-decision-required","notes":[],"proposed_mutations":[{"file":"path","reason":"why"}]}', RESULT_END,
    '', 'BRIEF:', String(brief || ''), '', 'ALLOWLISTED CHECK RESULTS:', JSON.stringify(checks),
  ].join('\n');
}

function createWorktree(repo, run = spawnSync, tempRoot = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(tempRoot, 'tl-verify-'));
  const r = run('git', ['worktree', 'add', '--detach', dir, 'HEAD'], { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error('could not create verifier worktree'); }
  return dir;
}

function removeWorktree(repo, dir, run = spawnSync) {
  run('git', ['worktree', 'remove', '--force', dir], { cwd: repo, encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
}

function runIsolatedVerification(opts) {
  const run = opts.spawn || spawnSync;
  const policy = normalizePolicy(opts.policy);
  const worktree = (opts.createWorktree || createWorktree)(opts.repo, run, opts.tempRoot);
  try {
    const checks = policy.mode === 'review-only' ? [] : runAcceptanceCommands(worktree, policy.allowCommands, run, opts.env);
    const prompt = makePrompt({ brief: opts.brief, checks });
    const invocation = (opts.buildInvocation || buildGeminiInvocation)(policy, prompt);
    const child = run(invocation.file, invocation.args, {
      cwd: worktree, env: scrubEnvironment(opts.env), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    if (child.status !== 0) return { status: 'blocked', reason: 'verifier process failed', checks };
    const result = parseStructuredResult(child.stdout);
    const mutations = changedFiles(worktree, run);
    const proposed = result.proposed_mutations.concat(mutations.map(file => ({ file, reason: 'unexpected verifier worktree mutation' })));
    if (proposed.length) {
      return { status: 'human-decision-required', verdict: 'human-decision-required', notes: result.notes, proposed_mutations: proposed, checks };
    }
    if (checks.some(c => c.status !== 0)) return { status: 'blocked', reason: 'allowlisted acceptance command failed', notes: result.notes, checks };
    return { status: result.verdict === 'pass' ? 'pass' : 'blocked', verdict: result.verdict, notes: result.notes, checks };
  } finally {
    (opts.removeWorktree || removeWorktree)(opts.repo, worktree, run);
  }
}

// ---------- leases (_metrics/verify-locks/<slug>.lock) ----------
//
// Same path lib/worker.js verifyLockPath uses, on purpose: the scheduled
// verify tick and this queue contend on one file. Staleness is judged by file
// mtime (parity with worker.js checkLock) so a corrupt lease still expires
// rather than wedging the spec forever.

const VERIFIER_LEASE_DIR = '_metrics/verify-locks';
const DEFAULT_LEASE_TTL_MINUTES = 60; // matches DEFAULT_VERIFY_LOCK_TIMEOUT_MINUTES
const DEFAULT_VERIFIER_CONCURRENCY = 2; // calm over swarm
const VERIFIER_RESULTS_REL = 'outcome/VERIFICATIONS.jsonl';
const LEASE_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const QUEUE_STAGES = Object.freeze(['tests', 'in-progress']);

function refusal(reason, details = {}) {
  return { ok: false, reason, ...details };
}

function verifierLeasePath(wsDir, slug) {
  return path.join(wsDir, ...VERIFIER_LEASE_DIR.split('/'), slug + '.lock');
}

function readVerifierLease(wsDir, slug) {
  const file = verifierLeasePath(wsDir, slug);
  let st;
  try { st = fs.statSync(file); } catch { return { exists: false, lease: null, mtimeMs: 0 }; }
  let lease = null;
  try { lease = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { lease = null; }
  return { exists: true, lease, mtimeMs: st.mtimeMs };
}

// free | held | stale — mtime-based, content-independent.
function verifierLeaseState({ wsDir, slug, ttlMinutes = DEFAULT_LEASE_TTL_MINUTES, nowMs = Date.now() }) {
  const read = readVerifierLease(wsDir, slug);
  if (!read.exists) return { state: 'free', holder: null, ageMinutes: 0, lease: null };
  const ageMinutes = (nowMs - read.mtimeMs) / 60000;
  const holder = read.lease && read.lease.verifier ? String(read.lease.verifier) : null;
  return {
    state: ageMinutes < ttlMinutes ? 'held' : 'stale',
    holder,
    ageMinutes: Math.round(ageMinutes),
    lease: read.lease,
  };
}

function specDirFor(wsDir, slug) {
  for (const stage of QUEUE_STAGES) {
    const dir = path.join(wsDir, stage, slug);
    if (isDir(dir)) return { stage, dir };
  }
  return null;
}

function specBuilder(specDir) {
  const text = safeRead(path.join(specDir, 'SPEC.md'));
  if (text == null) return null;
  const meta = parseFrontmatter(text).meta || {};
  const v = String(meta.claimed_by || meta.agent || '').toLowerCase().trim();
  return v && v !== 'any' ? v : null;
}

// Exclusive, expiring acquisition. Builder exclusion is enforced HERE — a
// verifier can never lease its own build, whatever the selection layer said.
// Atomicity: O_EXCL (`wx`) create wins or loses cleanly; stale takeover
// unlinks the expired file and retries the exclusive create exactly once, so
// two takers resolve to one winner.
function acquireVerifierLease(opts = {}) {
  const wsDir = opts.wsDir && path.resolve(String(opts.wsDir));
  const slug = String(opts.slug || '');
  const verifier = String(opts.verifier || '').trim();
  const ttlMinutes = Number.isFinite(Number(opts.ttlMinutes)) && Number(opts.ttlMinutes) > 0
    ? Number(opts.ttlMinutes) : DEFAULT_LEASE_TTL_MINUTES;
  const now = opts.now instanceof Date ? opts.now : new Date();
  if (!wsDir || !LEASE_SLUG_RE.test(slug) || !verifier) {
    return refusal('invalid-lease-request', { slug: slug || null, verifier: verifier || null });
  }

  const found = specDirFor(wsDir, slug);
  if (!found) return refusal('spec-not-found', { slug });
  const builder = specBuilder(found.dir);
  if (builder && builder === verifier.toLowerCase()) {
    return refusal('builder-exclusion', { slug, verifier, builder });
  }

  const file = verifierLeasePath(wsDir, slug);
  const lease = {
    slug, verifier, builder: builder || null,
    acquired_at: now.toISOString(), renewed_at: now.toISOString(),
    ttl_minutes: ttlMinutes, pid: process.pid,
    ...(opts.runId ? { run_id: String(opts.runId) } : {}),
  };
  const body = JSON.stringify(lease) + '\n';

  const tryCreate = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (err) {
      if (err && err.code === 'EEXIST') return false;
      throw err;
    }
  };

  try {
    if (tryCreate()) return { ok: true, lease, path: file, takeover: false };
    const state = verifierLeaseState({ wsDir, slug, ttlMinutes, nowMs: now.getTime() });
    if (state.state === 'held') {
      return refusal('lease-held', {
        slug, verifier, holder: state.holder, age_minutes: state.ageMinutes, ttl_minutes: ttlMinutes,
      });
    }
    // Stale: expired holder loses the spec. One unlink + one exclusive retry —
    // a concurrent taker that wins the recreate turns this into lease-held.
    try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (tryCreate()) {
      return { ok: true, lease, path: file, takeover: true, taken_over_from: state.holder };
    }
    const after = verifierLeaseState({ wsDir, slug, ttlMinutes, nowMs: now.getTime() });
    return refusal('lease-held', {
      slug, verifier, holder: after.holder, age_minutes: after.ageMinutes, ttl_minutes: ttlMinutes,
    });
  } catch (err) {
    return refusal('io-error', { slug, code: String(err.code || 'unknown'), detail: String(err.message || err) });
  }
}

// Holder-checked renewal — rewrites the lease (bumping mtime, the expiry
// clock). A lost lease is reported honestly, never silently re-acquired.
function heartbeatVerifierLease(opts = {}) {
  const wsDir = opts.wsDir && path.resolve(String(opts.wsDir));
  const slug = String(opts.slug || '');
  const verifier = String(opts.verifier || '').trim();
  const now = opts.now instanceof Date ? opts.now : new Date();
  if (!wsDir || !LEASE_SLUG_RE.test(slug) || !verifier) {
    return refusal('invalid-lease-request', { slug: slug || null, verifier: verifier || null });
  }
  const read = readVerifierLease(wsDir, slug);
  if (!read.exists) return refusal('lease-lost', { slug, verifier });
  const holder = read.lease && read.lease.verifier ? String(read.lease.verifier) : null;
  if (holder !== verifier) return refusal('not-lease-holder', { slug, verifier, holder });
  const renewed = { ...read.lease, renewed_at: now.toISOString() };
  try {
    fs.writeFileSync(verifierLeasePath(wsDir, slug), JSON.stringify(renewed) + '\n');
  } catch (err) {
    return refusal('io-error', { slug, code: String(err.code || 'unknown'), detail: String(err.message || err) });
  }
  return { ok: true, lease: renewed };
}

// Holder-checked release; releasing an already-gone lease is idempotent
// ({ released: false }), releasing someone else's is a refusal.
function releaseVerifierLease(opts = {}) {
  const wsDir = opts.wsDir && path.resolve(String(opts.wsDir));
  const slug = String(opts.slug || '');
  const verifier = String(opts.verifier || '').trim();
  if (!wsDir || !LEASE_SLUG_RE.test(slug) || !verifier) {
    return refusal('invalid-lease-request', { slug: slug || null, verifier: verifier || null });
  }
  const read = readVerifierLease(wsDir, slug);
  if (!read.exists) return { ok: true, released: false };
  const holder = read.lease && read.lease.verifier ? String(read.lease.verifier) : null;
  if (holder !== null && holder !== verifier) {
    return refusal('not-lease-holder', { slug, verifier, holder });
  }
  try { fs.unlinkSync(verifierLeasePath(wsDir, slug)); } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, released: false };
    return refusal('io-error', { slug, code: String(err.code || 'unknown'), detail: String(err.message || err) });
  }
  return { ok: true, released: true };
}

// ---------- the manifest-backed queue ----------

function humanDecisionPending(meta = {}) {
  if (String(meta.verifier_status || '').toLowerCase() === 'human-decision-required') return true;
  return String(meta.status || '').toLowerCase() === 'blocked'
    && String(meta.blocked_reason || '').toLowerCase().includes('human decision');
}

// One spec's eligibility. Canonical: at tests/ with a valid V1 manifest.
// Legacy: `awaiting_verifier: true` without a (valid) manifest — grandfathered
// during migration. Broken manifests are refusals, not verifiable work.
function verifierEligibility(specDir, meta = {}, stage = 'tests') {
  if (humanDecisionPending(meta)) {
    return { eligible: false, reason: 'human-decision-required' };
  }
  const cls = classifyHandoff(specDir);
  if (cls.kind === 'v1') {
    if (stage !== 'tests') {
      return meta.awaiting_verifier === true
        ? { eligible: true, eligibility: 'legacy', classification: cls.kind, manifest: cls.manifest }
        : { eligible: false, reason: 'not-at-tests' };
    }
    return { eligible: true, eligibility: 'manifest', classification: cls.kind, manifest: cls.manifest };
  }
  if (cls.kind === 'invalid') {
    return { eligible: false, reason: 'invalid-manifest', detail: cls.reason };
  }
  if (cls.kind === 'partial' && cls.reason === 'partial-write') {
    return { eligible: false, reason: 'partial-write' };
  }
  if (meta.awaiting_verifier === true) {
    return { eligible: true, eligibility: 'legacy', classification: cls.kind, manifest: null };
  }
  return { eligible: false, reason: 'not-awaiting' };
}

// Scan tests/ (canonical) and in-progress/ (legacy migration surface) for
// verifiable work. Returns { eligible, ineligible }; eligible sorted oldest
// SPEC.md first so contention across verifiers starts at opposite ends of
// nothing — everyone sees the same order, leases decide ownership.
function verifierQueue(wsDir) {
  const eligible = [], ineligible = [];
  for (const stage of QUEUE_STAGES) {
    const stageDir = path.join(wsDir, stage);
    if (!isDir(stageDir)) continue;
    for (const entry of fs.readdirSync(stageDir).sort()) {
      if (entry.startsWith('.') || !LEASE_SLUG_RE.test(entry)) continue;
      const dir = path.join(stageDir, entry);
      if (!isDir(dir)) continue;
      const text = safeRead(path.join(dir, 'SPEC.md'));
      if (text == null) continue;
      const meta = parseFrontmatter(text).meta || {};
      const e = verifierEligibility(dir, meta, stage);
      const row = {
        slug: entry, stage, path: `${stage}/${entry}/`,
        builder: specBuilder(dir), meta,
        mtime: (() => { try { return fs.statSync(path.join(dir, 'SPEC.md')).mtimeMs; } catch { return 0; } })(),
      };
      if (e.eligible) eligible.push({ ...row, eligibility: e.eligibility, manifest: e.manifest || null });
      else if (e.reason !== 'not-awaiting') ineligible.push({ ...row, reason: e.reason, ...(e.detail ? { detail: e.detail } : {}) });
    }
  }
  eligible.sort((a, b) => a.mtime - b.mtime);
  return { eligible, ineligible };
}

// `verification.verifier_concurrency` — fallback-on-garbage to a calm 2.
function verifierConcurrency(cfg, fallback = DEFAULT_VERIFIER_CONCURRENCY) {
  const v = cfg && cfg.verification ? Number(cfg.verification.verifier_concurrency) : NaN;
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

function countHeldLeases(wsDir, { ttlMinutes = DEFAULT_LEASE_TTL_MINUTES, nowMs = Date.now() } = {}) {
  const dir = path.join(wsDir, ...VERIFIER_LEASE_DIR.split('/'));
  if (!isDir(dir)) return 0;
  let held = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.lock')) continue;
    const slug = f.slice(0, -'.lock'.length);
    if (verifierLeaseState({ wsDir, slug, ttlMinutes, nowMs }).state === 'held') held++;
  }
  return held;
}

// Select up to (cap - leases already held workspace-wide) distinct specs this
// verifier may lease: not its own builds, not currently leased. Selection is
// advisory — acquireVerifierLease is the authority (same posture as pickWork
// vs the run brief). Returns { batch, skipped, cap, active }.
function selectVerifierWork(opts = {}) {
  const wsDir = opts.wsDir && path.resolve(String(opts.wsDir));
  const verifier = String(opts.verifier || '').trim().toLowerCase();
  const ttlMinutes = Number.isFinite(Number(opts.ttlMinutes)) && Number(opts.ttlMinutes) > 0
    ? Number(opts.ttlMinutes) : DEFAULT_LEASE_TTL_MINUTES;
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : Date.now();
  const cap = Number.isInteger(opts.cap) && opts.cap > 0 ? opts.cap : verifierConcurrency(opts.cfg);
  if (!wsDir || !verifier) return { batch: [], skipped: [], cap, active: 0 };

  const active = countHeldLeases(wsDir, { ttlMinutes, nowMs });
  let budget = Math.max(0, cap - active);
  const batch = [], skipped = [];
  for (const entry of verifierQueue(wsDir).eligible) {
    if (entry.builder && entry.builder === verifier) {
      skipped.push({ slug: entry.slug, reason: 'builder-exclusion', builder: entry.builder });
      continue;
    }
    const state = verifierLeaseState({ wsDir, slug: entry.slug, ttlMinutes, nowMs });
    if (state.state === 'held') {
      skipped.push({ slug: entry.slug, reason: 'leased', holder: state.holder });
      continue;
    }
    if (budget <= 0) {
      skipped.push({ slug: entry.slug, reason: 'concurrency-cap', cap });
      continue;
    }
    batch.push(entry);
    budget--;
  }
  return { batch, skipped, cap, active };
}

// ---------- immutable results (outcome/VERIFICATIONS.jsonl) ----------

// Append-only by construction: one JSON row per verification attempt, never
// rewritten. The file lives in the spec folder so it travels with stage moves.
function appendVerifierResult(specDir, row = {}) {
  const record = {
    ts: row.ts || new Date().toISOString(),
    verifier: String(row.verifier || 'unknown'),
    builder: row.builder == null ? null : String(row.builder),
    verdict: String(row.verdict || row.status || 'unknown'),
    eligibility: row.eligibility ? String(row.eligibility) : null,
    ...(row.run_id ? { run_id: String(row.run_id) } : {}),
    ...(Array.isArray(row.notes) ? { notes: row.notes.map(String) } : {}),
    ...(Array.isArray(row.proposed_mutations)
      ? { proposed_mutations: row.proposed_mutations.map(m => ({ file: String(m.file || ''), reason: String(m.reason || '') })) }
      : {}),
  };
  const file = path.join(specDir, ...VERIFIER_RESULTS_REL.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
  return record;
}

function readVerifierResults(specDir) {
  const text = safeRead(path.join(specDir, ...VERIFIER_RESULTS_REL.split('/')));
  if (text == null) return [];
  return text.split('\n').filter(l => l.trim()).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// ---------- read-only parity ----------

// The handoff bytes the builder content-bound must be identical after
// verification. `before` is the manifest captured at lease time (null for
// legacy work — nothing was bound, nothing to compare). Any drift is a
// mutation finding, never a pass.
function manifestParity(specDir, before) {
  if (!before) return { ok: true, legacy: true, changed: [] };
  const after = validateHandoff({ specDir });
  if (!after.ok) {
    return {
      ok: false,
      reason: after.reason,
      changed: after.path ? [after.path] : [],
      details: after,
    };
  }
  const prior = new Map((before.artifacts || []).map(a => [a.path, a.sha256]));
  const changed = [];
  for (const a of after.manifest.artifacts) {
    if (prior.has(a.path) && prior.get(a.path) !== a.sha256) changed.push(a.path);
  }
  return changed.length ? { ok: false, reason: 'artifact-changed', changed } : { ok: true, changed: [] };
}

function alignmentText({ specPath, builder, verifier, result }) {
  const human = result.status === 'human-decision-required';
  const verdict = human ? 'human-decision-required' : (result.verdict || result.status);
  const concerns = (result.notes || []).concat((result.proposed_mutations || []).map(m => `${m.file}: ${m.reason}`));
  return [
    '---', `spec: "${fmValue(specPath)}"`, `builder: "${fmValue(builder)}"`, `verifier: "${fmValue(verifier)}"`,
    'verification_type: "independent"', 'rounds: 1', `verdict: "${fmValue(verdict)}"`,
    ...(concerns.length ? ['residual_concerns:', ...concerns.map(x => `  - "${fmValue(x)}"`)] : ['residual_concerns: []']), '---', '',
    '# Alignment', '', human
      ? 'The verifier proposed a mutation. No source change was applied and the spec remains held for a human decision.'
      : 'The isolated verifier completed without mutating the disposable worktree.', '',
    ...(result.notes || []).map(x => `- ${x}`),
  ].join('\n') + '\n';
}

// Record one verification outcome. All writes (ALIGNMENT, NOTES, frontmatter,
// the immutable VERIFICATIONS.jsonl row) land while the spec is still in
// tests/; the folder move is last, and it goes through the guarded stage CAS
// (lib/stage.js moveSpec, role `verifier`) — whose only verifier edge is
// tests → in-review. There is no path to done/ from here, structurally.
// `eligibility` / `run_id` are optional provenance for the result row.
function recordVerificationOutcome({ wsDir, slug, builder, verifier, result, eligibility = null, run_id = null }) {
  const testsDir = path.join(wsDir, 'tests', slug);
  if (!fs.statSync(testsDir).isDirectory()) throw new Error('spec is not at tests gate');
  const outcomeDir = path.join(testsDir, 'outcome');
  fs.mkdirSync(outcomeDir, { recursive: true });
  fs.writeFileSync(path.join(outcomeDir, 'ALIGNMENT.md'), alignmentText({
    specPath: `tests/${slug}/`, builder, verifier, result,
  }));
  const resultRow = () => appendVerifierResult(testsDir, {
    verifier, builder,
    verdict: result.status === 'human-decision-required' ? 'human-decision-required' : (result.verdict || result.status),
    eligibility, run_id,
    notes: result.notes || [],
    proposed_mutations: result.proposed_mutations || [],
  });

  if (result.status === 'human-decision-required') {
    const proposals = (result.proposed_mutations || []).map(m => `- \`${m.file}\`: ${m.reason}`).join('\n') || '- See ALIGNMENT.md.';
    fs.appendFileSync(path.join(testsDir, 'NOTES.md'), [
      '', '## Verifier mutation proposal — human decision required', '',
      'No mutation was applied. Choose either: approve a fix-forward for an agent to implement, or kick this spec back to the builder/another agent.', '', proposals, '',
    ].join('\n'));
    let spec = fs.readFileSync(path.join(testsDir, 'SPEC.md'), 'utf8');
    spec = setFrontmatterField(spec, 'status', 'blocked');
    spec = setFrontmatterField(spec, 'awaiting_verifier', false);
    spec = setFrontmatterField(spec, 'verified_by', verifier);
    spec = setFrontmatterField(spec, 'verification_type', 'independent');
    fs.writeFileSync(path.join(testsDir, 'SPEC.md'), spec);
    resultRow();
    return { status: 'human-decision-required', path: `tests/${slug}/` };
  }

  if (result.status !== 'pass') {
    resultRow();
    return { status: 'blocked', path: `tests/${slug}/` };
  }
  let spec = fs.readFileSync(path.join(testsDir, 'SPEC.md'), 'utf8');
  spec = setFrontmatterField(spec, 'status', 'in-review');
  spec = setFrontmatterField(spec, 'awaiting_verifier', false);
  spec = setFrontmatterField(spec, 'verified_by', verifier);
  spec = setFrontmatterField(spec, 'verification_type', 'independent');
  fs.writeFileSync(path.join(testsDir, 'SPEC.md'), spec);
  resultRow();
  const moved = moveSpec({
    wsDir, slug, from: 'tests', to: 'in-review', actor: verifier, role: 'verifier',
  });
  if (!moved.ok) {
    throw new Error(`guarded stage move refused (${moved.reason}) — spec remains at tests/${slug}/`);
  }
  return { status: 'in-review', path: `in-review/${slug}/` };
}

// ---------- the leased verification round-trip ----------

// One spec, end to end: lease → verify (injected, read-only) → parity check →
// immutable record → release. The verify seam receives a `heartbeat` callable
// to renew the lease across long checks. Any handoff drift or proposed
// mutation downgrades the round to human-decision-required — never a pass,
// never an applied patch. The spec must sit at tests/ (the only stage the
// guarded verifier edge leaves from); legacy tests/ work verifies too, just
// without a manifest parity baseline.
function runLeasedVerification(opts = {}) {
  const wsDir = opts.wsDir && path.resolve(String(opts.wsDir));
  const slug = String(opts.slug || '');
  const verifier = String(opts.verifier || '').trim();
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();
  const verify = opts.verify;
  if (!wsDir || !LEASE_SLUG_RE.test(slug) || !verifier || typeof verify !== 'function') {
    return refusal('invalid-verification-request', { slug: slug || null, verifier: verifier || null });
  }

  const testsDir = path.join(wsDir, 'tests', slug);
  if (!isDir(testsDir)) return refusal('not-at-tests', { slug });
  const text = safeRead(path.join(testsDir, 'SPEC.md'));
  if (text == null) return refusal('spec-not-found', { slug });
  const meta = parseFrontmatter(text).meta || {};
  const eligibility = verifierEligibility(testsDir, meta, 'tests');
  if (!eligibility.eligible) {
    return refusal('not-eligible', { slug, detail: eligibility.reason });
  }
  const builder = specBuilder(testsDir);

  const acquired = acquireVerifierLease({
    wsDir, slug, verifier, ttlMinutes: opts.ttlMinutes, now: now(), runId: opts.runId,
  });
  if (!acquired.ok) return acquired;

  try {
    const before = eligibility.manifest || null;
    const heartbeat = () => heartbeatVerifierLease({ wsDir, slug, verifier, now: now() });
    const result = verify({ specDir: testsDir, meta, builder, lease: acquired.lease, heartbeat });

    const parity = manifestParity(testsDir, before);
    let final = result || { status: 'blocked', reason: 'verifier returned no result' };
    if (!parity.ok) {
      final = {
        status: 'human-decision-required',
        verdict: 'human-decision-required',
        notes: [...(final.notes || []), `handoff parity violation: ${parity.reason}`],
        proposed_mutations: [
          ...(final.proposed_mutations || []),
          ...(parity.changed || []).map(file => ({ file, reason: 'handoff artifact changed during verification' })),
        ],
      };
    }
    const recorded = recordVerificationOutcome({
      wsDir, slug, builder, verifier, result: final,
      eligibility: eligibility.eligibility,
      run_id: acquired.lease.run_id || null,
    });
    return {
      ok: true, ...recorded,
      eligibility: eligibility.eligibility,
      takeover: acquired.takeover === true,
      parity: parity.ok,
    };
  } finally {
    releaseVerifierLease({ wsDir, slug, verifier });
  }
}

module.exports = {
  RESULT_BEGIN, RESULT_END, scrubEnvironment, normalizePolicy, buildGeminiInvocation,
  parseStructuredResult, changedFiles, runAcceptanceCommands, makePrompt,
  createWorktree, removeWorktree, runIsolatedVerification, alignmentText, recordVerificationOutcome,
  // leased, read-only verifier queue
  VERIFIER_LEASE_DIR, DEFAULT_LEASE_TTL_MINUTES, DEFAULT_VERIFIER_CONCURRENCY, VERIFIER_RESULTS_REL,
  verifierLeasePath, readVerifierLease, verifierLeaseState,
  acquireVerifierLease, heartbeatVerifierLease, releaseVerifierLease,
  verifierEligibility, verifierQueue, verifierConcurrency, countHeldLeases, selectVerifierWork,
  appendVerifierResult, readVerifierResults, manifestParity, runLeasedVerification,
};

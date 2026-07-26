// lib/worker.js — the headless lane driver's decision logic (one tick).
//
// A tick answers one question — does lane <x> have run work right now? — and
// if yes, launches the lane's configured agent CLI exactly once with the
// `tl run` brief as the prompt. The driver is deliberately dumb: it never
// reasons, never edits specs, never moves folders, never advances stages. The
// spawned session does all of that under the run SKILL, stopping at in-review/
// (or blocked at tests/ when independent verification is required). The driver
// is the worker's alarm clock, not its brain; cron/launchd owns the interval.
//
// The pre-check here is advisory only — the authoritative brief is the stdout
// of `node bin/tl.js run <ws> --agent <lane>` (a subprocess, so none of tl.js's
// continuation/banner logic is duplicated). A narrow race between pre-check
// and spawn is accepted for v1. Everything effectful (the tl run subprocess,
// the agent spawn, git) is an injected seam so the whole tick is unit-testable
// without launching real agents. Node stdlib only; zero dependencies.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { parseFrontmatter, parseYaml } = require('./parse');
const { safeRead, isDir, mtime } = require('./workspace');
const { specSlug, activeConflicts, selectBatch, repoHoldReason, calmCap, section, sameLocalRepo } = require('./batch');
const { setFrontmatterField } = require('./frontmatter');
const { moveSpec, observedStages } = require('./stage');
const { createHandoff, validateHandoff, HANDOFF_REL } = require('./handoff');
const {
  normalizePolicy, runIsolatedVerification, recordVerificationOutcome,
} = require('./verifier-worker');

// Stage -> folder ladder, same shape bin/tl.js reads (from _templates/SCHEMA.md).
// Re-declared here because bin/tl.js is a script, not a module — requiring it
// would run main(). Kept minimal: the pre-check only needs stage/meta/body.
const STAGES = [
  ['triage', 'triage'],
  ['ready', 'specs'],
  ['in-progress', 'in-progress'],
  ['tests', 'tests'],
  ['in-review', 'in-review'],
  ['done', 'done'],
];

const DEFAULT_LOCK_TIMEOUT_MINUTES = 120;  // 2h — a stuck session, not a slow one
const DEFAULT_VERIFY_LOCK_TIMEOUT_MINUTES = 60;
const DEFAULT_BUILDER_LEASE_TTL_MINUTES = 120;  // parity with the lane lock timeout
const LANE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;  // lib/stage.js parity — lease files are slug-named
const VERIFY_REQUESTS_DIR = '_metrics/verify-requests';
const VERIFY_LOCKS_DIR = '_metrics/verify-locks';
const BUILDER_LEASES_DIR = '_metrics/builder-leases';

// ---------- workspace reading (pre-check inputs) ----------

function readWorkspaceSpecs(wsDir) {
  const specs = [];
  for (const [stage, folder] of STAGES) {
    const stageDir = path.join(wsDir, folder);
    if (!isDir(stageDir)) continue;
    for (const entry of fs.readdirSync(stageDir).sort()) {
      if (entry.startsWith('.')) continue;
      const p = path.join(stageDir, entry);
      let file = null, isFolder = false;
      if (isDir(p)) { file = path.join(p, 'SPEC.md'); isFolder = true; }
      else if (entry.endsWith('.md')) file = p;
      if (!file) continue;
      const text = safeRead(file);
      if (text === null) continue;
      const { meta, body } = parseFrontmatter(text);
      specs.push({ stage, path: folder + '/' + entry + (isFolder ? '/' : ''), meta, body, mtime: mtime(file) });
    }
  }
  return specs;
}

// Live pending continuations: `_dispatch/<slug>.json` with mode "continuation"
// and status "pending" whose spec is actually in in-progress/ or tests/. Stale
// pending triggers (no matching spec) don't hold the ready queue — same rule as
// `tl run` — so they are simply not returned here.
function readPendingContinuations(wsDir, specs) {
  const dDir = path.join(wsDir, '_dispatch');
  const live = [];
  if (!isDir(dDir)) return live;
  for (const f of fs.readdirSync(dDir).sort()) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    let d = null;
    try { d = JSON.parse(safeRead(path.join(dDir, f)) || ''); } catch { continue; }
    if (!d || d.mode !== 'continuation' || d.status !== 'pending') continue;
    const slug = specSlug(d.spec || f.replace(/\.json$/, ''));
    const spec = specs.find(s => (s.stage === 'in-progress' || s.stage === 'tests') && specSlug(s.path) === slug);
    if (spec) live.push({ file: '_dispatch/' + f, dispatch: d, spec });
  }
  return live;
}

// The claim-time asset preflight inputs for this workspace (lib/batch.js
// repoHoldReason): an fs existence check — never a shell-out — for "directory
// containing .git", the tl checkout root (containment guard), and the
// workspace's own PROJECT.md `repo:` (the tl-developing-tl exemption).
function repoPreflight(root, wsDir) {
  const pm = safeRead(path.join(wsDir, 'PROJECT.md'));
  const workspaceRepo = pm === null ? null : (parseFrontmatter(pm).meta.repo || null);
  return {
    isRepo: p => fs.existsSync(path.join(p, '.git')),
    tlRoot: root || null,
    workspaceRepo,
  };
}

// ---------- lane config (TRIAGE.yml `lanes:`) ----------

// A lane is an agent CLI invocation — tl ships no provider integrations.
// Argv-first: `command` may be a string (whitespace-split into an argv array)
// or a YAML inline list (`command: [bin, arg, ...]`, used verbatim — the same
// argv-array shape the experiment PROVIDERS table and verifier lanes already
// use). Shell interpretation is an explicit opt-in: `shell: true` (literal)
// on the lane map keeps the old spawn-through-sh behavior for commands that
// genuinely need pipes/redirection. Returns
// { command, argv, shell, model, lockTimeoutMinutes } or null when the lane
// isn't configured — `argv` is null for shell lanes, `command` is always the
// display string (automation.js reads it for the reachability probe).
//
// `model` is the optional `lanes.<name>.model` declaration: the model identity
// the lane's command pins (e.g. `claude --model opus` → `model: claude-opus-4`).
// Purely declarative — the worker never verifies it, never edits the command
// with it; it only passes it through to the spawned session's brief so the
// claim stamp can carry `claimed_model` (SCHEMA.md spec frontmatter). Absent,
// empty, or non-scalar values normalize to null — absent = unknown, never
// guessed (fallback-on-garbage, same posture as lock_timeout_minutes).
function laneConfig(cfg, lane) {
  const lanes = cfg && cfg.lanes;
  if (!lanes || typeof lanes !== 'object' || Array.isArray(lanes)) return null;
  const entry = lanes[lane];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const t = Number(entry.lock_timeout_minutes);
  const lockTimeoutMinutes = Number.isFinite(t) && t > 0 ? t : DEFAULT_LOCK_TIMEOUT_MINUTES;
  const shell = entry.shell === true;
  const model = laneModel(entry);

  if (Array.isArray(entry.command)) {
    if (shell) return null;  // shell needs one string to hand to sh — list form is argv-only
    const argv = entry.command.map(x => String(x).trim()).filter(Boolean);
    if (!argv.length) return null;
    return { command: argv.join(' '), argv, shell: false, listForm: true, model, lockTimeoutMinutes };
  }
  if (typeof entry.command !== 'string' || !entry.command.trim()) return null;
  const command = entry.command.trim();
  if (shell) return { command, argv: null, shell: true, listForm: false, model, lockTimeoutMinutes };
  return { command, argv: command.split(/\s+/), shell: false, listForm: false, model, lockTimeoutMinutes };
}

// The `lanes.<name>.model` scalar, or null. Strings and numbers only (YAML
// scalars); anything else — lists, maps, empty/whitespace — is garbage and
// normalizes to null rather than inventing an identity.
function laneModel(entry) {
  const v = entry && entry.model;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return s || null;
}

function validLaneName(lane) {
  return LANE_NAME_RE.test(String(lane || ''));
}

// ---------- selection (pre-check only; the subprocess brief is authoritative) ----------

// Continuation ownership: `claimed_by` is binding — if the spec was claimed,
// only that lane may resume it, and `agent: any` never overrides an existing
// claim. Only when unclaimed does the routing lane (`agent: <lane>` or `any`)
// decide. Otherwise another lane's cron must pick it up.
function continuationEligible(spec, lane) {
  const claimed = String(spec.meta.claimed_by || '').toLowerCase();
  if (claimed) return claimed === lane;
  const agent = String(spec.meta.agent || 'any').toLowerCase();
  return agent === lane || agent === 'any';
}

// One tick, one spawn: pending continuations eligible for this lane first, then
// at most one conflict-free ready spec in this lane. When live continuations
// exist but none is ours, this lane has no work at all — `tl run` holds the
// ready queue back behind any pending continuation, so spawning would hand this
// lane another agent's resume brief. `preflight` (repoPreflight / injected)
// applies the claim-time asset check: repo-held work is not eligible work —
// a lane whose only work is repo-held has NO work, so no agent is spawned.
// `triageCfg` is the workspace's parsed TRIAGE.yml: its `run: { cap: N }` dial
// bounds fresh-batch selection exactly as it does for `tl run` (calmCap's
// fallback-on-garbage → default 4). The continuation path is already within
// any cap — one tick resumes at most one dispatch, and calmCap is never < 1.
// The ready pick returns the capped `batch` too, so callers (and tests) can
// see the selection width, not just the single spec this tick spawns for.
function pickWork({ specs, continuations, lane, dirtyPaths = [], preflight = null, triageCfg = null }) {
  const eligible = continuations.filter(c => continuationEligible(c.spec, lane));
  const workable = eligible.filter(c => !repoHoldReason(c.spec, preflight));
  if (workable.length) return { kind: 'continuation', picked: workable[0].file, spec: workable[0].spec };
  if (eligible.length) return { kind: 'none', picked: null, reason: 'repo_held' };
  if (continuations.length) return { kind: 'none', picked: null, reason: 'no_continuation' };

  // Same lane + conflict + cap + preflight discipline as `tl run --agent <lane>`.
  const doneSlugs = new Set(specs.filter(s => s.stage === 'done').map(s => specSlug(s.path)));
  const activeSpecs = specs.filter(s => ['in-progress', 'tests', 'in-review'].includes(s.stage));
  const active = activeConflicts(activeSpecs, dirtyPaths);
  const laneOf = s => String(s.meta.agent || 'any').toLowerCase();
  const ready = specs.filter(s => s.stage === 'ready' && (laneOf(s) === 'any' || laneOf(s) === lane));
  const { batch } = selectBatch(ready, doneSlugs, { active, cap: calmCap(triageCfg), preflight });
  if (!batch.length) return { kind: 'none', picked: null, reason: 'no_ready' };
  return { kind: 'ready', picked: batch[0].path, spec: batch[0], batch };
}

// ---------- dirty-git parity (mirrors bin/tl.js, which isn't importable) ----------

// Only consulted when the workspace's `repo` frontmatter points at this
// checkout — the guard is about *this* repo's uncommitted edits. Best effort;
// returns [] on any git failure, never throws, never blocks a tick.
function dirtyGitPaths(root, exec = execFileSync) {
  try {
    const raw = exec('git', ['status', '--porcelain'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const paths = [];
    for (const line of String(raw).split('\n')) {
      if (!line.trim()) continue;
      let p = line.slice(3).trim();
      const arrow = p.indexOf(' -> ');
      if (arrow >= 0) p = p.slice(arrow + 4).trim();
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      if (p) paths.push(p);
    }
    return paths;
  } catch { return []; }
}

function workspaceIsThisRepo(specs, root) {
  const repoRef = specs.map(s => s.meta && s.meta.repo).find(Boolean);
  if (!repoRef) return false;
  // Exact resolved path via lib/batch sameLocalRepo — basename coincidence
  // (sibling checkouts named the same) must not enable the dirty-git guard.
  return sameLocalRepo(repoRef, root, process.env.HOME || '');
}

// ---------- prompt delivery (argv default; shell escape for the opt-in path) ----------

// Single-quote escaping: safe under sh for any byte but the quote itself.
// Kept ONLY for the `shell: true` opt-in path — argv lanes never escape.
function shellEscape(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Shell syntax an argv spawn would silently change the meaning of: quoting,
// operators, substitution, globs, escapes. A whitespace-split string command
// containing any of these is a misconfiguration under the argv default — the
// lane must either move structure into the YAML list form / an agent profile,
// or explicitly opt in with `shell: true`. `{`/`}` are excluded (placeholders).
const SHELL_SYNTAX_RE = /[|&;<>()$`\\'"*?[\]\r\n]/;

// Loud pre-spawn validation. Returns a human-readable problem string, or null
// when the lane can spawn as configured. List-form argv is exempt from the
// syntax check — its tokens reach execve verbatim, so any byte is just data.
function laneSpawnIssue(laneCfg, lane) {
  if (!laneCfg) return `lane "${lane}" is not configured`;
  if (laneCfg.shell) return null;                       // explicit opt-in: sh owns the parsing
  const tokens = laneCfg.argv || [];
  if (!laneCfg.listForm && SHELL_SYNTAX_RE.test(tokens.join(' '))) {
    return `lane "${lane}" command contains shell syntax (quotes, |, &, ;, redirection, $, \`, \\, or globs) `
      + `but lanes are argv-first — spawn is direct, no shell parses the command. `
      + `Use the YAML list form (command: [bin, arg, ...]), move structure into the agent's profile, `
      + `or set lanes.${lane}.shell: true to explicitly opt in to shell interpretation.`;
  }
  if (tokens.some(t => t.startsWith('~'))) {
    return `lane "${lane}" command uses "~" — there is no shell to expand it under the argv default. `
      + `Use an absolute path, or set lanes.${lane}.shell: true.`;
  }
  return null;
}

// `{prompt}` substitution gets a single-line form (newlines collapse to
// spaces) — lossy for markdown structure, which is why docs and examples
// prefer `{prompt_file}`.
function promptOneLine(prompt) {
  return String(prompt).replace(/\s*\r?\n\s*/g, ' ').trim();
}

// The lane-config model pass-through into the claim stamp. The worker never
// stamps spec frontmatter on the run path — the spawned session signs the
// claim under skills/run — so `lanes.<name>.model` travels as a trailer on the
// brief: the session stamps `claimed_model` alongside `claimed_by`/`claimed_at`
// when it moves specs/ → in-progress/. Wording is claim-scoped on purpose: a
// continuation resume signs no claim, so the trailer is inert there, and the
// honesty rule from SCHEMA.md rides along — the configured value yields to
// what the agent actually knows it is, and unknown stays unset, never guessed.
function claimModelTrailer(lane, model) {
  return [
    '',
    '--- lane model identity (TRIAGE.yml lanes.' + lane + '.model) ---',
    '',
    'This lane is configured as model: ' + model,
    'When you sign a claim this session (stamping claimed_by/claimed_at as you move a spec',
    'specs/ -> in-progress/), also stamp `claimed_model: "' + model + '"` in the same frontmatter pass.',
    'If you know your actual model differs from the configured one, stamp what you actually are.',
    'If you cannot confirm any model, leave claimed_model unset — absent means unknown, never guess.',
    '',
  ].join('\n');
}

// Append the trailer to a brief (newline-safe). No model → brief unchanged.
function briefWithClaimModel(brief, lane, model) {
  if (!model) return brief;
  const b = String(brief);
  return b + (b.endsWith('\n') ? '' : '\n') + claimModelTrailer(lane, model) + '\n';
}

// The builder-lease trailer: the tick acquired an expiring lease for the
// dispatched spec before spawning, so the session must know its run_id, how
// to heartbeat, and that the tests-gate hand-off is the write-last finalize
// (skills/run/SKILL.md step d). Renewal is a heartbeat, not a lock — a dead
// session simply stops renewing and the lease expires into recoverable state.
function builderLeaseTrailer(wsName, lane, slug, runId, ttlMinutes) {
  return [
    '',
    '--- builder lease (write-last handoff contract) ---',
    '',
    'This dispatch holds the builder lease for ' + slug + ':',
    '  ' + BUILDER_LEASES_DIR + '/' + slug + '.json   (run_id ' + runId + ', ttl ' + ttlMinutes + 'm)',
    'Renew it at each major step — a heartbeat, not a lock:',
    '  node bin/tl-worker.js ' + wsName + ' --lease renew --spec ' + slug + ' --agent ' + lane + ' --run ' + runId,
    'Finalize the in-progress -> tests hand-off atomically (checks -> outcome artifacts ->',
    'terminal HANDOFF.json -> guarded move; see skills/run/SKILL.md step d):',
    '  node bin/tl-worker.js ' + wsName + ' --finalize --spec ' + slug + ' --agent ' + lane + ' --run ' + runId + ' \\',
    '    --base <git rev-parse HEAD of the spec repo> --tests <absolute path to tests.json>',
    'Never edit the spec after the manifest is written, and never move the folder by hand',
    'around a failed finalize — a typed refusal plus the committed manifest is the recovery',
    'signal, not an invitation to force the move.',
    '',
  ].join('\n');
}

// Append the lease trailer to a brief (newline-safe), mirroring briefWithClaimModel.
function briefWithBuilderLease(brief, wsName, lane, slug, runId, ttlMinutes) {
  const b = String(brief);
  return b + (b.endsWith('\n') ? '' : '\n') + builderLeaseTrailer(wsName, lane, slug, runId, ttlMinutes) + '\n';
}

// Shell-lane template -> concrete command (the `shell: true` opt-in path only).
// `{prompt_file}` is substituted with the escaped temp-file path; `{prompt}`
// with the escaped single-line brief; a template with neither placeholder
// receives the prompt bytes on stdin.
function buildCommand(template, promptPath, prompt) {
  if (template.includes('{prompt_file}')) {
    return { command: template.split('{prompt_file}').join(shellEscape(promptPath)), stdin: false };
  }
  if (template.includes('{prompt}')) {
    return { command: template.split('{prompt}').join(shellEscape(promptOneLine(prompt))), stdin: false };
  }
  return { command: template, stdin: true };
}

// Argv-lane tokens -> concrete argv (the default path). Same placeholder
// semantics as buildCommand, but NO escaping — each token reaches execve
// verbatim as one argument, so prompt content is data, never shell input.
// This is what kills the quoting-injection surface.
function buildArgv(tokens, promptPath, prompt) {
  if (tokens.some(t => t.includes('{prompt_file}'))) {
    return { argv: tokens.map(t => t.split('{prompt_file}').join(promptPath)), stdin: false };
  }
  if (tokens.some(t => t.includes('{prompt}'))) {
    return { argv: tokens.map(t => t.split('{prompt}').join(promptOneLine(prompt))), stdin: false };
  }
  return { argv: tokens.slice(), stdin: true };
}

// The one spawn contract handed to the spawnLane seam (bin/tl-worker.js):
//   { shell: false, argv: [bin, ...args], command: <display>, stdin: bool }  — default
//   { shell: true,  argv: null, command: <sh -c string>,     stdin: bool }  — explicit opt-in
// `command` is always printable (dry-run / logs); `argv` is authoritative
// when shell is false.
function buildInvocation(laneCfg, promptPath, prompt) {
  if (laneCfg.shell) {
    const { command, stdin } = buildCommand(laneCfg.command, promptPath, prompt);
    return { shell: true, argv: null, command, stdin };
  }
  const { argv, stdin } = buildArgv(laneCfg.argv, promptPath, prompt);
  return { shell: false, argv, command: argv.join(' '), stdin };
}

// ---------- lock lifecycle (_metrics/locks/<lane>.lock) ----------

function lockPathFor(wsDir, lane) {
  return path.join(wsDir, '_metrics', 'locks', lane + '.lock');
}

// Staleness is judged by file mtime, not lock content — a corrupt lock file
// must still time out rather than wedge the lane forever.
function checkLock(file, nowMs, timeoutMinutes) {
  let st;
  try { st = fs.statSync(file); } catch { return { state: 'free' }; }
  const ageMinutes = (nowMs - st.mtimeMs) / 60000;
  return { state: ageMinutes < timeoutMinutes ? 'held' : 'stale', ageMinutes: Math.round(ageMinutes) };
}

// ---------- builder leases (_metrics/builder-leases/<slug>.json) ----------
//
// A builder lease is the liveness signal for one spec's build: a live builder
// renews (heartbeats) it at each major step; a session that dies simply stops
// renewing and the lease expires on its own. That live/expired distinction is
// what lets downstream recovery tell "an agent is mid-build right now" from
// "a session was killed between the tests gate and the folder move" (the
// half-handoff incident) without guessing from artifact smells. Files-only,
// cooperative enforcement — same posture as lib/stage.js and lib/handoff.js;
// a process with shell access can still bypass this API.
//
// Record: { slug, actor, run_id, stage, issued_at, heartbeat_at, expires_at,
// ttl_minutes, pid } plus `ended_reason` when a lease is explicitly expired
// (e.g. the tick observed the session exit without finalizing). Fresh
// acquisition commits with an atomic no-replace link — exactly one concurrent
// acquirer wins (lib/handoff.js posture). Renewal and expired-lease takeover
// commit tmp+rename and confirm by read-back: a lost race is a typed
// `lease-lost`, never a forced overwrite. A malformed lease file must not
// wedge a spec forever — its file mtime decides held vs expired (checkLock
// posture: corrupt state still times out).

function leaseRefusal(reason, details = {}) {
  return { ok: false, reason, ...details };
}

function builderLeasePath(wsDir, slug) {
  return path.join(wsDir, ...BUILDER_LEASES_DIR.split('/'), specSlug(slug) + '.json');
}

function leaseTmpName(file) {
  return file + '.tmp.' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

function readBuilderLeaseFile(wsDir, slug) {
  const file = builderLeasePath(wsDir, slug);
  const text = safeRead(file);
  if (text === null) return { file, exists: false, lease: null, malformed: false };
  let lease = null;
  try { lease = JSON.parse(text); } catch { lease = null; }
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) {
    return { file, exists: true, lease: null, malformed: true, mtimeMs: mtime(file) };
  }
  return { file, exists: true, lease, malformed: false, mtimeMs: mtime(file) };
}

// Typed liveness view: { state: 'none' | 'live' | 'expired', lease, malformed }.
// A malformed lease (or one whose expires_at is unparseable) is judged by file
// age against the default TTL — held while fresh, takeover-eligible once old.
function builderLeaseState(wsDir, slug, nowMs = Date.now()) {
  const r = readBuilderLeaseFile(wsDir, slug);
  if (!r.exists) return { state: 'none', lease: null, malformed: false };
  const expMs = r.malformed ? NaN : Date.parse(r.lease && r.lease.expires_at);
  if (!Number.isFinite(expMs)) {
    const ageMinutes = (nowMs - r.mtimeMs) / 60000;
    return {
      state: ageMinutes < DEFAULT_BUILDER_LEASE_TTL_MINUTES ? 'live' : 'expired',
      lease: r.lease, malformed: true, ageMinutes: Math.round(ageMinutes),
    };
  }
  return { state: nowMs < expMs ? 'live' : 'expired', lease: r.lease, malformed: false };
}

function leaseHolderDetails(lease) {
  if (!lease) return { holder: null };
  return {
    holder: {
      actor: lease.actor == null ? null : String(lease.actor),
      run_id: lease.run_id == null ? null : String(lease.run_id),
      stage: lease.stage == null ? null : String(lease.stage),
      expires_at: lease.expires_at == null ? null : String(lease.expires_at),
    },
  };
}

function ownsLease(lease, actor, runId) {
  return !!lease && String(lease.actor || '') === actor && String(lease.run_id || '') === runId;
}

function buildLeaseRecord({ slug, actor, runId, stage, ttlMinutes, now, issuedAt }) {
  const iso = now.toISOString();
  return {
    slug, actor, run_id: runId,
    stage: stage || null,
    issued_at: issuedAt || iso,
    heartbeat_at: iso,
    expires_at: new Date(now.getTime() + ttlMinutes * 60000).toISOString(),
    ttl_minutes: ttlMinutes,
    pid: process.pid,
  };
}

function validLeaseArgs(wsDir, slug, actor, runId) {
  if (!wsDir || !slug || !SLUG_RE.test(slug)) return leaseRefusal('invalid-slug', { slug: slug || null });
  if (!actor) return leaseRefusal('actor-required', { slug });
  if (!runId) return leaseRefusal('run-required', { slug, actor });
  return null;
}

// Commit lease bytes. `fresh` uses no-replace link semantics (exactly one
// concurrent creator wins — EEXIST is a typed loss, never an overwrite);
// otherwise tmp+rename replaces, and the caller confirms by read-back.
function commitLease(file, record, { fresh }) {
  const tmp = leaseTmpName(file);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    if (fresh) {
      fs.linkSync(tmp, file);
      fs.unlinkSync(tmp);
    } else {
      fs.renameSync(tmp, file);
    }
    return { ok: true };
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    if (fresh && err && err.code === 'EEXIST') return leaseRefusal('lease-lost', { detail: 'another acquirer committed first' });
    return leaseRefusal('io-error', { code: String((err && err.code) || 'unknown'), detail: String((err && err.message) || err) });
  }
}

// Read-back confirmation for replacing commits: our bytes must be the ones on
// disk. A takeover race that rewrote the file after our rename is a typed loss.
function confirmLease(wsDir, slug, record) {
  const after = readBuilderLeaseFile(wsDir, slug);
  if (!after.exists || after.malformed
    || !ownsLease(after.lease, record.actor, record.run_id)
    || String(after.lease.heartbeat_at || '') !== record.heartbeat_at) {
    return leaseRefusal('lease-lost', { ...leaseHolderDetails(after.lease), slug });
  }
  return { ok: true, lease: after.lease, path: BUILDER_LEASES_DIR + '/' + slug + '.json' };
}

// acquireBuilderLease — take (or re-take) the builder lease for one spec.
//   none            → fresh atomic create (no-replace; one winner).
//   live, own run   → renewal (idempotent re-acquire).
//   live, foreign   → typed `lease-held` with holder details; never forced.
//   expired         → takeover via tmp+rename + read-back (`lease-lost` on a
//                     lost race). Malformed leases follow file age.
function acquireBuilderLease(wsDir, opts = {}) {
  const slug = specSlug(String(opts.slug || ''));
  const actor = String(opts.actor || '').trim();
  const runId = String(opts.runId != null ? opts.runId : opts.run_id || '').trim();
  const bad = validLeaseArgs(wsDir, slug, actor, runId);
  if (bad) return bad;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const t = Number(opts.ttlMinutes);
  const ttlMinutes = Number.isFinite(t) && t > 0 ? t : DEFAULT_BUILDER_LEASE_TTL_MINUTES;
  const stage = opts.stage == null ? null : String(opts.stage);

  const cur = builderLeaseState(wsDir, slug, now.getTime());
  if (cur.state === 'live' && !ownsLease(cur.lease, actor, runId)) {
    return leaseRefusal('lease-held', { slug, actor, run_id: runId, malformed: cur.malformed, ...leaseHolderDetails(cur.lease) });
  }

  const issuedAt = cur.state === 'live' && ownsLease(cur.lease, actor, runId)
    ? String(cur.lease.issued_at || now.toISOString())
    : null;
  const record = buildLeaseRecord({ slug, actor, runId, stage, ttlMinutes, now, issuedAt });

  if (cur.state === 'none') {
    const committed = commitLease(builderLeasePath(wsDir, slug), record, { fresh: true });
    if (!committed.ok) {
      if (committed.reason !== 'lease-lost') return committed;
      // Someone created a lease between our read and our link — report theirs.
      const after = builderLeaseState(wsDir, slug, now.getTime());
      if (after.state === 'live' && !ownsLease(after.lease, actor, runId)) {
        return leaseRefusal('lease-held', { slug, actor, run_id: runId, ...leaseHolderDetails(after.lease) });
      }
      return leaseRefusal('lease-lost', { slug, actor, run_id: runId, ...leaseHolderDetails(after.lease) });
    }
    return { ok: true, lease: record, takeover: false, path: BUILDER_LEASES_DIR + '/' + slug + '.json' };
  }

  // Own-live renewal or expired takeover: replacing commit + read-back CAS.
  const committed = commitLease(builderLeasePath(wsDir, slug), record, { fresh: false });
  if (!committed.ok) return committed;
  const confirmed = confirmLease(wsDir, slug, record);
  if (!confirmed.ok) return confirmed;
  return { ok: true, lease: confirmed.lease, takeover: cur.state === 'expired', path: confirmed.path };
}

// renewBuilderLease — the heartbeat. Only the live owner may renew; an expired
// lease is abandonment and must be re-acquired (takeover), not quietly revived
// past the fact. Optional `stage` update rides the same atomic write.
function renewBuilderLease(wsDir, opts = {}) {
  const slug = specSlug(String(opts.slug || ''));
  const actor = String(opts.actor || '').trim();
  const runId = String(opts.runId != null ? opts.runId : opts.run_id || '').trim();
  const bad = validLeaseArgs(wsDir, slug, actor, runId);
  if (bad) return bad;
  const now = opts.now instanceof Date ? opts.now : new Date();

  const cur = builderLeaseState(wsDir, slug, now.getTime());
  if (cur.state === 'none') return leaseRefusal('lease-missing', { slug, actor, run_id: runId });
  if (cur.malformed) return leaseRefusal('malformed-lease', { slug, actor, run_id: runId });
  if (!ownsLease(cur.lease, actor, runId)) {
    return leaseRefusal('foreign-lease', { slug, actor, run_id: runId, ...leaseHolderDetails(cur.lease) });
  }
  if (cur.state === 'expired') {
    return leaseRefusal('lease-expired', { slug, actor, run_id: runId, expires_at: String(cur.lease.expires_at || '') });
  }

  const t = Number(opts.ttlMinutes);
  const ttlMinutes = Number.isFinite(t) && t > 0 ? t : (Number(cur.lease.ttl_minutes) > 0 ? Number(cur.lease.ttl_minutes) : DEFAULT_BUILDER_LEASE_TTL_MINUTES);
  const record = buildLeaseRecord({
    slug, actor, runId,
    stage: opts.stage != null ? String(opts.stage) : (cur.lease.stage == null ? null : String(cur.lease.stage)),
    ttlMinutes, now,
    issuedAt: String(cur.lease.issued_at || now.toISOString()),
  });
  const committed = commitLease(builderLeasePath(wsDir, slug), record, { fresh: false });
  if (!committed.ok) return committed;
  return confirmLease(wsDir, slug, record);
}

// releaseBuilderLease — owner removes the lease (build finalized or otherwise
// cleanly done). Missing is idempotent success; foreign is a typed refusal.
function releaseBuilderLease(wsDir, opts = {}) {
  const slug = specSlug(String(opts.slug || ''));
  const actor = String(opts.actor || '').trim();
  const runId = String(opts.runId != null ? opts.runId : opts.run_id || '').trim();
  const bad = validLeaseArgs(wsDir, slug, actor, runId);
  if (bad) return bad;

  const cur = readBuilderLeaseFile(wsDir, slug);
  if (!cur.exists) return { ok: true, released: false, slug };
  if (cur.malformed) return leaseRefusal('malformed-lease', { slug, actor, run_id: runId });
  if (!ownsLease(cur.lease, actor, runId)) {
    return leaseRefusal('foreign-lease', { slug, actor, run_id: runId, ...leaseHolderDetails(cur.lease) });
  }
  try { fs.unlinkSync(cur.file); } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, released: false, slug };
    return leaseRefusal('io-error', { slug, code: String((err && err.code) || 'unknown') });
  }
  return { ok: true, released: true, slug };
}

// expireBuilderLease — owner marks its own lease expired NOW with a reason
// (e.g. the tick watched the session exit without finalizing). The record
// stays on disk as attributable abandonment evidence instead of waiting out
// the TTL or vanishing; recovery sees an expired lease immediately.
function expireBuilderLease(wsDir, opts = {}) {
  const slug = specSlug(String(opts.slug || ''));
  const actor = String(opts.actor || '').trim();
  const runId = String(opts.runId != null ? opts.runId : opts.run_id || '').trim();
  const bad = validLeaseArgs(wsDir, slug, actor, runId);
  if (bad) return bad;
  const now = opts.now instanceof Date ? opts.now : new Date();

  const cur = readBuilderLeaseFile(wsDir, slug);
  if (!cur.exists) return { ok: true, expired: false, slug };
  if (cur.malformed) return leaseRefusal('malformed-lease', { slug, actor, run_id: runId });
  if (!ownsLease(cur.lease, actor, runId)) {
    return leaseRefusal('foreign-lease', { slug, actor, run_id: runId, ...leaseHolderDetails(cur.lease) });
  }
  const record = {
    ...cur.lease,
    heartbeat_at: String(cur.lease.heartbeat_at || now.toISOString()),
    expires_at: now.toISOString(),
    ended_reason: String(opts.reason || 'expired-by-owner'),
  };
  const committed = commitLease(cur.file, record, { fresh: false });
  if (!committed.ok) return committed;
  return { ok: true, expired: true, slug, lease: record };
}

// ---------- finalize (in-progress → tests under an expiring lease) ----------
//
// The ONE builder handoff order for interactive and headless runs
// (docs/canonical-e2e-path.md; skills/run/SKILL.md "write-last"):
//
//   checks → outcome artifacts → terminal manifest → guarded move
//
// The caller runs its acceptance checks and writes FEEDBACK.md, BUILDER.diff,
// and VERIFY.md while the spec is still in in-progress/. finalize then, under
// the builder lease: stamps frontmatter (status/awaiting_verifier/requested_at
// — the last SPEC.md writes, so the manifest binds final bytes), writes
// outcome/HANDOFF.json via lib/handoff.js (write-last, atomic), validates it,
// and only then makes the guarded in-progress → tests move via lib/stage.js.
// NOTHING touches the spec after the manifest commits: a validation or move
// failure returns a typed, actionable refusal (recorded in TRACE.jsonl) and
// leaves the observed stage as-is — never a false success stamp, and never an
// invalidated manifest. Landing in tests/ with a valid manifest IS the
// canonical verifier eligibility — no _metrics/verify-requests file is
// written, so there is no request-file race; the legacy awaiting_verifier
// stamp is kept for migration-era readers (pickVerifyWork, cockpit).
//
// Retry is first-class (the incident this exists for is a builder killed
// between the tests gate and the folder move): a valid committed manifest is
// reused idempotently; an invalid one is recreated under the lease; a spec
// already in tests/ with a valid matching manifest returns ok with
// `already_finalized: true`. Exactly one correlated `handoff` trace event is
// recorded per completed handoff, keyed by the manifest's run_id.

const FINALIZE_ARTIFACTS = Object.freeze(['VERIFY.md']);  // required beyond lib/handoff.js's set

function finalizeBuilderHandoff(opts = {}) {
  const wsDir = opts.wsDir && path.resolve(String(opts.wsDir));
  const slug = specSlug(String(opts.slug || ''));
  const actor = String(opts.actor || '').trim();
  const runId = String(opts.runId != null ? opts.runId : opts.run_id || '').trim();
  const now = opts.now instanceof Date ? opts.now : new Date();
  const initiation = opts.initiation ? String(opts.initiation) : 'unknown';
  const source = opts.source ? String(opts.source) : 'unknown';

  const bad = validLeaseArgs(wsDir, slug, actor, runId);
  if (bad) return bad;
  const baseCommit = String(opts.baseCommit != null ? opts.baseCommit : opts.base_commit || '').trim();
  if (!baseCommit) return leaseRefusal('malformed-manifest', { slug, detail: 'base_commit required (source/base-diff identity)' });
  const tests = opts.tests;
  if (!Array.isArray(tests) || tests.length === 0) {
    return leaseRefusal('malformed-tests', { slug, detail: 'tests evidence must be a non-empty array' });
  }
  const failing = tests.filter(t => !t || t.ok !== true);
  if (failing.length) {
    return leaseRefusal('failing-tests', {
      slug,
      failing: failing.map(t => (t && t.command) ? String(t.command) : null),
      detail: 'every handoff test must be ok: true — a red gate is a block (skills/run g), not a handoff',
    });
  }

  const specDir = path.join(wsDir, 'in-progress', slug);
  const observed = observedStages(wsDir, slug);

  // Crash-after-move recovery: already in tests/ with a valid matching
  // manifest is a completed handoff — release any lease we hold and say so.
  if (!observed.includes('in-progress') && observed.length === 1 && observed[0] === 'tests') {
    const v = validateHandoff({
      specDir: path.join(wsDir, 'tests', slug),
      expected_builder: actor, expected_from_stage: 'in-progress', expected_to_stage: 'tests',
    });
    if (v.ok) {
      const rel = releaseBuilderLease(wsDir, { slug, actor, runId });
      return {
        ok: true, already_finalized: true, slug, path: 'tests/' + slug + '/',
        manifest: v.manifest, manifest_path: HANDOFF_REL, run_id: v.run_id,
        lease_released: !!(rel.ok && rel.released),
      };
    }
  }
  if (observed.includes('in-progress') && observed.includes('tests')) {
    // Duplicate-slug board (lib/stage.js CAS semantics): refuse BEFORE any
    // stamp or manifest write — repair the invariant, then retry finalize.
    const refusal = leaseRefusal('destination-exists', {
      slug, actor, observed_stage: 'in-progress', observed_stages: observed,
      detail: 'spec exists in both in-progress/ and tests/ — repair the duplicate before finalizing',
    });
    appendSpecTraceEvent(specDir, {
      type: 'blocked', reason: 'destination-exists',
      summary: 'handoff finalize refused (destination-exists): ' + refusal.detail,
      actor_type: 'agent', actor_id: actor, initiation, source, run_id: runId,
    }, { now });
    return refusal;
  }
  if (observed.length !== 1 || observed[0] !== 'in-progress') {
    return leaseRefusal('stale-stage', {
      slug, actor,
      observed_stage: observed.length === 1 ? observed[0] : null,
      observed_stages: observed,
      detail: 'finalize expects the spec in in-progress/ (or completed in tests/ with a valid manifest)',
    });
  }

  // Ownership: builder handoffs belong to the signed claimant.
  const specText = safeRead(path.join(specDir, 'SPEC.md'));
  if (specText === null) return leaseRefusal('missing-artifact', { slug, path: 'SPEC.md' });
  const meta = parseFrontmatter(specText).meta || {};
  const claimedBy = String(meta.claimed_by || '').trim();
  if (claimedBy && claimedBy !== actor) {
    return leaseRefusal('foreign-claim', { slug, actor, claimed_by: claimedBy });
  }

  // The lease gate: finalize happens under a lease this run owns. acquire
  // handles fresh, own-live renewal, and expired takeover (a retry after a
  // crash); a live foreign lease is a typed stop — never steal a live builder.
  const leased = acquireBuilderLease(wsDir, {
    slug, actor, runId, stage: 'in-progress',
    ttlMinutes: opts.ttlMinutes, now,
  });
  if (!leased.ok) return leased;

  // Post-lease refusals leave an actionable trace breadcrumb (never a SPEC.md
  // edit — a committed manifest must stay valid).
  const refuseTraced = (refusal) => {
    appendSpecTraceEvent(specDir, {
      type: 'blocked', reason: String(refusal.reason || 'finalize-failed'),
      summary: ('handoff finalize refused (' + refusal.reason + ')'
        + (refusal.detail ? ': ' + String(refusal.detail).slice(0, 200) : '')
        + (refusal.manifest_committed ? ' — terminal manifest is committed; retry or recovery can complete the move' : '')),
      actor_type: 'agent', actor_id: actor, initiation, source, run_id: runId,
    }, { now });
    return refusal;
  };

  // Pre-stamp artifact existence check: every finalize-required artifact must
  // already exist so a refusal here leaves zero false-success stamps behind.
  const extraArtifacts = [...FINALIZE_ARTIFACTS, ...([].concat(opts.artifacts || []).map(String).filter(Boolean))];
  for (const rel of ['outcome/FEEDBACK.md', 'outcome/BUILDER.diff', ...extraArtifacts]) {
    const abs = path.join(specDir, ...rel.split('/'));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return refuseTraced(leaseRefusal('missing-artifact', { slug, path: rel, detail: 'write checks and outcome artifacts before finalize (write-last order)' }));
    }
  }

  // Stamps — the LAST SPEC.md writes, before the manifest binds its bytes.
  // requested_at is kept when already present so a retry stays byte-stable.
  const requestedAt = String(meta.requested_at || '').trim() || now.toISOString().slice(0, 10);
  try {
    stampSpecFrontmatter(specDir, {
      status: 'tests',
      awaiting_verifier: true,
      requested_at: requestedAt,
    });
  } catch (err) {
    return refuseTraced(leaseRefusal('io-error', { slug, detail: 'frontmatter stamp failed: ' + String((err && err.message) || err) }));
  }

  // Terminal manifest: reuse a valid committed one (the killed-between-gate-
  // and-move retry), recreate an invalid one under our lease, else create.
  const manifestAbs = path.join(specDir, 'outcome', 'HANDOFF.json');
  const manifestOpts = {
    specDir, builder: actor,
    from_stage: 'in-progress', to_stage: 'tests',
    base_commit: baseCommit, run_id: runId,
    prepared_at: now.toISOString(),
    claimed_at: meta.claimed_at != null ? meta.claimed_at : null,
    tests, artifacts: extraArtifacts,
  };
  let manifest = null, reusedManifest = false;
  if (fs.existsSync(manifestAbs)) {
    const v = validateHandoff({
      specDir, expected_builder: actor,
      expected_from_stage: 'in-progress', expected_to_stage: 'tests',
    });
    if (v.ok) { manifest = v.manifest; reusedManifest = true; }
    else {
      const created = createHandoff({ ...manifestOpts, overwrite: true });
      if (!created.ok) return refuseTraced({ ...created, slug, manifest_committed: false });
      manifest = created.manifest;
    }
  } else {
    const created = createHandoff(manifestOpts);
    if (!created.ok) return refuseTraced({ ...created, slug, manifest_committed: false });
    manifest = created.manifest;
  }

  // Belt-and-braces: the bytes on disk must validate as one complete handoff
  // immediately before the move — integrity, identity, and stage consistency.
  const valid = validateHandoff({
    specDir, expected_builder: actor,
    expected_from_stage: 'in-progress', expected_to_stage: 'tests',
  });
  if (!valid.ok) return refuseTraced({ ...valid, slug, manifest_committed: true });

  // Guarded move, LAST. A refusal (stale stage, collision, race) leaves the
  // committed manifest in place — retry or recovery completes the move; no
  // hand-rolled rename ever goes around the CAS.
  const moved = moveSpec({ wsDir, slug, from: 'in-progress', to: 'tests', actor, role: 'builder' });
  if (!moved.ok) return refuseTraced({ ...moved, manifest_committed: true });

  // One correlated handoff record, keyed by the manifest's run_id (a retry
  // that reused a committed manifest correlates to the run that prepared it).
  const manifestRunId = String(manifest.run_id || runId);
  appendSpecTraceEvent(path.join(wsDir, 'tests', slug), {
    type: 'handoff', from_stage: 'in-progress', to_stage: 'tests',
    summary: 'builder handoff finalized under lease — terminal manifest binds '
      + manifest.artifacts.length + ' artifact(s); awaiting independent verifier',
    paths: ['tests/' + slug + '/'],
    actor_type: 'agent', actor_id: actor, initiation, source,
    run_id: manifestRunId,
    ...(manifestRunId !== runId ? { finalized_by_run: runId } : {}),
  }, { now });

  const released = releaseBuilderLease(wsDir, { slug, actor, runId });
  return {
    ok: true, slug, from: 'in-progress', to: 'tests',
    path: 'tests/' + slug + '/',
    manifest, manifest_path: HANDOFF_REL,
    run_id: manifestRunId, reused_manifest: reusedManifest,
    requested_at: requestedAt,
    lease_released: !!(released.ok && released.released),
  };
}

// ---------- observability (_metrics/worker-log.jsonl) ----------

function appendWorkerLog(wsDir, record) {
  const file = path.join(wsDir, '_metrics', 'worker-log.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
}

// ---------- experiment auto-initiation (`experiments.auto_initiate` dial) ----------
//
// The last link in the auto-shadow chain: when this tick claims fresh ready
// work, the experiment routing policy (lib/experiment-policy.js decideRouting)
// decides whether the spec warrants shadow candidates, and if so the cohort is
// queued through the existing lib/experiment-queue.js queueExperiment path —
// same artifacts, same judge path as a human `tl experiment queue`, plus an
// `initiated_by: "policy"` provenance stamp (absent = human).
//
// Posture, in order of importance:
//   - INERT unless BOTH `experiments.enabled` and `experiments.auto_initiate`
//     are literal true — absent section means zero reads-beyond-config, zero
//     writes, zero behavior change (calm over swarm; dial fields in
//     _templates/SCHEMA.md).
//   - FAILURE-SILENT toward canonical work: everything is wrapped; a broken
//     experiment path logs and moves on — it never stops or delays a claim.
//   - EVERY decision is logged to _metrics/auto-initiation-log.jsonl with the
//     policy inputs that drove it (the training signal for priors): initiation
//     and budget holds at level "info", policy "no" decisions at "debug".
//   - Budget exhaustion HOLDS new experiments with a visible reason; it never
//     cancels running ones (this module only ever counts existing rows).

const AUTO_INITIATE_DEFAULTS = { max_concurrent: 1, daily_max: 3 };

// Normalize the auto-initiation fields of an already-normalized `experiments:`
// config. Fallback-on-garbage like the rest of the section: `auto_initiate`
// must be literal true; counts must be positive integers or the defaults win.
function autoInitiateDial(expConfig) {
  const src = expConfig && typeof expConfig === 'object' ? expConfig : {};
  const posInt = (v, dflt) =>
    (v !== null && v !== '' && Number.isFinite(+v) && +v >= 1 ? Math.floor(+v) : dflt);
  return {
    enabled: src.auto_initiate === true,
    lanes: Array.isArray(src.auto_initiate_lanes)
      ? src.auto_initiate_lanes.map(l => String(l).toLowerCase().trim()).filter(Boolean)
      : [],
    maxConcurrent: posInt(src.auto_initiate_max_concurrent, AUTO_INITIATE_DEFAULTS.max_concurrent),
    dailyMax: posInt(src.auto_initiate_daily_max, AUTO_INITIATE_DEFAULTS.daily_max),
  };
}

function autoInitiationLogFile(wsDir) {
  return path.join(wsDir, '_metrics', 'auto-initiation-log.jsonl');
}

function readAutoInitiationLog(wsDir) {
  let text;
  try { text = fs.readFileSync(autoInitiationLogFile(wsDir), 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a corrupt line never blocks a decision */ }
  }
  return rows;
}

function appendAutoInitiationLog(wsDir, row) {
  const file = autoInitiationLogFile(wsDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

// The budget view: how many auto experiments were initiated today (UTC date of
// the log row), and how many are still active — an auto experiment counts as
// active while ANY of its candidate rows is non-terminal. Counting is the only
// thing budgets ever do here: a hold never touches running rows.
function autoInitiateBudget(wsDir, nowIso) {
  const initiated = readAutoInitiationLog(wsDir)
    .filter(r => r && r.decision === 'initiated' && r.experiment_id);
  const dailyUsed = initiated
    .filter(r => String(r.date || '').slice(0, 10) === String(nowIso).slice(0, 10)).length;
  const autoIds = new Set(initiated.map(r => r.experiment_id));
  const { readQueueRows, TERMINAL_STATUSES } = require('./experiment-queue');
  const active = new Set();
  for (const row of readQueueRows(wsDir)) {
    if (!row || row.role === 'judge') continue;
    if (autoIds.has(row.experiment_id) && !TERMINAL_STATUSES.includes(row.status)) {
      active.add(row.experiment_id);
    }
  }
  return { daily_used: dailyUsed, concurrent_used: active.size };
}

// Repo the experiment's candidates run against (queueExperiment's base_commit
// source): the spec's own `repo:` frontmatter, else PROJECT.md `repo:`, with
// `~` expanded. Null when neither names one — base_commit degrades to
// "unknown", which is still a recordable shadow experiment.
function workspaceRepoDir(wsDir, spec) {
  let r = spec && spec.meta && spec.meta.repo ? String(spec.meta.repo) : null;
  if (!r) {
    const pm = safeRead(path.join(wsDir, 'PROJECT.md'));
    const meta = pm === null ? {} : parseFrontmatter(pm).meta;
    r = meta.repo ? String(meta.repo) : null;
  }
  if (!r) return null;
  r = r.trim().replace(/\/+$/, '');
  if (r.startsWith('~')) r = path.join(process.env.HOME || '', r.slice(1));
  return r;
}

// The initiation hook. Called by tick() right after the canonical claim is
// committed (lock + prompt on disk) and immediately BEFORE the spawn, so the
// experiment's base_commit snapshots the tree the canonical session starts
// from, and shadow lanes can drain in parallel with canonical work.
//
//   opts: { wsDir, specPath, spec, triageCfg, repoDir, now, rng, print }
//     specPath   workspace-relative spec path ('specs/<slug>/')
//     spec       parsed spec ({ meta, body })
//     triageCfg  parsed TRIAGE.yml (read from disk when omitted)
//
// Returns { decision, experiment_id, reason } — decision one of
// 'off' | 'initiated' | 'skipped' | 'held' | 'error'. NEVER throws.
function maybeAutoInitiateExperiment(opts) {
  const { wsDir, specPath, spec, print = () => {} } = opts;
  const nowIso = ((opts.now instanceof Date ? opts.now : new Date())).toISOString();

  // Stage 1 — config only. If even this fails (missing module, unreadable
  // config) we return silently: the dial state is unknown, so writing any
  // artifact would violate absent-config inertness.
  let policy, config, dial;
  try {
    policy = require('./experiment-policy');
    config = opts.triageCfg !== undefined && opts.triageCfg !== null
      ? policy.normalizeExperimentsConfig(opts.triageCfg)
      : policy.readExperimentsConfig(wsDir);
    dial = autoInitiateDial(config);
  } catch (e) {
    return { decision: 'error', experiment_id: null, reason: String(e && e.message ? e.message : e).slice(0, 300) };
  }
  if (!config.enabled || !dial.enabled) {
    return { decision: 'off', experiment_id: null, reason: 'auto-initiation disabled' };
  }

  // Stage 2 — the dial is on: decide, log every outcome, stay failure-silent.
  try {
    // The lane allowlist filters the WHOLE candidate pool the policy routes
    // over (primary and shadows); empty allowlist = all configured candidates.
    const candidates = dial.lanes.length
      ? config.candidates.filter(c => dial.lanes.includes(String(c.id).toLowerCase())
        || dial.lanes.includes(String(c.agent_tool).toLowerCase()))
      : config.candidates;
    const dialInputs = {
      auto_initiate: true,
      auto_initiate_lanes: dial.lanes,
      auto_initiate_max_concurrent: dial.maxConcurrent,
      auto_initiate_daily_max: dial.dailyMax,
      candidates: candidates.map(c => c.id),
    };

    if (!candidates.length) {
      const reason = config.candidates.length
        ? 'no configured candidate matches auto_initiate_lanes'
        : 'no candidates configured (experiments.candidates is empty)';
      appendAutoInitiationLog(wsDir, {
        date: nowIso, spec: specPath, decision: 'skipped', level: 'debug',
        initiated_by: 'policy', experiment_id: null, reason, policy: dialInputs,
      });
      return { decision: 'skipped', experiment_id: null, reason };
    }

    // Budget gate before routing. Exhaustion holds NEW experiments with a
    // visible reason (log + stdout); running ones are never cancelled.
    const used = autoInitiateBudget(wsDir, nowIso);
    const budget = {
      daily_used: used.daily_used, daily_max: dial.dailyMax,
      concurrent_used: used.concurrent_used, max_concurrent: dial.maxConcurrent,
    };
    if (used.daily_used >= dial.dailyMax || used.concurrent_used >= dial.maxConcurrent) {
      const reason = used.daily_used >= dial.dailyMax
        ? `daily auto-experiment budget exhausted (${used.daily_used}/${dial.dailyMax} initiated today) — new experiment held; running experiments unaffected`
        : `concurrent auto-experiment budget exhausted (${used.concurrent_used}/${dial.maxConcurrent} active) — new experiment held; running experiments unaffected`;
      appendAutoInitiationLog(wsDir, {
        date: nowIso, spec: specPath, decision: 'held', level: 'info',
        initiated_by: 'policy', experiment_id: null, reason, policy: dialInputs, budget,
      });
      print(`tl-worker: experiment held for ${specPath} — ${reason}`);
      return { decision: 'held', experiment_id: null, reason };
    }

    // The routing decision — read-only; the policy recommends, this hook owns
    // the side effects.
    const decision = policy.decideRouting(wsDir, spec, {
      config: { ...config, candidates }, rng: opts.rng,
    });
    const policyInputs = {
      ...dialInputs,
      context_key: decision.context_key,
      primary: decision.primary
        ? { id: decision.primary.id, source: decision.primary.source, reason: decision.primary.reason }
        : null,
      shadows: (decision.shadows || []).map(s => s.id),
      shadow_mode: decision.shadow_mode || null,
      scores: decision.scores || {},
      explore_rate: config.explore_rate,
      min_samples_to_route: config.min_samples_to_route,
    };

    if (!decision.queue_candidates.length) {
      appendAutoInitiationLog(wsDir, {
        date: nowIso, spec: specPath, decision: 'skipped', level: 'debug',
        initiated_by: 'policy', experiment_id: null, reason: decision.reason, policy: policyInputs,
      });
      return { decision: 'skipped', experiment_id: null, reason: decision.reason };
    }

    // Queue through the one existing path — auto experiments are downstream-
    // indistinguishable (same artifacts, same judge path) except provenance.
    const { queueExperiment } = require('./experiment-queue');
    const created = queueExperiment(wsDir, {
      spec: specPath,
      repoDir: opts.repoDir || null,
      candidates: decision.queue_candidates,
      ...(decision.judge ? { judge: decision.judge } : {}),
      budgetUsd: decision.budget_usd,
      timeoutMinutes: decision.timeout_minutes,
      source: 'policy',
      now: opts.now,
    });

    // Provenance stamp: initiated_by "policy" (absent = "human" — the manual
    // `tl experiment queue`/UI paths). Best effort; the log row is the backstop.
    try {
      const { setFrontmatterField } = require('./frontmatter');
      const expFile = path.join(created.experimentDir, 'EXPERIMENT.md');
      fs.writeFileSync(expFile, setFrontmatterField(fs.readFileSync(expFile, 'utf8'), 'initiated_by', 'policy'));
    } catch { /* stamp is best-effort */ }

    appendAutoInitiationLog(wsDir, {
      date: nowIso, spec: specPath, decision: 'initiated', level: 'info',
      initiated_by: 'policy', experiment_id: created.experimentId,
      reason: decision.reason, policy: policyInputs,
      budget: { ...budget, daily_used: budget.daily_used + 1, concurrent_used: budget.concurrent_used + 1 },
    });
    print(`tl-worker: auto-initiated experiment ${created.experimentId} for ${specPath} (${decision.queue_candidates.length} candidate row(s), initiated_by: policy).`);
    return { decision: 'initiated', experiment_id: created.experimentId, reason: decision.reason };
  } catch (e) {
    // Failure-silent toward canonical work: record best-effort, never rethrow.
    const msg = String(e && e.message ? e.message : e).slice(0, 300);
    try {
      appendAutoInitiationLog(wsDir, {
        date: nowIso, spec: specPath, decision: 'error', level: 'info',
        initiated_by: 'policy', experiment_id: null, reason: 'auto-initiation failed: ' + msg,
      });
    } catch { /* even the error record is best-effort */ }
    try { print(`tl-worker: experiment auto-initiation failed for ${specPath} (canonical claim unaffected) — ${msg}`); } catch { /* never throw */ }
    return { decision: 'error', experiment_id: null, reason: msg };
  }
}

// ---------- spec activity trace (<stage>/<slug>/TRACE.jsonl) ----------
//
// The canonical-spec activity trace (_templates/SCHEMA.md "Activity trace"):
// an append-only JSONL file in the spec's own folder, so it travels with the
// folder through every stage move. Observable actions and deliberate
// summaries only — never private chain-of-thought. Distinct from the
// experiment candidate TRACE.jsonl (lib/experiment-trace.js); this module
// reuses only its secret redaction so no credential lands on disk.
//
// Provenance discipline: every event written here carries explicit
// actor_type / actor_id / initiation / source — missing values are written as
// "unknown", and readers must never interpret absence as `human`.

const SPEC_TRACE_FILE = 'TRACE.jsonl';
const TRACE_UNKNOWN = 'unknown';

// Append one event to <specDir>/TRACE.jsonl. `specDir` is the spec's stage
// folder (absolute); flat .md specs have no folder for the trace to travel
// with, so a non-directory is a silent no-op. The trace is observability —
// it must NEVER block or fail lifecycle work, so every failure returns null.
function appendSpecTraceEvent(specDir, event = {}, opts = {}) {
  try {
    if (!specDir || !isDir(specDir)) return null;
    const src = event && typeof event === 'object' ? event : {};
    const row = {
      ts: src.ts || ((opts.now instanceof Date ? opts.now : new Date())).toISOString(),
      type: String(src.type || 'status'),
      summary: String(src.summary || '').slice(0, 500),
      ...(src.paths != null ? { paths: [].concat(src.paths).map(String) } : {}),
      actor_type: src.actor_type ? String(src.actor_type) : TRACE_UNKNOWN,
      actor_id: src.actor_id ? String(src.actor_id) : TRACE_UNKNOWN,
      initiation: src.initiation ? String(src.initiation) : TRACE_UNKNOWN,
      source: src.source ? String(src.source) : TRACE_UNKNOWN,
    };
    // Correlation + event-specific payload keys ride alongside the common
    // fields (run_id, dispatch_id, from_stage, to_stage, lane, reason, ...).
    for (const [k, v] of Object.entries(src)) {
      if (!(k in row) && k !== 'paths' && k !== 'ts') row[k] = v;
    }
    const { redactDeep } = require('./experiment-trace');
    fs.appendFileSync(path.join(specDir, SPEC_TRACE_FILE), JSON.stringify(redactDeep(row)) + '\n');
    return row;
  } catch { return null; }
}

// Read a spec folder's trace events (tolerant: bad lines skipped, missing
// file = []). Readers treat absent provenance fields as unknown, never human.
function readSpecTrace(specDir) {
  try {
    const text = fs.readFileSync(path.join(specDir, SPEC_TRACE_FILE), 'utf8');
    return text.split('\n').filter(l => l.trim()).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// Cockpit payload shape for a spec folder's TRACE.jsonl. Missing / empty file
// → null (drawer omits the Trace section and falls back to body/notes). Cap
// keeps the most recent events; `truncated: true` when older rows were dropped.
function loadSpecTracePayload(specDir, opts = {}) {
  try {
    if (!specDir || !fs.existsSync(path.join(specDir, SPEC_TRACE_FILE))) return null;
  } catch { return null; }
  const events = readSpecTrace(specDir);
  if (!events.length) return null;
  const limit = opts.limit == null ? 200 : Number(opts.limit);
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
  const truncated = events.length > max;
  return {
    events: truncated ? events.slice(-max) : events,
    truncated,
  };
}

// ---------- the tick ----------

// One worker tick. Returns { code, reason, picked, spawned } — `code` is the
// process exit code: 0 no work / child ok; 1 misconfig, spawn failure, or
// child non-zero; 2 paused or lock held. Effectful seams are injected:
//   getRunBrief()  -> stdout of `node bin/tl.js run <ws> --agent <lane>`
//   spawnLane({ argv, command, shell, stdin }) -> child exit code (throw on
//     spawn failure). `shell: false` (default): exec argv[0] with argv.slice(1)
//     directly — no shell anywhere. `shell: true` (lane opt-in): run `command`
//     through the shell, old behavior.
// `dirtyPaths` may be injected for tests; by default it is computed from git
// when the workspace's repo is this checkout (parity with tl run's guard).
// `preflight` may likewise be injected; by default repoPreflight(root, wsDir).
function tick(opts) {
  const {
    root, wsDir, wsName, lane,
    dryRun = false,
    now = () => new Date(),
    getRunBrief, spawnLane,
    print = s => process.stdout.write(s + '\n'),
  } = opts;

  const started = now();
  const startedMs = started.getTime();
  const durationSeconds = () => Math.round((now().getTime() - startedMs) / 1000);
  // --dry-run never appends to worker-log.jsonl (documented choice) — a dry
  // tick leaves zero artifacts: no prompt file, no lock, no log line.
  const log = extra => {
    if (dryRun) return;
    appendWorkerLog(wsDir, { date: started.toISOString(), workspace: wsName, lane, ...extra });
  };
  const finish = (code, reason, picked, spawned, extra = {}) => {
    log({ picked: picked || 'none', spawned, exit_code: code, duration_seconds: durationSeconds(), ...(reason ? { reason } : {}), ...extra });
    return { code, reason, picked: picked || null, spawned };
  };

  // Lane names become artifact filenames; keep them path-safe.
  if (!validLaneName(lane)) {
    print(`tl-worker: invalid lane "${lane}" — use lowercase letters, numbers, dots, underscores, or hyphens. Nothing executed.`);
    return finish(1, 'lane_unconfigured', null, false);
  }

  // 1. Lane config — a misconfigured cron should scream (1), not stay quiet.
  const cfg = parseYaml(safeRead(path.join(wsDir, 'TRIAGE.yml')) || '') || {};
  const laneCfg = laneConfig(cfg, lane);
  if (!laneCfg) {
    print(`tl-worker: lane "${lane}" is not configured — add lanes.${lane}.command to ${wsName}/TRIAGE.yml. Nothing executed.`);
    return finish(1, 'lane_unconfigured', null, false);
  }

  // 1.5 Argv-first guard: a string command with shell syntax cannot spawn
  // safely without the shell it implies — scream (1) instead of silently
  // splitting it into the wrong argv. `shell: true` is the explicit opt-out.
  const spawnIssue = laneSpawnIssue(laneCfg, lane);
  if (spawnIssue) {
    print(`tl-worker: ${spawnIssue} Nothing executed.`);
    return finish(1, 'shell_required', null, false);
  }

  // 2. PAUSE — the workspace-root kill switch halts every lane.
  if (fs.existsSync(path.join(wsDir, 'PAUSE'))) {
    print(`tl-worker: workspace "${wsName}" is paused (PAUSE file present) — no spawn.`);
    return finish(2, 'paused', null, false);
  }

  // 3. Lock — a fresh lock means a session is (probably) still running.
  const lockFile = lockPathFor(wsDir, lane);
  const lock = checkLock(lockFile, startedMs, laneCfg.lockTimeoutMinutes);
  if (lock.state === 'held') {
    print(`tl-worker: lane "${lane}" lock held (${lock.ageMinutes}m old, timeout ${laneCfg.lockTimeoutMinutes}m) — no spawn.`);
    return finish(2, 'locked', null, false);
  }
  const staleTakeover = lock.state === 'stale';
  if (staleTakeover) {
    print(`tl-worker: stale lock for lane "${lane}" (${lock.ageMinutes}m old > ${laneCfg.lockTimeoutMinutes}m timeout) — taking over.`);
  }

  // 4. Pre-check selection: continuation for this lane first, then one ready spec.
  const specs = readWorkspaceSpecs(wsDir);
  const continuations = readPendingContinuations(wsDir, specs);
  const dirtyPaths = opts.dirtyPaths !== undefined
    ? opts.dirtyPaths
    : (root && workspaceIsThisRepo(specs, root) ? dirtyGitPaths(root) : []);
  const preflight = opts.preflight !== undefined ? opts.preflight : repoPreflight(root, wsDir);
  const pick = pickWork({ specs, continuations, lane, dirtyPaths, preflight, triageCfg: cfg });
  if (!pick.picked) {
    print(`tl-worker: no work for lane "${lane}" — ${pick.reason}.`);
    return finish(0, pick.reason, null, false, staleTakeover ? { stale_lock_takeover: true } : {});
  }

  // Trace provenance for this tick (SCHEMA.md "Activity trace"): the run_id is
  // the lane + tick stamp — the same stamp as the prompt file, so trace events,
  // the prompt artifact, and the lock are cross-correlatable. Folder-form specs
  // only (a flat .md spec has no folder for the trace to travel with).
  const stamp = started.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const runId = lane + '-' + stamp;
  const pickedSlug = specSlug(pick.spec.path);
  const specTraceDir = pick.spec && pick.spec.path && pick.spec.path.endsWith('/')
    ? path.join(wsDir, pick.spec.path) : null;
  const isContinuation = pick.kind === 'continuation';

  // 4.5 Builder-lease gate: a live lease on the picked spec means a builder
  // session is (probably) still working it right now — spawning would hand a
  // second agent the same spec. Read-only here; the acquire happens at the
  // claim commitment below. An expired lease never blocks (stale takeover is
  // the acquire's job); `lease_held` exits 2, same posture as a held lock.
  const leaseBefore = builderLeaseState(wsDir, pickedSlug, startedMs);
  if (leaseBefore.state === 'live' && !ownsLease(leaseBefore.lease, lane, runId)) {
    const holder = leaseBefore.lease
      ? `${leaseBefore.lease.actor || 'unknown'} (run ${leaseBefore.lease.run_id || 'unknown'}, expires ${leaseBefore.lease.expires_at || 'unknown'})`
      : 'unreadable lease file';
    print(`tl-worker: builder lease held for ${pick.picked} by ${holder} — no spawn.`);
    return finish(2, 'lease_held', pick.picked, false, staleTakeover ? { stale_lock_takeover: true } : {});
  }
  const traceProvenance = {
    actor_type: 'agent', actor_id: lane,
    initiation: isContinuation ? 'continuation' : 'automation',
    source: 'worker', run_id: runId,
    ...(isContinuation ? { dispatch_id: pick.picked } : {}),
  };
  // Unsuccessful dispatches are first-class trace events: lane, initiator,
  // source, correlation id, and a sanitized (redacted, truncated) failure
  // reason — a failed dispatch must never leave a spec looking successfully
  // claimed, so the failure event always follows any claimed/dispatched one.
  // The folder is re-resolved by slug at append time: a session that claimed
  // (moved the folder) and then died still gets its failure recorded where the
  // spec now lives.
  const traceDispatchFailed = (reason, detail) => {
    if (dryRun) return;
    let dir = specTraceDir;
    if (dir && !isDir(dir)) {
      const slug = specSlug(pick.spec.path);
      for (const [, folder] of STAGES) {
        const cand = path.join(wsDir, folder, slug);
        if (isDir(cand)) { dir = cand; break; }
      }
    }
    appendSpecTraceEvent(dir, {
      type: 'dispatch-failed', lane, reason,
      summary: `lane "${lane}" dispatch failed (${reason}): ${String(detail || '').slice(0, 200)}`,
      ...traceProvenance,
    }, { now: now() });
  };

  // 5. The authoritative prompt: subprocess `tl run` stdout. Tolerate failure —
  // log, exit 1, never throw past the tick. TL_WORKER_DISPATCH marks the
  // subprocess as tick-driven so `tl run` skips its own interactive claim-trace
  // appends — the tick owns dispatch provenance on this path (one writer per
  // path, no duplicate claimed events).
  let brief;
  const prevDispatchEnv = process.env.TL_WORKER_DISPATCH;
  process.env.TL_WORKER_DISPATCH = runId;
  try { brief = String(getRunBrief()); } catch (e) {
    traceDispatchFailed('tl_run_failed', e && e.message ? e.message : e);
    print('tl-worker: `tl run` subprocess failed — ' + (e && e.message ? e.message : e));
    return finish(1, 'tl_run_failed', pick.picked, false, staleTakeover ? { stale_lock_takeover: true } : {});
  } finally {
    if (prevDispatchEnv === undefined) delete process.env.TL_WORKER_DISPATCH;
    else process.env.TL_WORKER_DISPATCH = prevDispatchEnv;
  }
  // Lane-config model pass-through into the claim stamp: `lanes.<lane>.model`
  // rides the brief as a trailer so the spawned session stamps `claimed_model`
  // when it signs the claim. No model configured = no trailer = claims land
  // with claimed_model unset (absent = unknown, never guessed).
  brief = briefWithClaimModel(brief, lane, laneCfg.model);
  // Builder-lease trailer: every dispatched brief names the lease this tick
  // holds for the session (run_id, renew heartbeat, write-last finalize).
  brief = briefWithBuilderLease(brief, wsName, lane, pickedSlug, runId, laneCfg.lockTimeoutMinutes);

  const promptPath = path.join(wsDir, '_metrics', 'worker-prompts', lane + '-' + stamp + '.txt');
  const invocation = buildInvocation(laneCfg, promptPath, brief);

  // 6. Dry run: show exactly what would happen, write nothing, exit 0.
  if (dryRun) {
    print(`tl-worker: dry run — lane "${lane}" would spawn for ${pick.picked}:`);
    print('  ' + invocation.command + (invocation.shell ? '   (shell: true)' : ''));
    if (!invocation.shell) print('  argv: ' + JSON.stringify(invocation.argv));
    print(invocation.stdin ? `  prompt: stdin (${Buffer.byteLength(brief)} bytes)` : '  prompt file: ' + promptPath);
    return { code: 0, reason: 'dry_run', picked: pick.picked, spawned: false };
  }

  // 7. Prompt file, then lock (immediately before spawn), then the one spawn.
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, brief);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({
    date: started.toISOString(), workspace: wsName, lane,
    pid: process.pid, picked: pick.picked, prompt_path: path.relative(wsDir, promptPath),
    run_id: runId,
    ...(laneCfg.model ? { model: laneCfg.model } : {}),
  }) + '\n');

  // Builder lease at the claim commitment: acquired for the session about to
  // spawn (actor = lane, this tick's run_id), TTL = the lane's lock timeout —
  // the same stuck-vs-slow threshold. The session renews it (heartbeat) and
  // finalizeBuilderHandoff releases it; a lost race here (another acquirer
  // slipped in since the 4.5 read) aborts the spawn rather than doubling up.
  const leaseRes = acquireBuilderLease(wsDir, {
    slug: pickedSlug, actor: lane, runId,
    stage: isContinuation ? pick.spec.stage : 'in-progress',
    ttlMinutes: laneCfg.lockTimeoutMinutes, now: started,
  });
  if (!leaseRes.ok) {
    try { fs.unlinkSync(lockFile); } catch { /* best-effort */ }
    print(`tl-worker: could not acquire builder lease for ${pick.picked} (${leaseRes.reason}) — no spawn.`);
    return finish(2, 'lease_held', pick.picked, false, {
      lease_refusal: leaseRes.reason,
      ...(staleTakeover ? { stale_lock_takeover: true } : {}),
    });
  }

  // Dispatch provenance (SCHEMA.md "Activity trace"): the tick's lock + prompt
  // commit is the scheduler-side claim commitment, so append it now — a fresh
  // ready pick is a `claimed` event (initiation: automation — a scheduled
  // pickup, distinguishable from a human-invoked run even when the same agent
  // does the work); a continuation resume signs no claim, so it is `dispatched`
  // with the dispatch file as correlation. Failure events below tell the truth
  // when the spawn then fails.
  appendSpecTraceEvent(specTraceDir, {
    type: isContinuation ? 'dispatched' : 'claimed',
    summary: isContinuation
      ? `lane "${lane}" dispatched by headless worker tick to resume ${pick.spec.path} (continuation)`
      : `lane "${lane}" claimed ${pick.spec.path} via headless worker tick (scheduled pickup)`,
    paths: [pick.spec.path],
    ...(laneCfg.model ? { actor_model: laneCfg.model } : {}),
    ...traceProvenance,
  }, { now: started });

  // 7.5 Experiment auto-initiation (`experiments.auto_initiate` dial): the
  // canonical claim is committed (lock + prompt on disk), so consult the
  // routing policy and best-effort queue shadow candidates BEFORE the spawn —
  // base_commit snapshots the tree the canonical session starts from. The hook
  // never throws (failure-silent by contract): a broken experiment path never
  // stops or delays the spawn below. Fresh ready picks only — a continuation
  // resumes an already-claimed spec and must not re-spend the auto budget.
  let autoInit = null;
  if (pick.kind === 'ready') {
    autoInit = maybeAutoInitiateExperiment({
      wsDir, specPath: pick.picked, spec: pick.spec, triageCfg: cfg,
      repoDir: workspaceRepoDir(wsDir, pick.spec), now: started, print,
    });
  }
  const autoExtra = autoInit && autoInit.experiment_id
    ? { experiment_queued: autoInit.experiment_id } : {};

  let childCode = null, spawnError = null;
  try {
    childCode = spawnLane({
      argv: invocation.argv,
      command: invocation.command,
      shell: invocation.shell,
      stdin: invocation.stdin ? brief : null,
    });
  } catch (e) { spawnError = e; }

  // 8. Remove the lock whether the child succeeded or failed. A cleanup failure
  // is logged (the next tick recovers via stale-lock takeover), never fatal.
  try { fs.unlinkSync(lockFile); } catch (e) {
    print('tl-worker: failed to remove ' + lockFile + ' — ' + (e && e.message ? e.message : e));
    log({ event: 'lock_cleanup_failed', lock: path.relative(wsDir, lockFile), error: String(e && e.message ? e.message : e) });
  }

  // 8.5 Lease disposition: the child has definitively exited. A finalized
  // handoff already released the lease; a lease this run still owns means the
  // session ended without finalizing, so mark it expired NOW with the reason —
  // an interrupted builder becomes immediately, unambiguously recoverable
  // instead of ambiguous until the TTL runs out. A foreign lease (someone
  // legitimately took over) is left alone. Never fatal.
  let leaseDisposition = 'released';
  try {
    const after = readBuilderLeaseFile(wsDir, pickedSlug);
    if (after.exists) {
      if (!after.malformed && ownsLease(after.lease, lane, runId)) {
        const reason = spawnError
          ? 'spawn-failed'
          : 'session-exited-' + (childCode === 0 ? '0-without-finalize' : String(childCode));
        const ended = expireBuilderLease(wsDir, { slug: pickedSlug, actor: lane, runId, reason, now: now() });
        leaseDisposition = ended.ok && ended.expired ? 'expired-on-exit' : 'expire-failed';
      } else {
        leaseDisposition = 'foreign';
      }
    }
  } catch (e) {
    leaseDisposition = 'expire-failed';
    print('tl-worker: builder lease disposition failed — ' + (e && e.message ? e.message : e));
  }
  const leaseExtra = { builder_lease: leaseDisposition };

  if (spawnError) {
    traceDispatchFailed('spawn_failed', spawnError.message || spawnError);
    print('tl-worker: spawn failed — ' + (spawnError.message || spawnError));
    return finish(1, 'spawn_failed', pick.picked, false, { ...autoExtra, ...leaseExtra, ...(staleTakeover ? { stale_lock_takeover: true } : {}) });
  }
  if (childCode !== 0) {
    // Lane-readiness failures (unavailable auth, invalid invocation, sandbox/
    // workspace visibility) surface as a non-zero session exit — record it so
    // the spec never silently looks successfully claimed.
    traceDispatchFailed('agent_session_failed',
      `agent session exited ${childCode} — check lane readiness (auth, command invocation, sandbox/workspace visibility)`);
  }
  const code = childCode === 0 ? 0 : 1;
  print(`tl-worker: lane "${lane}" session for ${pick.picked} exited ${childCode}.`);
  return finish(code, null, pick.picked, true, {
    child_exit_code: childCode,
    ...autoExtra,
    ...leaseExtra,
    ...(staleTakeover ? { stale_lock_takeover: true } : {}),
  });
}

// ---------- verifier lanes (TRIAGE.yml `verification.verifier_lanes`) ----------
//
// Structured isolated-verifier policy. The scheduler selects + locks; the
// isolated runner evaluates; only recordVerificationOutcome mutates TL state.
// Unsafe Gemini configs fail loudly at read time — never silently degrade to a
// builder run command.

function sandboxRequired(raw) {
  const v = raw && raw.sandbox;
  return v === true || v === 'required' || v === 'true';
}

function readVerifierLanes(cfg) {
  const src = cfg && cfg.verification && cfg.verification.verifier_lanes;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return [];
  const out = [];
  for (const [id, raw] of Object.entries(src)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const name = String(id).toLowerCase().trim();
    if (!validLaneName(name)) continue;
    const agent = String(raw.agent || name).toLowerCase().trim() || name;
    const t = Number(raw.lock_timeout_minutes);
    out.push({
      id: name,
      agent,
      mode: raw.mode === 'review-only' ? 'review-only' : 'verify',
      isolated: raw.isolated === true,
      sandbox: sandboxRequired(raw),
      allow_network: raw.allow_network === true,
      allow_commands: Array.isArray(raw.allow_commands) ? raw.allow_commands.map(String).filter(Boolean) : [],
      command: Array.isArray(raw.command) ? raw.command.map(String) : (raw.command ? [String(raw.command)] : []),
      lockTimeoutMinutes: Number.isFinite(t) && t > 0 ? t : DEFAULT_VERIFY_LOCK_TIMEOUT_MINUTES,
      raw,
    });
  }
  return out;
}

// Loud rejection for Gemini (and any isolated) verifier lane misconfig. Throws
// with a human-readable message; never returns a half-safe policy.
function validateVerifierLane(lane) {
  if (!lane) throw new Error('verifier lane missing');
  const label = lane.id || lane.agent || 'unknown';
  if (!validLaneName(lane.id || lane.agent)) {
    throw new Error(`unsafe verifier configuration: invalid lane name "${label}"`);
  }
  if (lane.isolated !== true) {
    throw new Error(`unsafe verifier configuration: lanes.${label} must set isolated: true`);
  }
  if (!lane.sandbox) {
    throw new Error(`unsafe verifier configuration: lanes.${label} must require sandbox (sandbox: required)`);
  }
  if (lane.allow_network === true && String(lane.agent || '').toLowerCase() === 'gemini') {
    throw new Error(`unsafe verifier configuration: Gemini lane "${label}" must set allow_network: false`);
  }
  // Reuse the runner's hard gates (--dangerously-skip-permissions, review-only+commands).
  normalizePolicy({
    mode: lane.mode,
    command: lane.command,
    allow_commands: lane.allow_commands,
    allow_network: lane.allow_network,
  });
  return true;
}

function verifierLaneIssues(cfg) {
  const issues = [];
  const lanes = readVerifierLanes(cfg);
  for (const lane of lanes) {
    try { validateVerifierLane(lane); }
    catch (e) {
      issues.push({
        lane: lane.id,
        problem: String(e && e.message ? e.message : e),
        hint: 'see _templates/SCHEMA.md (verification.verifier_lanes) and docs/headless-lanes.md',
      });
    }
  }
  return issues;
}

function verifierLaneAvailable(lane, { which = null } = {}) {
  try { validateVerifierLane(lane); } catch { return { ok: false, reason: 'unsafe or invalid verifier lane' }; }
  const bin = (lane.command && lane.command[0]) || (String(lane.agent).toLowerCase() === 'gemini' ? 'agy' : null);
  if (!bin) return { ok: true };
  if (typeof which === 'function') {
    const found = which(bin);
    if (!found) return { ok: false, reason: `verifier binary unavailable: ${bin}` };
  }
  return { ok: true };
}

function lanePolicy(lane) {
  return {
    mode: lane.mode,
    command: lane.command.length ? lane.command : (String(lane.agent).toLowerCase() === 'gemini' ? ['agy'] : []),
    allow_commands: lane.allow_commands,
    allow_network: lane.allow_network,
  };
}

// ---------- verify-request artifacts (`_metrics/verify-requests/`) ----------
//
// Cockpit Dispatch verify writes one file; the verify tick drains it. UI/server
// never spawn agent CLIs — workers / `tl verify --execute` do.

function verifyRequestDir(wsDir) {
  return path.join(wsDir, VERIFY_REQUESTS_DIR);
}

function readVerifyRequests(wsDir) {
  const dir = verifyRequestDir(wsDir);
  if (!isDir(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    let d = null;
    try { d = JSON.parse(safeRead(path.join(dir, f)) || ''); } catch { continue; }
    if (!d || d.mode !== 'verify') continue;
    out.push({ file: VERIFY_REQUESTS_DIR + '/' + f, abs: path.join(dir, f), request: d });
  }
  return out;
}

function writeVerifyRequest(wsDir, { spec, targetLane = 'any-other', source = 'cockpit', now = new Date() }) {
  const slug = specSlug(spec);
  if (!slug) throw new Error('verify request requires a spec slug');
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rel = `${VERIFY_REQUESTS_DIR}/${stamp}-${slug}.json`;
  const full = path.join(wsDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (fs.existsSync(full)) throw new Error('a verify request with this name already exists');
  const body = {
    spec: slug,
    mode: 'verify',
    status: 'pending',
    target_lane: String(targetLane || 'any-other').toLowerCase().trim() || 'any-other',
    created: (now instanceof Date ? now : new Date(now)).toISOString(),
    source: String(source || 'cockpit'),
  };
  fs.writeFileSync(full, JSON.stringify(body, null, 2) + '\n');
  return { path: rel, request: body };
}

function setVerifyRequestStatus(absPath, status, extra = {}) {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(absPath, 'utf8')); } catch { d = {}; }
  const next = { ...d, status, ...extra };
  fs.writeFileSync(absPath, JSON.stringify(next, null, 2) + '\n');
  return next;
}

// ---------- per-spec verify lock (prevents concurrent double-check) ----------

function verifyLockPath(wsDir, slug) {
  return path.join(wsDir, VERIFY_LOCKS_DIR, specSlug(slug) + '.lock');
}

function builderOf(spec) {
  return String((spec && spec.meta && (spec.meta.claimed_by || spec.meta.agent)) || '').toLowerCase();
}

function isAwaitingVerifier(spec) {
  return !!spec && ['tests', 'in-progress'].includes(spec.stage) && spec.meta && spec.meta.awaiting_verifier === true;
}

function isHumanDecisionRequired(spec) {
  if (!spec || !spec.meta) return false;
  const st = String(spec.meta.verifier_status || '').toLowerCase();
  if (st === 'human-decision-required') return true;
  return String(spec.meta.status || '').toLowerCase() === 'blocked'
    && String(spec.meta.blocked_reason || '').toLowerCase().includes('human decision');
}

// Surface status for cockpit/CLI: queued | running | blocked | human-decision-required
// plus verified-by when stamped.
function verifierStatusOf(spec, { wsDir = null, nowMs = Date.now() } = {}) {
  if (!spec) return { status: null, verified_by: null };
  const by = String(spec.meta.verified_by || '').toLowerCase() || null;
  if (spec.stage === 'in-review' || by) {
    return { status: by ? 'verified' : String(spec.meta.status || spec.stage), verified_by: by };
  }
  if (isHumanDecisionRequired(spec)) {
    return { status: 'human-decision-required', verified_by: by };
  }
  const stamped = String(spec.meta.verifier_status || '').toLowerCase();
  if (stamped === 'running' || stamped === 'blocked' || stamped === 'queued' || stamped === 'human-decision-required') {
    if (stamped === 'running' && wsDir) {
      const lock = checkLock(verifyLockPath(wsDir, specSlug(spec.path)), nowMs, DEFAULT_VERIFY_LOCK_TIMEOUT_MINUTES);
      if (lock.state === 'held') return { status: 'running', verified_by: by };
    }
    if (stamped !== 'running') return { status: stamped, verified_by: by };
  }
  if (String(spec.meta.status || '').toLowerCase() === 'blocked' && !isAwaitingVerifier(spec)) {
    return { status: 'blocked', verified_by: by };
  }
  if (isAwaitingVerifier(spec)) {
    if (wsDir) {
      const lock = checkLock(verifyLockPath(wsDir, specSlug(spec.path)), nowMs, DEFAULT_VERIFY_LOCK_TIMEOUT_MINUTES);
      if (lock.state === 'held') return { status: 'running', verified_by: by };
    }
    return { status: 'queued', verified_by: by };
  }
  return { status: String(spec.meta.status || spec.stage), verified_by: by };
}

// Pick at most one (spec, lane) pair. Prefer pending verify-requests, then the
// oldest awaiting-verifier spec the lane did not build. Concurrent lanes
// collide on the per-spec lock, not here.
function pickVerifyWork({ specs, lanes, requests = [], preferLane = null }) {
  const awaiting = specs.filter(isAwaitingVerifier)
    .filter(s => !isHumanDecisionRequired(s))
    .sort((a, b) => (a.mtime || 0) - (b.mtime || 0));
  const bySlug = new Map(awaiting.map(s => [specSlug(s.path), s]));
  const usableLanes = (lanes || []).filter(l => {
    try { validateVerifierLane(l); return true; } catch { return false; }
  });
  if (!usableLanes.length) return { kind: 'none', reason: 'no_verifier_lane' };

  const laneMatch = (lane, target) => {
    const t = String(target || 'any-other').toLowerCase();
    if (!t || t === 'any-other' || t === 'any') return true;
    return lane.id === t || lane.agent === t;
  };

  const pending = (requests || []).filter(r => r.request && r.request.status === 'pending');
  for (const r of pending) {
    const spec = bySlug.get(specSlug(r.request.spec));
    if (!spec) continue;
    const builder = builderOf(spec);
    const candidates = usableLanes.filter(l => laneMatch(l, r.request.target_lane)
      && l.agent !== builder && l.id !== builder);
    const preferred = preferLane
      ? candidates.find(l => l.id === preferLane || l.agent === preferLane)
      : null;
    const lane = preferred || candidates[0];
    if (!lane) continue;
    return { kind: 'request', picked: spec.path, spec, lane, request: r };
  }

  for (const spec of awaiting) {
    const builder = builderOf(spec);
    const candidates = usableLanes.filter(l => l.agent !== builder && l.id !== builder);
    const preferred = preferLane
      ? candidates.find(l => l.id === preferLane || l.agent === preferLane)
      : null;
    const lane = preferred || candidates[0];
    if (!lane) continue;
    return { kind: 'queue', picked: spec.path, spec, lane, request: null };
  }
  return { kind: 'none', reason: preferLane ? 'no_eligible_for_lane' : 'no_awaiting' };
}

function stampSpecFrontmatter(specDir, fields) {
  const file = path.join(specDir, 'SPEC.md');
  let text = fs.readFileSync(file, 'utf8');
  for (const [k, v] of Object.entries(fields)) text = setFrontmatterField(text, k, v);
  fs.writeFileSync(file, text);
}

function assembleVerifyBrief(specDir, spec) {
  const parts = [
    `Spec: ${spec.path}`,
    `Builder: ${builderOf(spec) || '(unstamped)'}`,
    '',
  ];
  const verifyReq = safeRead(path.join(specDir, 'VERIFY.md'));
  if (verifyReq) parts.push('VERIFY.md:', verifyReq.trim(), '');
  const acc = section(spec.body || '', 'Acceptance criteria');
  if (acc) parts.push('Acceptance criteria:', acc, '');
  const feedback = safeRead(path.join(specDir, 'outcome', 'FEEDBACK.md'));
  if (feedback) parts.push('FEEDBACK.md:', feedback.trim(), '');
  return parts.join('\n');
}

function resolveSpecRepo(wsDir, spec) {
  return workspaceRepoDir(wsDir, spec) || wsDir;
}

// One verifier tick: select ≤1 eligible awaiting-verifier spec, lock it, run the
// isolated worker, record the outcome. Inject seams for unit tests.
function verifyTick(opts) {
  const {
    wsDir, wsName, root,
    preferLane = null,
    dryRun = false,
    now = () => new Date(),
    print = s => process.stdout.write(s + '\n'),
    which = null,
    runVerify = runIsolatedVerification,
    recordOutcome = recordVerificationOutcome,
    // Trace provenance (SCHEMA.md "Activity trace"): the scheduled verify tick
    // is automation/worker; `tl verify --execute` passes human/cli.
    initiation = 'automation',
    source = 'worker',
  } = opts;

  const started = now();
  const startedMs = started.getTime();
  const durationSeconds = () => Math.round((now().getTime() - startedMs) / 1000);
  const log = extra => {
    if (dryRun) return;
    appendWorkerLog(wsDir, {
      date: started.toISOString(), workspace: wsName, lane: preferLane || 'verify',
      mode: 'verify', ...extra,
    });
  };
  const finish = (code, reason, picked, spawned, extra = {}) => {
    log({
      picked: picked || 'none', spawned: !!spawned, exit_code: code,
      duration_seconds: durationSeconds(), ...(reason ? { reason } : {}), ...extra,
    });
    return { code, reason, picked: picked || null, spawned: !!spawned, ...extra };
  };

  if (fs.existsSync(path.join(wsDir, 'PAUSE'))) {
    print(`tl-worker: workspace "${wsName}" is paused (PAUSE file present) — no verify.`);
    return finish(2, 'paused', null, false);
  }

  const cfg = parseYaml(safeRead(path.join(wsDir, 'TRIAGE.yml')) || '') || {};
  const lanes = readVerifierLanes(cfg);
  const laneIssues = verifierLaneIssues(cfg);
  if (!lanes.length) {
    print('tl-worker: no verification.verifier_lanes configured — nothing verified.');
    return finish(1, 'no_verifier_lane', null, false);
  }
  if (laneIssues.length && !lanes.some(l => { try { validateVerifierLane(l); return true; } catch { return false; } })) {
    print('tl-worker: verifier lanes misconfigured — ' + laneIssues.map(i => i.problem).join('; '));
    return finish(1, 'lane_unconfigured', null, false, { issues: laneIssues });
  }

  const specs = readWorkspaceSpecs(wsDir);
  const requests = readVerifyRequests(wsDir);
  const pick = pickVerifyWork({ specs, lanes, requests, preferLane });
  if (!pick.picked) {
    print(`tl-worker: no verify work — ${pick.reason}.`);
    return finish(0, pick.reason, null, false);
  }

  const slug = specSlug(pick.spec.path);
  const builder = builderOf(pick.spec);
  if (pick.lane.agent === builder || pick.lane.id === builder) {
    print(`tl-worker: refusing to verify ${pick.picked} — lane "${pick.lane.id}" is the builder.`);
    return finish(1, 'builder_exclusion', pick.picked, false);
  }

  const avail = verifierLaneAvailable(pick.lane, { which });
  if (!avail.ok) {
    const specDir = path.join(wsDir, pick.spec.stage === 'tests' ? 'tests' : 'in-progress', slug);
    if (!dryRun && isDir(specDir)) {
      stampSpecFrontmatter(specDir, {
        status: 'blocked',
        verifier_status: 'blocked',
        blocked_reason: avail.reason,
      });
      appendSpecTraceEvent(specDir, {
        type: 'blocked', lane: pick.lane.id, reason: avail.reason,
        summary: `verifier unavailable for lane "${pick.lane.id}": ${avail.reason}`,
        actor_type: 'system', actor_id: 'tl-worker', initiation, source,
      }, { now: started });
    }
    print(`tl-worker: verifier unavailable for ${pick.picked} — ${avail.reason}.`);
    return finish(1, 'verifier_unavailable', pick.picked, false, { detail: avail.reason });
  }

  const lockFile = verifyLockPath(wsDir, slug);
  const lock = checkLock(lockFile, startedMs, pick.lane.lockTimeoutMinutes);
  if (lock.state === 'held') {
    print(`tl-worker: verify lock held for ${slug} (${lock.ageMinutes}m) — no double-check.`);
    return finish(2, 'locked', pick.picked, false);
  }

  if (dryRun) {
    print(`tl-worker: dry run — would verify ${pick.picked} with lane "${pick.lane.id}" (builder ${builder || 'unset'}).`);
    return { code: 0, reason: 'dry_run', picked: pick.picked, spawned: false, lane: pick.lane.id };
  }

  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({
    date: started.toISOString(), workspace: wsName, slug, verifier: pick.lane.id,
    pid: process.pid, status: 'running',
  }) + '\n');

  const stageFolder = pick.spec.stage === 'tests' ? 'tests' : 'in-progress';
  const specDir = path.join(wsDir, stageFolder, slug);
  // Verify-path trace provenance: correlated by a verify run id; the verifier
  // lane is the actor. dispatch_id carries the cockpit/CLI request file when
  // one triggered this tick.
  const verifyRunId = pick.lane.id + '-verify-' + started.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const verifyProvenance = {
    actor_type: 'agent', actor_id: pick.lane.agent,
    initiation, source, run_id: verifyRunId,
    ...(pick.request ? { dispatch_id: pick.request.file } : {}),
  };
  stampSpecFrontmatter(specDir, { verifier_status: 'running' });
  if (pick.request) setVerifyRequestStatus(pick.request.abs, 'claimed', { verifier: pick.lane.id });

  let result;
  try {
    const brief = assembleVerifyBrief(specDir, pick.spec);
    const repo = opts.repoDir || resolveSpecRepo(wsDir, pick.spec);
    result = runVerify({
      repo,
      brief,
      policy: lanePolicy(pick.lane),
      spawn: opts.spawn,
      createWorktree: opts.createWorktree,
      removeWorktree: opts.removeWorktree,
      tempRoot: opts.tempRoot,
      env: opts.env,
      buildInvocation: opts.buildInvocation,
    });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e).slice(0, 300);
    stampSpecFrontmatter(specDir, {
      status: 'blocked', verifier_status: 'blocked', blocked_reason: 'verifier failed: ' + msg,
    });
    appendSpecTraceEvent(specDir, {
      type: 'blocked', lane: pick.lane.id, reason: 'verifier failed: ' + msg,
      summary: `isolated verification failed: ${msg}`,
      ...verifyProvenance,
    }, { now: now() });
    if (pick.request) setVerifyRequestStatus(pick.request.abs, 'failed', { reason: msg });
    try { fs.unlinkSync(lockFile); } catch { /* next tick recovers via stale takeover */ }
    print(`tl-worker: verify failed for ${pick.picked} — ${msg}`);
    return finish(1, 'verify_failed', pick.picked, true, { detail: msg });
  }

  let recorded;
  try {
    if (result.status === 'pass') {
      recorded = recordOutcome({
        wsDir, slug, builder, verifier: pick.lane.agent, result,
      });
      // Stage handoff with the same correlation id: the readable claim-to-
      // review chain (tests → in-review) without reconstructing it from
      // frontmatter. The folder has already moved, so append at the destination.
      appendSpecTraceEvent(path.join(wsDir, 'in-review', slug), {
        type: 'handoff', from_stage: 'tests', to_stage: 'in-review',
        summary: `independent verification passed — verifier "${pick.lane.agent}" (builder ${builder || 'unknown'}); advanced tests → in-review`,
        ...verifyProvenance,
      }, { now: now() });
    } else if (result.status === 'human-decision-required') {
      recorded = recordOutcome({
        wsDir, slug, builder, verifier: pick.lane.agent, result,
      });
      stampSpecFrontmatter(path.join(wsDir, 'tests', slug), {
        verifier_status: 'human-decision-required',
        blocked_reason: 'verifier proposed a mutation — human decision required',
      });
      appendSpecTraceEvent(path.join(wsDir, 'tests', slug), {
        type: 'blocked', reason: 'verifier proposed a mutation — human decision required',
        summary: `verifier "${pick.lane.agent}" proposed a mutation — held at tests/ for an explicit human decision`,
        ...verifyProvenance,
      }, { now: now() });
    } else {
      const reason = result.reason || 'verifier blocked';
      stampSpecFrontmatter(specDir, {
        status: 'blocked', verifier_status: 'blocked', blocked_reason: reason,
        awaiting_verifier: true,
      });
      fs.mkdirSync(path.join(specDir, 'outcome'), { recursive: true });
      fs.writeFileSync(path.join(specDir, 'outcome', 'ALIGNMENT.md'), [
        '---',
        `spec: "tests/${slug}/"`,
        `builder: "${builder}"`,
        `verifier: "${pick.lane.agent}"`,
        'verification_type: "independent"',
        'rounds: 1',
        'verdict: "concerns"',
        `residual_concerns: ["${String(reason).replace(/"/g, "'")}"]`,
        '---',
        '',
        '# Alignment',
        '',
        'Isolated verifier did not pass. Spec remains at the tests gate.',
        '',
        ...(result.notes || []).map(n => `- ${n}`),
        '',
      ].join('\n'));
      recorded = { status: 'blocked', path: `tests/${slug}/`, reason };
      appendSpecTraceEvent(specDir, {
        type: 'blocked', reason,
        summary: `isolated verifier did not pass: ${reason} — spec remains at the tests gate`,
        ...verifyProvenance,
      }, { now: now() });
    }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e).slice(0, 300);
    stampSpecFrontmatter(specDir, {
      status: 'blocked', verifier_status: 'blocked', blocked_reason: 'record failed: ' + msg,
    });
    if (pick.request) setVerifyRequestStatus(pick.request.abs, 'failed', { reason: msg });
    try { fs.unlinkSync(lockFile); } catch { /* stale recovery */ }
    print(`tl-worker: could not record verify outcome for ${pick.picked} — ${msg}`);
    return finish(1, 'record_failed', pick.picked, true, { detail: msg });
  }

  try { fs.unlinkSync(lockFile); } catch (e) {
    print('tl-worker: failed to remove verify lock — ' + (e && e.message ? e.message : e));
  }
  if (pick.request) {
    setVerifyRequestStatus(pick.request.abs, recorded.status === 'in-review' ? 'done' : recorded.status, {
      verifier: pick.lane.agent,
    });
  }

  print(`tl-worker: verified ${pick.picked} via ${pick.lane.id} → ${recorded.status}.`);
  return finish(recorded.status === 'blocked' && result.status !== 'human-decision-required' ? 1 : 0, null, pick.picked, true, {
    verifier: pick.lane.agent,
    outcome: recorded.status,
  });
}

// Human mutation decision: never auto-apply. Present authorize fix-forward
// (continue in in-progress with a binding note) or kick back — explicit choice.
function applyVerifyHumanDecision(wsDir, { slug, action, note = '', now = new Date(), by = null, source = 'cli' }) {
  const s = specSlug(slug);
  const testsDir = path.join(wsDir, 'tests', s);
  if (!isDir(testsDir)) throw new Error('spec is not at tests gate');
  const act = String(action || '').toLowerCase();
  if (!['authorize-fix-forward', 'kick-back'].includes(act)) {
    throw new Error('action must be authorize-fix-forward or kick-back');
  }
  const date = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  const label = act === 'authorize-fix-forward'
    ? 'human authorized agent fix-forward (mutations not auto-applied)'
    : 'human kicked back after verifier mutation proposal';
  const body = [
    '',
    `## ${date} — verifier human decision: ${act}`,
    '',
    label,
    note ? String(note).trim() : '',
    '',
  ].filter((line, i, arr) => line !== '' || (i > 0 && arr[i - 1] !== '')).join('\n');
  fs.appendFileSync(path.join(testsDir, 'NOTES.md'), body + '\n');
  stampSpecFrontmatter(testsDir, {
    status: 'in-progress',
    awaiting_verifier: false,
    verifier_status: act === 'authorize-fix-forward' ? 'fix-forward-authorized' : 'kicked-back',
    blocked_reason: '',
  });
  const dest = path.join(wsDir, 'in-progress', s);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(testsDir, dest);
  const dispatchFile = path.join(wsDir, '_dispatch', s + '.json');
  fs.mkdirSync(path.dirname(dispatchFile), { recursive: true });
  fs.writeFileSync(dispatchFile, JSON.stringify({
    spec: s, mode: 'continuation', stage: 'in-progress',
    notes_path: s + '/NOTES.md', status: 'pending', created: date,
    reason: act === 'authorize-fix-forward'
      ? 'human authorized fix-forward after verifier mutation proposal'
      : 'kicked back after verifier mutation proposal',
  }, null, 2) + '\n');
  // Human handoff provenance: an explicit human decision moved the spec
  // backwards (tests → in-progress) — the trace records who and why, with the
  // continuation dispatch as the correlation for the resuming run.
  appendSpecTraceEvent(dest, {
    type: 'handoff', from_stage: 'tests', to_stage: 'in-progress',
    summary: `${label}${note ? ': ' + String(note).trim().slice(0, 160) : ''}`,
    actor_type: 'human', actor_id: by ? String(by) : 'unknown',
    initiation: 'human', source: String(source || 'cli'),
    dispatch_id: '_dispatch/' + s + '.json',
  }, { now: now instanceof Date ? now : new Date(now) });
  return { status: 'in-progress', path: `in-progress/${s}/`, action: act };
}

module.exports = {
  readWorkspaceSpecs, readPendingContinuations,
  laneConfig, laneModel, continuationEligible, pickWork, repoPreflight,
  validLaneName,
  dirtyGitPaths, workspaceIsThisRepo,
  shellEscape, promptOneLine, buildCommand, buildArgv, buildInvocation, laneSpawnIssue,
  claimModelTrailer, briefWithClaimModel,
  builderLeaseTrailer, briefWithBuilderLease,
  builderLeasePath, builderLeaseState, ownsLease,
  acquireBuilderLease, renewBuilderLease, releaseBuilderLease, expireBuilderLease,
  finalizeBuilderHandoff,
  lockPathFor, checkLock, appendWorkerLog,
  appendSpecTraceEvent, readSpecTrace, loadSpecTracePayload, SPEC_TRACE_FILE,
  autoInitiateDial, autoInitiateBudget, readAutoInitiationLog,
  workspaceRepoDir, maybeAutoInitiateExperiment,
  tick,
  readVerifierLanes, validateVerifierLane, verifierLaneIssues, verifierLaneAvailable,
  lanePolicy, builderOf, isAwaitingVerifier, verifierStatusOf,
  readVerifyRequests, writeVerifyRequest, pickVerifyWork,
  verifyLockPath, verifyTick, applyVerifyHumanDecision,
  DEFAULT_LOCK_TIMEOUT_MINUTES, DEFAULT_VERIFY_LOCK_TIMEOUT_MINUTES,
  DEFAULT_BUILDER_LEASE_TTL_MINUTES,
  AUTO_INITIATE_DEFAULTS, VERIFY_REQUESTS_DIR, VERIFY_LOCKS_DIR, BUILDER_LEASES_DIR,
};

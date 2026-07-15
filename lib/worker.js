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
const { specSlug, activeConflicts, selectBatch, repoHoldReason, calmCap, section } = require('./batch');
const { setFrontmatterField } = require('./frontmatter');
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
const LANE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const VERIFY_REQUESTS_DIR = '_metrics/verify-requests';
const VERIFY_LOCKS_DIR = '_metrics/verify-locks';

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

// A lane is any shell command — tl ships no provider integrations. Returns
// { command, lockTimeoutMinutes } or null when the lane isn't configured.
function laneConfig(cfg, lane) {
  const lanes = cfg && cfg.lanes;
  if (!lanes || typeof lanes !== 'object' || Array.isArray(lanes)) return null;
  const entry = lanes[lane];
  if (!entry || typeof entry !== 'object' || typeof entry.command !== 'string' || !entry.command.trim()) return null;
  const t = Number(entry.lock_timeout_minutes);
  return {
    command: entry.command.trim(),
    lockTimeoutMinutes: Number.isFinite(t) && t > 0 ? t : DEFAULT_LOCK_TIMEOUT_MINUTES,
  };
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
  let r = String(repoRef).trim().replace(/\/+$/, '');
  if (r.startsWith('~')) r = path.join(process.env.HOME || '', r.slice(1));
  try {
    return path.resolve(r) === path.resolve(root) || path.basename(path.resolve(r)) === path.basename(path.resolve(root));
  } catch { return false; }
}

// ---------- shell-safe prompt delivery ----------

// Single-quote escaping: safe under sh for any byte but the quote itself.
function shellEscape(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// `{prompt}` substitution gets a single-line form (newlines collapse to
// spaces) — lossy for markdown structure, which is why docs and examples
// prefer `{prompt_file}`.
function promptOneLine(prompt) {
  return String(prompt).replace(/\s*\r?\n\s*/g, ' ').trim();
}

// Template -> concrete command. `{prompt_file}` is substituted with the escaped
// temp-file path; `{prompt}` with the escaped single-line brief; a template
// with neither placeholder receives the prompt bytes on stdin.
function buildCommand(template, promptPath, prompt) {
  if (template.includes('{prompt_file}')) {
    return { command: template.split('{prompt_file}').join(shellEscape(promptPath)), stdin: false };
  }
  if (template.includes('{prompt}')) {
    return { command: template.split('{prompt}').join(shellEscape(promptOneLine(prompt))), stdin: false };
  }
  return { command: template, stdin: true };
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

// ---------- the tick ----------

// One worker tick. Returns { code, reason, picked, spawned } — `code` is the
// process exit code: 0 no work / child ok; 1 misconfig, spawn failure, or
// child non-zero; 2 paused or lock held. Effectful seams are injected:
//   getRunBrief()                 -> stdout of `node bin/tl.js run <ws> --agent <lane>`
//   spawnLane({ command, stdin }) -> child exit code (throw on spawn failure)
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

  // 5. The authoritative prompt: subprocess `tl run` stdout. Tolerate failure —
  // log, exit 1, never throw past the tick.
  let brief;
  try { brief = String(getRunBrief()); } catch (e) {
    print('tl-worker: `tl run` subprocess failed — ' + (e && e.message ? e.message : e));
    return finish(1, 'tl_run_failed', pick.picked, false, staleTakeover ? { stale_lock_takeover: true } : {});
  }

  const stamp = started.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const promptPath = path.join(wsDir, '_metrics', 'worker-prompts', lane + '-' + stamp + '.txt');
  const { command, stdin } = buildCommand(laneCfg.command, promptPath, brief);

  // 6. Dry run: show exactly what would happen, write nothing, exit 0.
  if (dryRun) {
    print(`tl-worker: dry run — lane "${lane}" would spawn for ${pick.picked}:`);
    print('  ' + command);
    print(stdin ? `  prompt: stdin (${Buffer.byteLength(brief)} bytes)` : '  prompt file: ' + promptPath);
    return { code: 0, reason: 'dry_run', picked: pick.picked, spawned: false };
  }

  // 7. Prompt file, then lock (immediately before spawn), then the one spawn.
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, brief);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({
    date: started.toISOString(), workspace: wsName, lane,
    pid: process.pid, picked: pick.picked, prompt_path: path.relative(wsDir, promptPath),
  }) + '\n');

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
  try { childCode = spawnLane({ command, stdin: stdin ? brief : null }); }
  catch (e) { spawnError = e; }

  // 8. Remove the lock whether the child succeeded or failed. A cleanup failure
  // is logged (the next tick recovers via stale-lock takeover), never fatal.
  try { fs.unlinkSync(lockFile); } catch (e) {
    print('tl-worker: failed to remove ' + lockFile + ' — ' + (e && e.message ? e.message : e));
    log({ event: 'lock_cleanup_failed', lock: path.relative(wsDir, lockFile), error: String(e && e.message ? e.message : e) });
  }

  if (spawnError) {
    print('tl-worker: spawn failed — ' + (spawnError.message || spawnError));
    return finish(1, 'spawn_failed', pick.picked, false, { ...autoExtra, ...(staleTakeover ? { stale_lock_takeover: true } : {}) });
  }
  const code = childCode === 0 ? 0 : 1;
  print(`tl-worker: lane "${lane}" session for ${pick.picked} exited ${childCode}.`);
  return finish(code, null, pick.picked, true, {
    child_exit_code: childCode,
    ...autoExtra,
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
    } else if (result.status === 'human-decision-required') {
      recorded = recordOutcome({
        wsDir, slug, builder, verifier: pick.lane.agent, result,
      });
      stampSpecFrontmatter(path.join(wsDir, 'tests', slug), {
        verifier_status: 'human-decision-required',
        blocked_reason: 'verifier proposed a mutation — human decision required',
      });
    } else {
      const reason = result.reason || 'verifier blocked';
      stampSpecFrontmatter(specDir, {
        status: 'blocked', verifier_status: 'blocked', blocked_reason: reason,
        awaiting_verifier: 'true',
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
function applyVerifyHumanDecision(wsDir, { slug, action, note = '', now = new Date() }) {
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
    awaiting_verifier: 'false',
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
  return { status: 'in-progress', path: `in-progress/${s}/`, action: act };
}

module.exports = {
  readWorkspaceSpecs, readPendingContinuations,
  laneConfig, continuationEligible, pickWork, repoPreflight,
  validLaneName,
  dirtyGitPaths, workspaceIsThisRepo,
  shellEscape, promptOneLine, buildCommand,
  lockPathFor, checkLock, appendWorkerLog,
  autoInitiateDial, autoInitiateBudget, readAutoInitiationLog,
  workspaceRepoDir, maybeAutoInitiateExperiment,
  tick,
  readVerifierLanes, validateVerifierLane, verifierLaneIssues, verifierLaneAvailable,
  lanePolicy, builderOf, isAwaitingVerifier, verifierStatusOf,
  readVerifyRequests, writeVerifyRequest, pickVerifyWork,
  verifyLockPath, verifyTick, applyVerifyHumanDecision,
  DEFAULT_LOCK_TIMEOUT_MINUTES, DEFAULT_VERIFY_LOCK_TIMEOUT_MINUTES,
  AUTO_INITIATE_DEFAULTS, VERIFY_REQUESTS_DIR, VERIFY_LOCKS_DIR,
};

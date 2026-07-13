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
const { specSlug, activeConflicts, selectBatch, repoHoldReason, calmCap } = require('./batch');

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
const LANE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

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
    return finish(1, 'spawn_failed', pick.picked, false, staleTakeover ? { stale_lock_takeover: true } : {});
  }
  const code = childCode === 0 ? 0 : 1;
  print(`tl-worker: lane "${lane}" session for ${pick.picked} exited ${childCode}.`);
  return finish(code, null, pick.picked, true, {
    child_exit_code: childCode,
    ...(staleTakeover ? { stale_lock_takeover: true } : {}),
  });
}

module.exports = {
  readWorkspaceSpecs, readPendingContinuations,
  laneConfig, continuationEligible, pickWork, repoPreflight,
  validLaneName,
  dirtyGitPaths, workspaceIsThisRepo,
  shellEscape, promptOneLine, buildCommand,
  lockPathFor, checkLock, appendWorkerLog,
  tick,
  DEFAULT_LOCK_TIMEOUT_MINUTES,
};

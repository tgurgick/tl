#!/usr/bin/env node
// tl — the throughline CLI. Zero dependencies, Node stdlib only.
//
// Thin, deterministic glue: each subcommand does the file work (resolve the
// workspace, read the stages, evaluate conflicts) and then prints the matching
// SKILL.md as a prompt for whatever agent is running. The CLI does the
// bookkeeping; the agent supplies the reasoning.
//
//   tl up     [ws]        start the operating path — cockpit + automation + next action
//   tl run    [ws] [spec] work the ready queue — pick the conflict-free batch
//   tl review [ws]        sign off in-review work — criteria + feedback
//   tl resume [ws]        reconstruct context — stage counts, ready top, open loops
//   (`open` is a short-lived alias of `up`)
//
// Workspace resolution mirrors the skills: an arg names a workspace under
// projects/, or if exactly one exists use it, else list and error.

const fs = require('fs');
const path = require('path');

// The install root is the parent of bin/ — where skills/, ui/, and lib/ live.
// Projects may live elsewhere: TL_ROOT / --root override ROOT (mirrors
// ui/server.js --root) so tests and multi-root setups can point projects/ at
// a scratch tree without relocating the tool itself.
const INSTALL_ROOT = path.resolve(__dirname, '..');

function flagValue(argv, name) {
  const dash = '--' + name;
  const eq = dash + '=';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === dash && argv[i + 1] && !String(argv[i + 1]).startsWith('-')) return argv[i + 1];
    if (argv[i].startsWith(eq)) return argv[i].slice(eq.length);
  }
  return null;
}

function resolveRoot(argv = process.argv.slice(2)) {
  const fromFlag = flagValue(argv, 'root');
  if (fromFlag) return path.resolve(fromFlag);
  if (process.env.TL_ROOT) return path.resolve(process.env.TL_ROOT);
  return INSTALL_ROOT;
}

function stripRootFlag(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') { i++; continue; }
    if (argv[i].startsWith('--root=')) continue;
    out.push(argv[i]);
  }
  return out;
}

const ROOT = resolveRoot();
const SKILLS = path.join(INSTALL_ROOT, 'skills');

// Shared logic lives in lib/ so the CLI and ui/server.js can't drift into
// separate copies of the parser, the batch rules, or the path guard.
const { parseFrontmatter, parseYaml } = require('../lib/parse');
const { safeRead, readFirst, isDir, mtime } = require('../lib/workspace');
const { section, filesToTouch, isReadOnly, priorityRank, specSlug, activeConflicts, selectBatch, calmCap, selectContinuations, repoHoldReason, sameLocalRepo } = require('../lib/batch');
const { stallThresholdMs, detectStalledClaims, reclaimStalled, classifyRecovery, recoverPreparedHandoff } = require('../lib/stall');
const {
  recordReflectProposalDecision, pendingReflectProposals, normalizeProposalId, REFLECT_REVIEW_LOG,
} = require('../lib/reflect-desk');
const { runFixtureExperiment } = require('../lib/experiment-fixture');
const { selectWinner, applyWinner, rejectWinner, sendWinnerToReview } = require('../lib/experiment-apply');
const { queueExperiment, drainQueue, readQueueRows } = require('../lib/experiment-queue');
const { replayExperiment, replayReport, parseCandidate, createSuite, listSuites, selectSuiteExperiments, replaySuite } = require('../lib/experiment-replay');
const { canAdvanceToReview, verificationPolicy } = require('../lib/verification-gate');
const { recallSearch, readThreads } = require('../lib/recall');
const { normalizeTypeMap, normalizeTypeKey, DEFAULT_TYPE_MAP } = require('../lib/sync-map');
const { checkTriageLock, acquireTriageLock, touchTriageLock, releaseTriageLock } = require('../lib/triage-lock');
const {
  readAutomation, laneIssues, scheduleArtifacts, installLaunchd, automationStatus,
  experimentScheduleSummary, laneAvailability, formatLaneAvailability,
} = require('../lib/automation');
const {
  diagnoseWorkspace, formatLifecycleFindings, formatCapacityRows, healthOpenLoops,
} = require('../lib/doctor');
const {
  verifyTick, applyVerifyHumanDecision, verifierStatusOf, readVerifierLanes,
  verifierLaneIssues, builderOf, writeVerifyRequest, readVerifyRequests,
  maybeAutoInitiateExperiment, workspaceRepoDir, appendSpecTraceEvent,
} = require('../lib/worker');
const { execFileSync, spawn, spawnSync } = require('child_process');

// ---------- workspace resolution (same convention as the skills) ----------

function listWorkspaces() {
  const out = [];
  const projects = path.join(ROOT, 'projects');
  if (isDir(projects)) {
    for (const name of fs.readdirSync(projects).sort()) {
      if (isDir(path.join(projects, name))) out.push({ name, dir: path.join(projects, name) });
    }
  }
  return out;
}

// An arg names a workspace; else if exactly one exists use it; else list + error.
function resolveWorkspace(arg) {
  const all = listWorkspaces();
  if (arg) {
    const hit = all.find(w => w.name === arg);
    if (hit) return hit;
    fail(`Unknown workspace "${arg}". Available: ${all.map(w => w.name).join(', ') || '(none)'}`);
  }
  if (all.length === 1) return all[0];
  if (all.length === 0) fail('No workspaces found under projects/.');
  fail(`Multiple workspaces — name one: ${all.map(w => w.name).join(', ')}`);
}

function fail(msg) { process.stderr.write('tl: ' + msg + '\n'); process.exit(1); }

// ---------- stage reading (stage -> folder, from _templates/SCHEMA.md) ----------

// A spec's lifecycle stage IS its folder. This is the triage -> done ladder.
const STAGES = [
  ['triage', 'triage'],
  ['ready', 'specs'],
  ['in-progress', 'in-progress'],
  ['tests', 'tests'],
  ['in-review', 'in-review'],
  ['done', 'done'],
];

function readStage(dir, stage, folder) {
  const stageDir = path.join(dir, folder);
  if (!isDir(stageDir)) return [];
  const out = [];
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
    const rel = folder + '/' + entry + (isFolder ? '/' : '');
    const item = {
      stage, path: rel, dir: isFolder ? p : null,
      title: meta.title || entry.replace(/\.md$/, ''),
      meta, body, mtime: mtime(file),
      notes: isFolder ? safeRead(path.join(p, 'NOTES.md')) : null,
    };
    if (isFolder) {
      const fb = readFirst(path.join(p, 'outcome', 'FEEDBACK.md'), path.join(p, 'outcome', 'feedback.md'));
      item.feedback = fb;
    }
    out.push(item);
  }
  return out;
}

function readAllSpecs(dir) {
  const specs = [];
  for (const [stage, folder] of STAGES) specs.push(...readStage(dir, stage, folder));
  return specs;
}

// Dirty paths in the TL repo itself — the uncommitted edits an agent may be
// mid-flight on that no spec has declared yet. Repo-relative, matching how
// `Files to touch` bullets are written, so they compare directly against a
// ready spec's declared scope. Only consulted when the workspace's repo IS this
// TL repo (the guard is about *this* checkout); returns [] if git is
// unavailable, not a repo, or errors — never throws, never blocks a run.
function dirtyGitPaths() {
  try {
    const raw = execFileSync('git', ['status', '--porcelain'], {
      cwd: INSTALL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const paths = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      // porcelain: XY <path> (or `orig -> path` for renames). Take the dest.
      let p = line.slice(3).trim();
      const arrow = p.indexOf(' -> ');
      if (arrow >= 0) p = p.slice(arrow + 4).trim();
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      if (p) paths.push(p);
    }
    return paths;
  } catch { return []; }
}

// Does this workspace's `repo` frontmatter point at the current TL repo? Only
// then do dirty git paths of THIS checkout belong in the conflict set. Best
// effort: tolerate `~`, trailing slashes, and relative forms. Compare against
// INSTALL_ROOT (the real checkout), not a TL_ROOT/--root projects overlay.
function workspaceIsThisRepo(specs) {
  const repoRef = specs.map(s => s.meta && s.meta.repo).find(Boolean);
  if (!repoRef) return false;
  // Exact resolved path only (lib/batch sameLocalRepo) — a sibling checkout
  // that merely shares a leaf name must not enable the dirty-git conflict set.
  return sameLocalRepo(repoRef, INSTALL_ROOT, process.env.HOME || '');
}

// The workspace's own repo identity — PROJECT.md `repo:` — the exemption input
// for the claim-time containment guard: only when it points at THIS checkout
// (the tl-developing-tl workspace) may code specs legitimately target tl.
function workspaceRepoRef(wsDir) {
  const text = safeRead(path.join(wsDir, 'PROJECT.md'));
  if (text === null) return null;
  return parseFrontmatter(text).meta.repo || null;
}

// ---------- continuation dispatches (_dispatch/<slug>.json) ----------

// The continuation half of dispatch (contract in _templates/SCHEMA.md): a
// kickback leaves `_dispatch/<slug>.json` with mode "continuation" and status
// "pending" so the next run resumes the claimed spec before touching the ready
// queue. `live` pairs each pending trigger with its in-progress/tests spec;
// `stale` collects pending triggers whose spec is no longer active (accepted or
// removed meanwhile) — surfaced so they get marked done/failed, never deleted.
function readContinuations(dir, specs) {
  const dDir = path.join(dir, '_dispatch');
  const live = [], stale = [];
  if (!isDir(dDir)) return { live, stale };
  for (const f of fs.readdirSync(dDir).sort()) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    let d = null;
    try { d = JSON.parse(safeRead(path.join(dDir, f)) || ''); } catch {
      // unparseable is a failure to surface, not to swallow — a corrupt trigger
      // would otherwise silently never fire.
      stale.push({ file: '_dispatch/' + f, slug: f.replace(/\.json$/, ''), note: 'unparseable JSON — fix it or mark it failed' });
      continue;
    }
    if (!d || d.mode !== 'continuation' || d.status !== 'pending') continue;
    const slug = specSlug(d.spec || f.replace(/\.json$/, ''));
    const spec = specs.find(s => (s.stage === 'in-progress' || s.stage === 'tests') && specSlug(s.path) === slug);
    if (spec) live.push({ file: '_dispatch/' + f, dispatch: d, spec });
    else stale.push({ file: '_dispatch/' + f, slug, note: 'no matching in-progress/tests spec — mark it done (accepted meanwhile) or failed; do not delete' });
  }
  return { live, stale };
}

// The tail of NOTES.md — the most recent `## …` section (a kickback note is
// appended last), capped so the run banner stays a banner.
function notesExcerpt(notes, maxLines = 8) {
  if (!notes || !notes.trim()) return '(no NOTES.md — resume from SPEC.md and outcome/)';
  const lines = notes.trim().split('\n');
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^##\s/.test(lines[i])) { start = i; break; }
  }
  const excerpt = lines.slice(start, start + maxLines);
  if (start + maxLines < lines.length) excerpt.push('…');
  return excerpt.join('\n');
}

// Thread records come from the shared reader in lib/recall.js (readThreads),
// which stamps `mtime` — the recency signal lib/resume-recommended.js ranks
// open loops by. The CLI used to keep a private copy here that omitted mtime,
// so /tl resume saw every thread as infinitely old while the cockpit did not
// (threads/2026-07-14-cli-readthreads-mtime-drift.md). One reader, no drift.

// ---------- SKILL printing ----------

function printSkill(name) {
  const text = safeRead(path.join(SKILLS, name, 'SKILL.md'));
  if (text === null) { fail(`skills/${name}/SKILL.md not found — cannot print the procedure.`); }
  // strip the frontmatter; print the procedure body the agent should follow
  const { body } = parseFrontmatter(text);
  out('===== SKILL: ' + name + ' (follow this procedure) =====\n');
  out(body.trim() + '\n');
  out('===== END SKILL =====\n');
}

function out(s) { process.stdout.write(s + '\n'); }
function hr() { out('---'); }

// ---------- tl resume ----------

function cmdResume(args) {
  const ws = resolveWorkspace(args[0]);
  printSkill('resume');

  const specs = readAllSpecs(ws.dir);
  const threads = readThreads(ws.dir);
  const priorities = readFirst(path.join(ws.dir, 'PRIORITIES.md'), path.join(ws.dir, 'priorities.md'));
  const triage = readFirst(path.join(ws.dir, 'TRIAGE.yml'), path.join(ws.dir, 'triage.yml'));

  out('\n===== SNAPSHOT: ' + ws.name + ' =====\n');

  // stage counts
  const counts = {};
  for (const [stage] of STAGES) counts[stage] = 0;
  for (const s of specs) counts[s.stage] = (counts[s.stage] || 0) + 1;
  out('## Stage counts');
  out(STAGES.map(([stage]) => `${stage}: ${counts[stage]}`).join('  ·  '));

  // most recently touched done spec (what changed while away)
  const done = specs.filter(s => s.stage === 'done').sort((a, b) => b.mtime - a.mtime);
  if (done.length) {
    out('\n## Recently completed');
    out(`${done.length} in done/ — latest: ${done[0].title} (${done[0].path})`);
  }

  // in-progress — with stalled-claim flags (lib/stall.js: idle past the
  // TRIAGE.yml `stall.idle_hours` threshold, no healthy hand-off). A stalled
  // claim is visible here instead of silently parking queue capacity.
  const inProgress = specs.filter(s => s.stage === 'in-progress');
  if (inProgress.length) {
    let triageCfg = null;
    try { triageCfg = triage ? parseYaml(triage) : null; } catch { /* best-effort */ }
    const thresholdMs = stallThresholdMs(triageCfg);
    const stalled = detectStalledClaims(ws.dir, specs, {
      thresholdMs, continuations: readContinuations(ws.dir, specs),
    });
    const stalledBySlug = new Map(stalled.map(x => [x.slug, x]));
    out('\n## In progress');
    for (const s of inProgress) {
      const st = stalledBySlug.get(specSlug(s.path));
      out(`- ${s.title} (${s.path})` + (st
        ? ` — STALLED: claimed_by ${s.meta.claimed_by || '(unstamped)'}, idle ~${st.idleHours}h (> ${Math.round(thresholdMs / 3600000)}h)`
        : ''));
    }
    if (stalled.length) {
      out(`${stalled.length} stalled claim${stalled.length === 1 ? '' : 's'} — reclaim explicitly (never a sweep): tl reclaim ${ws.name} <spec> --by <you> --reason "<why>"`);
    }
  }

  // goal in focus — top-weighted goal from TRIAGE.yml (best-effort text scan)
  if (triage) {
    const goal = topGoal(triage);
    if (goal) { out('\n## Goal in focus'); out(`${goal.id} (weight ${goal.weight}) — ${goal.description}`); }
  }

  // ready top — the queue, priority-ranked (fall back to PRIORITIES.md ordering intent)
  const ready = specs.filter(s => s.stage === 'ready')
    .sort((a, b) => priorityRank(a.meta.priority) - priorityRank(b.meta.priority) || a.mtime - b.mtime);
  out('\n## Ready queue (top)');
  if (!ready.length) out('empty — decompose the next slice of an intent.');
  else ready.slice(0, 5).forEach((s, i) =>
    out(`${i + 1}. ${s.title} (${s.path})${s.meta.priority ? ' [' + s.meta.priority + ']' : ''}`));

  // open loops — the decay inbox (surfaced; the agent ranks + caps to 3)
  out('\n## Open loops (decay inbox — rank and cap to 3)');
  const loops = [];
  for (const t of threads) {
    const type = String(t.meta.type || '').toLowerCase();
    const status = String(t.meta.status || '').toLowerCase();
    if ((type === 'question' || type === 'risk') && status === 'open') loops.push(`open ${type}: ${t.title} (${t.path})`);
  }
  for (const s of specs) {
    // A blocked spec always says why when it can — `blocked_reason` is the
    // breadcrumb the run skill stamps on any post-claim block.
    if (String(s.meta.status || '').toLowerCase() === 'blocked') {
      const why = s.meta.blocked_reason ? ' — ' + String(s.meta.blocked_reason).trim() : '';
      loops.push(`blocked spec: ${s.title} (${s.path})${why}`);
    }
    if (s.stage === 'done' && !s.feedback) loops.push(`done, no FEEDBACK: ${s.title} (${s.path})`);
    if (s.stage === 'in-review') loops.push(`awaiting review: ${s.title} (${s.path})`);
  }
  const parked = threads.filter(t => String(t.meta.status || '').toLowerCase() === 'parked').length;
  if (parked) loops.push(`${parked} parked thread${parked === 1 ? '' : 's'} (cleanup review)`);
  if (!loops.length) out('none — clean.');
  else loops.forEach(l => out('- ' + l));

  // Shared health classifier — lifecycle findings + blocked verifier capacity.
  try {
    const cfg = triage ? parseYaml(triage) : {};
    const health = diagnoseWorkspace(ws.dir, {
      cfg,
      which: bin => {
        try {
          const r = spawnSync('which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
          return r.status === 0 ? String(r.stdout || '').trim() : '';
        } catch { return ''; }
      },
    });
    const hLoops = healthOpenLoops(health);
    out('\n## Health (lifecycle · verifier capacity)');
    if (!hLoops.length && health.lifecycle.summary.ok) {
      out('lifecycle ok'
        + (health.capacity.summary.ok
          ? ` · verifier available: ${(health.capacity.summary.available || []).join(', ') || '(none)'}`
          : ` · verifier blocked: ${(health.capacity.verifier_lanes || []).filter(r => !r.ok).map(r => r.state).join(', ')}`));
    } else {
      for (const line of formatLifecycleFindings(health.lifecycle.findings)) out(line);
      for (const line of formatCapacityRows(health.capacity.verifier_lanes)) out(line);
    }
  } catch { /* best-effort — snapshot still useful without health */ }

  // backlog reference
  out('\n## Backlog · parked (reference)');
  out(`ready: ${counts.ready}  ·  triage: ${counts.triage}  ·  threads: ${threads.length} (${parked} parked)`);

  if (priorities) { out('\n## PRIORITIES.md'); out(priorities.trim()); }

  hr();
  out('The snapshot above is the deterministic read. Now follow the resume SKILL: report Status, Goal in focus, In focus, Open loops (cap 3), Backlog — for workspace "' + ws.name + '".');
}

// The highest-weight goal from TRIAGE.yml, read from the parsed structure (the
// shared YAML parser) rather than line-scanning.
function topGoal(triage) {
  let cfg;
  try { cfg = parseYaml(triage); } catch { return null; }
  const goals = (cfg && Array.isArray(cfg.goals)) ? cfg.goals : [];
  if (!goals.length) return null;
  return goals.slice().sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))[0];
}

// ---------- tl up (alias: open) ----------

// The one next human action — resume-shaped and deterministic, so `tl up`
// ends on a single pointer instead of a wall of state. Priority order: the
// review gate first (sign-off is the human's job the automation can't do),
// then verifier hand-offs, then blocked work, then pending kickbacks, then
// the ready queue, then an empty backlog.
function nextHumanAction(wsName, specs, conts, automationRunning) {
  const inReview = specs.filter(s => s.stage === 'in-review');
  if (inReview.length) {
    return {
      action: `Review ${inReview.length} spec${inReview.length === 1 ? '' : 's'} awaiting sign-off — run: tl review ${wsName}`,
      reason: 'completed work pools at in-review; only a human accepts it to done/',
    };
  }
  const awaiting = specs.filter(s => s.meta.awaiting_verifier === true && ['tests', 'in-progress'].includes(s.stage));
  if (awaiting.length) {
    return {
      action: `Verify ${awaiting.length} spec${awaiting.length === 1 ? '' : 's'} at the tests gate — run: tl verify ${wsName} --agent <not-the-builder>`,
      reason: 'builders stopped at tests/ per the independent-verifier policy; a different agent must check the work',
    };
  }
  const blocked = specs.filter(s => String(s.meta.status || '').toLowerCase() === 'blocked' && s.meta.awaiting_verifier !== true);
  if (blocked.length) {
    const b = blocked[0];
    return {
      action: `Unblock ${b.title} (${b.path})${b.meta.blocked_reason ? ' — ' + String(b.meta.blocked_reason).trim() : ''}`,
      reason: 'blocked work stalls the throughline until a human clears the reason',
    };
  }
  if (conts.live.length) {
    return {
      action: `${conts.live.length} kicked-back spec${conts.live.length === 1 ? ' waits' : 's wait'} for resume — ${automationRunning ? 'the owning lane\'s next tick picks it up' : 'run: tl run ' + wsName}`,
      reason: 'pending continuations outrank fresh claims',
    };
  }
  const ready = specs.filter(s => s.stage === 'ready');
  if (ready.length) {
    return {
      action: `${ready.length} ready spec${ready.length === 1 ? '' : 's'} queued — ${automationRunning ? 'automation drains them on its next tick' : 'run: tl run ' + wsName + ' (or enable automation:)'}`,
      reason: 'the ready/ stage is the queue',
    };
  }
  const triage = specs.filter(s => s.stage === 'triage');
  if (triage.length) {
    return {
      action: `${triage.length} spec${triage.length === 1 ? '' : 's'} held for shaping in triage/ — shape the blocker or release to specs/ (cockpit release button, or a folder move)`,
      reason: 'triage/ is the shaping hold pen; nothing runs until authorized and released to ready',
    };
  }
  return {
    action: 'Backlog empty — capture a thought (tl capture) or decompose the next intent (tl decompose).',
    reason: '',
  };
}

// Is the cockpit already listening? A short local probe — never a hang.
function probeUi(port) {
  return new Promise(resolve => {
    const http = require('http');
    const req = http.get({ host: '127.0.0.1', port, path: '/api/workspaces', timeout: 400 }, res => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

const UI_PORT = 4400;

// tl up [ws] [--dry-run] [--print-schedule] — one command starts a
// project's operating path: cockpit up, automation schedule installed or
// refreshed from TRIAGE.yml `automation:`, one next human action. It never
// claims or moves specs; the schedule's worker ticks spawn the sessions that
// do, and everything still pools at the human review gate. `open` is a
// short-lived alias of the same handler.
//
// --print-schedule is a first-class outcome, not a debug flag: agent-side
// installs can hang on macOS permission prompts, so the complete paste-able
// cron line + launchd plist must always be one command away.
async function cmdUp(args) {
  let dryRun = false, printSchedule = false;
  const pos = [];
  for (const a of args) {
    if (a === '--dry-run') dryRun = true;
    else if (a === '--print-schedule') printSchedule = true;
    else pos.push(a);
  }
  const ws = resolveWorkspace(pos[0]);
  const cfg = parseYaml(safeRead(path.join(ws.dir, 'TRIAGE.yml')) || '') || {};
  const automation = readAutomation(cfg);

  // Loud failure before anything is installed or printed as installable: a
  // listed lane without a command would be a schedule that ticks into error
  // every interval — or worse, one that looks green while nothing moves.
  const issues = laneIssues(automation, cfg);
  if (automation.enabled && issues.length) {
    for (const i of issues) process.stderr.write(`tl up: ${i.problem} — fix: ${i.hint}\n`);
    fail('automation profile is misconfigured — no schedule was generated or installed.');
  }

  // Schedule ticks `cd` into the install root (bin/tl-worker.js lives there);
  // ROOT may be a TL_ROOT/--root projects overlay without the tool tree.
  const artifacts = automation.enabled
    ? scheduleArtifacts({ root: INSTALL_ROOT, wsName: ws.name, automation })
    : null;

  // ---- --print-schedule: paste-able artifacts only, nothing else ----
  if (printSchedule) {
    if (!automation.enabled) {
      fail('automation is not enabled for "' + ws.name + '" — add an automation: block to its TRIAGE.yml (contract: _templates/SCHEMA.md; sample: docs/headless-lanes.md).');
    }
    out('# ===== tl up --print-schedule: ' + ws.name + ' =====');
    out('#');
    out('# Option A — cron (any platform):');
    out('#');
    out(artifacts.cron);
    out('#');
    out('# Option B — launchd (macOS). Write the plist below to:');
    out('#   ' + artifacts.plist.path);
    out('# then load it yourself (this can trigger a macOS permission prompt):');
    out('#   launchctl load ' + artifacts.plist.path);
    out('#');
    out(artifacts.plist.content);
    return;
  }

  // skill stays at skills/open/ (least churn); the CLI command is `up`.
  printSkill('open');
  out('\n===== UP: ' + ws.name + (dryRun ? ' (dry run)' : '') + ' =====\n');

  // ---- (b) the cockpit: start or reuse, idempotent ----
  out('## Cockpit (UI)');
  const uiUp = await probeUi(UI_PORT);
  if (uiUp) {
    out(`already running — http://localhost:${UI_PORT} (reused)`);
  } else if (dryRun) {
    out(`would start: node ui/server.js --port ${UI_PORT} --root ${ROOT}  → http://localhost:${UI_PORT}`);
  } else {
    const child = spawn(process.execPath, [path.join(INSTALL_ROOT, 'ui', 'server.js'), '--port', String(UI_PORT), '--root', ROOT], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
    out(`started — http://localhost:${UI_PORT}`);
  }

  // ---- (c) automation: install or refresh the single per-workspace schedule ----
  out('\n## Automation');
  if (!automation.configured) {
    out(`not configured — no behavior change. To schedule headless lanes, add an automation: block to ${ws.name}/TRIAGE.yml (contract: _templates/SCHEMA.md; sample: docs/headless-lanes.md).`);
  } else if (!automation.enabled) {
    out('configured but disabled (automation.enabled is not literal true) — nothing installed.');
  } else {
    out(`profile: every ${automation.intervalMinutes}m · lanes: ${automation.lanes.join(', ') || '(none)'}`
      + (automation.verify ? ' · verify tick: isolated verifier worker (≤1 awaiting-verifier claim per tick)' : '')
      + ` · experiment: ${automation.experiment}`);
    out(experimentScheduleSummary(automation));
    if (automation.experiment === 'drain') {
      for (const c of artifacts.commands.filter(x => x.kind === 'experiment-drain')) {
        out(`  will run: ${c.command}`);
      }
    }
    if (dryRun) {
      out('dry run — would write: ' + artifacts.plist.path);
      out('dry run — would run:   launchctl unload/load ' + artifacts.plist.path + '  (macOS; can trigger a permission prompt)');
      out('dry run — cron alternative (paste yourself):');
      out(artifacts.cron);
      out(`nothing written, nothing loaded, no agent spawned. \`tl up ${ws.name} --print-schedule\` emits the full paste-able plist + cron.`);
    } else if (process.platform === 'darwin') {
      const res = installLaunchd(artifacts.plist, {
        exec: (c, a) => execFileSync(c, a, { stdio: 'ignore' }),
      });
      if (res.written) out('wrote ' + artifacts.plist.path);
      if (res.loaded) out('loaded via launchctl — ticking every ' + automation.intervalMinutes + 'm.');
      if (res.error) {
        out('install incomplete: ' + res.error);
        out('paste path instead: tl up ' + ws.name + ' --print-schedule');
      }
    } else {
      out('non-macOS: tl never runs crontab for you — paste this into `crontab -e`:');
      out(artifacts.cron);
    }
    out('log: ' + artifacts.logPath);
  }

  // Status after any install, so the state line reflects what just happened.
  const status = automationStatus({ wsDir: ws.dir, wsName: ws.name, root: INSTALL_ROOT, cfg });
  if (status.paused) {
    out(`PAUSED — projects/${ws.name}/PAUSE is present: every lane tick exits without spawning. Remove the file to resume.`);
  }
  out('status: ' + status.state + (status.stuckAtTests
    ? ` · stuck at tests: ${status.stuckAtTests} (awaiting verification — tl verify ${ws.name})`
    : ''));

  out('\n## Lane availability');
  const whichBin = bin => {
    try {
      const r = spawnSync('which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return r.status === 0 ? String(r.stdout || '').trim() : '';
    } catch { return ''; }
  };
  const availability = laneAvailability({
    wsDir: ws.dir,
    cfg,
    which: whichBin,
  });
  for (const line of formatLaneAvailability(availability)) out(line);

  // Shared lifecycle + verifier capacity (lib/doctor.js) — same object the
  // cockpit and automation status consume. Observation only.
  const health = diagnoseWorkspace(ws.dir, { cfg, which: whichBin });
  out('\n## Lifecycle integrity');
  for (const line of formatLifecycleFindings(health.lifecycle.findings)) out(line);
  out('\n## Verifier capacity');
  for (const line of formatCapacityRows(health.capacity.verifier_lanes)) out(line);

  // ---- (d) one next human action ----
  const specs = readAllSpecs(ws.dir);
  const conts = readContinuations(ws.dir, specs);

  // Stalled claims surface here too — additive, so the next-action ladder
  // (review gate first) is unchanged; a stalled claim is queue capacity
  // silently parked, and `tl up` is the operating path that must show it.
  const stalledClaims = detectStalledClaims(ws.dir, specs, {
    thresholdMs: stallThresholdMs(cfg), continuations: conts,
  });
  if (stalledClaims.length) {
    out('\n## Stalled claims (idle past threshold — reclaim explicitly)');
    for (const x of stalledClaims) {
      out(`- ${x.spec.title} (${x.spec.path}) — claimed_by ${x.spec.meta.claimed_by || '(unstamped)'}, idle ~${x.idleHours}h`);
    }
    out(`reclaim: tl reclaim ${ws.name} <spec> --by <you> --reason "<why>"  (one spec at a time; fresh claims refuse)`);
  }

  out('\n## Next human action');
  const next = nextHumanAction(ws.name, specs, conts, automation.enabled && !status.paused && !issues.length);
  out(next.action);
  if (next.reason) out('why: ' + next.reason);

  hr();
  out('tl up never claims or moves specs — worker ticks spawn run sessions, and finished work pools at in-review/ for `tl review`. Workspace "' + ws.name + '".');
}

// ---------- tl run ----------

function cmdRun(args) {
  // extract --agent <me> (heterogeneous routing) and --dry-run from positionals.
  // Dry-run prints the same brief but never auto-initiates experiments (parity
  // with the headless worker tick's dry_run early return).
  let agent = null;
  let dryRun = false;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent') agent = String(args[++i] || '').toLowerCase();
    else if (args[i].startsWith('--agent=')) agent = args[i].slice(8).toLowerCase();
    else if (args[i] === '--dry-run') dryRun = true;
    else pos.push(args[i]);
  }
  const ws = resolveWorkspace(pos[0]);
  const named = pos[1];
  printSkill('run');

  const specs = readAllSpecs(ws.dir);
  // dependencies are matched by slug, so a dep `specs/foo/` is satisfied once
  // foo is done (as `done/foo/`) — not by literal path.
  const doneSlugs = new Set(specs.filter(s => s.stage === 'done').map(s => specSlug(s.path)));
  // Active conflict set: files already locked by work underway — specs in
  // in-progress/, tests/, in-review/ (their declared scope) plus the dirty git
  // tree of THIS repo. A ready spec whose scope overlaps this is held back so a
  // fresh run won't collide with an agent already mid-flight. This is a
  // guardrail: it explains the conflict, it does not try to resolve it.
  const activeSpecs = specs.filter(s => ['in-progress', 'tests', 'in-review'].includes(s.stage));
  const dirty = workspaceIsThisRepo(specs) ? dirtyGitPaths() : [];
  const active = activeConflicts(activeSpecs, dirty);
  // The calm cap is a workspace dial (TRIAGE.yml `run: cap:`), default 4 — it
  // bounds both fresh fan-out and how many continuations resume together.
  const cap = calmCap(parseYaml(safeRead(path.join(ws.dir, 'TRIAGE.yml')) || ''));
  // Claim-time asset preflight (lib/batch.js repoHoldReason): a spec whose
  // `repo:` is a void is held in specs/ with a concrete reason, never claimed —
  // and a code spec with no project repo never defaults into this checkout.
  // The existence check is fs, never a shell-out.
  const preflight = {
    isRepo: p => fs.existsSync(path.join(p, '.git')),
    // Containment is about the real checkout (INSTALL_ROOT), not a projects/
    // overlay from TL_ROOT/--root — otherwise the tl-developing-tl exemption
    // breaks when tests point ROOT at a scratch tree.
    tlRoot: INSTALL_ROOT,
    workspaceRepo: workspaceRepoRef(ws.dir),
  };
  const allReady = specs.filter(s => s.stage === 'ready');
  // agent routing: a spec's `agent:` (default `any`) must match the running agent's lane.
  const agentOf = s => (s.meta.agent || 'any').toLowerCase();
  const ready = agent ? allReady.filter(s => agentOf(s) === 'any' || agentOf(s) === agent) : allReady;
  const otherLane = agent ? allReady.filter(s => agentOf(s) !== 'any' && agentOf(s) !== agent)
    .map(s => ({ ...s, holdReason: 'assigned to agent "' + agentOf(s) + '"' })) : [];

  out('\n===== RUN BRIEF: ' + ws.name + (agent ? ' (agent lane: ' + agent + ')' : '') + ' =====\n');

  // Continuation dispatches outrank fresh claims: kicked-back / mid-flight work
  // resumes before anything new is started (skills/run step 0). The ready queue
  // waits for the next run; its specs are listed as held, not claimed.
  // Ownership mirrors lib/worker.js continuationEligible: claimed_by is binding;
  // only when unclaimed does agent:/any decide. Without --agent, all live conts
  // remain visible (unchanged). With --agent, other-lane-only → fall through.
  const conts = readContinuations(ws.dir, specs);
  const continuationEligible = (spec, lane) => {
    const claimed = String(spec.meta.claimed_by || '').toLowerCase();
    if (claimed) return claimed === lane;
    const a = String(spec.meta.agent || 'any').toLowerCase();
    return a === lane || a === 'any';
  };
  const continuationOwner = (spec) => {
    const claimed = String(spec.meta.claimed_by || '').toLowerCase();
    if (claimed) return claimed;
    return String(spec.meta.agent || 'any').toLowerCase();
  };
  const otherLaneLive = agent
    ? conts.live.filter(c => !continuationEligible(c.spec, agent))
    : [];
  const live = agent
    ? conts.live.filter(c => continuationEligible(c.spec, agent))
    : conts.live;
  if (conts.stale.length) {
    out('## Stale continuation dispatches');
    for (const c of conts.stale) {
      out(`- ${c.file} → "${c.slug}" — ${c.note}.`);
    }
    out('');
  }
  if (otherLaneLive.length && !live.length) {
    // Other agents' kickbacks must not hold this lane's ready queue.
    out('## Other-lane continuation dispatches');
    for (const c of otherLaneLive) {
      out(`- ${c.spec.title} (${c.spec.path}) [${c.file}] — owned by ${continuationOwner(c.spec)}`);
    }
    out('');
  }
  if (live.length && named) {
    // a named run is an explicit human choice — surface the pending resume, honor the name.
    out('Note: ' + live.length + ' pending continuation dispatch(es) — kicked-back work is waiting (resume it first unless this named run is intentional).\n');
  }
  // Interactive dispatch provenance (SCHEMA.md "Activity trace"): a human
  // typed `tl run`, so events carry initiation: human / source: cli — the
  // trace distinguishes this from a scheduled pickup even when the same agent
  // does the work. Skipped when the brief is tick-driven (TL_WORKER_DISPATCH:
  // the worker owns dispatch provenance on that path — one writer per path)
  // and on --dry-run (a dry run writes nothing).
  const traceInteractive = !dryRun && !process.env.TL_WORKER_DISPATCH;
  const cliRunId = 'cli-' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

  if (live.length && !named) {
    // Several kickbacks can be pending at once — they fan out like a fresh
    // batch: ordered (priority, then oldest kickback), capped at the calm cap,
    // and conflict-checked against each other so two resumed specs never share
    // a file. Held continuations stay pending for the next run, with a reason.
    const resumed = selectContinuations(live, { cap, preflight });
    if (traceInteractive) {
      // A continuation resume signs no claim → `dispatched`, correlated by the
      // dispatch file the kickback left behind.
      for (const c of resumed.batch) {
        appendSpecTraceEvent(path.join(ws.dir, c.spec.path), {
          type: 'dispatched',
          summary: `resume dispatched via interactive tl run brief (continuation${c.dispatch.reason ? ': ' + String(c.dispatch.reason).slice(0, 120) : ''})`,
          paths: [c.spec.path],
          actor_type: 'agent', actor_id: agent || 'unknown',
          initiation: 'human', source: 'cli',
          run_id: cliRunId, dispatch_id: c.file,
        });
      }
    }
    out('## Continuation dispatches — resume these before fresh claims (' + resumed.batch.length + ')');
    for (const c of resumed.batch) {
      out(`\n### ${c.spec.title}  (${c.spec.path}) [${c.file}]`);
      if (c.dispatch.reason) out('Reason: ' + c.dispatch.reason);
      out('**NOTES.md excerpt (binding — read the full file first)**');
      out(notesExcerpt(c.spec.notes));
    }
    if (resumed.held.length || ready.length || otherLaneLive.length) {
      out('\n## Held back for the next run');
      for (const c of resumed.held) out(`- ${c.spec.title} (${c.spec.path}) [${c.file}] — ${c.holdReason} (dispatch stays pending)`);
      for (const c of otherLaneLive) out(`- ${c.spec.title} (${c.spec.path}) [${c.file}] — owned by ${continuationOwner(c.spec)}`);
      for (const s of ready) out(`- ${s.title} (${s.path}) — continuation pending, resume in-progress work first`);
    }
    hr();
    out('Follow run SKILL step 0: flip each selected dispatch to "claimed" BEFORE any work begins, read NOTES.md then SPEC.md, and continue each spec from its current folder (' + (resumed.batch.length > 1 ? 'in parallel — their scopes are disjoint' : 'inline') + ') — never claim fresh ready work while a continuation is pending. Workspace "' + ws.name + '".');
    return;
  }

  if (!ready.length) {
    out(agent
      ? 'No ready specs in the "' + agent + '" lane (agent: ' + agent + ' or any). Nothing to run for this agent.'
      : 'The ready/ queue is empty — nothing to run. Stop and say so.');
    hr();
    return;
  }

  // If a spec is named, that's the batch (just it).
  let batch, held = [];
  if (named) {
    // match by slug exactly — `foo`, `specs/foo`, `specs/foo/` all name the same
    // spec; no substring match (which would let `foo` also hit `foo-bar`).
    const want = specSlug(named);
    const hit = ready.find(s => specSlug(s.path) === want);
    if (!hit) fail(`Named spec "${named}" not found in ready/. Ready: ${ready.map(s => s.path).join(', ')}`);
    // Asset preflight applies to named runs too — naming a spec is not an
    // override for a missing repo or the tl-checkout containment guard.
    const repoHold = repoHoldReason(hit, preflight);
    if (repoHold) fail(`Named spec "${named}" is held — ${repoHold}. Refusing to claim.`);
    // Even a named run refuses a spec whose write scope collides with active
    // work — no override flag exists yet, so a conflict is a hard stop.
    if (!isReadOnly(hit)) {
      const files = filesToTouch(hit);
      if (!files.length && active.codeActive) {
        fail(`Named spec "${named}" has undeclared scope and code work is already active — declare its Files to touch or wait. Refusing to claim.`);
      }
      const clash = files.find(f => active.files.has(f));
      if (clash) fail(`Named spec "${named}" conflicts with ${active.files.get(clash)} on ${clash}. Refusing to claim (no override).`);
    }
    batch = [hit];
    held = ready.filter(s => s !== hit).map(s => ({ ...s, holdReason: 'not the named spec' }));
  } else {
    ({ batch, held } = selectBatch(ready, doneSlugs, { active, cap, preflight }));
  }
  held = held.concat(otherLane);  // specs in another agent's lane wait for that agent

  out('## Selected batch (' + batch.length + ')');
  for (const s of batch) {
    const ro = isReadOnly(s);
    const files = filesToTouch(s);
    out(`- ${s.title} (${s.path})${s.meta.priority ? ' [' + s.meta.priority + ']' : ''} — ${ro ? 'read-only' : 'files: ' + (files.join(', ') || 'UNDECLARED SCOPE')}`);
  }

  if (held.length) {
    out('\n## Held back for the next run');
    for (const h of held) {
      out(`- ${h.title} (${h.path})${h.holdReason ? ' — ' + h.holdReason : ''}`);
    }
  }

  // The claim comes before any work: moving every selected folder out of
  // specs/ up front is what makes the batch atomic — a second run (or another
  // agent) that starts mid-flight finds nothing claimable it could collide on.
  if (batch.length) {
    out('\n## Claim the whole batch first (folder moves before any work)');
    for (const s of batch) {
      out(`- ${s.path} → in-progress/${specSlug(s.path)}/  (set status: in-progress, stamp claimed_by + claimed_at)`);
    }
    if (traceInteractive) {
      // The brief commits the batch, so the claim event lands now — in the
      // specs/ folder, where it travels with the folder move the agent makes.
      // The trace tells the truth if no claim follows: `claimed` here means
      // "claim directed interactively", and skills/run says don't duplicate it.
      for (const s of batch) {
        appendSpecTraceEvent(path.join(ws.dir, s.path), {
          type: 'claimed',
          summary: `claim directed via interactive tl run brief${agent ? ' (agent lane: ' + agent + ')' : ''} — human-invoked run`,
          paths: [s.path],
          actor_type: 'agent', actor_id: agent || 'unknown',
          initiation: 'human', source: 'cli', run_id: cliRunId,
        });
      }
    }
  }

  // Fresh interactive claims: same auto-initiation as the headless worker
  // (maybeAutoInitiateExperiment) after the claim is committed in the brief.
  // Continuations return earlier and never reach here. Dry runs skip. The
  // helper is failure-silent by contract; the outer try is belt-and-braces so
  // a broken experiment path never blocks or delays the canonical run brief.
  if (batch.length && !dryRun) {
    for (const s of batch) {
      try {
        maybeAutoInitiateExperiment({
          wsDir: ws.dir,
          specPath: s.path,
          spec: s,
          repoDir: workspaceRepoDir(ws.dir, s),
          print: out,
        });
      } catch { /* never throw past the brief */ }
    }
  }

  // The per-spec brief the agent works from.
  out('\n## Per-spec brief');
  for (const s of batch) {
    out('\n### ' + s.title + '  (' + s.path + ')');
    const obj = section(s.body, 'Objective');
    const acc = section(s.body, 'Acceptance criteria');
    const scope = section(s.body, 'Scope');
    if (obj) { out('**Objective**'); out(obj); }
    if (acc) { out('\n**Acceptance criteria**'); out(acc); }
    if (scope) { out('\n**Scope**'); out(scope); }
    if (s.notes) { out('\n**NOTES.md (binding — honor like acceptance criteria)**'); out(s.notes.trim()); }
  }

  hr();
  out('The batch above is conflict-free and claimed-ready. Now follow the run SKILL: claim the WHOLE batch first (every folder move above, before any work begins), then do each spec\'s work in scope and carry it to in-review (never done). Workspace "' + ws.name + '".');
}

// ---------- tl reclaim ----------

// Explicit reclaim of ONE stalled in-progress claim — never a sweep.
//
//   tl reclaim [ws]                          list stalled candidates, act on nothing
//   tl reclaim [ws] <spec> --by <who> --reason "<why>"   reclaim that one claim
//
// The rule and guards live in lib/stall.js: a claim with activity inside the
// threshold refuses (never force-steal), as do awaiting-verifier hand-offs,
// recorded blockers, and specs with a pending continuation dispatch. The
// reclaim itself is logged in the spec's NOTES.md — prior claim, reclaimer,
// reason — before any frontmatter changes or the folder move, so attribution
// is never stripped silently (the routing-priors mis-credit lesson).
function cmdReclaim(args) {
  let by = null, reason = null;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--by') by = args[++i];
    else if (args[i].startsWith('--by=')) by = args[i].slice(5);
    else if (args[i] === '--reason') reason = args[++i];
    else if (args[i].startsWith('--reason=')) reason = args[i].slice(9);
    else pos.push(args[i]);
  }
  const ws = resolveWorkspace(pos[0]);
  const slug = pos[1] || null;
  const specs = readAllSpecs(ws.dir);
  const conts = readContinuations(ws.dir, specs);
  const cfg = parseYaml(safeRead(path.join(ws.dir, 'TRIAGE.yml')) || '') || {};
  const thresholdMs = stallThresholdMs(cfg);
  const thresholdHours = Math.round(thresholdMs / 3600000);

  if (!slug) {
    const stalled = detectStalledClaims(ws.dir, specs, { thresholdMs, continuations: conts });
    out(`===== RECLAIM CANDIDATES: ${ws.name} (idle > ${thresholdHours}h) =====\n`);
    if (!stalled.length) {
      out('none — every in-progress claim shows recent activity or a healthy hand-off (awaiting_verifier / blocked / pending continuation).');
      return;
    }
    for (const x of stalled) {
      const hasFeedback = !!(x.spec.feedback && x.spec.feedback.trim());
      out(`- ${x.spec.title} (${x.spec.path}) — claimed_by ${x.spec.meta.claimed_by || '(unstamped)'}, idle ~${x.idleHours}h`);
      out(`    would ${hasFeedback
        ? 'ADVANCE to tests/ — builder artifacts (outcome/FEEDBACK.md) present; claimed_by preserved as builder attribution'
        : 'RELEASE to specs/ — status: ready, claim cleared after the prior claim is recorded in NOTES.md'}`);
      out(`    run: tl reclaim ${ws.name} ${x.slug} --by <you> --reason "<why>"`);
    }
    out('\nreclaim acts on ONE named spec; nothing was changed by this listing.');
    return;
  }

  const res = reclaimStalled(ws.dir, slug, { by, reason, thresholdMs, continuations: conts });
  if (!res.ok) {
    const why = {
      'reason-required': 'a recorded --reason "<why>" is mandatory — stamps change only with a reason.',
      'by-required': 'say who reclaims: --by <agent-or-human>.',
      'not-found': `no in-progress/${slug}/SPEC.md in "${ws.name}".`,
      'active-claim': 'the claim shows activity inside the threshold — never force-steal live work.',
      'awaiting-verifier': `that spec is a verifier hand-off, not a stall — tl verify ${ws.name}.`,
      'continuation-pending': `a pending continuation dispatch owns the resume — tl run ${ws.name}.`,
      'blocked': 'the spec records a blocker; unblock or kick it back instead of reclaiming.',
      'destination-exists': 'the destination folder already exists — resolve the collision by hand.',
      'no-evidence': 'no dateable activity for the claim — inspect the folder by hand before touching it.',
    }[res.reason] || res.reason;
    fail('reclaim refused: ' + why);
  }
  // Handoff provenance: an explicit human-attributed reclaim moved the spec —
  // record who, why, and the stage edge in the trace that travels with it.
  appendSpecTraceEvent(path.join(ws.dir, res.to), {
    type: 'handoff',
    from_stage: res.from.split('/')[0], to_stage: res.to.split('/')[0],
    summary: `reclaimed by ${by} (${res.mode}): ${String(reason || '').slice(0, 200)} — prior claim ${res.priorClaimedBy || 'unstamped'}`,
    actor_type: 'human', actor_id: String(by),
    initiation: 'human', source: 'cli',
  });
  out(`reclaimed ${res.slug}: ${res.from} → ${res.to} (${res.mode})`);
  out(res.mode === 'advance'
    ? `builder attribution preserved (claimed_by: ${res.priorClaimedBy || 'unknown'}) — awaiting independent verification: tl verify ${ws.name}`
    : `prior claim (${res.priorClaimedBy || 'unstamped'}) recorded in NOTES.md; spec re-queued as ready.`);
  out(`idle ~${res.idleHours}h > threshold ${res.thresholdHours}h — the why is logged in ${res.to}NOTES.md`);
}

// ---------- tl recover ----------

// Finish a COMMITTED builder handoff whose session died before the move —
// the counterpart to reclaim (which owns pre-manifest stalls). Same CLI
// discipline: list-then-act, --by/--reason mandatory to act, typed refusals,
// one spec at a time, never a sweep.
//
//   tl recover [ws]                    list recovery candidates, act on nothing
//   tl recover [ws] <spec>             inspect ONE spec's typed state (read-only)
//   tl recover [ws] <spec> --by <who> --reason "<why>" [--allow-no-lease]
//                                      finish that one committed hand-off
//
// The contract lives in lib/stall.js classifyRecovery/recoverPreparedHandoff:
// eligibility needs a valid terminal HANDOFF.json for in-progress → tests and
// an EXPIRED builder lease; a live lease refuses with holder details (never
// steal a live builder); partial writes, invalid/changed manifests, and
// missing manifests refuse (FEEDBACK.md alone is never completion). The
// recovery delegates to the worker finalize path — byte-identical manifest
// reuse, stage-CAS move — so the original builder keeps attribution; the
// recoverer is logged separately in NOTES.md and the spec's TRACE.jsonl.
function cmdRecover(args) {
  let by = null, reason = null, allowNoLease = false;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--by') by = args[++i];
    else if (args[i].startsWith('--by=')) by = args[i].slice(5);
    else if (args[i] === '--reason') reason = args[++i];
    else if (args[i].startsWith('--reason=')) reason = args[i].slice(9);
    else if (args[i] === '--allow-no-lease') allowNoLease = true;
    else pos.push(args[i]);
  }
  const ws = resolveWorkspace(pos[0]);
  const slug = pos[1] ? specSlug(pos[1]) : null;
  const cfg = parseYaml(safeRead(path.join(ws.dir, 'TRIAGE.yml')) || '') || {};
  const thresholdMs = stallThresholdMs(cfg);
  const thresholdHours = Math.round(thresholdMs / 3600000);

  const stateLine = (c) => {
    switch (c.state) {
      case 'recoverable':
        return `RECOVERABLE — valid HANDOFF.json (builder ${c.builder}, run ${c.run_id}), lease expired, idle ~${Math.round((c.idleMs || 0) / 3600000)}h`;
      case 'no-lease':
        return `NO-LEASE — valid manifest (builder ${c.builder}) but no builder lease on record (legacy). Explicit grace: --allow-no-lease, requires idle > ${thresholdHours}h (now ~${Math.round((c.idleMs || 0) / 3600000)}h)`;
      case 'active':
        return `ACTIVE — live builder lease (${(c.holder && c.holder.actor) || 'unknown'}, run ${(c.holder && c.holder.run_id) || '?'}, expires ${(c.holder && c.holder.expires_at) || 'per file age'}) — never steal a live builder`;
      case 'partial':
        return `PARTIAL — ${c.detail || c.reason} — not a committed handoff; not recoverable`;
      case 'invalid':
        return `INVALID — manifest refused (${c.reason}) — changed bytes / mismatch refuse; inspect by hand`;
      case 'finalized':
        return `FINALIZED — already in tests/ with a valid manifest (builder ${c.builder}) — nothing to recover`;
      case 'conflict':
        return `CONFLICT — spec observed in ${(c.observed_stages || []).join(' AND ')} — repair the duplicate before recovery`;
      default:
        return `${String(c.state || 'unknown').toUpperCase()} — ${c.detail || c.reason || ''}`;
    }
  };

  if (!slug) {
    const specs = readAllSpecs(ws.dir).filter(s => s.stage === 'in-progress' && s.dir);
    out(`===== RECOVERY CANDIDATES: ${ws.name} (committed handoffs only) =====\n`);
    let shown = 0, plain = 0;
    for (const s of specs) {
      const c = classifyRecovery(ws.dir, specSlug(s.path), {});
      if (c.state === 'no-manifest') { plain++; continue; }
      shown++;
      out(`- ${s.title} (${s.path}) — ${stateLine(c)}`);
      if (c.state === 'recoverable') out(`    run: tl recover ${ws.name} ${c.slug} --by <you> --reason "<why>"`);
      if (c.state === 'no-lease') out(`    run: tl recover ${ws.name} ${c.slug} --by <you> --reason "<why>" --allow-no-lease`);
    }
    if (!shown) out('none — no in-progress claim holds a committed handoff manifest.');
    if (plain) out(`\n${plain} in-progress claim(s) without a committed handoff — plain stalls belong to: tl reclaim ${ws.name}`);
    out('\nrecover acts on ONE named spec; nothing was changed by this listing.');
    return;
  }

  if (by == null && reason == null) {
    // Inspect surface: one spec's typed state, read-only, exit 0.
    const c = classifyRecovery(ws.dir, slug, {});
    out(`===== RECOVERY INSPECT: ${ws.name} ${slug} =====\n`);
    out(stateLine(c));
    if (c.state === 'recoverable') out(`\nact: tl recover ${ws.name} ${slug} --by <you> --reason "<why>"`);
    else if (c.state === 'no-lease') out(`\nact (explicit legacy grace): tl recover ${ws.name} ${slug} --by <you> --reason "<why>" --allow-no-lease`);
    else out('\nnot recoverable in this state; nothing was changed by this inspection.');
    return;
  }

  const res = recoverPreparedHandoff(ws.dir, slug, { by, reason, thresholdMs, allowNoLease });
  if (!res.ok) {
    const holder = res.holder ? ` (holder ${res.holder.actor || 'unknown'}, run ${res.holder.run_id || '?'}, expires ${res.holder.expires_at || 'per file age'})` : '';
    const why = {
      'reason-required': 'a recorded --reason "<why>" is mandatory — recovery always logs why.',
      'by-required': 'say who recovers: --by <agent-or-human>.',
      'not-found': `no committed hand-off for "${slug}" — not in in-progress/ and not finalized in tests/.`,
      'live-lease': `a live builder lease holds this spec${holder} — recovery never steals live builders; wait for expiry or let the builder finalize.`,
      'partial-handoff': 'the handoff is a partial write / incomplete artifact set — not a committed manifest; tl reclaim owns pre-manifest stalls.',
      'no-manifest': 'no committed HANDOFF.json — FEEDBACK.md alone is never completion; tl reclaim owns pre-manifest stalls.',
      'invalid-manifest': `the committed manifest does not validate (${res.cause || 'refused'}) — changed bytes refuse; inspect by hand.`,
      'no-lease': 'no builder lease on record — the legacy grace path is explicit: add --allow-no-lease (idle past threshold still required).',
      'recent-activity': `the folder shows activity inside the threshold (${thresholdHours}h) — a builder may be alive without a lease; grace refuses.`,
      'destination-exists': 'the spec is observed in more than one stage — repair the duplicate before recovery.',
      'failing-tests': 'the committed manifest records failing tests — a red gate is never handed off; kick it back instead.',
      'lease-held': `another run holds the builder lease${holder} — a concurrent recovery/retry is live; let it finish.`,
      'lease-lost': 'lost the lease race to a concurrent recovery/retry — re-run tl recover to see the resulting state.',
      'stale-stage': 'the spec moved stages mid-recovery — re-run tl recover to see the resulting state.',
      'manifest-invalidated': 'artifact bytes drifted mid-recovery — reuse_only refused before stamp, overwrite, or move; inspect in-progress/' + slug + '/ by hand: ' + (res.detail || ''),
      're-prepared': 'artifact bytes drifted mid-recovery and the manifest was re-prepared — inspect provenance by hand: ' + (res.detail || ''),
      'invariant-breach': 'recovery invariant failed after finalize — inspect provenance by hand: ' + (res.detail || ''),
    }[res.reason] || (res.detail || res.reason);
    fail('recover refused: ' + why);
  }
  if (res.already_finalized) {
    out(`already finalized: tests/${slug}/ holds the valid committed manifest (builder ${res.builder || 'unknown'}) — recovery had nothing to do (idempotent).`);
    return;
  }
  out(`recovered ${res.slug}: ${res.from} → ${res.to} (${res.mode})`);
  out(`builder attribution preserved (${res.builder}, run ${res.run_id}) — the manifest was reused byte-identically${res.byte_identical ? '' : ' (WARNING: manifest bytes could not be confirmed identical)'}; recovery is logged in NOTES.md + TRACE.jsonl as ${res.recovered_by}`);
  out(`awaiting independent verification: tl verify ${ws.name}`);
}

// ---------- tl review ----------

// ---------- tl reflect-decision ----------
// Explicit human marker for a /tl reflect proposal. Appends one row to
// _metrics/reflect-review-log.jsonl — never rewrites history, never applies
// TRIAGE.yml. Viewing the proposal file alone must not call this.

function cmdReflectDecision(args) {
  const flags = new Set();
  const positional = [];
  let action = null, by = 'human-cli', note = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--action' && args[i + 1]) { action = args[++i]; continue; }
    if (a.startsWith('--action=')) { action = a.slice(9); continue; }
    if (a === '--by' && args[i + 1]) { by = args[++i]; continue; }
    if (a.startsWith('--by=')) { by = a.slice(5); continue; }
    if (a === '--note' && args[i + 1]) { note = args[++i]; continue; }
    if (a.startsWith('--note=')) { note = a.slice(7); continue; }
    if (a === '--reviewed' || a === '--dismissed' || a === '--applied') {
      action = a.slice(2); continue;
    }
    if (a.startsWith('-')) fail('unknown flag for reflect-decision: ' + a);
    positional.push(a);
  }
  // Allow: tl reflect-decision [ws] <id> --action X  OR  tl reflect-decision <id> --action X
  let wsArg = null, idArg = null;
  if (positional.length >= 2) { wsArg = positional[0]; idArg = positional[1]; }
  else if (positional.length === 1) { idArg = positional[0]; }
  const ws = resolveWorkspace(wsArg);
  if (!idArg) {
    // List unread proposals (read-only).
    const metrics = {};
    const metricsDir = path.join(ws.dir, '_metrics');
    if (isDir(metricsDir)) {
      for (const f of fs.readdirSync(metricsDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const lines = (safeRead(path.join(metricsDir, f)) || '').split('\n').filter(Boolean).map(l => {
          try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
        metrics[f.replace(/\.jsonl$/, '')] = lines;
      }
    }
    const pending = pendingReflectProposals({ metrics, now: Date.now() });
    out('===== REFLECT PROPOSALS: ' + ws.name + ' =====');
    if (!pending.proposals.length) {
      out('no unread reflect proposals.');
      return;
    }
    for (const p of pending.proposals) {
      out(`  ${p.id}  ${p.path}  (${p.proposals} change${p.proposals === 1 ? '' : 's'})`);
    }
    out('');
    out('Mark one: tl reflect-decision ' + ws.name + ' <id> --action reviewed|dismissed|applied [--by <who>] [--note "..."]');
    return;
  }
  if (!action) fail('Usage: tl reflect-decision [ws] <reflect-YYYY-MM-DD|date> --action reviewed|dismissed|applied [--by <who>] [--note "..."]');
  const id = normalizeProposalId(idArg);
  if (!id) fail('bad proposal id — use reflect-YYYY-MM-DD or YYYY-MM-DD');
  try {
    const got = recordReflectProposalDecision(ws.dir, {
      proposalId: id, action, actor: by, via: 'cli', note,
    });
    out(`recorded ${got.row.action} for ${got.row.proposal_id} → ${got.path} (actor ${got.row.actor})`);
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  }
}

function cmdReview(args) {
  const ws = resolveWorkspace(args[0]);
  printSkill('review');

  const specs = readAllSpecs(ws.dir);
  const inReview = specs.filter(s => s.stage === 'in-review').sort((a, b) => a.mtime - b.mtime);

  out('\n===== REVIEW QUEUE: ' + ws.name + ' =====\n');
  if (!inReview.length) {
    out('in-review/ is empty — nothing to sign off. Stop and say so.');
    hr();
    return;
  }

  const triage = parseYaml(safeRead(path.join(ws.dir, 'TRIAGE.yml')) || '');
  out(`## Sign-off queue (${inReview.length}, oldest first)\n`);
  for (const s of inReview) {
    out('### ' + s.title + '  (' + s.path + ')');
    // verification status leads — self-check work is not visually equal to
    // independently verified work; the human is the second set of eyes then.
    const alignRaw = s.dir ? safeRead(path.join(s.dir, 'outcome', 'ALIGNMENT.md')) : null;
    const align = alignRaw ? parseFrontmatter(alignRaw) : null;
    if (align) {
      const am = align.meta;
      const self = String(am.verification_type || '').toLowerCase() === 'self-check' ||
        (am.builder && am.builder === am.verifier);
      out(self
        ? `⚠ SELF-CHECK ONLY (builder ${am.builder || '?'} verified itself) — you are the second set of eyes`
        : `✓ Independent check: built by ${am.builder || '?'}, verified by ${am.verifier || '?'} (${am.verdict || 'no verdict'})`);
      const gate = canAdvanceToReview(s, align, triage);
      if (!gate.ok) out(`⚠ Gate says this should not have advanced: ${gate.reason}`);
    } else {
      out('⚠ No ALIGNMENT.md (pre-gate spec — grandfathered; verify claims yourself)');
    }
    const acc = section(s.body, 'Acceptance criteria');
    out('\n**Acceptance criteria (the contract to check)**');
    out(acc || '(none declared)');
    out('\n**outcome/FEEDBACK.md (the worker\'s claim — verify against the diff)**');
    out(s.feedback ? s.feedback.trim() : '(missing — a spec in review should have FEEDBACK)');
    if (s.notes) { out('\n**NOTES.md**'); out(s.notes.trim()); }
    out('');
  }

  hr();
  out('For each spec: check the diff in its repo against the criteria, then accept (→ done/) or kick back (→ in-progress/ with a thread reason). Workspace "' + ws.name + '".');
}

// ---------- tl verify ----------

// Independent-verifier handoff + isolated-worker drain. Default is status/
// brief output (builder exclusion, queued/running/blocked/human-decision-
// required, verified-by). `--execute` runs one isolated verify tick (same as
// `tl-worker --mode verify`). Human mutation decisions are explicit CLI flags
// — never auto-applied.
function cmdVerify(args) {
  let agent = null, execute = false, decide = null, note = '', dispatch = false, targetLane = 'any-other';
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent') agent = String(args[++i] || '').toLowerCase();
    else if (args[i].startsWith('--agent=')) agent = args[i].slice(8).toLowerCase();
    else if (args[i] === '--execute') execute = true;
    else if (args[i] === '--dispatch') dispatch = true;
    else if (args[i] === '--target-lane') targetLane = String(args[++i] || 'any-other').toLowerCase();
    else if (args[i].startsWith('--target-lane=')) targetLane = args[i].slice(14).toLowerCase();
    else if (args[i] === '--authorize-fix-forward') decide = 'authorize-fix-forward';
    else if (args[i] === '--kick-back') decide = 'kick-back';
    else if (args[i] === '--note') note = String(args[++i] || '');
    else if (args[i].startsWith('--note=')) note = args[i].slice(7);
    else pos.push(args[i]);
  }
  const ws = resolveWorkspace(pos[0]);
  const named = pos[1];
  const triage = parseYaml(safeRead(path.join(ws.dir, 'TRIAGE.yml')) || '') || {};

  if (decide) {
    if (!named) fail('Human decision requires a spec slug: tl verify <ws> <spec> --authorize-fix-forward|--kick-back');
    try {
      const got = applyVerifyHumanDecision(ws.dir, { slug: named, action: decide, note, by: 'human-cli', source: 'cli' });
      out(`Human decision recorded: ${decide} → ${got.path}`);
      out('No mutation was auto-applied. A continuation dispatch is pending for the next run.');
    } catch (e) { fail(e && e.message ? e.message : String(e)); }
    return;
  }

  if (dispatch) {
    if (!named) fail('Dispatch requires a spec: tl verify <ws> <spec> --dispatch [--target-lane <lane>|any-other]');
    try {
      const got = writeVerifyRequest(ws.dir, { spec: named, targetLane, source: 'cli' });
      out(`Wrote verify request ${got.path} (target_lane: ${got.request.target_lane}).`);
      out('UI/CLI never spawn verifier CLIs — drain with `tl verify --execute` or the scheduled verify tick.');
    } catch (e) { fail(e && e.message ? e.message : String(e)); }
    return;
  }

  if (execute) {
    const which = bin => {
      try {
        const r = spawnSync('which', [bin], { encoding: 'utf8' });
        return r.status === 0 ? String(r.stdout || '').trim() : '';
      } catch { return ''; }
    };
    const result = verifyTick({
      root: INSTALL_ROOT, wsDir: ws.dir, wsName: ws.name,
      preferLane: agent || null, which,
      // trace provenance: a human typed `tl verify --execute`
      initiation: 'human', source: 'cli',
    });
    out(`verify tick: code ${result.code}` + (result.picked ? ` · ${result.picked}` : '')
      + (result.outcome ? ` · ${result.outcome}` : '')
      + (result.reason ? ` · ${result.reason}` : ''));
    if (result.code !== 0) process.exit(result.code);
    return;
  }

  printSkill('verify');

  const specs = readAllSpecs(ws.dir);
  const policy = verificationPolicy(triage);
  const vLanes = readVerifierLanes(triage);
  const vIssues = verifierLaneIssues(triage);

  let awaiting = specs.filter(s => ['tests', 'in-progress'].includes(s.stage) && (
    s.meta.awaiting_verifier === true
    || String(s.meta.verifier_status || '').toLowerCase() === 'human-decision-required'
    || String(s.meta.verifier_status || '').toLowerCase() === 'blocked'
  ));
  if (named) {
    const want = specSlug(named);
    awaiting = awaiting.filter(s => specSlug(s.path) === want);
    if (!awaiting.length) fail(`Named spec "${named}" is not in the verify surface. Queue: ${specs.filter(s => s.meta.awaiting_verifier === true).map(s => s.path).join(', ') || '(none)'}`);
  }
  const mine = agent ? awaiting.filter(s => builderOf(s) === agent) : [];
  if (agent) awaiting = awaiting.filter(s => builderOf(s) !== agent);

  out('\n===== VERIFY QUEUE: ' + ws.name + (agent ? ' (verifier: ' + agent + ')' : '') + ' =====\n');
  out('Policy: require_independent_verifier: ' + policy.required +
    (policy.allowSelfCheckFor.length ? ' · self-check allowed for: ' + policy.allowSelfCheckFor.join(', ') : ' · self-check allowed for: (none)'));
  out('Verifier lanes: ' + (vLanes.map(l => l.id).join(', ') || '(none configured)'));
  if (vIssues.length) {
    out('Lane issues:');
    for (const i of vIssues) out(`  - ${i.lane || '?'}: ${i.problem}`);
  }
  const pendingReqs = readVerifyRequests(ws.dir).filter(r => r.request.status === 'pending');
  if (pendingReqs.length) {
    out(`Pending dispatch requests: ${pendingReqs.length}`);
    for (const r of pendingReqs) out(`  - ${r.file} → ${r.request.spec} (target: ${r.request.target_lane})`);
  }

  if (mine.length) {
    out('\n## Built by you — cannot verify (' + mine.length + ')');
    for (const s of mine) out(`- ${s.title} (${s.path}) — builder ${builderOf(s)}; another agent must verify`);
  }
  if (!awaiting.length) {
    out('\nNothing awaiting independent verification' + (agent ? ' that you did not build yourself' : '') + '. Stop and say so.');
    hr();
    return;
  }

  out(`\n## Verify surface (${awaiting.length}, oldest first)\n`);
  for (const s of awaiting.sort((a, b) => a.mtime - b.mtime)) {
    const st = verifierStatusOf(s, { wsDir: ws.dir });
    out('### ' + s.title + '  (' + s.path + ')');
    out(`Status: ${st.status}` + (st.verified_by ? ` · verified-by: ${st.verified_by}` : '')
      + ` · builder: ${builderOf(s) || '(unstamped)'} · type: ${s.meta.type || '?'} · requested: ${s.meta.requested_at || '?'}`);
    if (s.meta.blocked_reason) out(`Blocked reason: ${s.meta.blocked_reason}`);
    const verifyReq = s.dir ? safeRead(path.join(s.dir, 'VERIFY.md')) : null;
    if (verifyReq) { out('\n**VERIFY.md (the request)**'); out(verifyReq.trim()); }
    const acc = section(s.body, 'Acceptance criteria');
    if (acc) { out('\n**Acceptance criteria (verify against the diff, not the claim)**'); out(acc); }
    if (s.feedback) { out('\n**outcome/FEEDBACK.md (the builder\'s claim)**'); out(s.feedback.trim()); }
    const notes = s.dir ? safeRead(path.join(s.dir, 'NOTES.md')) : null;
    if (st.status === 'human-decision-required') {
      out('\n**Human decision required** — mutation proposals were NOT applied.');
      if (notes) out(notes.trim());
      out(`Choices: tl verify ${ws.name} ${specSlug(s.path)} --authorize-fix-forward [--note "..."]`);
      out(`         tl verify ${ws.name} ${specSlug(s.path)} --kick-back [--note "..."]`);
    }
    const alignment = s.dir ? safeRead(path.join(s.dir, 'outcome', 'ALIGNMENT.md')) : null;
    const gate = canAdvanceToReview(s, alignment ? parseFrontmatter(alignment) : null, triage);
    out(`\nGate now: ${gate.ok ? 'would advance' : 'held'} — ${gate.reason}`);
    out('');
  }

  hr();
  out('Drain via isolated worker: `tl verify ' + ws.name + ' --execute`' + (agent ? ` --agent ${agent}` : '')
    + ' (or the scheduled `tl-worker --mode verify` tick). Clean pass → in-review only; mutations stay held for an explicit human choice. Workspace "' + ws.name + '".');
}

// ---------- tl recall ----------

// Corpus assembly, scoring, and kind-grouping live in lib/recall.js — the SAME
// helpers the UI server's read-only GET /api/recall uses, so the CLI and the
// cockpit cannot drift (the parity the tl-recall-skill outcome carried
// forward). The CLI prints the full uncapped snapshot; the UI caps.

function cmdRecall(args) {
  const ws = resolveWorkspace(args[0]);
  const query = args.slice(1).join(' ').trim();
  printSkill('recall');

  if (!query) {
    out('\n===== RECALL: ' + ws.name + ' =====\n');
    out('No query given. Usage: tl recall ' + ws.name + ' <query>');
    hr();
    return;
  }

  const { total, groups } = recallSearch(ws.dir, query);

  out('\n===== RECALL: ' + ws.name + ' — "' + query + '" =====\n');
  if (!total) {
    out('No prior discussion found across intents, specs, threads, or done outcomes.');
    hr();
    out('recall found no prior art for "' + query + '" in workspace "' + ws.name + '". Answer: no — proceed, this looks new.');
    return;
  }

  out('## Matches (' + total + ', grouped by kind)');
  for (const g of groups) {
    out('\n### ' + g.kind);
    for (const h of g.hits) {
      out('- ' + h.title + ' (' + h.path + ') [score ' + h.score + ']');
      if (h.snippet) out('    ↳ ' + h.snippet);
    }
  }

  hr();
  out('The matches above are the deterministic read across the workspace corpus. Now follow the recall SKILL: lead with have-we-discussed-this (yes / partially / no), summarize the prior discussion grouped by kind, and recommend the next action. Workspace "' + ws.name + '".');
}

// ---------- tl sync ----------

// Offline validation of a workspace's JIRA sync config — the CLI surface for
// lib/sync-map.js `normalizeTypeMap` (the canonical type-map contract the sync
// skill stops-before-import on). Reads TRIAGE.yml only: never touches JIRA,
// never reads credentials, safe to run anywhere. Full bidirectional sync stays
// skill-driven (skills/sync/SKILL.md); this is its deterministic precondition
// check as a command.
function cmdSync(args) {
  const [sub, ...rest] = args;
  if (sub !== 'check' || rest.length > 1) {
    fail('Usage: tl sync check [workspace] — validate TRIAGE.yml sync.jira.map offline (full sync stays skill-driven: skills/sync/SKILL.md)');
  }
  const ws = resolveWorkspace(rest[0]);
  const raw = safeRead(path.join(ws.dir, 'TRIAGE.yml'));
  let cfg = {};
  try { cfg = (raw ? parseYaml(raw) : {}) || {}; } catch { cfg = {}; }
  const sync = cfg.sync && typeof cfg.sync === 'object' && !Array.isArray(cfg.sync) ? cfg.sync : null;
  const jira = sync && sync.jira && typeof sync.jira === 'object' && !Array.isArray(sync.jira) ? sync.jira : null;

  out('===== SYNC CHECK: ' + ws.name + ' =====\n');

  // Absent config is a calm no, not an error — local-only tl is a complete
  // product, and this check must be safe to run on any workspace.
  if (!jira) {
    out('sync is not configured — no sync.jira section in TRIAGE.yml. Nothing to validate.');
    out('To set it up, add the sync: block from skills/sync/SKILL.md (url, project, import_filter, map).');
    return;
  }

  const url = typeof jira.url === 'string' && jira.url.trim() ? jira.url.trim() : '(unset)';
  const project = typeof jira.project === 'string' && jira.project.trim() ? jira.project.trim() : '(unset)';
  out(`jira: url ${url} · project ${project}`
    + (url === '(unset)' || project === '(unset)' ? '  (needed for a real sync run; map validation is offline either way)' : ''));

  const { map, errors } = normalizeTypeMap(jira.map);

  // Invalid entries are the bridge's stop-before-import condition: list every
  // offending key with its paste-ready fix hint (the exact lines the sync
  // skill would print), then exit non-zero.
  if (errors.length) {
    out(`\nmap: INVALID — ${errors.length} entr${errors.length === 1 ? 'y' : 'ies'} rejected; sync stops before import on an invalid map:`);
    for (const e of errors) out('  - ' + e);
    out(`\nFix the entries above in projects/${ws.name}/TRIAGE.yml, then re-run: tl sync check ${ws.name}`);
    fail(`sync.jira.map is invalid (${errors.length} error${errors.length === 1 ? '' : 's'}) — see the fix hints above.`);
  }

  // Valid: the effective map is defaults merged with the workspace entries
  // (workspace wins on key collision). Show each entry with its provenance so
  // "defaults in effect" is visible, not implied.
  const rawMap = jira.map && typeof jira.map === 'object' && !Array.isArray(jira.map) ? jira.map : {};
  const wsKeys = new Set(Object.keys(rawMap).map(normalizeTypeKey));
  const entries = Object.entries(map);
  const counts = { default: 0, override: 0, workspace: 0 };
  out(`\nmap: OK — ${entries.length} effective entr${entries.length === 1 ? 'y' : 'ies'}:`);
  for (const [key, e] of entries) {
    const src = !wsKeys.has(key) ? 'default' : (DEFAULT_TYPE_MAP[key] ? 'override' : 'workspace');
    counts[src]++;
    const target = e.to === 'spec'
      ? `spec (type: ${e.type}${e.tags && e.tags.length ? ', tags: [' + e.tags.join(', ') + ']' : ''})`
      : e.to;
    out(`  - ${key} → ${target}  [${src}]`);
  }
  out(`defaults in effect: ${counts.default} untouched · ${counts.override} overridden · ${counts.workspace} workspace-added`
    + (wsKeys.size ? '' : '  (no workspace map — the shipped defaults are the whole contract)'));
  hr();
  out('Offline check only — no JIRA call was made and no credentials were read. A clean map is sync\'s stop-before-import precondition (lib/sync-map.js normalizeTypeMap).');
}

// ---------- tl sync-rules ----------

// The per-agent instruction files (AGENTS.md, .cursor/rules/tl.mdc, GEMINI.md)
// are GENERATED from the skills' SKILL.md frontmatter plus the core file-model
// rules below. SKILL.md stays the single source of truth for the verbs; this
// command re-derives the rules files in place so they never drift.

// Read every skills/<name>/SKILL.md and pull its name + description from the
// frontmatter. Sorted by name for a stable, diff-friendly output.
function readSkills(root = INSTALL_ROOT) {
  const skillsDir = path.join(root, 'skills');
  if (!isDir(skillsDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(skillsDir).sort()) {
    if (name.startsWith('.')) continue;
    const file = path.join(skillsDir, name, 'SKILL.md');
    const text = safeRead(file);
    if (text === null) continue;
    const { meta } = parseFrontmatter(text);
    const desc = String(meta.description || '').trim();
    out.push({ name: String(meta.name || name).trim(), description: desc });
  }
  return out;
}

// A description's first sentence is the verb's one-liner; the rest is triggering
// guidance meant for skill routing, which the rules files don't need.
function firstSentence(s) {
  const t = String(s).trim();
  const m = t.match(/^(.*?[.!?])(\s|$)/);
  return (m ? m[1] : t).trim();
}

// The core file-model rules — the invariants an agent must not get wrong.
// Shared verbatim across all three generated files (each formats them to suit).
const CORE_RULES = [
  ['Status IS the folder', 'A spec\'s lifecycle stage is its directory. To change the stage, move the folder: specs/ (ready) → in-progress/ → tests/ → in-review/ → done/. If a status: field and the folder disagree, the folder wins.'],
  ['Claim by moving', 'To start a spec, move specs/<slug>/ → in-progress/<slug>/ and set status: in-progress. The move is the claim — once it leaves specs/, no other agent can pick it up.'],
  ['Stop at in-review — never done', 'When work is complete and verification is green, write outcome/FEEDBACK.md and move the spec to in-review/ (status: in-review). An agent never moves any spec to done/ — its own or another\'s: builder and verifier both stop at in-review/, and only a human accepts work into done/. This gate is what makes parallel fan-out safe.'],
  ['Honor scope and NOTES', 'Do the work only within the spec\'s Files to touch; treat Do not touch as a hard boundary. If a spec has NOTES.md, it is as binding as the acceptance criteria.'],
  ['Capture threads', 'Anything worth not losing but out of scope — a decision, follow-up, risk, or discovery — becomes a file in threads/ (see the capture verb). An undocumented discovery is a leak; it does not justify widening the current spec.'],
  ['Files only', 'Every change is a markdown/JSONL edit plus a folder move. No hidden state; specs/ is the only queue for *new* work, but a pending `_dispatch/` continuation outranks fresh claims — the folders are the status.'],
  ['Ranking passes coordinate and write narrowly', 'Before ranking, acquire `_metrics/locks/triage.lock`; a fresh lock means triage is already running, so exit instead of racing. Triage writes only its allowed priority/hold/status fields with targeted edits, re-stats before every write, and skips a spec that moved since inventory.'],
];

const GEN_MARKER = '<!-- generated by `tl sync-rules` from skills/*/SKILL.md — do not edit by hand -->';

// Shared prose blocks so all three files tell the same story.
function whatIsTl() {
  return 'Throughline (tl) is markdown-native project management for agent-driven work. Human **intents** (why) decompose into agent-ready **specs** (what to do now); **threads** capture what not to lose. There is no database and no server-of-record: the markdown files are the database, git is the history, and a spec\'s folder is its status.';
}

function layoutBlock() {
  return [
    'The tool lives in this repo. Actual work lives in **workspaces** under `projects/<name>/` (gitignored). One workspace per project:',
    '',
    '```',
    'projects/<name>/',
    '├── TRIAGE.yml       # goals (weighted), allocation targets, priority rules',
    '├── PRIORITIES.md    # generated ranked backlog (by triage)',
    '├── intents/         # human objectives, outcome language',
    '├── specs/           # agent-ready, not started  ← the READY QUEUE',
    '├── in-progress/     # being worked',
    '├── tests/           # code complete, at the test/verification gate',
    '├── in-review/       # tests green, awaiting human sign-off (has outcome/FEEDBACK.md)',
    '├── done/            # reviewed and accepted (human only)',
    '└── threads/         # parked ideas, decisions, open questions, risks',
    '```',
    '',
    'Each spec is a self-contained folder: `SPEC.md` (Objective, Acceptance criteria, Scope), optional `context/`, `outcome/FEEDBACK.md` (written when work completes), and optional `NOTES.md` (human mid-flight feedback — binding). The frontmatter contract lives in `_templates/SCHEMA.md`; enums are lowercase, dates are ISO.',
  ].join('\n');
}

function quickstartSteps() {
  return [
    '1. **Pick the workspace.** If `projects/` holds exactly one workspace, use it; otherwise the human names it.',
    '2. **Pick a spec.** Look in `projects/<name>/specs/` (the ready queue). Prefer the highest priority per `PRIORITIES.md`; ties broken by oldest. Pick one whose `depends_on` are all in `done/`.',
    '3. **Claim it.** `git mv projects/<name>/specs/<slug> projects/<name>/in-progress/<slug>` and set `status: in-progress`.',
    '4. **Assemble the brief.** Read the spec\'s Objective, Acceptance criteria, Scope, any `NOTES.md`, its `context/`, the parent intent\'s Outcome, and the goal it ladders to (`TRIAGE.yml`).',
    '5. **Do the work** in the spec\'s repo, strictly within `Files to touch`. Out-of-scope find → write a `threads/` file, keep going.',
    '6. **Test gate.** Move to `tests/` (`status: tests`) and run the acceptance checks. If red, leave it in `tests/` as `status: blocked` with what broke, and stop.',
    '7. **Hand to review.** On green, write `outcome/FEEDBACK.md`, move `tests/<slug> → in-review/<slug>`, set `status: in-review`. **Stop here — do not move it to `done/`.**',
    '8. **Report** the final state, any threads captured, and that it now waits in `in-review/` for a human to accept.',
  ].join('\n');
}

// The verb list, rendered as markdown bullets: `verb` — one-liner.
function verbsBlock(skills) {
  return skills.map(s => `- \`tl ${s.name}\` — ${firstSentence(s.description)}`).join('\n');
}

// ----- AGENTS.md (repo root; Codex/Claude and the generic default) -----
function genAgents(skills) {
  const rules = CORE_RULES.map((r, i) => `${i + 1}. **${r[0]}.** ${r[1]}`).join('\n');
  return [
    '# AGENTS.md',
    '',
    GEN_MARKER,
    '',
    'Standing instructions for **any** coding agent (Codex, Cursor, Gemini, Claude, …) working in this repo. This file plus the skills it points to are enough to drive a spec correctly with zero new tooling.',
    '',
    '> **Cross-agent PoC.** A non-Claude agent, given only this AGENTS.md, can pick up one ready spec and carry it to `in-review/` — no `tl`-specific tools, just files and git. If you are that agent: follow the quickstart below.',
    '',
    '## What tl is',
    '',
    whatIsTl(),
    '',
    '## Workspace layout',
    '',
    layoutBlock(),
    '',
    '## The verbs — source of truth is the skills',
    '',
    'Each verb is one `skills/<name>/SKILL.md` — the algorithm. Don\'t re-derive the procedures; read and follow them. Start with **`skills/run/SKILL.md`** (work the queue), **`skills/resume/SKILL.md`** (orient), and **`skills/review/SKILL.md`** (human sign-off).',
    '',
    verbsBlock(skills),
    '',
    '## Critical rules — do not get these wrong',
    '',
    rules,
    '',
    '## Quickstart: work one spec',
    '',
    'You can follow this literally. (`skills/run/SKILL.md` is the full version — read it too.)',
    '',
    quickstartSteps(),
    '',
  ].join('\n');
}

// ----- .cursor/rules/tl.mdc (Cursor project rules; MDC frontmatter) -----
function genCursor(skills) {
  const rules = CORE_RULES.map(r => `- **${r[0]}.** ${r[1]}`).join('\n');
  return [
    '---',
    'description: Throughline (tl) — markdown-native project management. How to work a spec.',
    'alwaysApply: true',
    '---',
    '',
    GEN_MARKER,
    '',
    '# Working in a Throughline (tl) repo',
    '',
    whatIsTl(),
    '',
    '## Layout',
    '',
    layoutBlock(),
    '',
    '## Verbs (each is `skills/<name>/SKILL.md` — read the skill, follow it)',
    '',
    verbsBlock(skills),
    '',
    '## Rules — do not get these wrong',
    '',
    rules,
    '',
    '## Work one spec',
    '',
    quickstartSteps(),
    '',
  ].join('\n');
}

// ----- GEMINI.md (Gemini context file) -----
function genGemini(skills) {
  const rules = CORE_RULES.map((r, i) => `${i + 1}. **${r[0]}.** ${r[1]}`).join('\n');
  return [
    '# GEMINI.md',
    '',
    GEN_MARKER,
    '',
    'Context for Gemini working in this Throughline (tl) repo. This file plus the `skills/*/SKILL.md` it names are enough to drive a spec with zero new tooling.',
    '',
    '## What tl is',
    '',
    whatIsTl(),
    '',
    '## Workspace layout',
    '',
    layoutBlock(),
    '',
    '## The verbs',
    '',
    'Each verb is one `skills/<name>/SKILL.md` — read the skill and follow its steps rather than re-deriving. Core loop: `run` (work the queue), `resume` (orient), `review` (human sign-off).',
    '',
    verbsBlock(skills),
    '',
    '## Critical rules',
    '',
    rules,
    '',
    '## Quickstart: work one spec',
    '',
    quickstartSteps(),
    '',
  ].join('\n');
}

function syncRulesRoot() {
  return path.resolve(process.env.TL_SYNC_RULES_ROOT || INSTALL_ROOT);
}

function syncRuleTargets(root, skills) {
  return [
    { path: path.join(root, 'AGENTS.md'), content: genAgents(skills) },
    { path: path.join(root, '.cursor', 'rules', 'tl.mdc'), content: genCursor(skills) },
    { path: path.join(root, 'GEMINI.md'), content: genGemini(skills) },
  ];
}

function cmdSyncRules(args = []) {
  const check = args.includes('--check');
  const unknown = args.filter(a => a !== '--check');
  if (unknown.length) fail('Usage: tl sync-rules [--check]');

  const root = syncRulesRoot();
  const skills = readSkills(root);
  if (!skills.length) fail('No skills found under skills/*/SKILL.md — nothing to generate from.');

  const targets = syncRuleTargets(root, skills);

  if (check) {
    const drifted = targets
      .filter(t => safeRead(t.path) !== t.content)
      .map(t => path.relative(root, t.path));
    if (!drifted.length) {
      out('tl sync-rules --check: generated rule files are up to date.');
      return;
    }
    process.stderr.write('tl sync-rules --check: generated rule files are out of date:\n');
    for (const rel of drifted) process.stderr.write('  ' + rel + '\n');
    process.exit(1);
  }

  out('===== tl sync-rules =====');
  out(`Source: ${skills.length} skill${skills.length === 1 ? '' : 's'} under skills/*/SKILL.md`);
  out('');
  for (const t of targets) {
    const rel = path.relative(root, t.path);
    const before = safeRead(t.path);
    const status = before === null ? 'created' : (before === t.content ? 'unchanged' : 'updated');
    if (status !== 'unchanged') {
      fs.mkdirSync(path.dirname(t.path), { recursive: true });
      fs.writeFileSync(t.path, t.content);
    }
    out(`  ${status.padEnd(9)} ${rel}`);
  }
  out('');
  out('SKILL.md frontmatter is the single source of truth — re-run `tl sync-rules` after editing skills to refresh these.');
}

// ---------- tl triage-lock ----------

function cmdTriageLock(args = []) {
  const action = args[0];
  const positional = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--lane') { i++; continue; }
    if (args[i].startsWith('--lane=')) continue;
    positional.push(args[i]);
  }
  if (positional.length > 1) fail('Usage: tl triage-lock <acquire|touch|release|check> [workspace] [--lane <name>]');
  const ws = resolveWorkspace(positional[0]);
  const lane = flagValue(args, 'lane') || process.env.TL_AGENT || 'interactive';
  let result;
  if (action === 'acquire') result = acquireTriageLock(ws.dir, { lane });
  else if (action === 'touch') result = touchTriageLock(ws.dir);
  else if (action === 'release') result = releaseTriageLock(ws.dir);
  else if (action === 'check') result = checkTriageLock(ws.dir);
  else fail('Usage: tl triage-lock <acquire|touch|release|check> [workspace] [--lane <name>]');

  if (result.state === 'held') fail(`triage already running (age ${result.ageMinutes}m)`);
  if (result.state === 'taken-over') out(`stale triage lock taken over by ${lane} (older than 15m)`);
  else out(`triage lock ${result.state}${action === 'acquire' ? ` by ${lane}` : ''}`);
}

// ---------- tl experiment ----------

// Winner-application subcommands share an argument shape:
//   tl experiment <action> [workspace] <experiment-id> <candidate-id> [flags]
// The workspace is optional exactly like everywhere else — if the first
// positional names a workspace it is consumed, otherwise the default resolves.
function parseWinnerArgs(rest, action) {
  const positional = [];
  const flags = { by: '', reason: '', repo: '' };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--by') flags.by = rest[++i] || '';
    else if (a === '--reason') flags.reason = rest[++i] || '';
    else if (a === '--repo') flags.repo = rest[++i] || '';
    else positional.push(a);
  }
  const names = listWorkspaces().map(w => w.name);
  const wsArg = positional.length > 2 || names.includes(positional[0]) ? positional.shift() : undefined;
  const [experimentId, candidateId] = positional;
  if (!experimentId || !candidateId) {
    fail(`Usage: tl experiment ${action} [workspace] <experiment-id> <candidate-id>${action === 'reject' ? ' --reason "<why>"' : ''} [--by <who>]`);
  }
  return { ws: resolveWorkspace(wsArg), experimentId, candidateId, flags };
}

function cmdExperiment(args) {
  const [subcmd, ...rest] = args;

  // ---- tl experiment queue [ws] <spec> — initiate an experiment ----
  // Creates the experiment folder (hashing SPEC.md, recording base_commit)
  // and writes one queued row per candidate. Candidates come from --config
  // (explicit JSON) or default to the deterministic fixture pair. This never
  // moves the spec — experiments are shadow attempts against a snapshot.
  if (subcmd === 'queue') {
    const positional = [];
    const flags = { config: '', budget: '', timeout: '', repo: '', id: '' };
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--config') flags.config = rest[++i] || '';
      else if (a === '--budget') flags.budget = rest[++i] || '';
      else if (a === '--timeout') flags.timeout = rest[++i] || '';
      else if (a === '--repo') flags.repo = rest[++i] || '';
      else if (a === '--id') flags.id = rest[++i] || '';
      else positional.push(a);
    }
    const names = listWorkspaces().map(w => w.name);
    const wsArg = positional.length > 1 || names.includes(positional[0]) ? positional.shift() : undefined;
    const ws = resolveWorkspace(wsArg);
    const spec = positional[0];
    if (!spec) fail('Usage: tl experiment queue [workspace] <spec> [--config <file>] [--budget <usd>] [--timeout <min>] [--repo <path>] [--id <experiment-id>]');
    let config = {};
    if (flags.config) {
      try { config = JSON.parse(fs.readFileSync(path.resolve(flags.config), 'utf8')); }
      catch (e) { fail(`Cannot read --config ${flags.config}: ${e.message}`); }
    }
    try {
      const result = queueExperiment(ws.dir, {
        spec,
        repoDir: path.resolve(flags.repo || config.repo || INSTALL_ROOT),
        candidates: config.candidates,
        judge: config.judge,
        budgetUsd: flags.budget !== '' ? flags.budget : config.budget_usd,
        timeoutMinutes: flags.timeout !== '' ? flags.timeout : config.timeout_minutes,
        experimentId: flags.id || undefined,
        source: 'cli',
      });
      out('===== tl experiment queue =====');
      out(`workspace: ${ws.name}`);
      out(`experiment: _experiments/${result.experimentId}/  (status: queued)`);
      out(`queue rows: ${result.rows.length} → _experiments/queue/${result.experimentId}.jsonl`);
      for (const r of result.rows) {
        out(`  - ${r.candidate_id} [${r.role}] lane ${r.agent_tool}${r.agent_model_requested ? ' model ' + r.agent_model_requested : ''}`);
      }
      out('Workers drain their lanes with: tl experiment drain --agent <tool> ' + ws.name);
    } catch (e) { fail(e.message); }
    return;
  }

  // ---- tl experiment drain --agent <name> [ws] — one worker pass ----
  // Claims queued rows for this agent's lane only, runs them locally
  // (fixture/shell in this slice), queues judge rows for experiments whose
  // candidate runs are all terminal, and executes queued judge rows in this
  // lane headlessly (deterministic checks in code; model-judgment dimensions
  // land in a lane-agnostic JUDGE-BRIEF.md). Never applies winners — a judge
  // verdict is a nomination; apply/reject stays an explicit human action.
  if (subcmd === 'drain') {
    const positional = [];
    const flags = { agent: '', max: '', evaluatePartial: [], skipJudges: false, repo: '', testCommand: '', unsafeHostExec: false };
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--agent') flags.agent = rest[++i] || '';
      else if (a.startsWith('--agent=')) flags.agent = a.slice(8);
      else if (a === '--max') flags.max = rest[++i] || '';
      else if (a === '--evaluate-partial') flags.evaluatePartial.push(rest[++i] || '');
      else if (a === '--skip-judges') flags.skipJudges = true;
      else if (a === '--repo') flags.repo = rest[++i] || '';
      else if (a === '--test-command') flags.testCommand = rest[++i] || '';
      else if (a === '--unsafe-host-exec') flags.unsafeHostExec = true;
      else positional.push(a);
    }
    if (!flags.agent) fail('Usage: tl experiment drain --agent <name> [workspace] [--max <n>] [--evaluate-partial <experiment-id>] [--skip-judges] [--repo <path>] [--test-command <cmd>] [--unsafe-host-exec]');
    const ws = resolveWorkspace(positional[0]);
    try {
      const result = drainQueue(ws.dir, {
        agent: flags.agent,
        max: flags.max !== '' ? flags.max : undefined,
        evaluatePartial: flags.evaluatePartial.filter(Boolean),
        judges: !flags.skipJudges,
        repoDir: path.resolve(flags.repo || INSTALL_ROOT),
        testCommand: flags.testCommand || undefined,
        // Explicit trust decision for unsandboxed shell rows in this drain —
        // without it (or a row-level config.unsafe_host_exec) the shell
        // runner fails closed. See lib/env-policy.js.
        allowUnsafeHostExec: flags.unsafeHostExec || undefined,
      });
      out('===== tl experiment drain =====');
      out(`workspace: ${ws.name} · lane: ${flags.agent}`);
      for (const r of result.requests) out(`request ${r.file}: ${r.status}${r.experimentId ? ' → _experiments/' + r.experimentId + '/' : ''}${r.reason ? ' — ' + r.reason : ''}`);
      if (!result.ran.length) out('no queued rows in this lane.');
      for (const r of result.ran) out(`ran ${r.row.experiment_id}/${r.row.candidate_id} [${r.row.role}] → ${r.status}${r.reason ? ' — ' + r.reason : ''}`);
      for (const j of result.judges) out(`judge queued for ${j.experimentId} (${j.row.candidate_id}, lane ${j.row.agent_tool})`);
      for (const j of result.judged || []) {
        out(`judged ${j.row.experiment_id} (${j.row.candidate_id}) → ${j.status}${j.status === 'succeeded' ? ` — winner: ${j.winner || 'none (human decides)'}` : j.reason ? ' — ' + j.reason : ''}`);
        if (j.status === 'succeeded') out(`  evaluation: _experiments/${j.row.experiment_id}/evaluation/${j.row.candidate_id}/`);
      }
      const left = readQueueRows(ws.dir).filter(r => r.status === 'queued');
      out(`still queued: ${left.length} row(s)${left.length ? ' — lanes: ' + [...new Set(left.map(r => r.agent_tool))].join(', ') : ''}`);
    } catch (e) { fail(e.message); }
    return;
  }

  if (subcmd === 'fixture') {
    const ws = resolveWorkspace(rest[0]);
    const result = runFixtureExperiment(ws.dir);
    out('===== tl experiment fixture =====');
    out(`workspace: ${ws.name}`);
    out(`experiment: _experiments/${result.experimentId}/`);
    out(`winner: ${result.winner}`);
    return;
  }

  // ---- tl experiment replay — rerun a historical task on a new runtime ----
  // `tl experiment replay <experiment-id> --candidate <tool>[:<model>]` queues
  // a replay experiment (exact mode by default: original spec_hash +
  // base_commit; --mode spec reruns the current spec text; --mode auto lets
  // replay decide). `tl experiment replay report` folds judged replays into
  // _metrics/replay-log.jsonl: previous winner vs new candidate, deltas, and
  // the threshold-enforced promotion recommendation. Replay evaluates — it
  // never applies a patch and never moves a spec.
  if (subcmd === 'replay') {
    const positional = [];
    const flags = { candidate: '', mode: '', repo: '', budget: '', timeout: '', id: '', command: '' };
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--candidate') flags.candidate = rest[++i] || '';
      else if (a === '--mode') flags.mode = rest[++i] || '';
      else if (a === '--repo') flags.repo = rest[++i] || '';
      else if (a === '--budget') flags.budget = rest[++i] || '';
      else if (a === '--timeout') flags.timeout = rest[++i] || '';
      else if (a === '--id') flags.id = rest[++i] || '';
      else if (a === '--command') flags.command = rest[++i] || '';
      else positional.push(a);
    }

    // ---- tl experiment replay report [ws] — fold judged replays ----
    if (positional[0] === 'report') {
      const ws = resolveWorkspace(positional[1]);
      try {
        const result = replayReport(ws.dir);
        out('===== tl experiment replay report =====');
        out(`workspace: ${ws.name}`);
        if (!result.appended) out('no newly judged replay experiments — nothing to fold.');
        for (const r of result.rows) {
          out(`${r.experiment_id} (replay of ${r.replay_of}${r.suite_id ? ', suite ' + r.suite_id : ''})`);
          out(`  candidate ${r.candidate_id} [${r.agent_tool}${r.agent_model ? ':' + r.agent_model : ''}] status ${r.replay_status || 'unknown'}${r.fault ? ' fault ' + r.fault : ''}`);
          out(`  previous winner: ${r.previous_winner || 'none'} → new winner: ${r.new_winner || 'none'}`);
          out(`  Δ utility ${r.utility_delta ?? 'n/a'} · Δ quality ${r.quality_delta ?? 'n/a'} · Δ cost ${r.cost_delta ?? 'n/a'} · Δ latency ${r.latency_delta ?? 'n/a'}`);
          if (r.fingerprint_changes.length) out(`  runtime changed: ${r.fingerprint_changes.join(', ')}`);
          out(`  promotion: ${r.promotion_recommendation} — ${r.promotion_reason}`);
        }
        out(`appended: ${result.appended} row(s) → _metrics/replay-log.jsonl`);
        out('Promotion is a recommendation only — changing default_primary stays a human TRIAGE.yml edit.');
      } catch (e) { fail(e.message); }
      return;
    }

    const names = listWorkspaces().map(w => w.name);
    const wsArg = positional.length > 1 || names.includes(positional[0]) ? positional.shift() : undefined;
    const experimentId = positional[0];
    if (!experimentId || !flags.candidate) {
      fail('Usage: tl experiment replay [workspace] <experiment-id> --candidate <tool>[:<model>] [--mode exact|spec|auto] [--repo <path>] [--budget <usd>] [--timeout <min>] [--command <cmd>] [--id <experiment-id>]\n       tl experiment replay report [workspace]');
    }
    const ws = resolveWorkspace(wsArg);
    try {
      const result = replayExperiment(ws.dir, experimentId, {
        candidate: flags.command
          ? { ...parseCandidate(flags.candidate), command: flags.command }
          : flags.candidate,
        mode: flags.mode || undefined,
        repoDir: path.resolve(flags.repo || INSTALL_ROOT),
        budgetUsd: flags.budget !== '' ? flags.budget : undefined,
        timeoutMinutes: flags.timeout !== '' ? flags.timeout : undefined,
        experimentId: flags.id || undefined,
        source: 'cli',
      });
      out('===== tl experiment replay =====');
      out(`workspace: ${ws.name}`);
      out(`replay of: _experiments/${experimentId}/  (mode: ${result.mode})`);
      out(`experiment: _experiments/${result.experimentId}/  (status: queued)`);
      for (const r of result.rows) out(`  - ${r.candidate_id} [${r.role}] lane ${r.agent_tool}${r.agent_model_requested ? ' model ' + r.agent_model_requested : ''}`);
      const fp = result.fingerprint;
      out(`runtime fingerprint: tool ${fp.agent_tool} · model ${fp.agent_model} · tl ${fp.tl_version} · rules ${fp.rules_hash} · skills ${fp.skills_hash}`);
      out(`replay metadata: _experiments/${result.experimentId}/REPLAY.json`);
      out(`Drain the lane (tl experiment drain --agent ${result.rows[0].agent_tool} ${ws.name}), then fold results with: tl experiment replay report ${ws.name}`);
    } catch (e) { fail(e.message); }
    return;
  }

  // ---- tl experiment suite — benchmark suite definitions + suite replay ----
  // A suite is a stored selector query over judged historical experiments,
  // not a snapshot: `suite create` records it, `suite replay` re-selects at
  // run time and queues one replay experiment per selected task.
  if (subcmd === 'suite') {
    const [action, ...suiteRest] = rest;
    const positional = [];
    const flags = { candidate: '', mode: '', repo: '', budget: '', timeout: '', sample: '', notes: '', specs: [], tags: [], taskTypes: [] };
    for (let i = 0; i < suiteRest.length; i++) {
      const a = suiteRest[i];
      if (a === '--spec') flags.specs.push(suiteRest[++i] || '');
      else if (a === '--tag') flags.tags.push(suiteRest[++i] || '');
      else if (a === '--task-type') flags.taskTypes.push(suiteRest[++i] || '');
      else if (a === '--sample') flags.sample = suiteRest[++i] || '';
      else if (a === '--notes') flags.notes = suiteRest[++i] || '';
      else if (a === '--candidate') flags.candidate = suiteRest[++i] || '';
      else if (a === '--mode') flags.mode = suiteRest[++i] || '';
      else if (a === '--repo') flags.repo = suiteRest[++i] || '';
      else if (a === '--budget') flags.budget = suiteRest[++i] || '';
      else if (a === '--timeout') flags.timeout = suiteRest[++i] || '';
      else positional.push(a);
    }
    const names = listWorkspaces().map(w => w.name);

    if (action === 'create') {
      const wsArg = positional.length > 1 || names.includes(positional[0]) ? positional.shift() : undefined;
      const name = positional[0];
      if (!name) fail('Usage: tl experiment suite create [workspace] <name> [--spec <path>]… [--tag <tag>]… [--task-type <type>]… [--sample <n>] [--notes "<text>"]');
      const ws = resolveWorkspace(wsArg);
      try {
        const { suite, file } = createSuite(ws.dir, name, {
          specs: flags.specs.filter(Boolean),
          tags: flags.tags.filter(Boolean),
          taskTypes: flags.taskTypes.filter(Boolean),
          sampleSize: flags.sample !== '' ? flags.sample : undefined,
          notes: flags.notes,
        });
        const preview = selectSuiteExperiments(ws.dir, suite);
        out('===== tl experiment suite create =====');
        out(`workspace: ${ws.name}`);
        out(`suite: ${suite.suite_id} → ${path.relative(ws.dir, file)}`);
        out(`selectors: specs [${suite.selectors.specs.join(', ')}] · tags [${suite.selectors.tags.join(', ')}] · task_types [${suite.selectors.task_types.join(', ')}] · sample ${suite.sample_size ?? 'all'}`);
        out(`currently matches ${preview.length} judged historical task(s)${preview.length ? ': ' + preview.map(m => m.experiment_id).join(', ') : ''}`);
        out(`Replay it with: tl experiment suite replay ${suite.suite_id} --candidate <tool>[:<model>] ${ws.name}`);
      } catch (e) { fail(e.message); }
      return;
    }

    if (action === 'list') {
      const ws = resolveWorkspace(positional[0]);
      const suites = listSuites(ws.dir);
      out('===== tl experiment suite list =====');
      out(`workspace: ${ws.name}`);
      if (!suites.length) out('no suites defined — create one with: tl experiment suite create <name> …');
      for (const s of suites) {
        const matches = selectSuiteExperiments(ws.dir, s);
        out(`- ${s.suite_id}: specs [${(s.selectors.specs || []).join(', ')}] tags [${(s.selectors.tags || []).join(', ')}] task_types [${(s.selectors.task_types || []).join(', ')}] sample ${s.sample_size ?? 'all'} — matches ${matches.length} task(s)`);
      }
      return;
    }

    if (action === 'replay') {
      const wsArg = positional.length > 1 || names.includes(positional[0]) ? positional.shift() : undefined;
      const name = positional[0];
      if (!name || !flags.candidate) fail('Usage: tl experiment suite replay [workspace] <name> --candidate <tool>[:<model>] [--mode exact|spec|auto] [--repo <path>] [--budget <usd>] [--timeout <min>] [--sample <n>]');
      const ws = resolveWorkspace(wsArg);
      try {
        const result = replaySuite(ws.dir, name, {
          candidate: flags.candidate,
          mode: flags.mode || undefined,
          repoDir: path.resolve(flags.repo || INSTALL_ROOT),
          budgetUsd: flags.budget !== '' ? flags.budget : undefined,
          timeoutMinutes: flags.timeout !== '' ? flags.timeout : undefined,
          sampleSize: flags.sample !== '' ? flags.sample : undefined,
        });
        out('===== tl experiment suite replay =====');
        out(`workspace: ${ws.name} · suite: ${result.suite.suite_id}`);
        out(`selected ${result.selected.length} historical task(s)`);
        for (const q of result.queued) out(`  queued _experiments/${q.experimentId}/ (mode ${q.mode}) ← replay of ${q.replayOf}`);
        for (const s of result.skipped) out(`  skipped ${s.experiment_id} — ${s.reason}`);
        if (result.queued.length) {
          const lanes = [...new Set(result.queued.flatMap(q => q.rows.map(r => r.agent_tool)))];
          out(`Drain with: tl experiment drain --agent ${lanes.join(' | ')} ${ws.name}, then: tl experiment replay report ${ws.name}`);
        }
      } catch (e) { fail(e.message); }
      return;
    }

    fail('Usage: tl experiment suite <create|list|replay> …');
  }

  // Winner application — the explicit human gate. Running one of these
  // commands IS the explicit action; nothing applies a candidate patch
  // automatically. Agents must not run apply/reject on a human's behalf.
  if (['select', 'apply', 'reject', 'send-to-review'].includes(subcmd)) {
    const { ws, experimentId, candidateId, flags } = parseWinnerArgs(rest, subcmd);
    const opts = {
      decidedBy: flags.by || process.env.USER || 'human',
      decisionSource: 'human',
      reason: flags.reason || undefined,
    };
    try {
      let record;
      if (subcmd === 'select') record = selectWinner(ws.dir, experimentId, candidateId, opts);
      else if (subcmd === 'reject') record = rejectWinner(ws.dir, experimentId, candidateId, opts);
      else if (subcmd === 'send-to-review') record = sendWinnerToReview(ws.dir, experimentId, candidateId, opts);
      else record = applyWinner(ws.dir, experimentId, candidateId, { ...opts, repoDir: path.resolve(flags.repo || INSTALL_ROOT) });
      out(`===== tl experiment ${subcmd} =====`);
      out(`workspace: ${ws.name}`);
      out(`experiment: _experiments/${experimentId}/`);
      out(`candidate: ${candidateId}`);
      out(`state: ${record.state}`);
      if (record.error_summary) out(`error: ${record.error_summary}`);
      if (record.review_artifact) out(`review artifact: ${record.review_artifact}`);
      out('log: _metrics/winner-log.jsonl (append-only)');
      if (record.state === 'apply-failed') process.exit(1);
    } catch (e) {
      fail(e.message);
    }
    return;
  }

  fail('Usage: tl experiment <queue|drain|fixture|replay|suite|select|apply|reject|send-to-review> …');
}

// ---------- usage ----------

function usage(stream) {
  const w = s => (stream || process.stdout).write(s + '\n');
  w('tl — the throughline CLI');
  w('');
  w('Four verbs. Underlying skills keep working; this is how you reach for them.');
  w('');
  w('steer — shape what to build');
  w('  tl sync check [workspace]       Validate TRIAGE.yml sync.jira.map offline via lib/sync-map — no JIRA calls,');
  w('                                  no credentials; the bridge\'s stop-before-import precondition as a command');
  w('  (skills / agent verbs: new, decompose, goal, promote, groom, capture, sync)');
  w('');
  w('run — start it, or leave automation to it');
  w('  tl up     [workspace]           Happy path — cockpit + automation schedule + next human action');
  w('              [--dry-run]         Show what would start/install; write nothing, load nothing, spawn nothing');
  w('              [--print-schedule]  Emit the complete paste-able cron line + launchd plist, then exit');
  w('              (alias: open)');
  w('  tl run    [workspace] [spec]    Work the ready queue — pick the conflict-free batch (or a named spec)');
  w('              [--agent <name>]    Only claim specs in this agent\'s lane (agent: <name> or any) — heterogeneous fan-out');
  w('  tl reclaim [workspace] [spec]   List stalled in-progress claims (idle past TRIAGE.yml stall.idle_hours, default 24h);');
  w('                                  with a spec: return it to specs/ (or advance to tests/ when builder artifacts exist)');
  w('              --by <who>          Who reclaims — recorded in the spec\'s NOTES.md log');
  w('              --reason "<why>"    Mandatory — a reclaim always logs why; fresh claims always refuse');
  w('  tl recover [workspace] [spec]   Finish a committed builder hand-off whose session died before the move:');
  w('                                  no spec lists candidates; a spec alone inspects its typed state (read-only)');
  w('              --by <who>          Who recovers — logged in NOTES.md + TRACE.jsonl; the builder stays the builder');
  w('              --reason "<why>"    Mandatory to act — recovery always logs why; live builder leases always refuse');
  w('              [--allow-no-lease]  Explicit legacy grace (pre-lease work): idle past threshold AND a valid');
  w('                                  committed HANDOFF.json still required — FEEDBACK.md alone is never completion');
  w('  tl experiment queue [workspace] <spec>');
  w('                                  (advanced) Initiate an experiment: hash the spec, record base_commit, write candidate queue rows');
  w('              [--config <file>]   Explicit candidates/judge JSON (default: deterministic fixture pair)');
  w('              [--budget <usd>] [--timeout <min>] [--repo <path>] [--id <experiment-id>]');
  w('  tl experiment drain --agent <name> [workspace]');
  w('                                  (advanced) Worker pass: claim + run queued rows for this agent\'s lane only,');
  w('                                  then execute queued judge rows in the lane (verdict + JUDGE-BRIEF.md)');
  w('              [--max <n>]         Cap how many candidate rows one pass claims');
  w('              [--evaluate-partial <experiment-id>]');
  w('                                  Force-queue the judge even with non-terminal candidates');
  w('              [--skip-judges]     Leave judge rows queued for the interactive skill path');
  w('              [--repo <path>]     Repo for the judge\'s patch-apply check (default: this repo)');
  w('              [--test-command <cmd>]');
  w('                                  Judge gate: run tests in the isolated patched workdir (runs candidate');
  w('                                  code on this host with a scrubbed env — an explicit trust decision)');
  w('              [--unsafe-host-exec]');
  w('                                  Trust opt-in for shell rows: config.command runs unsandboxed on this');
  w('                                  host (a worktree isolates the checkout, not the machine). Without this');
  w('                                  flag or row-level config.unsafe_host_exec, shell rows fail closed');
  w('  tl experiment fixture [workspace]');
  w('                                  (advanced) Create a deterministic fixture experiment proof');
  w('  tl experiment replay [workspace] <experiment-id> --candidate <tool>[:<model>]');
  w('                                  (advanced) Rerun a historical task on a new runtime — exact mode pins the');
  w('                                  original spec_hash + base_commit; the candidate fingerprint is recorded');
  w('              [--mode exact|spec|auto] [--repo <path>] [--budget <usd>] [--timeout <min>] [--command <cmd>]');
  w('  tl experiment replay report [workspace]');
  w('                                  Fold judged replays into _metrics/replay-log.jsonl: previous winner vs new');
  w('                                  candidate deltas + threshold-enforced promotion recommendation');
  w('  tl experiment suite create [workspace] <name> [--spec <p>]… [--tag <t>]… [--task-type <t>]… [--sample <n>]');
  w('                                  Record a benchmark suite definition (a stored selector query, not a snapshot)');
  w('  tl experiment suite list [workspace]');
  w('  tl experiment suite replay [workspace] <name> --candidate <tool>[:<model>]');
  w('                                  Queue replay experiments across the suite\'s judged historical tasks');
  w('');
  w('review — sign off, unblock, decide on experiment winners');
  w('  tl review [workspace]           Sign off in-review work — criteria + feedback');
  w('  tl reflect-decision [workspace] [id]');
  w('                                  List unread reflect proposals, or append a review marker');
  w('              --action reviewed|dismissed|applied');
  w('              [--by <who>] [--note "..."]');
  w('                                  Explicit human clear — viewing alone does not dismiss; never auto-applies TRIAGE.yml');
  w('  tl verify [workspace] [spec]    Independent-verifier queue — status + briefs (non-builder)');
  w('              [--agent <name>]    Prefer / filter this verifier lane; builders are excluded');
  w('              [--execute]         Run one isolated verify tick (drains request or queue)');
  w('              [--dispatch]        Write a verify-request artifact (no agent spawn)');
  w('              [--target-lane <l>] For --dispatch: lane ≠ builder, or any-other');
  w('              [--authorize-fix-forward|--kick-back] [--note "..."]');
  w('                                  Explicit human decision on a mutation proposal (never auto-apply)');
  w('  tl experiment select|apply|reject|send-to-review [workspace] <experiment-id> <candidate-id>');
  w('                                  Winner application — the explicit HUMAN action on a winning patch');
  w('              [--by <who>]        Who decided (recorded in WINNER.json and _metrics/winner-log.jsonl)');
  w('              [--reason "<why>"]  Required for reject — rejections record why');
  w('              [--repo <path>]     Canonical repo for apply (default: this checkout)');
  w('');
  w('learn — where am I, what changed, what should change');
  w('  tl resume [workspace]           Reconstruct context — stage counts, ready top, open loops');
  w('  tl recall [workspace] <query>   Search intents/specs/threads/outcomes — "did we discuss this?"');
  w('  (skills / agent verbs: map, reflect, insights)');
  w('');
  w('  tl sync-rules [--check]         Regenerate per-agent rules, or check for generated-rule drift');
  w('  tl triage-lock <acquire|touch|release|check> [workspace] [--lane <name>]');
  w('');
  w('Workspace: an argument names a workspace under projects/; if exactly one exists it is used;');
  w('otherwise the available workspaces are listed.');
  const all = listWorkspaces();
  w('');
  w('Workspaces: ' + (all.map(w2 => w2.name).join(', ') || '(none under projects/)'));
}

// ---------- dispatch ----------

function main() {
  // Global --root / TL_ROOT already resolved into ROOT at load; strip the
  // flag so it is never mistaken for a subcommand.
  const [cmd, ...rest] = stripRootFlag(process.argv.slice(2));
  switch (cmd) {
    case 'resume': return cmdResume(rest);
    // up (and short-lived alias open) is async (a short UI port probe); errors still exit through fail().
    case 'up':
    case 'open': return void cmdUp(rest).catch(e => fail(e && e.message ? e.message : String(e)));
    case 'run': return cmdRun(rest);
    case 'reclaim': return cmdReclaim(rest);
    case 'recover': return cmdRecover(rest);
    case 'review': return cmdReview(rest);
    case 'reflect-decision': return cmdReflectDecision(rest);
    case 'verify': return cmdVerify(rest);
    case 'recall': return cmdRecall(rest);
    case 'sync': return cmdSync(rest);
    case 'experiment': return cmdExperiment(rest);
    case 'sync-rules': return cmdSyncRules(rest);
    case 'triage-lock': return cmdTriageLock(rest);
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      return usage();
    default:
      // an unknown command is an error — exit non-zero so automation and shell
      // pipelines don't read a typo as success. Usage goes to stderr here.
      process.stderr.write('tl: unknown command "' + cmd + '"\n\n');
      usage(process.stderr);
      process.exit(2);
  }
}

main();

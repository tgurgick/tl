'use strict';

// Experiment runner — executes ONE claimed queue row locally and always
// leaves the same artifact set behind, whatever happened.
//
// The contract that matters (spec hint, verbatim): every candidate produces
// the same artifact set and terminal status. Even a fault writes:
//   _experiments/<id>/candidates/<cid>/PATCH.diff     ('' when none)
//   _experiments/<id>/candidates/<cid>/FEEDBACK.md    what happened, honestly
//   _experiments/<id>/candidates/<cid>/METRICS.json   status/fault/fingerprint
//   _experiments/<id>/candidates/<cid>/TRACE.jsonl    observable action events
//   _metrics/candidate-run-log.jsonl                  one append-only row
//
// Two runners ship in this slice, keyed by the row's `agent_tool`:
//   fixture  deterministic, side-effect-free — the protocol proof
//   shell    runs `config.command` in an ISOLATED workdir (git worktree from
//            base_commit, sibling-clone fallback) and collects `git diff`
//
// ---- Seam for later worktree/clone orchestration -------------------------
// Real agent adapters (Claude / Codex / Cursor SDK / cloud) plug in at TWO
// points, both exported:
//   1. RUNNERS — register `RUNNERS[agent_tool] = (workspaceDir, row, opts) =>
//      ({ status, patch, feedback, output, taskComplete, agentModel, reason })`.
//      The wrapper (`runCandidate`) owns budget stop, timeout mapping, patch
//      validation, artifact writing, and log rows — an adapter only produces.
//      A full adapter should satisfy lib/experiment-adapter.js `isAdapter` and
//      wrap its prepare/start/collect cycle inside one RUNNERS entry.
//   2. createIsolatedWorkdir / removeIsolatedWorkdir — the isolation strategy.
//      Local case implemented here: `git worktree add --detach <dir> <commit>`
//      (cheap, shares the object store), falling back to a sibling clone when
//      worktrees are unavailable. A remote/cloud adapter replaces this pair
//      with its own sandbox provisioning but keeps the same promise: the
//      canonical repo working tree is NEVER mutated by a candidate run.
// ---------------------------------------------------------------------------
//
// Fault posture (all terminal, all serialized as both status and fault):
//   over_budget     estimated cost exceeds the row's budget_usd — stopped
//                   before execution
//   unavailable     no local runner for the row's agent_tool, or the shell
//                   runner's repo is missing
//   timed_out       the command outlived timeout_minutes
//   failed          the command exited non-zero (or the runner crashed)
//   invalid_output  the run "succeeded" but produced no usable patch
//
// Workers never apply winners — that is an explicit human CLI action, so this
// module must not import lib/experiment-apply.js (a test enforces it).
// Node stdlib only; zero dependencies.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { makeFingerprint } = require('./experiment-adapter');
const { parseFrontmatter } = require('./parse');

function isoNow(now) {
  return (now instanceof Date ? now : new Date()).toISOString();
}

function datePart(iso) {
  return iso.slice(0, 10);
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p, content) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, content);
}

function appendJsonl(file, row) {
  mkdirp(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

function git(cwd, args, opts = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', ...opts });
}

function tail(s, lines = 20, chars = 2000) {
  const text = String(s || '').trim();
  if (!text) return '';
  return text.split('\n').slice(-lines).join('\n').slice(-chars);
}

// ---------- isolation (the local worktree/clone strategy) ----------

// Create an isolated workdir for one candidate run: a detached git worktree
// at base_commit (preferred — cheap, shares objects), else a sibling clone.
// Returns { ok, mode: 'worktree' | 'clone', error }. The candidate mutates
// ONLY this directory; the canonical working tree is untouched.
function createIsolatedWorkdir(repoDir, baseCommit, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true }); // stale leftovers never poison a run
  mkdirp(path.dirname(destDir));
  const ref = baseCommit && baseCommit !== 'unknown' ? baseCommit : 'HEAD';

  const wt = git(repoDir, ['worktree', 'add', '--detach', destDir, ref]);
  if (wt.status === 0) return { ok: true, mode: 'worktree', error: null };

  const clone = git(path.dirname(destDir), ['clone', '--quiet', '--no-hardlinks', repoDir, destDir]);
  if (clone.status === 0) {
    const co = ref === 'HEAD' ? { status: 0 } : git(destDir, ['checkout', '--quiet', '--detach', ref]);
    if (co.status === 0) return { ok: true, mode: 'clone', error: null };
  }
  return {
    ok: false, mode: null,
    error: tail((wt.stderr || '') + '\n' + (clone.stderr || ''), 3, 300) || 'worktree add and clone both failed',
  };
}

// Tear the isolated workdir down. Best effort — a leftover directory is
// debris, never a correctness problem, so this never throws.
function removeIsolatedWorkdir(repoDir, destDir, mode) {
  try {
    if (mode === 'worktree') {
      git(repoDir, ['worktree', 'remove', '--force', destDir]);
      git(repoDir, ['worktree', 'prune']);
    }
    fs.rmSync(destDir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

// ---------- the two local runners ----------

// Deterministic fixture candidate: no processes, no isolation needed (it
// writes only its own artifact folder). `config.complete` pins the outcome;
// default mirrors the fixture proof — primary completes, shadow doesn't.
function runFixtureCandidate(workspaceDir, row) {
  const config = row.config || {};
  const complete = config.complete !== undefined ? Boolean(config.complete) : row.role === 'primary';
  const patch = [
    `diff --git a/fixture-${row.candidate_id}.txt b/fixture-${row.candidate_id}.txt`,
    'new file mode 100644',
    'index 0000000..2cf24d8',
    '--- /dev/null',
    `+++ b/fixture-${row.candidate_id}.txt`,
    '@@ -0,0 +1 @@',
    `+fixture ${complete ? 'complete' : 'incomplete'}`,
    '',
  ].join('\n');
  return {
    status: 'succeeded',
    patch,
    taskComplete: complete,
    agentModel: row.agent_model_requested || 'deterministic',
    agentModelSource: 'fixture',
    framework: 'throughline-fixture',
    output: '',
    events: [{ type: 'patch', summary: 'Wrote deterministic fixture patch.' }],
  };
}

// Shell candidate: run `config.command` inside an isolated worktree/clone of
// `config.repo` at the experiment's base_commit, then collect `git diff`
// (intent-to-add first, so new files show) as PATCH.diff.
function runShellCandidate(workspaceDir, row, opts = {}) {
  const config = row.config || {};
  const repo = config.repo ? path.resolve(config.repo) : null;
  if (!repo || !fs.existsSync(repo)) {
    return { status: 'unavailable', reason: 'shell runner requires config.repo pointing at an existing repo', events: [] };
  }
  const meta = opts.meta || {};
  const baseCommit = config.base_commit || meta.base_commit || 'unknown';
  const workdir = path.join(workspaceDir, '_experiments', row.experiment_id, 'work', row.candidate_id);
  const events = [];

  const iso = createIsolatedWorkdir(repo, baseCommit, workdir);
  if (!iso.ok) {
    return { status: 'failed', reason: `could not create isolated workdir: ${iso.error}`, events };
  }
  events.push({ type: 'isolate', summary: `Created isolated ${iso.mode} at base ${baseCommit}.` });

  try {
    const command = String(config.command || 'true');
    const timeoutMs = row.timeout_minutes != null && Number.isFinite(+row.timeout_minutes)
      ? Math.max(1, Math.round(+row.timeout_minutes * 60000)) : undefined;
    events.push({ type: 'exec', summary: `Running shell command${timeoutMs ? ` (timeout ${row.timeout_minutes} min)` : ''}: ${command.slice(0, 200)}` });
    const r = spawnSync('/bin/sh', ['-c', command], {
      cwd: workdir, encoding: 'utf8', timeout: timeoutMs,
      env: { ...process.env, ...(config.env || {}) },
    });
    const output = tail((r.stdout || '') + (r.stderr ? '\n' + r.stderr : ''));

    if (r.error && r.error.code === 'ETIMEDOUT') {
      return { status: 'timed_out', reason: `command exceeded timeout of ${row.timeout_minutes} minute(s)`, output, events };
    }
    if (r.error) {
      return { status: 'failed', reason: `command could not run: ${r.error.message}`, output, events };
    }
    if (r.status !== 0) {
      return { status: 'failed', reason: `command exited ${r.status}`, output, events };
    }

    git(workdir, ['add', '--intent-to-add', '--all']); // untracked files become diffable
    const diff = git(workdir, ['diff']);
    const patch = diff.status === 0 ? diff.stdout : '';
    events.push({ type: 'patch', summary: `Collected git diff (${patch.split('\n').length} lines).` });
    return { status: 'succeeded', patch, taskComplete: true, output, events };
  } finally {
    removeIsolatedWorkdir(repo, workdir, iso.mode);
    events.push({ type: 'isolate', summary: `Removed isolated ${iso.mode}.` });
  }
}

// The runner registry — the first seam. Later adapters (Claude/Codex/Cursor
// SDK/cloud workers) register here under their agent_tool; the queue and
// wrapper never change. Unknown tools are `unavailable`, never a crash.
const RUNNERS = {
  fixture: runFixtureCandidate,
  shell: runShellCandidate,
};

function hasRunner(agentTool) {
  return Object.prototype.hasOwnProperty.call(RUNNERS, String(agentTool || ''));
}

// ---------- the wrapper: run one claimed row, always leave artifacts ----------

function readExperimentMeta(workspaceDir, experimentId) {
  try {
    const text = fs.readFileSync(path.join(workspaceDir, '_experiments', experimentId, 'EXPERIMENT.md'), 'utf8');
    return parseFrontmatter(text).meta || {};
  } catch {
    return {};
  }
}

// Execute one CLAIMED queue row. Owns the cross-cutting rules so individual
// runners stay thin: budget stop before execution, unavailable-tool mapping,
// empty-patch → invalid_output, and the invariant artifact set + log row on
// EVERY terminal path. Returns { status, reason, candidateDir }.
function runCandidate(workspaceDir, row, opts = {}) {
  const startedAt = Date.now();
  const started = isoNow(opts.now);
  const meta = readExperimentMeta(workspaceDir, row.experiment_id);
  const config = row.config || {};
  const trace = [{ ts: started, type: 'start', status: 'running', summary: `Claimed by ${row.claimed_by || 'worker'} (attempt ${row.attempt}); starting ${row.agent_tool} candidate.` }];

  let result;
  const estimated = Number(config.estimated_cost_usd) || 0;
  if (row.budget_usd != null && estimated > row.budget_usd) {
    // Budget stop happens BEFORE execution — the cheapest possible fault.
    result = { status: 'over_budget', reason: `estimated cost $${estimated} exceeds budget $${row.budget_usd}`, events: [] };
  } else if (!hasRunner(row.agent_tool)) {
    result = { status: 'unavailable', reason: `no local runner for agent_tool "${row.agent_tool}" — a ${row.agent_tool} worker (SDK/cloud/CLI) must drain this lane`, events: [] };
  } else {
    try {
      result = RUNNERS[row.agent_tool](workspaceDir, row, { ...opts, meta });
    } catch (e) {
      result = { status: 'failed', reason: `runner threw: ${String(e.message).slice(0, 300)}`, events: [] };
    }
  }

  let { status } = result;
  let reason = result.reason || null;
  const patch = String(result.patch || '');
  if (status === 'succeeded' && !patch.trim()) {
    status = 'invalid_output';
    reason = 'run finished but produced an empty or missing patch';
  }
  const fault = status === 'succeeded' ? null : status;
  const finished = isoNow(opts.now);
  const durationMinutes = Math.round(((Date.now() - startedAt) / 60000) * 1000) / 1000;

  for (const ev of result.events || []) trace.push({ ts: finished, status: 'running', ...ev });
  trace.push({ ts: finished, type: 'finish', status, summary: reason || `Finished with status ${status}.` });

  // The invariant artifact set — written on every terminal path, fault or not.
  const candDir = path.join(workspaceDir, '_experiments', row.experiment_id, 'candidates', row.candidate_id);
  const fingerprint = makeFingerprint({
    agent_tool: row.agent_tool,
    agent_model: result.agentModel || row.agent_model_requested || 'none',
    agent_model_auto: !row.agent_model_requested && Boolean(result.agentModel),
    agent_model_source: result.agentModelSource || (row.agent_model_requested ? 'requested' : 'none'),
    runtime_version: '1',
    framework: result.framework || row.agent_tool,
    adapter_version: '1',
  });
  const metrics = {
    candidate_id: row.candidate_id,
    role: row.role,
    status,
    ...fingerprint,
    duration_minutes: durationMinutes,
    cost_usd: Number(config.actual_cost_usd) || 0,
    tokens_used: 0,
    fault,
    task_complete: status === 'succeeded' ? result.taskComplete !== false : false,
  };

  writeFile(path.join(candDir, 'PATCH.diff'), patch);
  writeFile(path.join(candDir, 'FEEDBACK.md'), [
    `# Feedback: ${row.candidate_id}`,
    '',
    `- Status: \`${status}\`${fault ? ` (fault: \`${fault}\`)` : ''}`,
    `- Role: ${row.role} · tool: \`${row.agent_tool}\` · attempt: ${row.attempt}`,
    reason ? `- Reason: ${reason}` : null,
    '',
    status === 'succeeded'
      ? 'The run completed and its patch is recorded in `PATCH.diff` for judging.'
      : 'The run did not complete successfully. This report and the metrics are retained as evidence — faults are learning data, never dropped.',
    result.output ? '' : null,
    result.output ? '## Output (tail)' : null,
    result.output ? '' : null,
    result.output ? '```\n' + result.output + '\n```' : null,
    '',
  ].filter(l => l !== null).join('\n'));
  writeFile(path.join(candDir, 'METRICS.json'), JSON.stringify(metrics, null, 2) + '\n');
  writeFile(path.join(candDir, 'TRACE.jsonl'), trace.map(t => JSON.stringify(t)).join('\n') + '\n');

  appendJsonl(path.join(workspaceDir, '_metrics', 'candidate-run-log.jsonl'), {
    date: datePart(finished),
    experiment_id: row.experiment_id,
    task_type: meta.task_type || '',
    tl_spec: meta.tl_spec || '',
    spec_hash: meta.spec_hash || '',
    base_commit: meta.base_commit || '',
    candidate_id: row.candidate_id,
    role: row.role,
    status,
    fault,
    ...fingerprint,
    duration_minutes: durationMinutes,
    cost_usd: metrics.cost_usd,
    tokens_used: metrics.tokens_used,
    patch_path: `_experiments/${row.experiment_id}/candidates/${row.candidate_id}/PATCH.diff`,
    trace_path: `_experiments/${row.experiment_id}/candidates/${row.candidate_id}/TRACE.jsonl`,
  });

  return { status, reason, candidateDir: candDir };
}

module.exports = {
  RUNNERS,
  hasRunner,
  runCandidate,
  createIsolatedWorkdir,
  removeIsolatedWorkdir,
};
